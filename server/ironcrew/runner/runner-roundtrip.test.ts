/**
 * Both halves of the runner, wired to each other through a fake socket pair.
 *
 * No filesystem, no ports — the transport is the only thing faked, so
 * everything under test is the code that will run in production. The
 * properties that matter are the unhappy ones: a run must always end, a
 * dropped connection must cancel what it started, and a job must never touch
 * a workspace outside the runner's root.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerServer, type RunnerSocket } from "./runner-server.ts";
import { RunnerRuntime, RunnerUnavailableError, type RunnerConnection } from "./runner-client.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunEvent, RunInput } from "../runtime/run-events.ts";

const TOKEN = "runner-token-geheim";
let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-runner-"));
});

afterEach(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

/**
 * A pair of ends that write into each other, standing in for a socket.
 * Delivery is deferred by a microtask, so ordering matches a real stream.
 */
function socketPair(): { client: RunnerConnection; server: RunnerSocket; dropClient(): void } {
  type Listener = (arg: never) => void;
  const listeners = { client: new Map<string, Listener[]>(), server: new Map<string, Listener[]>() };
  let open = true;

  const emit = (side: "client" | "server", event: string, arg?: unknown) => {
    for (const listener of listeners[side].get(event) ?? []) (listener as (a: unknown) => void)(arg);
  };
  const on = (side: "client" | "server") => (event: string, listener: Listener) => {
    const bucket = listeners[side].get(event) ?? [];
    bucket.push(listener);
    listeners[side].set(event, bucket);
  };
  const close = () => {
    if (!open) return;
    open = false;
    queueMicrotask(() => {
      emit("client", "close");
      emit("server", "close");
    });
  };

  return {
    client: {
      write: (data) => open && queueMicrotask(() => emit("server", "data", data)),
      on: on("client") as RunnerConnection["on"],
      destroy: close,
    },
    server: {
      write: (data) => open && queueMicrotask(() => emit("client", "data", data)),
      on: on("server") as RunnerSocket["on"],
      destroy: close,
    },
    dropClient: close,
  };
}

class ScriptedRuntime extends StubRuntime {
  constructor(
    type: string,
    private readonly behaviour: "complete" | "fail" | "hang" | "no-terminal" = "complete",
  ) {
    super(type);
  }

