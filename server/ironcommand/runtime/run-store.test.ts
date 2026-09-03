import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { TaskStore } from "../domain/task-store.ts";
import { RunStore } from "./run-store.ts";
import { MockRuntime } from "./mock-runtime.ts";
import {
  isTerminalRunEvent,
  runEventSchema,
  runStatusForEvent,
  RUN_EVENT_TYPES,
  type RunContext,
  type RunEvent,
} from "./run-events.ts";

let db: DatabaseSync;
let runs: RunStore;
let tasks: TaskStore;
let companyId: string;
let agentId: string;
let taskId: string;

beforeEach(() => {
  db = createTestDb();
  runs = new RunStore(db);
  tasks = new TaskStore(db);
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  taskId = tasks.create({ companyId, title: "test task", status: "ready" }).id;
});

afterEach(() => db.close());

function newRun() {
  return runs.create({ companyId, taskId, agentId, runtimeType: "mock", correlationId: "corr_1" });
}

describe("run event model", () => {
  it("covers every event type the master spec requires", () => {
    for (const t of [
      "run.started",
      "message.delta",
      "message.completed",
      "tool.requested",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "subagent.spawned",
      "subagent.completed",
      "approval.required",
      "usage.updated",
      "artifact.created",
      "rate_limit.detected",
      "run.waiting",
      "run.completed",
      "run.failed",
      "run.cancelled",
    ]) {
      expect(RUN_EVENT_TYPES).toContain(t);
    }
  });

  it("identifies terminal events", () => {
    expect(isTerminalRunEvent("run.completed")).toBe(true);
    expect(isTerminalRunEvent("run.failed")).toBe(true);
    expect(isTerminalRunEvent("run.cancelled")).toBe(true);
    expect(isTerminalRunEvent("message.delta")).toBe(false);
  });

  it("maps events to run statuses", () => {
    expect(runStatusForEvent("run.started")).toBe("running");
    expect(runStatusForEvent("rate_limit.detected")).toBe("rate_limited");
    expect(runStatusForEvent("message.delta")).toBeNull();
  });
});

