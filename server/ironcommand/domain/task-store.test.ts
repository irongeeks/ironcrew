import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { TaskStore, DEFAULT_LOCK_TTL_MS } from "./task-store.ts";
import { InvalidTransitionError } from "./task-state.ts";
import { verifyAuditChain } from "./audit.ts";
import { newId } from "./ids.ts";

let db: DatabaseSync;
let store: TaskStore;
let companyId: string;
let agentA: string;
let agentB: string;

beforeEach(() => {
  db = createTestDb();
  store = new TaskStore(db);
  companyId = seedCompany(db);
  agentA = seedAgent(db, companyId, "agent-a");
  agentB = seedAgent(db, companyId, "agent-b");
});

afterEach(() => db.close());

function readyTask(overrides: Record<string, unknown> = {}) {
  return store.create({ companyId, title: "Do the thing", status: "ready", ...overrides });
}

describe("create / read", () => {
  it("persists a task with defaults", () => {
    const t = readyTask();
    expect(t.company_id).toBe(companyId);
    expect(t.status).toBe("ready");
    expect(t.status_version).toBe(0);
    expect(t.priority).toBe("normal");
    expect(JSON.parse(t.acceptance_criteria)).toEqual([]);
  });

  it("stores acceptance criteria", () => {
    const t = readyTask({ acceptanceCriteria: ["tests pass", "docs updated"] });
    expect(JSON.parse(t.acceptance_criteria)).toEqual(["tests pass", "docs updated"]);
  });

  it("writes an audit entry on creation", () => {
    const t = readyTask();
    const rows = db
      .prepare("SELECT * FROM ic_audit_events WHERE task_id = ? AND action = 'task.created'")
      .all(t.id);
    expect(rows).toHaveLength(1);
  });

  it("lists by status and project", () => {
    readyTask();
    store.create({ companyId, title: "other", status: "inbox" });
    expect(store.list(companyId)).toHaveLength(2);
    expect(store.list(companyId, { status: "ready" })).toHaveLength(1);
  });
});

describe("transition", () => {
  it("advances status and bumps status_version", () => {
    const t = readyTask();
    const moved = store.transition(t.id, "assigned", { assignedAgentId: agentA });
    expect(moved!.status).toBe("assigned");
    expect(moved!.status_version).toBe(1);
    expect(moved!.assigned_agent_id).toBe(agentA);
  });

  it("rejects an illegal transition", () => {
    const t = readyTask();
    expect(() => store.transition(t.id, "done")).toThrow(InvalidTransitionError);
  });

  it("fails the CAS when the observed version is stale", () => {
    const t = readyTask();
    store.transition(t.id, "assigned", { assignedAgentId: agentA });
    // Caller still holds version 0 while the row is now at version 1.
    const stale = store.transition(t.id, "blocked", { expectedVersion: 0 });
    expect(stale).toBeNull();
    expect(store.get(t.id)!.status).toBe("assigned");
  });

  it("records completed_at on done", () => {
    const t = readyTask();
    store.transition(t.id, "assigned");
    store.transition(t.id, "running");
    store.transition(t.id, "review");
    const done = store.transition(t.id, "done", { resultSummary: "shipped" });
    expect(done!.completed_at).toBeGreaterThan(0);
    expect(done!.result_summary).toBe("shipped");
  });

  it("returns null for an unknown task", () => {
    expect(store.transition("task_nope", "ready")).toBeNull();
  });
});

