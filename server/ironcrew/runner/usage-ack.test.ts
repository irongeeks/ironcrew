import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerServer } from "./runner-server.ts";
import { RunnerRuntime } from "./runner-client.ts";
import { socketPair } from "./__fixtures__/socket-pair.ts";
import { encodeMessage, RUNNER_PROTOCOL_VERSION } from "./protocol.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import type { RunContext, RunInput, RunEvent } from "../runtime/run-events.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-usage-"));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

class MeteredRuntime extends StubRuntime {
  paidRounds = 0;
  constructor() {
    super("metered");
  }
  async *startRun(_input: RunInput, ctx: RunContext) {
    yield stubEvent(ctx, "run.started");
    this.paidRounds++;
    yield stubEvent(ctx, "usage.updated", { costMicros: 1000 }, 1);
    this.paidRounds++;
    yield stubEvent(ctx, "usage.updated", { costMicros: 1000 }, 2);
    yield stubEvent(ctx, "run.completed", {}, 3);
  }
}
function setup() {
  const runtime = new MeteredRuntime();
  const server = new RunnerServer({
    runtimes: [runtime],
    token: "transport-token",
    workspaceRoot: root,
    usageAckTimeoutMs: 100,
  });
  let pair: ReturnType<typeof socketPair>;
  const client = new RunnerRuntime({
    runtimeType: runtime.type,
    token: "transport-token",
    connect: async () => {
      pair = socketPair();
      server.handleConnection(pair.server);
      return pair.client;
    },
  });
  const context: RunContext = {
    companyId: "company",
    projectId: null,
    taskId: "task",
    runId: "run",
    agentId: "agent",
    correlationId: "corr",
    workspacePath: "",
    permissionMode: "restricted",
  };
  return { runtime, server, client, context, pair: () => pair! };
}
async function collect(stream: AsyncIterable<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("usage ingestion acknowledgement", () => {
  it("blocks the next paid round until the consumer finishes ingesting usage", async () => {
    const test = setup();
    const iterator = test.client.startRun({ prompt: "Run" }, test.context)[Symbol.asyncIterator]();
    await iterator.next();
    const usage = await iterator.next();
    expect(usage.value.type).toBe("usage.updated");
    expect(test.runtime.paidRounds).toBe(1);
    const second = await iterator.next();
    expect(second.value.type).toBe("usage.updated");
    expect(test.runtime.paidRounds).toBe(2);
    expect((await iterator.next()).value.type).toBe("run.completed");
    expect((await iterator.next()).done).toBe(true);
    const ack = test
      .pair()
      .traffic.map((line) => JSON.parse(line))
      .filter((frame) => frame.kind === "usage-ack");
    expect(ack).toHaveLength(2);
    expect(ack[0]).toMatchObject({
      companyId: "company",
      taskId: "task",
      runId: "run",
      eventId: usage.value.eventId,
      seq: 1,
    });
  });

  it("never ACKs after a consumer aborts at the budget boundary", async () => {
    const test = setup();
    const abort = new AbortController();
    const events: RunEvent[] = [];
    for await (const event of test.client.startRun({ prompt: "Run" }, { ...test.context, signal: abort.signal })) {
      events.push(event);
      if (event.type === "usage.updated") abort.abort(new Error("budget hard stop"));
    }
    expect(test.runtime.paidRounds).toBe(1);
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(test.pair().traffic.some((line) => JSON.parse(line).kind === "usage-ack")).toBe(false);
  });

  it("enforces the real persisted CompanyOrchestrator budget before native continuation", async () => {
    const test = setup();
    const db = createTestDb();
    try {
      const company = new CompanyOrchestrator(db);
      company.registerRuntime(test.client);
      const companyId = company.seedCompany({ name: "Budget test", slug: "budget-test" });
      const cto = company.getAgent(companyId, "cto")!;
      const task = company.tasks.create({
        companyId,
        title: "Metered native task",
        status: "ready",
        assignedAgentId: cto.id,
      });
      company.budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1000 });
      const result = await company.executeNextTask(companyId, { runtimeType: "metered" });
      expect(result?.task.status).toBe("failed");
      expect(company.runs.listForTask(task.id)[0].cost_micros).toBe(1000);
      expect(test.runtime.paidRounds).toBe(1);
      expect(test.pair().traffic.some((line) => JSON.parse(line).kind === "usage-ack")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("does not accept an acknowledgement for a different company or event", async () => {
    const test = setup();
    const iterator = test.client.startRun({ prompt: "Run" }, test.context)[Symbol.asyncIterator]();
    await iterator.next();
    const usage = (await iterator.next()).value as RunEvent;
    const start = test
      .pair()
      .traffic.map((line) => JSON.parse(line))
      .find((frame) => frame.kind === "start");
    for (const override of [
      { companyId: "other-company" },
      { eventId: "wrong-event" },
      { seq: 999 },
      { taskId: "other-task" },
    ]) {
      test.pair().client.write(
        encodeMessage({
          v: RUNNER_PROTOCOL_VERSION,
          kind: "usage-ack",
          id: start.id,
          companyId: "company",
          taskId: "task",
          runId: "run",
          eventId: usage.eventId,
          seq: usage.seq,
          ...override,
        }),
      );
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(test.runtime.paidRounds).toBe(1);
    await iterator.return?.();
  });

  it("expires a missing acknowledgement without starting another round", async () => {
    vi.useFakeTimers();
    const test = setup();
    const iterator = test.client.startRun({ prompt: "Run" }, test.context)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await vi.advanceTimersByTimeAsync(100);
    const failure = await iterator.next();
    expect(failure.value.type).toBe("run.failed");
    expect(failure.value.payload.message).toMatch(/acknowledge usage/);
    expect(test.runtime.paidRounds).toBe(1);
    await iterator.return?.();
  });

  it("releases the usage waiter when the connection disappears", async () => {
    const test = setup();
    const iterator = test.client.startRun({ prompt: "Run" }, test.context)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    test.pair().dropClient();
    expect((await iterator.next()).value.type).toBe("run.failed");
    expect((await iterator.next()).done).toBe(true);
    expect(test.runtime.paidRounds).toBe(1);
    // The task lease is released too: a fresh connection can run it again.
    expect((await collect(test.client.startRun({ prompt: "Retry" }, test.context))).at(-1)?.type).toBe("run.completed");
  });
});