describe("run persistence", () => {
  it("creates a queued run", () => {
    const run = newRun();
    expect(run.status).toBe("queued");
    expect(run.permission_mode).toBe("restricted");
    expect(run.next_event_seq).toBe(0);
  });

  it("assigns monotonic sequence numbers", () => {
    const run = newRun();
    const seqs = ["run.started", "message.delta", "message.delta", "run.completed"].map(
      (t) => runs.appendEvent({ companyId, runId: run.id, taskId, type: t as never }).seq,
    );
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  it("rejects events for an unknown run", () => {
    expect(() => runs.appendEvent({ companyId, runId: "run_nope", taskId, type: "run.started" })).toThrow(
      /unknown run/,
    );
  });

  it("derives run status from terminal events", () => {
    const run = newRun();
    runs.appendEvent({ companyId, runId: run.id, taskId, type: "run.started" });
    expect(runs.get(run.id)!.status).toBe("running");
    expect(runs.get(run.id)!.started_at).toBeGreaterThan(0);

    runs.appendEvent({ companyId, runId: run.id, taskId, type: "run.completed" });
    const done = runs.get(run.id)!;
    expect(done.status).toBe("completed");
    expect(done.ended_at).toBeGreaterThan(0);
  });

  it("records the failure message on run.failed", () => {
    const run = newRun();
    runs.appendEvent({
      companyId,
      runId: run.id,
      taskId,
      type: "run.failed",
      payload: { message: "boom" },
    });
    expect(runs.get(run.id)!.error_message).toBe("boom");
  });

  it("accumulates usage", () => {
    const run = newRun();
    runs.addUsage(run.id, 100, 50, 0);
    runs.addUsage(run.id, 20, 5, 0);
    const r = runs.get(run.id)!;
    expect(r.input_tokens).toBe(120);
    expect(r.output_tokens).toBe(55);
  });

  it("replays events after a sequence number", () => {
    const run = newRun();
    for (let i = 0; i < 5; i++) {
      runs.appendEvent({ companyId, runId: run.id, taskId, type: "message.delta", payload: { i } });
    }
    expect(runs.listEvents(run.id)).toHaveLength(5);
    expect(runs.listEvents(run.id, { afterSeq: 2 })).toHaveLength(2);
  });

  it("survives a restart: events persist and replay identically", () => {
    const run = newRun();
    runs.appendEvent({ companyId, runId: run.id, taskId, type: "run.started" });
    runs.appendEvent({ companyId, runId: run.id, taskId, type: "message.completed", payload: { text: "hi" } });
    runs.appendEvent({ companyId, runId: run.id, taskId, type: "run.completed" });

    // A fresh store over the same database is exactly what a restart looks like.
    const reopened = new RunStore(db);
    const replayed = reopened.listEvents(run.id);
    expect(replayed.map((e) => e.type)).toEqual(["run.started", "message.completed", "run.completed"]);
    expect(reopened.get(run.id)!.status).toBe("completed");
  });
});

describe("event redaction", () => {
  it("redacts secrets in payloads and flags the event", () => {
    const run = newRun();
    const ev = runs.appendEvent({
      companyId,
      runId: run.id,
      taskId,
      type: "tool.completed",
      payload: { output: "export ANTHROPIC_API_KEY=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH" },
    });
    expect(JSON.stringify(ev.payload)).not.toContain("sk-ant-api03");
    expect(ev.redaction.redacted).toBe(true);
    expect(ev.redaction.rules.length).toBeGreaterThan(0);
  });

  it("persists the redacted form, not the original", () => {
    const run = newRun();
    runs.appendEvent({
      companyId,
      runId: run.id,
      taskId,
      type: "tool.completed",
      payload: { output: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    });
    const stored = db.prepare("SELECT payload_json FROM ic_run_events").get() as { payload_json: string };
    expect(stored.payload_json).not.toContain("ghp_ABCDEFG");
  });

  it("does not flag ordinary payloads as redacted", () => {
    const run = newRun();
    const ev = runs.appendEvent({
      companyId,
      runId: run.id,
      taskId,
      type: "message.delta",
      payload: { text: "hallo welt" },
    });
    expect(ev.redaction.redacted).toBe(false);
  });

  it("redacts caller-supplied literal secret values", () => {
    const run = newRun();
    const ev = runs.appendEvent({
      companyId,
      runId: run.id,
      taskId,
      type: "tool.completed",
      payload: { output: "connecting with correct-horse-battery-staple" },
      redactValues: ["correct-horse-battery-staple"],
    });
    expect(JSON.stringify(ev.payload)).not.toContain("correct-horse");
  });
});

describe("stale run detection", () => {
  it("finds runs whose heartbeat has gone stale", () => {
    const run = newRun();
    runs.setStatus(run.id, "running");
    runs.heartbeat(run.id, Date.now() - 60_000);
    expect(runs.findStale(companyId, 30_000)).toHaveLength(1);
    runs.heartbeat(run.id, Date.now());
    expect(runs.findStale(companyId, 30_000)).toHaveLength(0);
  });

  it("ignores completed runs", () => {
    const run = newRun();
    runs.setStatus(run.id, "completed");
    runs.heartbeat(run.id, Date.now() - 600_000);
    expect(runs.findStale(companyId, 30_000)).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------

describe("MockRuntime", () => {
  const context = (): RunContext => ({
    companyId,
    projectId: null,
    taskId,
    runId: "run_mock_1",
    agentId,
    correlationId: "corr_x",
    workspacePath: "/tmp/ws",
    permissionMode: "restricted" as const,
  });

  async function collect(rt: MockRuntime, ctx = context()): Promise<RunEvent[]> {
    const out: RunEvent[] = [];
    for await (const ev of rt.startRun({ prompt: "do it" }, ctx)) out.push(ev);
    return out;
  }

  it("reports health and capabilities without external calls", async () => {
    const rt = new MockRuntime();
    expect((await rt.healthCheck()).healthy).toBe(true);
    const caps = await rt.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.costReporting).toBe(false);
  });

  it("never exposes a token in authStatus", async () => {
    const auth = await new MockRuntime().authStatus();
    expect(JSON.stringify(auth)).not.toMatch(/sk-|Bearer|token[A-Za-z0-9]/);
  });

  it("emits a well-formed, schema-valid event stream", async () => {
    const events = await collect(new MockRuntime());
    for (const ev of events) {
      expect(() => runEventSchema.parse(ev)).not.toThrow();
      expect(ev.taskId).toBe(taskId);
      expect(ev.correlationId).toBe("corr_x");
    }
    expect(events[0].type).toBe("run.started");
    expect(events.at(-1)!.type).toBe("run.completed");
  });

  it("streams message deltas and a completion", async () => {
    const events = await collect(new MockRuntime({ responseText: "eins zwei drei" }));
    const deltas = events.filter((e) => e.type === "message.delta");
    expect(deltas).toHaveLength(3);
    const completed = events.find((e) => e.type === "message.completed");
    expect(completed!.payload.text).toBe("eins zwei drei");
  });

  it("reports usage with no invented monetary cost", async () => {
    const events = await collect(new MockRuntime());
    const usage = events.find((e) => e.type === "usage.updated")!;
    expect(usage.payload.inputTokens).toBe(1200);
    expect(usage.payload.costMicros).toBe(0);
  });

  it("emits run.failed for the failure scenario", async () => {
    const events = await collect(new MockRuntime({ scenario: "failure" }));
    expect(events.at(-1)!.type).toBe("run.failed");
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
  });

  it("surfaces a rate limit as its own event, not a generic failure", async () => {
    const resetAt = Date.now() + 120_000;
    const events = await collect(new MockRuntime({ scenario: "rate_limit", rateLimitResetAt: resetAt }));
    const rl = events.find((e) => e.type === "rate_limit.detected")!;
    expect(rl).toBeDefined();
    expect(rl.payload.resetAt).toBe(resetAt);
    expect(events.some((e) => e.type === "run.failed")).toBe(false);
    expect(events.at(-1)!.type).toBe("run.waiting");
  });

  it("emits approval.required and then waits", async () => {
    const events = await collect(new MockRuntime({ scenario: "approval_required" }));
    expect(events.some((e) => e.type === "approval.required")).toBe(true);
    expect(events.at(-1)!.type).toBe("run.waiting");
  });

  it("stops cleanly when cancelled mid-run", async () => {
    const rt = new MockRuntime({ responseText: "a b c d e f g h" });
    const ctx = context();
    const out: RunEvent[] = [];
    for await (const ev of rt.startRun({ prompt: "x" }, ctx)) {
      out.push(ev);
      if (ev.type === "message.delta" && out.filter((e) => e.type === "message.delta").length === 2) {
        await rt.cancelRun(ctx.runId);
      }
    }
    expect(out.at(-1)!.type).toBe("run.cancelled");
    expect(out.filter((e) => e.type === "message.delta").length).toBeLessThan(8);
  });

  it("honours an AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(new MockRuntime(), { ...context(), signal: controller.signal });
    expect(events.at(-1)!.type).toBe("run.cancelled");
  });

  it("redacts secrets that appear in its own output", async () => {
    const rt = new MockRuntime({ responseText: "key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH done" });
    const events = await collect(rt);
    const completed = events.find((e) => e.type === "message.completed")!;
    expect(JSON.stringify(completed.payload)).not.toContain("sk-ant-api03");
    expect(completed.redaction.redacted).toBe(true);
  });

  it("resumes a session by delegating to startRun", async () => {
    const rt = new MockRuntime();
    const out: RunEvent[] = [];
    for await (const ev of rt.resumeRun("sess-1", { prompt: "again" }, context())) out.push(ev);
    expect(out[0].type).toBe("run.started");
  });
});