describe("atomic claiming (the double-work guarantee)", () => {
  it("lets exactly one of two competing workers win", () => {
    const t = readyTask();
    const runA = newId("run");
    const runB = newId("run");

    const claimedA = store.claim({ taskId: t.id, runId: runA, agentId: agentA, expectedVersion: 0 });
    const claimedB = store.claim({ taskId: t.id, runId: runB, agentId: agentB, expectedVersion: 0 });

    expect(claimedA).not.toBeNull();
    expect(claimedB).toBeNull();

    const after = store.get(t.id)!;
    expect(after.execution_run_id).toBe(runA);
    expect(after.assigned_agent_id).toBe(agentA);
    expect(after.status).toBe("assigned");
  });

  it("holds under a burst of concurrent claim attempts", () => {
    const t = readyTask();
    const results = Array.from({ length: 25 }, (_, i) =>
      store.claim({
        taskId: t.id,
        runId: `run_${i}`,
        agentId: i % 2 === 0 ? agentA : agentB,
        expectedVersion: 0,
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses to claim a task that is not in the expected status", () => {
    const t = store.create({ companyId, title: "not ready", status: "inbox" });
    expect(
      store.claim({ taskId: t.id, runId: newId("run"), agentId: agentA, expectedVersion: 0 }),
    ).toBeNull();
  });

  it("refuses a second claim while the lock is still live", () => {
    const t = readyTask();
    const now = Date.now();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0, now });
    // Even with the fresh version, the live lock blocks a takeover.
    const current = store.get(t.id)!;
    store.transition(t.id, "ready", { expectedVersion: current.status_version });
    const second = store.claim({
      taskId: t.id,
      runId: "run-2",
      agentId: agentB,
      expectedVersion: store.get(t.id)!.status_version,
      now: now + 1000,
    });
    expect(second).toBeNull();
  });

  it("allows a takeover once the lock has expired", () => {
    const t = readyTask();
    const now = Date.now();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0, now, lockTtlMs: 1000 });
    store.transition(t.id, "ready", { expectedVersion: store.get(t.id)!.status_version });

    const later = now + 5000;
    const second = store.claim({
      taskId: t.id,
      runId: "run-2",
      agentId: agentB,
      expectedVersion: store.get(t.id)!.status_version,
      now: later,
    });
    expect(second).not.toBeNull();
    expect(store.get(t.id)!.execution_run_id).toBe("run-2");
  });

  it("sets a lock expiry from the TTL", () => {
    const t = readyTask();
    const now = 1_700_000_000_000;
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0, now });
    expect(store.get(t.id)!.lock_expires_at).toBe(now + DEFAULT_LOCK_TTL_MS);
  });

  it("audits the claim", () => {
    const t = readyTask();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0 });
    const rows = db.prepare("SELECT * FROM ic_audit_events WHERE action='task.claimed'").all();
    expect(rows).toHaveLength(1);
  });
});

describe("lock lifecycle", () => {
  it("renews only for the owning run", () => {
    const t = readyTask();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0 });
    expect(store.renewLock(t.id, "run-1")).toBe(true);
    expect(store.renewLock(t.id, "run-2")).toBe(false);
  });

  it("releases only for the owning run", () => {
    const t = readyTask();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0 });
    expect(store.releaseLock(t.id, "run-impostor")).toBe(false);
    expect(store.get(t.id)!.execution_run_id).toBe("run-1");
    expect(store.releaseLock(t.id, "run-1")).toBe(true);
    expect(store.get(t.id)!.execution_run_id).toBeNull();
  });

  it("a late reaper cannot clear a fresh owner's lock", () => {
    const t = readyTask();
    const now = Date.now();
    store.claim({ taskId: t.id, runId: "run-old", agentId: agentA, expectedVersion: 0, now, lockTtlMs: 500 });
    store.transition(t.id, "ready", { expectedVersion: store.get(t.id)!.status_version });
    store.claim({
      taskId: t.id,
      runId: "run-new",
      agentId: agentB,
      expectedVersion: store.get(t.id)!.status_version,
      now: now + 5000,
    });
    // The reaper acts on its stale observation of run-old and must be ignored.
    expect(store.recoverOrphaned(t.id, "run-old")).toBeNull();
    expect(store.get(t.id)!.execution_run_id).toBe("run-new");
  });
});

describe("orphan recovery", () => {
  it("finds tasks whose lock expired while active", () => {
    const t = readyTask();
    const now = Date.now();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0, now, lockTtlMs: 100 });
    expect(store.findOrphaned(companyId, now)).toHaveLength(0);
    expect(store.findOrphaned(companyId, now + 1000)).toHaveLength(1);
  });

  it("returns a recovered task to ready and clears the lock", () => {
    const t = readyTask();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0, lockTtlMs: 1 });
    const recovered = store.recoverOrphaned(t.id, "run-1");
    expect(recovered!.status).toBe("ready");
    expect(recovered!.execution_run_id).toBeNull();
    expect(recovered!.lock_expires_at).toBeNull();
  });

  it("makes a recovered task claimable again", () => {
    const t = readyTask();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0, lockTtlMs: 1 });
    store.recoverOrphaned(t.id, "run-1");
    const reclaimed = store.claim({
      taskId: t.id,
      runId: "run-2",
      agentId: agentB,
      expectedVersion: store.get(t.id)!.status_version,
    });
    expect(reclaimed).not.toBeNull();
  });
});

