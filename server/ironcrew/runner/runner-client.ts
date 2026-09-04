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
 * so the tests drive the real code with no filesystem and no ports.
 */

import { newId } from "../domain/ids.ts";
import {
  decodeMessage,
  encodeMessage,
  LineDecoder,
  RunnerProtocolError,
  RUNNER_PROTOCOL_VERSION,
  toWireContext,
  type ServerMessage,
} from "./protocol.ts";
import type {
  AgentRuntime,
  AuthStatus,
  RunContext,
  RunEvent,
  RunInput,
  RuntimeCapabilities,
  RuntimeHealth,
} from "../runtime/run-events.ts";

/** What a transport must provide. A net.Socket satisfies this; so does a fake. */
export interface RunnerConnection {
  write(data: string): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  destroy(): void;
}

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

export class RunnerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerUnavailableError";
  }
}

/** A connection plus its line decoder, with the handshake already done. */
interface Session {
  connection: RunnerConnection;
  lines: AsyncIterableIterator<string>;
  close(): void;
}

export class RunnerRuntime implements AgentRuntime {
  readonly id: string;
  readonly type: string;

  private readonly connectFn: () => Promise<RunnerConnection>;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly cancelled = new Set<string>();

  constructor(opts: RunnerRuntimeOptions) {
    this.id = `runner:${opts.runtimeType}`;
    this.type = opts.runtimeType;
    this.connectFn = opts.connect;
    this.token = opts.token;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Opens a connection and completes the handshake.
   *
   * One connection per request rather than a long-lived shared one: a runner
   * restart then costs the next request a reconnect instead of silently
   * breaking every future one, and there is no shared state to get out of
   * sync between two processes that update independently.
   */
  private async open(): Promise<Session> {
    let connection: RunnerConnection;
    try {
      connection = await this.connectFn();
    } catch (err) {
      throw new RunnerUnavailableError(`Runner nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`);
    }

    const decoder = new LineDecoder();
    const queue: string[] = [];
    let resolveNext: (() => void) | null = null;
    let closed = false;
    let failure: Error | null = null;

    const wake = () => {
      const resolve = resolveNext;
      resolveNext = null;
      resolve?.();
    };

    connection.on("data", (chunk) => {
      try {
        queue.push(...decoder.push(chunk));
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        closed = true;
      }
      wake();
    });
    connection.on("close", () => {
      closed = true;
      wake();
    });
    connection.on("error", (err) => {
      failure = err;
      closed = true;
      wake();
    });

    async function* lines(): AsyncIterableIterator<string> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (failure) throw failure;
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    const session: Session = {
      connection,
      lines: lines(),
      close: () => {
        closed = true;
        wake();
        connection.destroy();
      },
    };

    connection.write(encodeMessage({ v: RUNNER_PROTOCOL_VERSION, kind: "hello", token: this.token }));

    const greeting = await this.nextMessage(session, this.requestTimeoutMs);
    if (!greeting || greeting.kind !== "hello-ok") {
      session.close();
      throw new RunnerUnavailableError(
        greeting?.kind === "error" ? `Runner lehnte die Verbindung ab: ${greeting.message}` : "Runner grüßte nicht.",
      );
    }
    if (!greeting.runtimes.includes(this.type)) {
      session.close();
      // Better here than as a confusing failure inside a run: the runner is
      // reachable, it simply cannot do this job.
      throw new RunnerUnavailableError(
        `Der Runner kennt die Laufzeit "${this.type}" nicht (verfügbar: ${greeting.runtimes.join(", ") || "keine"}).`,
      );
    }
    return session;
  }

  private async nextMessage(session: Session, timeoutMs: number): Promise<ServerMessage | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const line = await Promise.race([
        session.lines.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RunnerUnavailableError("Der Runner antwortete nicht rechtzeitig.")),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      if (line.done) return null;
      return decodeMessage(line.value) as ServerMessage;
    } finally {
      clearTimeout(timer);
    }
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
  }

  /**
   * Runs a job on the runner, yielding its events as they arrive.
   *
   * Every exit path yields a terminal event first — see this module's header.
   * The orchestrator's `for await` is what advances a task, so a generator
   * that merely stops leaves the task running and the agent locked until a
   * lease expires.
   */
  async *startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
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

    try {
      if (this.cancelled.has(context.runId) || context.signal?.aborted) {
        this.cancelled.delete(context.runId);
        yield synthetic(context, "run.cancelled", { reason: "cancelled before the job was sent" });
        return;
      }

      session.connection.write(
        encodeMessage({
          v: RUNNER_PROTOCOL_VERSION,
          kind: "start",
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

        if (message.kind === "event") {
          if (isTerminal(message.event.type)) sawTerminal = true;
          yield message.event;
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
      session.close();
    }
  }
}

function isTerminal(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled";
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
