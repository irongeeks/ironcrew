/**
 * IronCrew — the control plane's view of a runner.
 *
 * `RunnerRuntime implements AgentRuntime`, so the orchestrator cannot tell a
 * run that happened in another process under another OS user from one that
 * happened inline. That is the entire point of having the contract: the
 * security property (the control plane never holds a CLI login) costs the
 * rest of the system nothing.
 *
 * THE RULE THAT SHAPES THIS FILE
 *
 * **A run must always end.** Every failure mode here — the connection
 * dropping mid-run, the runner dying, a protocol error, a timeout — has to
 * produce a terminal event. A `startRun` generator that simply stops leaves
 * the orchestrator's `for await` waiting forever: the task stays `running`,
 * the agent stays locked, and the only recovery is the lease expiring
 * minutes later. So every exit path below yields `run.failed` or
 * `run.cancelled` first.
 *
 * The transport is injected as a plain duplex-ish pair rather than a socket,
 * so the tests drive the real code with no filesystem and no ports. The
 * connection and its handshake live in runner-session.ts, shared with the MCP
 * client.
 */

import { newId } from "../domain/ids.ts";
import {
  encodeMessage,
  RunnerProtocolError,
  RUNNER_PROTOCOL_VERSION,
  toWireContext,
  type ServerMessage,
} from "./protocol.ts";
import {
  nextMessage,
  openSession,
  RunnerUnavailableError,
  type RunnerConnection,
  type Session,
} from "./runner-session.ts";
import { runEventSchema } from "../runtime/run-events.ts";
import type {
  AgentRuntime,
  AuthStatus,
  RunContext,
  RunEvent,
  RunInput,
  RuntimeCapabilities,
  RuntimeHealth,
} from "../runtime/run-events.ts";

export { RunnerUnavailableError, type RunnerConnection } from "./runner-session.ts";