describe("dependencies", () => {
  it("reports a task with an unfinished blocker as not ready", () => {
    const blocker = readyTask({ title: "blocker" });
    const dependent = readyTask({ title: "dependent" });
    store.addDependency(companyId, dependent.id, blocker.id);

    expect(store.isDependencyReady(dependent.id)).toBe(false);
    expect(store.findClaimable(companyId).map((t) => t.id)).toEqual([blocker.id]);
  });

  it("unblocks the dependent once the blocker is done", () => {
    const blocker = readyTask({ title: "blocker" });
    const dependent = readyTask({ title: "dependent" });
    store.addDependency(companyId, dependent.id, blocker.id);

    store.transition(blocker.id, "assigned");
    store.transition(blocker.id, "running");
    store.transition(blocker.id, "review");
    store.transition(blocker.id, "done");

    expect(store.isDependencyReady(dependent.id)).toBe(true);
    expect(store.findClaimable(companyId).map((t) => t.id)).toEqual([dependent.id]);
  });

  it("rejects self-dependency", () => {
    const t = readyTask();
    expect(() => store.addDependency(companyId, t.id, t.id)).toThrow(/cannot depend on itself/);
  });

  it("rejects a direct cycle", () => {
    const a = readyTask({ title: "a" });
    const b = readyTask({ title: "b" });
    store.addDependency(companyId, a.id, b.id);
    expect(() => store.addDependency(companyId, b.id, a.id)).toThrow(/cycle/);
  });

  it("rejects an indirect cycle", () => {
    const a = readyTask({ title: "a" });
    const b = readyTask({ title: "b" });
    const c = readyTask({ title: "c" });
    store.addDependency(companyId, a.id, b.id);
    store.addDependency(companyId, b.id, c.id);
    expect(() => store.addDependency(companyId, c.id, a.id)).toThrow(/cycle/);
  });

  it("is idempotent for a repeated edge", () => {
    const a = readyTask({ title: "a" });
    const b = readyTask({ title: "b" });
    store.addDependency(companyId, a.id, b.id);
    store.addDependency(companyId, a.id, b.id);
    expect(store.blockers(a.id)).toHaveLength(1);
  });
});

describe("findClaimable ordering", () => {
  it("returns urgent work before normal work", () => {
    readyTask({ title: "normal", priority: "normal" });
    const urgent = readyTask({ title: "urgent", priority: "urgent" });
    expect(store.findClaimable(companyId)[0].id).toBe(urgent.id);
  });

  it("excludes locked tasks", () => {
    const t = readyTask();
    store.claim({ taskId: t.id, runId: "r1", agentId: agentA, expectedVersion: 0 });
    store.transition(t.id, "ready", { expectedVersion: store.get(t.id)!.status_version });
    expect(store.findClaimable(companyId)).toHaveLength(0);
  });
});

describe("audit chain integrity", () => {
  it("stays valid across a full task lifecycle", () => {
    const t = readyTask();
    store.claim({ taskId: t.id, runId: "run-1", agentId: agentA, expectedVersion: 0 });
    store.transition(t.id, "running");
    store.transition(t.id, "review");
    store.transition(t.id, "done");

    const result = verifyAuditChain(db, companyId);
    expect(result.valid).toBe(true);
    expect(result.checked).toBeGreaterThan(3);
  });

  it("detects a tampered historical entry", () => {
    const t = readyTask();
    store.transition(t.id, "assigned");
    store.transition(t.id, "running");

    db.prepare("UPDATE ic_audit_events SET action = 'task.forged' WHERE seq = 2 AND company_id = ?").run(
      companyId,
    );

    const result = verifyAuditChain(db, companyId);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it("detects a deleted entry as a sequence gap", () => {
    const t = readyTask();
    store.transition(t.id, "assigned");
    store.transition(t.id, "running");
    db.prepare("DELETE FROM ic_audit_events WHERE seq = 2 AND company_id = ?").run(companyId);
    expect(verifyAuditChain(db, companyId).valid).toBe(false);
  });
});
