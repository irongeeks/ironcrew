/**
 * IronCrew — the runner side of the wire.
 *
 * This is the half that holds the CLI logins. It runs as its own OS user,
 * from its own systemd unit, and the control plane never sees a token from it
 * — only capabilities, status and normalised events
 * (docs/RUNNER_PROTOCOL.md, docs/THREAT_MODEL.md T-05).
 *
 * WHY A UNIX SOCKET AND NOT A PORT
 *
 * Access control is then the filesystem's, which the operating system already
 * enforces and an admin already understands: the socket is owned by the
 * runner user, group-readable by the service user, and nothing else on the
 * machine can reach it. A localhost TCP port is reachable by every process on
 * the box, including anything an agent itself starts — which would make the
 * isolation this daemon exists for decorative.
 *
 * The token on top is defence in depth, not the primary control. It is
 * checked with a length-independent comparison so a wrong guess leaks nothing
 * through timing.
 *
 * WORKSPACE CONTAINMENT IS ENFORCED HERE, NOT ONLY REQUESTED
 *
 * The control plane names a workspace in every job. This side refuses a job
 * whose workspace is outside its configured root — because a runner that
 * trusted the path it was given would turn a bug in the control plane into
 * arbitrary filesystem access under the account that holds the logins.
 */

import { newId } from "../domain/ids.ts";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../observability/logger.ts";
import {
  decodeClientMessage,
  encodeMessage,
  LineDecoder,
  RUNNER_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.ts";
import { runEventSchema } from "../runtime/run-events.ts";
import { MAX_SANDBOX_GRANT_MS } from "../policy/runtime-permissions.ts";
import { SANDBOX_PROVIDERS } from "../policy/sandbox-access.ts";
import { redact, redactValue } from "../security/redaction.ts";
import type { AgentRuntime, RunContext } from "../runtime/run-events.ts";
import type { McpHost } from "./mcp-host.ts";

const log = logger.child({ module: "ironcrew-runner" });

/** The subset of a socket this needs; a fake satisfies it in tests. */
export interface RunnerSocket {
  write(data: string): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  destroy(): void;
}

export interface RunnerServerOptions {
  runtimes: AgentRuntime[];
  token: string;
  /** Every job's workspace must live under this directory. */
  workspaceRoot: string;
  /**
   * Where MCP servers run. Absent means this runner does not host them, and
   * says so instead of failing in a way that looks like a missing server.
   */
  mcp?: McpHost;
  /** Maximum time for the control plane to ingest usage and permit continuation. */
  usageAckTimeoutMs?: number;
}

/** Constant-time token comparison — a wrong guess must not leak its length. */
function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(given, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface RunningJob {
  controller: AbortController;
  runId: string;
  runtime: AgentRuntime;
  companyId: string;
  taskId: string;
  awaitingUsage?: { eventId: string; seq: number; ack: () => void };
}

export class RunnerServer {
  private readonly activeTasks = new Set<string>();
  private readonly connections = new Set<RunnerSocket>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly token: string;
  private readonly workspaceRoot: string;
  private readonly mcp: McpHost | undefined;
  private readonly usageAckTimeoutMs: number;

  constructor(opts: RunnerServerOptions) {
    for (const runtime of opts.runtimes) this.runtimes.set(runtime.type, runtime);
    if (!opts.token.trim()) throw new Error("Runner requires an authentication token.");
    this.token = opts.token;
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    if (this.workspaceRoot === path.parse(this.workspaceRoot).root)
      throw new Error("Runner workspace root must not be the filesystem root.");
    this.mcp = opts.mcp;
    this.usageAckTimeoutMs = opts.usageAckTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.usageAckTimeoutMs) || this.usageAckTimeoutMs <= 0)
      throw new Error("Invalid usage acknowledgement timeout.");
  }

  get runtimeTypes(): string[] {
    return [...this.runtimes.keys()];
  }

  /**
   * Whether a job's workspace is one this runner may touch.
   *
   * `realpath` of the nearest existing ancestor, not just a string prefix: a
   * symlink inside the root pointing out of it would pass a textual check and
   * hand an agent the rest of the filesystem under the account that holds the
   * CLI logins. Same reasoning as the change-proposal path check.
   */
  allowsWorkspace(workspacePath: string): boolean {
    if (!path.isAbsolute(workspacePath)) return false;

    let probe = path.resolve(workspacePath);
    const seen = new Set<string>();
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      // A path whose ancestors do not exist at all cannot be judged safe.
      if (parent === probe || seen.has(parent)) return false;
      seen.add(parent);
      probe = parent;
    }

    let real: string;
    let realRoot: string;
    try {
      real = fs.realpathSync(probe);
      realRoot = fs.realpathSync(this.workspaceRoot);
    } catch {
      return false;
    }
    return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
  }

  /**
   * Serves one connection until it closes.
   *
   * Every request is answered, including the failures: a control plane
   * waiting on a reply that never comes is the failure mode that leaves a
   * task running and an agent locked.
   */
  closeConnections(): void {
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
  }

  handleConnection(socket: RunnerSocket): void {
    if (this.connections.size >= 128) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    const decoder = new LineDecoder();
    let greeted = false;
    const handshakeTimeout = setTimeout(() => socket.destroy(), 15_000);
    handshakeTimeout.unref();
    const running = new Map<string, RunningJob>();

    const send = (message: ServerMessage): void => {
      try {
        socket.write(encodeMessage(message));
      } catch {
        // The peer went away mid-write. Nothing useful left to do on this
        // connection; the run's own abort below cleans up.
      }
    };

    const fail = (id: string, message: string): void =>
      send({ v: RUNNER_PROTOCOL_VERSION, kind: "error", id, message });

    socket.on("close", () => {
      clearTimeout(handshakeTimeout);
      this.connections.delete(socket);
      // A dropped connection cancels whatever it started. A CLI process left
      // running for a control plane that is no longer listening spends money
      // and holds a workspace for nothing.
      for (const job of running.values()) {
        job.controller.abort();
        void job.runtime.cancelRun(job.runId).catch(() => log.warn("runtime cancellation failed"));
      }
      running.clear();
    });
    socket.on("error", (err) => log.warn({ err: err.message }, "runner connection error"));

    socket.on("data", (chunk) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        fail("", err instanceof Error ? err.message : String(err));
        socket.destroy();
        return;
      }

      for (const line of lines) {
        let message: ClientMessage;
        try {
          message = decodeClientMessage(line);
        } catch (err) {
          fail("", err instanceof Error ? err.message : String(err));
          socket.destroy();
          return;
        }

        if (!greeted) {
          if (message.kind !== "hello" || !tokensMatch(this.token, message.token ?? "")) {
            fail("", "Nicht authentifiziert.");
            socket.destroy();
            return;
          }
          greeted = true;
          clearTimeout(handshakeTimeout);
          send({ v: RUNNER_PROTOCOL_VERSION, kind: "hello-ok", runtimes: this.runtimeTypes });
          continue;
        }

        void this.dispatch(message, send, fail, running);
      }
    });
  }

  /**
   * The MCP half of the protocol.
   *
   * Separate from the runtime half because these messages carry no
   * `runtimeType`: an MCP server is not a runtime, and forcing one in to
   * reuse the lookup would mean inventing a fake value on both sides.
   */
  private async dispatchMcp(
    message: Extract<ClientMessage, { kind: "mcp-connect" | "mcp-call" | "mcp-disconnect" }>,
    send: (m: ServerMessage) => void,
    fail: (id: string, message: string) => void,
  ): Promise<void> {
    if (!this.mcp) {
      fail(message.id, "Dieser Runner betreibt keine MCP-Server.");
      return;
    }

    try {
      if (message.kind === "mcp-connect") {
        const tools = await this.mcp.connect(message.config);
        send({ v: RUNNER_PROTOCOL_VERSION, kind: "result", id: message.id, value: { tools } });
        return;
      }
      if (message.kind === "mcp-call") {
        const result = await this.mcp.call(message.server, message.tool, message.input ?? {});
        send({ v: RUNNER_PROTOCOL_VERSION, kind: "result", id: message.id, value: result });
        return;
      }
      await this.mcp.disconnect(message.server);
      send({ v: RUNNER_PROTOCOL_VERSION, kind: "result", id: message.id, value: null });
    } catch (err) {
      // The message may name a vault item and a key, which is exactly what an
      // operator needs to fix it — and, by mcp-secrets.ts's rule, never a
      // value.
      fail(message.id, err instanceof Error ? err.message : String(err));
    }
  }

  private waitForUsage(job: RunningJob, eventId: string, seq: number): Promise<"ack" | "aborted" | "timeout"> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: "ack" | "aborted" | "timeout") => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        job.controller.signal.removeEventListener("abort", onAbort);
        job.awaitingUsage = undefined;
        resolve(result);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), this.usageAckTimeoutMs);
      timer.unref();
      job.awaitingUsage = { eventId, seq, ack: () => finish("ack") };
      job.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (job.controller.signal.aborted) onAbort();
    });
  }

  private async dispatch(
    message: ClientMessage,
    send: (m: ServerMessage) => void,
    fail: (id: string, message: string) => void,
    running: Map<string, RunningJob>,
  ): Promise<void> {
    if (message.kind === "hello") return;

    if (message.kind === "usage-ack") {
      const job = running.get(message.id);
      if (
        job &&
        job.runId === message.runId &&
        job.companyId === message.companyId &&
        job.taskId === message.taskId &&
        job.awaitingUsage?.eventId === message.eventId &&
        job.awaitingUsage.seq === message.seq
      ) {
        job.awaitingUsage.ack();
      }
      return;
    }

    if (message.kind === "cancel") {
      const job = running.get(message.id);
      if (job && job.runId === message.runId) {
        job.controller.abort();
        await job.runtime.cancelRun(job.runId).catch(() => log.warn("runtime cancellation failed"));
      }
      return;
    }

    if (message.kind === "mcp-connect" || message.kind === "mcp-call" || message.kind === "mcp-disconnect") {
      await this.dispatchMcp(message, send, fail);
      return;
    }

    const runtime = this.runtimes.get(message.runtimeType);
    if (!runtime) {
      fail(message.id, `Dieser Runner kennt die Laufzeit "${message.runtimeType}" nicht.`);
      return;
    }

    try {
      if (message.kind === "capabilities") {
        send({ v: RUNNER_PROTOCOL_VERSION, kind: "result", id: message.id, value: await runtime.capabilities() });
        return;
      }
      if (message.kind === "health") {
        send({ v: RUNNER_PROTOCOL_VERSION, kind: "result", id: message.id, value: await runtime.healthCheck() });
        return;
      }
      if (message.kind === "auth") {
        const status = await runtime.authStatus();
        // Belt and braces on the one rule this daemon exists for: the
        // contract says AuthStatus carries no token, and this is where a
        // future field that did would leave the trust domain.
        send({
          v: RUNNER_PROTOCOL_VERSION,
          kind: "result",
          id: message.id,
          value: {
            authenticated: status.authenticated,
            ...(status.verification ? { verification: status.verification } : {}),
            method: status.method,
            detail: status.detail,
            ...(status.accountHint ? { accountHint: status.accountHint } : {}),
            ...(status.setupHint ? { setupHint: status.setupHint } : {}),
          },
        });
        return;
      }

      if (message.kind === "start" || message.kind === "resume") {
        const capabilities = await runtime.capabilities();
        if (
          (message.context.workspacePath !== "" || capabilities.workspaceRequired !== false) &&
          !this.allowsWorkspace(message.context.workspacePath)
        ) {
          fail(message.id, `Arbeitsordner "${message.context.workspacePath}" liegt außerhalb dieses Runners.`);
          return;
        }

        const elevationWindow =
          message.context.permissionMode === "elevated" ? (message.context.sandboxExpiresAt ?? 0) - Date.now() : null;
        if (
          elevationWindow !== null &&
          (!message.context.sandboxGrantId ||
            elevationWindow <= 0 ||
            elevationWindow > MAX_SANDBOX_GRANT_MS ||
            !(SANDBOX_PROVIDERS as readonly string[]).includes(runtime.type))
        ) {
          fail(message.id, "Sandbox-Freigabe fehlt, ist abgelaufen oder gilt nicht für diese Laufzeit.");
          return;
        }

        const taskKey = JSON.stringify([message.context.companyId, message.context.taskId]);
        if (running.has(message.id) || this.activeTasks.has(taskKey)) {
          fail(message.id, "Diese Aufgabe wird bereits auf diesem Runner ausgeführt.");
          return;
        }
        const controller = new AbortController();
        const job: RunningJob = {
          controller,
          runId: message.context.runId,
          runtime,
          companyId: message.context.companyId,
          taskId: message.context.taskId,
        };
        running.set(message.id, job);
        this.activeTasks.add(taskKey);
        // This deadline is local to the native runner, independent of the
        // control plane's timers or a delayed cancellation frame.
        const sandboxTimer =
          elevationWindow === null
            ? undefined
            : setTimeout(() => {
                controller.abort(new Error("Sandbox-Zeitfenster abgelaufen."));
                void runtime.cancelRun(message.context.runId).catch(() => log.warn("runtime cancellation failed"));
              }, elevationWindow);
        try {
          const context: RunContext = { ...message.context, signal: controller.signal };
          const sessionRef = message.kind === "resume" ? message.sessionRef : message.input.sessionRef;
          if (sessionRef && (!runtime.resumeRun || !capabilities.sessionResume)) {
            fail(message.id, "Diese Laufzeit unterstützt keine Sitzungsfortsetzung.");
            return;
          }
          const events = sessionRef
            ? runtime.resumeRun!(sessionRef, message.input, context)
            : runtime.startRun(message.input, context);
          for await (const raw of events) {
            const parsed = runEventSchema.safeParse(raw);
            if (!parsed.success) throw new Error("Runtime emitted an invalid normalized event.");
            const event = parsed.data;
            if (
              event.companyId !== context.companyId ||
              event.taskId !== context.taskId ||
              event.runId !== context.runId ||
              event.projectId !== context.projectId ||
              event.agentId !== context.agentId ||
              event.correlationId !== context.correlationId
            ) {
              throw new Error("Runtime emitted an event outside its assigned task.");
            }
            const payload = redactValue(event.payload, context.redactValues);
            const changed = JSON.stringify(payload) !== JSON.stringify(event.payload);
            // Install the waiter before sending: even an immediate ACK must
            // not race ahead of its barrier. Do not request the next runtime
            // event (which can initiate a paid round) until ingestion is ACKed.
            const acknowledgement =
              event.type === "usage.updated" ? this.waitForUsage(job, event.eventId, event.seq) : null;
            send({
              v: RUNNER_PROTOCOL_VERSION,
              kind: "event",
              id: message.id,
              event: {
                ...event,
                payload,
                redaction: {
                  redacted: event.redaction.redacted || changed,
                  rules: [...event.redaction.rules, ...(changed ? ["runner_boundary"] : [])],
                },
              },
            });
            if (acknowledgement) {
              const result = await acknowledgement;
              if (result !== "ack") {
                controller.abort();
                await runtime.cancelRun(context.runId).catch(() => log.warn("runtime cancellation failed"));
                if (result === "timeout")
                  throw new Error("Control plane did not acknowledge usage before the deadline; run stopped.");
                send({
                  v: RUNNER_PROTOCOL_VERSION,
                  kind: "event",
                  id: message.id,
                  event: {
                    ...event,
                    eventId: newId("evt"),
                    seq: event.seq + 1,
                    type: "run.cancelled",
                    payload: {
                      reason:
                        controller.signal.reason instanceof Error
                          ? controller.signal.reason.message
                          : "Control plane cancelled before permitting the next round.",
                    },
                  },
                });
                send({ v: RUNNER_PROTOCOL_VERSION, kind: "end", id: message.id });
                return;
              }
            }
          }
          send({ v: RUNNER_PROTOCOL_VERSION, kind: "end", id: message.id });
        } catch (err) {
          fail(message.id, redact(err instanceof Error ? err.message : String(err), message.context.redactValues).text);
        } finally {
          if (sandboxTimer) clearTimeout(sandboxTimer);
          this.activeTasks.delete(taskKey);
          running.delete(message.id);
        }
      }
    } catch (err) {
      // Every request is answered, including this one: a control plane
      // waiting on a reply that never comes leaves a task running and an
      // agent locked until a lease expires.
      fail(message.id, err instanceof Error ? err.message : String(err));
    }
  }
}
