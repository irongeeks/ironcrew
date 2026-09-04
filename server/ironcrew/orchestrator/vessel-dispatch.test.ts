/**
 * What a vessel actually governs.
 *
 * Migration 0011 split an agent into Vessel × Talent and gave the vessel four
 * columns — model, timeout, retries, concurrency. Until this wiring they were
 * data nobody read: an operator could set a ten-second timeout on a vessel and
 * watch a run take an hour. These tests exist to keep that from being true
 * again, so each one asserts an *effect on dispatch*, never that a column can
 * be written and read back.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { RunStore } from "../runtime/run-store.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import type { RunContext, RunEvent, RunInput } from "../runtime/run-events.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;
let runs: RunStore;

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Fertig." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
  runs = new RunStore(db);
});

afterEach(() => db.close());

/** The one vessel the seed derives, so a test can change what it governs. */
function vessel(): { id: string; key: string } {
  return db.prepare("SELECT id, key FROM crew_vessels WHERE company_id = ?").get(companyId) as {
    id: string;
    key: string;
  };
}

function setVessel(patch: Record<string, string | number>): void {
  const columns = Object.keys(patch)
    .map((c) => `${c} = ?`)
    .join(", ");
  db.prepare(`UPDATE crew_vessels SET ${columns} WHERE id = ?`).run(...Object.values(patch), vessel().id);
}

/** A runtime that records what it was handed and can be told to hang. */
class SpyRuntime extends StubRuntime {
  readonly seen: Array<{ input: RunInput; context: RunContext }> = [];

  constructor(private readonly behaviour: "complete" | "hang" | "quiet-abort" = "complete") {
    super("spy");
  }

  async *startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    this.seen.push({ input, context });
    yield stubEvent(context, "run.started");

    if (this.behaviour === "complete") {
      yield stubEvent(context, "message.completed", { text: "Fertig." }, 1);
      yield stubEvent(context, "run.completed", {}, 2);
      return;
    }

