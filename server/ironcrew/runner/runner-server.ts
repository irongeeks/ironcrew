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

import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../observability/logger.ts";
import {
  decodeMessage,
  encodeMessage,
  LineDecoder,
  RUNNER_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.ts";
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
}

/** Constant-time token comparison — a wrong guess must not leak its length. */
function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(given, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class RunnerServer {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly token: string;
  private readonly workspaceRoot: string;
  private readonly mcp: McpHost | undefined;

  constructor(opts: RunnerServerOptions) {
    for (const runtime of opts.runtimes) this.runtimes.set(runtime.type, runtime);
    this.token = opts.token;
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.mcp = opts.mcp;
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
  handleConnection(socket: RunnerSocket): void {
    const decoder = new LineDecoder();
    let greeted = false;
    const running = new Map<string, AbortController>();

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
      // A dropped connection cancels whatever it started. A CLI process left
      // running for a control plane that is no longer listening spends money
      // and holds a workspace for nothing.
      for (const controller of running.values()) controller.abort();
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
          message = decodeMessage(line) as ClientMessage;
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

  private async dispatch(
    message: ClientMessage,
    send: (m: ServerMessage) => void,
    fail: (id: string, message: string) => void,
    running: Map<string, AbortController>,
  ): Promise<void> {
    if (message.kind === "hello") return;

    if (message.kind === "cancel") {
      running.get(message.id)?.abort();
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
            method: status.method,
            detail: status.detail,
            ...(status.accountHint ? { accountHint: status.accountHint } : {}),
            ...(status.setupHint ? { setupHint: status.setupHint } : {}),
          },
        });
        return;
      }

      if (message.kind === "start") {
        if (!this.allowsWorkspace(message.context.workspacePath)) {
          fail(message.id, `Arbeitsordner "${message.context.workspacePath}" liegt außerhalb dieses Runners.`);
          return;
        }

        const controller = new AbortController();
        running.set(message.id, controller);
        try {
          const context: RunContext = { ...message.context, signal: controller.signal };
          for await (const event of runtime.startRun(message.input, context)) {
            send({ v: RUNNER_PROTOCOL_VERSION, kind: "event", id: message.id, event });
          }
          send({ v: RUNNER_PROTOCOL_VERSION, kind: "end", id: message.id });
        } finally {
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