export interface RunnerRuntimeOptions {
  /** The runtime type this instance stands in for, e.g. "claude". */
  runtimeType: string;
  /** Opens a connection. Called per request, so a dropped socket self-heals. */
  connect: () => Promise<RunnerConnection>;
  token: string;
  /** How long to wait for a reply to a request. Not the run's own timeout. */
  requestTimeoutMs?: number;
  /** How long a run may go without a single event before it is abandoned. */
  idleTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export class RunnerRuntime implements AgentRuntime {
  readonly id: string;
  readonly type: string;

  private readonly connectFn: () => Promise<RunnerConnection>;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly cancelled = new Set<string>();
  private readonly activeCancels = new Map<string, () => void>();

  constructor(opts: RunnerRuntimeOptions) {
    this.id = `runner:${opts.runtimeType}`;
    this.type = opts.runtimeType;
    this.connectFn = opts.connect;
    this.token = opts.token;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  private open(): Promise<Session> {
    return openSession({
      connect: this.connectFn,
      token: this.token,
      requestTimeoutMs: this.requestTimeoutMs,
      requireRuntime: this.type,
    });
  }

  private nextMessage(session: Session, timeoutMs: number): Promise<ServerMessage | null> {
    return nextMessage(session, timeoutMs);
  }

  /** One request, one reply. Used for the three cheap status probes. */
  private async request<T>(kind: "capabilities" | "health" | "auth"): Promise<T> {
    const session = await this.open();
    try {
      const id = newId("evt");
      session.connection.write(encodeMessage({ v: RUNNER_PROTOCOL_VERSION, kind, id, runtimeType: this.type }));
      const reply = await this.nextMessage(session, this.requestTimeoutMs);

      if (!reply) throw new RunnerUnavailableError("Der Runner schloss die Verbindung ohne Antwort.");
      if (reply.kind === "error") throw new RunnerUnavailableError(reply.message);
      if (reply.kind !== "result") throw new RunnerProtocolError(`Unerwartete Antwort "${reply.kind}".`);
      return reply.value as T;
    } finally {
      session.close();
    }
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return this.request<RuntimeCapabilities>("capabilities");
  }

  async healthCheck(): Promise<RuntimeHealth> {
    try {
      return await this.request<RuntimeHealth>("health");
    } catch (err) {
      // A probe reports; it does not throw. An unreachable runner is exactly
      // what this question is for.
      return {
        healthy: false,
        installed: false,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      };
    }
  }

  async authStatus(): Promise<AuthStatus> {
    try {
      return await this.request<AuthStatus>("auth");
    } catch (err) {
      return {
        authenticated: false,
        method: "none",
        detail: err instanceof Error ? err.message : String(err),
        setupHint: "Läuft der ironcrew-runner-Dienst, und stimmt IRONCREW_RUNNER_SOCKET?",
      };
    }
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelled.add(runId);
    this.activeCancels.get(runId)?.();
  }

  /**
   * Runs a job on the runner, yielding its events as they arrive.
   *
   * Every exit path yields a terminal event first — see this module's header.
   * The orchestrator's `for await` is what advances a task, so a generator
   * that merely stops leaves the task running and the agent locked until a
   * lease expires.
   */
  resumeRun(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    return this.execute(input, context, sessionRef);
  }

  startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    return this.execute(input, context, input.sessionRef);
  }

  private async *execute(input: RunInput, context: RunContext, sessionRef?: string): AsyncIterable<RunEvent> {
    const id = newId("evt");
    let session: Session;

    try {
      session = await this.open();
    } catch (err) {
      yield synthetic(context, "run.failed", { message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const onAbort = () => {
      session.connection.write(encodeMessage({ v: RUNNER_PROTOCOL_VERSION, kind: "cancel", id, runId: context.runId }));
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    this.activeCancels.set(context.runId, onAbort);

    try {
      if (this.cancelled.has(context.runId) || context.signal?.aborted) {
        this.cancelled.delete(context.runId);
        yield synthetic(context, "run.cancelled", { reason: "cancelled before the job was sent" });
        return;
      }

      session.connection.write(
        encodeMessage({
          v: RUNNER_PROTOCOL_VERSION,
          ...(sessionRef ? { kind: "resume" as const, sessionRef } : { kind: "start" as const }),
          id,
          runtimeType: this.type,
          input,
          context: toWireContext(context),
        }),
      );

      let sawTerminal = false;
      for (;;) {
        let message: ServerMessage | null;
        try {
          message = await this.nextMessage(session, this.idleTimeoutMs);
        } catch (err) {
          yield synthetic(context, "run.failed", { message: err instanceof Error ? err.message : String(err) });
          return;
        }

        // The connection closed without an `end`: the runner died mid-run, or
        // something in between dropped it. Either way the run is over and the
        // control plane has to be told, not left waiting.
        if (!message) {
          if (!sawTerminal) {
            yield synthetic(context, "run.failed", {
              message: "Die Verbindung zum Runner brach während des Laufs ab.",
            });
          }
          return;
        }

        if (!("id" in message) || message.id !== id) {
          yield synthetic(context, "run.failed", { message: "Runner-Antwort gehört nicht zu diesem Auftrag." });
          return;
        }
        if (message.kind === "event") {
          const parsed = runEventSchema.safeParse(message.event);
          if (
            !parsed.success ||
            parsed.data.companyId !== context.companyId ||
            parsed.data.taskId !== context.taskId ||
            parsed.data.runId !== context.runId ||
            parsed.data.projectId !== context.projectId ||
            parsed.data.agentId !== context.agentId ||
            parsed.data.correlationId !== context.correlationId
          ) {
            yield synthetic(context, "run.failed", { message: "Runner-Event gehört nicht zum zugewiesenen Task." });
            return;
          }
          if (isTerminal(parsed.data.type)) sawTerminal = true;
          yield parsed.data;
          if (parsed.data.type === "usage.updated") {
            // Resuming this generator means the consumer has persisted usage
            // and completed its budget decision. An abort/return never ACKs.
            if (context.signal?.aborted || this.cancelled.has(context.runId)) {
              onAbort();
            } else {
              session.connection.write(
                encodeMessage({
                  v: RUNNER_PROTOCOL_VERSION,
                  kind: "usage-ack",
                  id,
                  companyId: context.companyId,
                  taskId: context.taskId,
                  runId: context.runId,
                  eventId: parsed.data.eventId,
                  seq: parsed.data.seq,
                }),
              );
            }
          }
          continue;
        }
        if (message.kind === "end") {
          if (!sawTerminal) {
            // A runner that ended without a terminal event is a runner with a
            // bug; the run still has to end here.
            yield synthetic(context, "run.failed", { message: "Der Runner beendete den Lauf ohne Abschluss-Event." });
          }
          return;
        }
        if (message.kind === "error") {
          yield synthetic(context, "run.failed", { message: message.message });
          return;
        }
        // Anything else is a protocol violation, and continuing to read would
        // be guessing about a peer that is already confused.
        yield synthetic(context, "run.failed", { message: `Unerwartete Runner-Nachricht "${message.kind}".` });
        return;
      }
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      this.activeCancels.delete(context.runId);
      this.cancelled.delete(context.runId);
      session.close();
    }
  }
}

function isTerminal(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled" || type === "run.waiting";
}

/**
 * An event the runner did not send, because it could not.
 *
 * `seq: -1` marks it as locally minted: the runner owns the sequence for a
 * run, and inventing a number in its space would collide with one it may
 * already have used. The orchestrator re-sequences on persist anyway.
 */
function synthetic(
  context: RunContext,
  type: "run.failed" | "run.cancelled",
  payload: Record<string, unknown>,
): RunEvent {
  return {
    eventId: newId("evt"),
    companyId: context.companyId,
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    agentId: context.agentId,
    seq: -1,
    type,
    timestamp: Date.now(),
    correlationId: context.correlationId,
    payload,
    redaction: { redacted: false, rules: [] },
  };
}