    // Both remaining behaviours wait for the abort. "hang" then throws the
    // way a killed process does; "quiet-abort" just stops, which is the case
    // a naive timeout would misread as a clean finish.
    await new Promise<void>((resolve) => {
      if (context.signal?.aborted) return resolve();
      context.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    if (this.behaviour === "hang") throw new Error("aborted");
  }
}

async function readyTask(text = "Bitte dokumentiere das Deployment-Verfahren.") {
  const result = orc.handleCeoMessage(companyId, text);
  return result.task!;
}

describe("the vessel's model reaches the runtime", () => {
  it("hands the model to the run and records it on the run row", async () => {
    const spy = new SpyRuntime();
    orc.registerRuntime(spy);
    setVessel({ runtime_provider: "spy", model: "claude-opus-5" });

    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    expect(spy.seen[0].input.model).toBe("claude-opus-5");
    expect(runs.get(exec!.runId)!.model).toBe("claude-opus-5");
  });

  it("passes no model at all when the vessel names none", async () => {
    const spy = new SpyRuntime();
    orc.registerRuntime(spy);
    setVessel({ runtime_provider: "spy", model: "" });

    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    // Not the empty string: a runtime asked to use a model called "" fails in
    // a way that looks like a broken account rather than a blank field.
    expect(spy.seen[0].input.model).toBeUndefined();
    expect(runs.get(exec!.runId)!.model).toBeNull();
  });
});

describe("the vessel's timeout stops the run", () => {
  it("fails a run that outlives the vessel's limit", async () => {
    const spy = new SpyRuntime("hang");
    orc.registerRuntime(spy);
    setVessel({ runtime_provider: "spy", timeout_ms: 40 });

    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    expect(exec!.task.status).toBe("failed");
    const failure = exec!.events.find((e) => e.type === "run.failed");
    expect((failure!.payload as { timedOut?: boolean }).timedOut).toBe(true);
    expect((failure!.payload as { message: string }).message).toMatch(/Zeitlimit/);
  });

  it("aborts the runtime rather than only marking the run afterwards", async () => {
    const spy = new SpyRuntime("hang");
    orc.registerRuntime(spy);
    setVessel({ runtime_provider: "spy", timeout_ms: 40 });

    await readyTask();
    await orc.executeNextTask(companyId);

    // The signal is what actually stops a real CLI process; a run marked
    // failed while its process keeps going is not a timeout, it is a leak.
    expect(spy.seen[0].context.signal?.aborted).toBe(true);
  });

  it("does not mistake a quiet abort for a clean finish", async () => {
    const spy = new SpyRuntime("quiet-abort");
    orc.registerRuntime(spy);
    setVessel({ runtime_provider: "spy", timeout_ms: 40 });

    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    expect(exec!.task.status).toBe("failed");
    expect(exec!.task.status).not.toBe("review");
  });

  it("leaves a run that finishes in time untouched", async () => {
    setVessel({ timeout_ms: 600_000 });
    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    expect(exec!.task.status).toBe("review");
    expect(exec!.events.some((e) => e.type === "run.failed")).toBe(false);
  });
});

describe("the vessel's concurrency caps how many runs share it", () => {
  /**
   * Puts a live run on the vessel without going through dispatch, so the cap
   * can be tested without racing two real runs against each other.
   */
  function liveRunOnVessel(now = Date.now()): string {
    const agent = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!;
    const task = orc.tasks.create({
      companyId,
      title: "Läuft bereits",
      description: "x",
      status: "inbox",
      createdBy: "test",
    });
    const run = runs.create({
      companyId,
      taskId: task.id,
      agentId: agent.id,
      runtimeType: "mock",
    });
    db.prepare("UPDATE crew_runs SET status = 'running', heartbeat_at = ? WHERE id = ?").run(now, run.id);
    return run.id;
  }

  it("refuses a second run when the vessel allows one", async () => {
    setVessel({ max_concurrency: 1 });
    liveRunOnVessel();

    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    expect(exec).toBeNull();
  });

  it("puts the task back to ready rather than losing it", async () => {
    setVessel({ max_concurrency: 1 });
    liveRunOnVessel();

    const task = await readyTask();
    await orc.executeNextTask(companyId);

    const after = orc.tasks.get(task.id)!;
    expect(after.status).toBe("ready");
    expect(after.execution_run_id).toBeNull();
  });

  it("says which vessel refused, in the task's own history", async () => {
    setVessel({ max_concurrency: 1 });
    liveRunOnVessel();

    const task = await readyTask();
    await orc.executeNextTask(companyId);

    const details = db
      .prepare(
        `SELECT details_json FROM crew_audit_events
          WHERE task_id = ? AND action = 'task.transitioned' ORDER BY seq DESC LIMIT 1`,
      )
      .get(task.id) as { details_json: string } | undefined;
    // Naming the vessel matters: "agent busy" and "vessel full" look identical
    // from the board, and they need different fixes.
    expect(details?.details_json ?? "").toMatch(/concurrency limit/);
    expect(details?.details_json ?? "").toContain(vessel().key);
  });

  it("admits the run when the vessel allows two", async () => {
    setVessel({ max_concurrency: 2 });
    liveRunOnVessel();

    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    expect(exec).not.toBeNull();
    expect(exec!.task.status).toBe("review");
  });

  it("does not let one crashed run hold a seat forever", async () => {
    setVessel({ max_concurrency: 1 });
    // Still `running` in the table, but silent for an hour: the process that
    // owned it is gone and wrote nothing on its way out.
    liveRunOnVessel(Date.now() - 60 * 60_000);

    await readyTask();
    const exec = await orc.executeNextTask(companyId);

    expect(exec).not.toBeNull();
  });

  it("cancels the run row it created when it backs off", async () => {
    setVessel({ max_concurrency: 1 });
    const existing = liveRunOnVessel();

    await readyTask();
    await orc.executeNextTask(companyId);

    const cancelled = db
      .prepare("SELECT id FROM crew_runs WHERE status = 'cancelled' AND company_id = ?")
      .all(companyId) as Array<{ id: string }>;
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].id).not.toBe(existing);
  });
});
