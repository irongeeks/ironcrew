import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RunnerDaemon } from "./runner-daemon.ts";
import { RunnerRuntime } from "./runner-client.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunEvent, RunInput } from "../runtime/run-events.ts";

let dir: string;
let socketPath: string;
let workspaceRoot: string;
const TOKEN = "geheim";

class EchoRuntime extends StubRuntime {
  constructor() {
    super("claude");
  }
  async *startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    yield stubEvent(context, "run.started");
    yield stubEvent(context, "message.completed", { text: `echo: ${input.prompt}` }, 1);
    yield stubEvent(context, "run.completed", {}, 2);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-daemon-"));
  socketPath = path.join(dir, "runner.sock");
  workspaceRoot = path.join(dir, "workspaces");
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function daemon() {
  return new RunnerDaemon({ socketPath, token: TOKEN, workspaceRoot, runtimes: [new EchoRuntime()] });
}

function client() {
  return new RunnerRuntime({
    runtimeType: "claude",
    token: TOKEN,
    connect: async () =>
      await new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.setEncoding("utf-8");
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      }),
    requestTimeoutMs: 3000,
    idleTimeoutMs: 3000,
  });
}

describe("over a real Unix socket", () => {
  it("runs a job end to end", async () => {
    const d = daemon();
    await d.listen();
    try {
      const events: RunEvent[] = [];
      for await (const event of client().startRun(
        { prompt: "Hallo" },
        {
          companyId: "cmp_1",
          projectId: null,
          taskId: "task_1",
          runId: "run_1",
          agentId: null,
          correlationId: "corr_1",
          workspacePath: path.join(workspaceRoot, "job"),
          permissionMode: "restricted",
        },
      )) {
        events.push(event);
      }

      expect(events.map((e) => e.type)).toEqual(["run.started", "message.completed", "run.completed"]);
      expect(events[1].payload.text).toBe("echo: Hallo");
    } finally {
      await d.close();
    }
  });

  it("creates the socket owner- and group-only, never world", async () => {
    const d = daemon();
    await d.listen();
    try {
      const mode = fs.statSync(socketPath).mode & 0o777;
      // The filesystem is the access control; a world-reachable socket would
      // make this daemon decorative.
      expect(mode & 0o007).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("removes the socket when it stops", async () => {
    const d = daemon();
    await d.listen();
    expect(fs.existsSync(socketPath)).toBe(true);
    await d.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("closing twice is safe", async () => {
    const d = daemon();
    await d.listen();
    await d.close();
    await expect(d.close()).resolves.toBeUndefined();
  });

  it("clears a stale socket left by an unclean shutdown", async () => {
    fs.writeFileSync(socketPath, "");
    const d = daemon();
    // A file existing proves nothing after a crash.
    await expect(d.listen()).resolves.toBeUndefined();
    await d.close();
  });

  it("refuses to steal a socket another daemon is serving", async () => {
    const first = daemon();
    await first.listen();
    try {
      // Removing a live socket would silently take over its traffic.
      await expect(daemon().listen()).rejects.toThrow(/already listening/);
    } finally {
      await first.close();
    }
  });
});
