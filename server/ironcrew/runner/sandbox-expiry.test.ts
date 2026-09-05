import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { RunnerServer } from "./runner-server.ts";
import { RunnerRuntime } from "./runner-client.ts";
import { socketPair } from "./__fixtures__/socket-pair.ts";
import { decodeClientMessage, toWireContext, RUNNER_PROTOCOL_VERSION } from "./protocol.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput, RunEvent } from "../runtime/run-events.ts";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-sandbox-"));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
class WaitingRuntime extends StubRuntime {
  seen: RunContext | null = null;
  cancelled = vi.fn(async (_runId: string) => {});
  constructor() {
    super("codex");
  }
  override async *startRun(_input: RunInput, context: RunContext) {
    this.seen = context;
    yield stubEvent(context, "run.started");
    await new Promise<void>((resolve) => {
      if (context.signal?.aborted) resolve();
      else context.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield stubEvent(context, "run.cancelled", { reason: "sandbox deadline" }, 1);
  }
  override cancelRun(runId: string) {
    return this.cancelled(runId);
  }
}
function setup() {
  const runtime = new WaitingRuntime();
  const server = new RunnerServer({ runtimes: [runtime], token: "test-token", workspaceRoot: root });
  const pair = socketPair();
  server.handleConnection(pair.server);
  const client = new RunnerRuntime({
    runtimeType: "codex",
    token: "test-token",
    connect: async () => pair.client,
    idleTimeoutMs: 120000,
  });
  const context: RunContext = {
    companyId: "company",
    taskId: "task",
    agentId: "agent",
    projectId: "project",
    runId: "run",
    correlationId: "corr",
    workspacePath: root,
    permissionMode: "elevated",
    sandboxGrantId: "grant",
    sandboxExpiresAt: Date.now() + 60000,
  };
  return { runtime, server, pair, client, context };
}
async function collect(stream: AsyncIterable<RunEvent>) {
  const events: RunEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
describe("native sandbox expiry enforcement", () => {
  it("carries the exact grant identity and independently aborts on deadline without a control-plane cancel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const test = setup();
    const iterator = test.client.startRun({ prompt: "Sandbox run" }, test.context)[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("run.started");
    expect(test.runtime.seen).toMatchObject({
      permissionMode: "elevated",
      sandboxGrantId: "grant",
      sandboxExpiresAt: test.context.sandboxExpiresAt,
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(test.runtime.seen?.signal?.aborted).toBe(true);
    expect(test.runtime.cancelled).toHaveBeenCalledWith("run");
    expect((await iterator.next()).value.type).toBe("run.cancelled");
    expect((await iterator.next()).done).toBe(true);
    expect(test.pair.traffic.map((line) => JSON.parse(line)).filter((frame) => frame.kind === "cancel")).toHaveLength(
      0,
    );
    test.server.closeConnections();
  });
  it.each([-1, 4 * 60 * 60 * 1000 + 60000])(
    "rejects an expired or overlong deadline before runtime start (%s)",
    async (offset) => {
      const test = setup();
      const events = await collect(
        test.client.startRun({ prompt: "Run" }, { ...test.context, sandboxExpiresAt: Date.now() + offset }),
      );
      expect(events.at(-1)?.type).toBe("run.failed");
      expect(test.runtime.seen).toBeNull();
      test.server.closeConnections();
    },
  );
  it("rejects an elevated wire request without proof fields while preserving restricted compatibility", () => {
    const { context, server } = setup();
    const wire = toWireContext(context);
    expect(wire).toMatchObject({ sandboxGrantId: "grant", sandboxExpiresAt: context.sandboxExpiresAt });
    const request = {
      v: RUNNER_PROTOCOL_VERSION,
      kind: "start",
      id: "request",
      runtimeType: "codex",
      input: { prompt: "Test" },
      context: { ...wire, sandboxGrantId: undefined },
    };
    expect(() => decodeClientMessage(JSON.stringify(request))).toThrow(/shape/);
    expect(() =>
      decodeClientMessage(
        JSON.stringify({
          ...request,
          context: { ...request.context, permissionMode: "restricted", sandboxExpiresAt: undefined },
        }),
      ),
    ).not.toThrow();
    server.closeConnections();
  });
});