  async *startRun(_input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    yield stubEvent(context, "run.started");

    if (this.behaviour === "fail") {
      throw new Error("Runtime kaputt.");
    }
    if (this.behaviour === "no-terminal") {
      yield stubEvent(context, "message.completed", { text: "halb fertig" }, 1);
      return;
    }
    if (this.behaviour === "hang") {
      await new Promise<void>((resolve) => {
        if (context.signal?.aborted) return resolve();
        context.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield stubEvent(context, "run.cancelled", { reason: "abgebrochen" }, 1);
      return;
    }

    yield stubEvent(context, "message.completed", { text: "Fertig." }, 1);
    yield stubEvent(context, "run.completed", {}, 2);
  }
}

/**
 * A client whose `connect()` makes a fresh pair each time, as the real one
 * does — RunnerRuntime opens a connection per request and closes it after, so
 * a helper that reused one pair would test a client that does not exist.
 */
function connected(runtimes: ScriptedRuntime[], over: Record<string, unknown> = {}) {
  const server = new RunnerServer({ runtimes, token: TOKEN, workspaceRoot });
  let latest: ReturnType<typeof socketPair> | null = null;

  const client = new RunnerRuntime({
    runtimeType: runtimes[0]?.type ?? "claude",
    token: TOKEN,
    connect: async () => {
      const pair = socketPair();
      latest = pair;
      server.handleConnection(pair.server);
      return pair.client;
    },
    requestTimeoutMs: 2000,
    idleTimeoutMs: 2000,
    ...over,
  });

  return { client, server, dropConnection: () => latest?.dropClient() };
}

function context(over: Partial<RunContext> = {}): RunContext {
  return {
    companyId: "cmp_1",
    projectId: null,
    taskId: "task_1",
    runId: "run_1",
    agentId: "agt_1",
    correlationId: "corr_1",
    workspacePath: path.join(workspaceRoot, "job"),
    permissionMode: "restricted",
    ...over,
  };
}

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("a job crosses the boundary and comes back", () => {
  it("streams the runner's events to the control plane", async () => {
    const { client } = connected([new ScriptedRuntime("claude")]);
    const events = await collect(client.startRun({ prompt: "Hallo" }, context()));

    expect(events.map((e) => e.type)).toEqual(["run.started", "message.completed", "run.completed"]);
    expect(events[1].payload.text).toBe("Fertig.");
  });

  it("carries every field an event needs to be auditable", async () => {
    const { client } = connected([new ScriptedRuntime("claude")]);
    const [first] = await collect(client.startRun({ prompt: "x" }, context()));

    expect(first).toMatchObject({ companyId: "cmp_1", taskId: "task_1", runId: "run_1", correlationId: "corr_1" });
  });

  it("answers the three status probes", async () => {
    const { client } = connected([new ScriptedRuntime("claude")]);

    expect((await client.capabilities()).streaming).toBeTypeOf("boolean");
    expect((await client.healthCheck()).healthy).toBe(true);
    expect((await client.authStatus()).method).toBeTruthy();
  });
});

describe("a run always ends", () => {
  it("fails cleanly when the runner cannot be reached at all", async () => {
    const client = new RunnerRuntime({
      runtimeType: "claude",
      token: TOKEN,
      connect: async () => {
        throw new Error("ENOENT /run/ironcrew/runner.sock");
      },
    });

    const events = await collect(client.startRun({ prompt: "x" }, context()));
    // A generator that merely stopped would leave the orchestrator's
    // `for await` waiting, the task running and the agent locked.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.failed");
    expect(String(events[0].payload.message)).toContain("ENOENT");
  });

  it("fails when the connection drops mid-run", async () => {
    const { client, dropConnection } = connected([new ScriptedRuntime("claude", "hang")]);

    const events: RunEvent[] = [];
    const iterator = client.startRun({ prompt: "x" }, context())[Symbol.asyncIterator]();
    const first = await iterator.next();
    events.push(first.value as RunEvent);

    dropConnection();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(events.at(-1)!.type).toBe("run.failed");
    expect(String(events.at(-1)!.payload.message)).toMatch(/Verbindung/);
  });

  it("fails when the runtime throws on the runner side", async () => {
    const { client } = connected([new ScriptedRuntime("claude", "fail")]);
    const events = await collect(client.startRun({ prompt: "x" }, context()));

    expect(events.at(-1)!.type).toBe("run.failed");
    expect(String(events.at(-1)!.payload.message)).toContain("Runtime kaputt");
  });

  it("fails when the runner ends without a terminal event", async () => {
    const { client } = connected([new ScriptedRuntime("claude", "no-terminal")]);
    const events = await collect(client.startRun({ prompt: "x" }, context()));

    // A runner with that bug still must not hang the control plane.
    expect(events.at(-1)!.type).toBe("run.failed");
    expect(String(events.at(-1)!.payload.message)).toMatch(/ohne Abschluss/);
  });

  it("marks locally minted events so they cannot collide with the runner's sequence", async () => {
    const client = new RunnerRuntime({
      runtimeType: "claude",
      token: TOKEN,
      connect: async () => {
        throw new Error("weg");
      },
    });
    const [event] = await collect(client.startRun({ prompt: "x" }, context()));
    expect(event.seq).toBe(-1);
  });
});

describe("cancellation crosses the wire", () => {
  it("aborts the run on the runner when the caller aborts", async () => {
    const { client } = connected([new ScriptedRuntime("claude", "hang")]);
    const abort = new AbortController();

    const iterator = client.startRun({ prompt: "x" }, context({ signal: abort.signal }))[Symbol.asyncIterator]();
    await iterator.next();
    abort.abort();

    const events: RunEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.some((e) => e.type === "run.cancelled")).toBe(true);
  });

  it("does not send a job that was already cancelled", async () => {
    const { client } = connected([new ScriptedRuntime("claude")]);
    await client.cancelRun("run_1");

    const events = await collect(client.startRun({ prompt: "x" }, context()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.cancelled");
  });

  it("a dropped connection cancels what it started", async () => {
    const runtime = new ScriptedRuntime("claude", "hang");
    const aborted = vi.fn();
    const pair = socketPair();
    const server = new RunnerServer({ runtimes: [runtime], token: TOKEN, workspaceRoot });
    server.handleConnection(pair.server);

    const client = new RunnerRuntime({
      runtimeType: "claude",
      token: TOKEN,
      connect: async () => pair.client,
      requestTimeoutMs: 2000,
      idleTimeoutMs: 2000,
    });

    const iterator = client.startRun({ prompt: "x" }, context())[Symbol.asyncIterator]();
    await iterator.next();
    pair.dropClient();
    await new Promise((r) => setTimeout(r, 20));

    // A CLI process left running for a control plane that is no longer
    // listening spends money and holds a workspace for nothing.
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
    }
    expect(aborted).not.toHaveBeenCalled();
  });
});

describe("the runner refuses what it should", () => {
  it("rejects a wrong token", async () => {
    const pair = socketPair();
    new RunnerServer({ runtimes: [new ScriptedRuntime("claude")], token: TOKEN, workspaceRoot }).handleConnection(
      pair.server,
    );
    const client = new RunnerRuntime({
      runtimeType: "claude",
      token: "falsch",
      connect: async () => pair.client,
      requestTimeoutMs: 1000,
    });

    await expect(client.capabilities()).rejects.toBeInstanceOf(RunnerUnavailableError);
  });

  it("says so when it does not have the runtime, rather than failing inside a run", async () => {
    const pair = socketPair();
    new RunnerServer({ runtimes: [new ScriptedRuntime("codex")], token: TOKEN, workspaceRoot }).handleConnection(
      pair.server,
    );
    const client = new RunnerRuntime({
      runtimeType: "claude",
      token: TOKEN,
      connect: async () => pair.client,
      requestTimeoutMs: 1000,
    });

    await expect(client.capabilities()).rejects.toThrow(/kennt die Laufzeit/);
  });

  it("refuses a workspace outside its root", async () => {
    const { client } = connected([new ScriptedRuntime("claude")]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-outside-"));
    try {
      const events = await collect(client.startRun({ prompt: "x" }, context({ workspacePath: outside })));
      expect(events.at(-1)!.type).toBe("run.failed");
      expect(String(events.at(-1)!.payload.message)).toMatch(/außerhalb/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a workspace that escapes through a symlink", () => {
    const server = new RunnerServer({ runtimes: [], token: TOKEN, workspaceRoot });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-outside-"));
    try {
      fs.symlinkSync(outside, path.join(workspaceRoot, "link"));
      // A string prefix check passes this; only resolving the real path does
      // not — and this is the account that holds the CLI logins.
      expect(server.allowsWorkspace(path.join(workspaceRoot, "link", "job"))).toBe(false);
      expect(server.allowsWorkspace(path.join(workspaceRoot, "job"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a relative path outright", () => {
    const server = new RunnerServer({ runtimes: [], token: TOKEN, workspaceRoot });
    expect(server.allowsWorkspace("relativ/job")).toBe(false);
    expect(server.allowsWorkspace("")).toBe(false);
  });
});

describe("status probes report rather than throw", () => {
  it("reports an unreachable runner as unhealthy", async () => {
    const client = new RunnerRuntime({
      runtimeType: "claude",
      token: TOKEN,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    // A probe answers the question "does this work?"; throwing would make the
    // Settings page an outage instead of an answer.
    expect(await client.healthCheck()).toMatchObject({ healthy: false });
    expect((await client.authStatus()).setupHint).toContain("IRONCREW_RUNNER_SOCKET");
  });
});
