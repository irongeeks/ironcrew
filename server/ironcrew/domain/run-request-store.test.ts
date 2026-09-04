import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { TaskStore } from "./task-store.ts";
import { newId } from "./ids.ts";
import { listAuditEvents, verifyAuditChain } from "./audit.ts";
import {
  backoffMs,
  DEFAULT_DEFER_MS,
  DEFAULT_LEASE_TTL_MS,
  RunRequestError,
  RunRequestStore,
} from "./run-request-store.ts";

let db: DatabaseSync;
let companyId: string;
let tasks: TaskStore;
let requests: RunRequestStore;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  seedAgent(db, companyId);
  tasks = new TaskStore(db);
  requests = new RunRequestStore(db);
});

afterEach(() => db.close());

/** The FK to crew_tasks is real, so tasks are created through the store. */
function seedTask(title = "Deployment vorbereiten"): string {
  return tasks.create({ companyId, title, status: "ready" }).id;
}

/** complete() writes a real FK, so a run has to exist before it can be named. */
function seedRun(taskId: string): string {
  const id = newId("run");
  db.prepare("INSERT INTO crew_runs (id, company_id, task_id, runtime_type) VALUES (?,?,?,?)").run(
    id,
    companyId,
    taskId,
    "mock",
  );
  return id;
}

function auditActions(): string[] {
  return listAuditEvents(db, companyId, { limit: 1000 }).map((row) => String(row.action));
}

describe("backoffMs", () => {
  it("doubles from 30s and is deterministic", () => {
    // No jitter, so a caller can predict — and a test can assert — the exact
    // moment of the next attempt.
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(3)).toBe(backoffMs(3));
  });

  it("caps rather than growing without bound", () => {
    expect(backoffMs(6)).toBe(15 * 60_000);
    expect(backoffMs(40)).toBe(15 * 60_000);
    expect(backoffMs(4000)).toBe(15 * 60_000);
  });

  it("treats a nonsensical attempt count as the first attempt", () => {
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(-5)).toBe(30_000);
    expect(backoffMs(Number.NaN)).toBe(30_000);
  });
});

describe("RunRequestStore", () => {
  describe("enqueue — one live request per task", () => {
    it("creates a queued request", () => {
      const taskId = seedTask();
      const { request, isNew } = requests.enqueue({ companyId, taskId, requestedBy: "ceo", now: 1_000 });

      expect(isNew).toBe(true);
      expect(request.status).toBe("queued");
      expect(request.attempts).toBe(0);
      expect(request.max_attempts).toBe(1);
      expect(request.requested_by).toBe("ceo");
      expect(request.created_at).toBe(1_000);
      expect(request.finished_at).toBeNull();
    });

    it("returns the existing request when one is already live", () => {
      const taskId = seedTask();
      const first = requests.enqueue({ companyId, taskId, requestedBy: "mail:mbx_1" });
      const second = requests.enqueue({ companyId, taskId, requestedBy: "ceo" });

      // Two ingresses asking at once is the normal case, not the exception.
      expect(second.isNew).toBe(false);
      expect(second.request.id).toBe(first.request.id);
      expect(second.request.requested_by).toBe("mail:mbx_1");
      expect(requests.list(companyId)).toHaveLength(1);
    });

    it("does not create a second row while the first is running", () => {
      const taskId = seedTask();
      const first = requests.enqueue({ companyId, taskId });
      requests.claimNext(companyId, "drain_1");

      const second = requests.enqueue({ companyId, taskId });
      expect(second.isNew).toBe(false);
      expect(second.request.id).toBe(first.request.id);
      expect(requests.list(companyId)).toHaveLength(1);
    });

    it("keeps requests for different tasks apart", () => {
      const a = requests.enqueue({ companyId, taskId: seedTask("A") });
      const b = requests.enqueue({ companyId, taskId: seedTask("B") });

      expect(b.isNew).toBe(true);
      expect(b.request.id).not.toBe(a.request.id);
      expect(requests.list(companyId)).toHaveLength(2);
    });

    it("lets a completed task be asked for again", () => {
      const taskId = seedTask();
      const first = requests.enqueue({ companyId, taskId });
      requests.claimNext(companyId, "drain_1");
      requests.complete(first.request.id);

      const second = requests.enqueue({ companyId, taskId });
      expect(second.isNew).toBe(true);
      expect(second.request.id).not.toBe(first.request.id);
      // History is kept: the finished attempt is evidence.
      expect(requests.list(companyId)).toHaveLength(2);
    });

    it("lets a cancelled task be asked for again", () => {
      const taskId = seedTask();
      const first = requests.enqueue({ companyId, taskId });
      requests.cancel(first.request.id);

      expect(requests.enqueue({ companyId, taskId }).isNew).toBe(true);
    });

    it("lets a dead-lettered task be asked for again", () => {
      const taskId = seedTask();
      const first = requests.enqueue({ companyId, taskId, maxAttempts: 1 });
      requests.claimNext(companyId, "drain_1");
      requests.fail(first.request.id, "runtime nicht erreichbar");

      expect(requests.get(first.request.id)?.status).toBe("dead");
      expect(requests.enqueue({ companyId, taskId }).isNew).toBe(true);
    });

    it("refuses a request for a task that does not exist", () => {
      // The FK is the guard; enqueue must not swallow it as "already live".
      expect(() => requests.enqueue({ companyId, taskId: "task_nope" })).toThrow(/FOREIGN KEY/);
    });
  });

  describe("lookup and listing", () => {
    it("finds the live request for a task, and nothing once it finished", () => {
      const taskId = seedTask();
      const { request } = requests.enqueue({ companyId, taskId });

      expect(requests.liveForTask(taskId)?.id).toBe(request.id);
      requests.cancel(request.id);
      expect(requests.liveForTask(taskId)).toBeNull();
    });

    it("returns null for an unknown id", () => {
      expect(requests.get("rreq_nope")).toBeNull();
      expect(requests.liveForTask("task_nope")).toBeNull();
    });

    it("narrows a listing to one status and respects the limit", () => {
      const a = requests.enqueue({ companyId, taskId: seedTask("A"), now: 1_000 });
      requests.enqueue({ companyId, taskId: seedTask("B"), now: 2_000 });
      requests.cancel(a.request.id);

      expect(requests.list(companyId)).toHaveLength(2);
      expect(requests.list(companyId, { status: "cancelled" }).map((r) => r.id)).toEqual([a.request.id]);
      expect(requests.list(companyId, { limit: 1 })).toHaveLength(1);
    });

    it("does not list another company's requests", () => {
      const other = seedCompany(db, "Other");
      requests.enqueue({ companyId, taskId: seedTask() });

      expect(requests.list(other)).toHaveLength(0);
    });
  });

  describe("claiming — the database decides", () => {
    it("claims the queued request and counts the attempt", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      const claimed = requests.claimNext(companyId, "drain_1", { now: 1_000 })!;

      expect(claimed.id).toBe(request.id);
      expect(claimed.status).toBe("running");
      expect(claimed.attempts).toBe(1);
      expect(claimed.lease_owner).toBe("drain_1");
      expect(claimed.lease_expires_at).toBe(1_000 + DEFAULT_LEASE_TTL_MS);
    });

    it("never hands the same request to two owners", () => {
      requests.enqueue({ companyId, taskId: seedTask("A"), now: 1_000 });
      requests.enqueue({ companyId, taskId: seedTask("B"), now: 2_000 });

      const first = requests.claimNext(companyId, "drain_1", { now: 3_000 })!;
      const second = requests.claimNext(companyId, "drain_2", { now: 3_000 })!;

      expect(first.id).not.toBe(second.id);
      expect(second.lease_owner).toBe("drain_2");
    });

    it("returns null rather than re-handing the only request out", () => {
      requests.enqueue({ companyId, taskId: seedTask() });

      expect(requests.claimNext(companyId, "drain_1", { now: 1_000 })).not.toBeNull();
      expect(requests.claimNext(companyId, "drain_2", { now: 1_000 })).toBeNull();
    });

    it("returns null when there is nothing queued at all", () => {
      expect(requests.claimNext(companyId, "drain_1")).toBeNull();
    });

    it("claims oldest first", () => {
      const older = requests.enqueue({ companyId, taskId: seedTask("alt"), now: 1_000 });
      const newer = requests.enqueue({ companyId, taskId: seedTask("neu"), now: 5_000 });

      expect(requests.claimNext(companyId, "drain_1", { now: 9_000 })?.id).toBe(older.request.id);
      expect(requests.claimNext(companyId, "drain_2", { now: 9_000 })?.id).toBe(newer.request.id);
    });

    it("orders by not_before before created_at, so a backed-off request waits its turn", () => {
      const delayed = requests.enqueue({ companyId, taskId: seedTask("alt"), now: 1_000, notBefore: 8_000 });
      const prompt = requests.enqueue({ companyId, taskId: seedTask("neu"), now: 5_000 });

      expect(requests.claimNext(companyId, "drain_1", { now: 9_000 })?.id).toBe(prompt.request.id);
      expect(requests.claimNext(companyId, "drain_2", { now: 9_000 })?.id).toBe(delayed.request.id);
    });

    it("does not claim a request before its not_before", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), notBefore: 5_000 });

      expect(requests.claimNext(companyId, "drain_1", { now: 4_999 })).toBeNull();
      expect(requests.claimNext(companyId, "drain_1", { now: 5_000 })?.id).toBe(request.id);
    });

    it("does not claim another company's request", () => {
      const other = seedCompany(db, "Other");
      requests.enqueue({ companyId, taskId: seedTask() });

      expect(requests.claimNext(other, "drain_1")).toBeNull();
    });

    it("honours a shorter lease when one is asked for", () => {
      requests.enqueue({ companyId, taskId: seedTask() });
      const claimed = requests.claimNext(companyId, "drain_1", { now: 1_000, leaseTtlMs: 60_000 })!;

      expect(claimed.lease_expires_at).toBe(61_000);
    });
  });

  describe("an expired lease — a drain that crashed mid-run", () => {
    it("is reclaimable by claimNext directly, without waiting for a sweep", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_dead", { now: 1_000, leaseTtlMs: 1_000 });

      // Nothing has swept. The request must not be stranded until someone
      // notices — the next drain simply takes it.
      const reclaimed = requests.claimNext(companyId, "drain_fresh", { now: 3_000 })!;
      expect(reclaimed.id).toBe(request.id);
      expect(reclaimed.lease_owner).toBe("drain_fresh");
      expect(reclaimed.attempts).toBe(2);
    });

    it("is not reclaimable while the lease still holds", () => {
      requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1", { now: 1_000, leaseTtlMs: 10_000 });

      expect(requests.claimNext(companyId, "drain_2", { now: 5_000 })).toBeNull();
    });

    it("is put back to queued by sweepExpired, which counts what it freed", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_dead", { now: 1_000, leaseTtlMs: 1_000 });

      expect(requests.sweepExpired(companyId, 5_000)).toBe(1);
      const swept = requests.get(request.id)!;
      expect(swept.status).toBe("queued");
      expect(swept.lease_owner).toBeNull();
      expect(swept.lease_expires_at).toBeNull();
      // The attempt still counted; sweeping is recovery, not amnesty.
      expect(swept.attempts).toBe(1);
    });

    it("sweeps nothing while leases are live", () => {
      requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1", { now: 1_000, leaseTtlMs: 10_000 });

      expect(requests.sweepExpired(companyId, 5_000)).toBe(0);
    });

    it("does not sweep another company's requests", () => {
      const other = seedCompany(db, "Other");
      requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1", { now: 1_000, leaseTtlMs: 1_000 });

      expect(requests.sweepExpired(other, 9_000)).toBe(0);
    });
  });

  describe("renew", () => {
    it("extends the lease of the owner that holds it", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1", { now: 1_000, leaseTtlMs: 1_000 });

      expect(requests.renew(request.id, "drain_1", { now: 1_500, leaseTtlMs: 5_000 })).toBe(true);
      expect(requests.get(request.id)?.lease_expires_at).toBe(6_500);
      expect(requests.claimNext(companyId, "drain_2", { now: 3_000 })).toBeNull();
    });

    it("refuses an owner that has been displaced", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1", { now: 1_000, leaseTtlMs: 1_000 });
      requests.claimNext(companyId, "drain_2", { now: 5_000 });

      expect(requests.renew(request.id, "drain_1", { now: 5_100 })).toBe(false);
    });

    it("refuses once the request has finished", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1");
      requests.complete(request.id);

      expect(requests.renew(request.id, "drain_1")).toBe(false);
    });
  });

  describe("complete", () => {
    it("finishes the request and names the run", () => {
      const taskId = seedTask();
      const { request } = requests.enqueue({ companyId, taskId });
      requests.claimNext(companyId, "drain_1");
      const runId = seedRun(taskId);

      const done = requests.complete(request.id, { runId, now: 7_000 })!;
      expect(done.status).toBe("done");
      expect(done.run_id).toBe(runId);
      expect(done.finished_at).toBe(7_000);
      expect(done.lease_owner).toBeNull();
    });

    it("is idempotent", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1");
      const first = requests.complete(request.id, { now: 7_000 })!;

      expect(requests.complete(request.id, { now: 9_000 })?.finished_at).toBe(first.finished_at);
    });

    it("keeps the error of an earlier attempt as evidence", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 3 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.fail(request.id, "timeout", { now: 2_000 });
      requests.claimNext(companyId, "drain_1", { now: 99_000 });

      // Succeeding on the second try does not make the first failure untrue.
      expect(requests.complete(request.id)?.last_error).toBe("timeout");
    });

    it("refuses to resurrect a cancelled request", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1");
      requests.cancel(request.id, { reason: "Auftrag zurückgezogen" });

      // A drain finishing late must not undo what a human decided.
      expect(() => requests.complete(request.id)).toThrow(RunRequestError);
      expect(requests.get(request.id)?.status).toBe("cancelled");
    });

    it("refuses to resurrect a dead request", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 1 });
      requests.claimNext(companyId, "drain_1");
      requests.fail(request.id, "runtime nicht erreichbar");

      expect(() => requests.complete(request.id)).toThrow(/dead/);
      expect(requests.get(request.id)?.status).toBe("dead");
    });

    it("returns null for an unknown request", () => {
      expect(requests.complete("rreq_nope")).toBeNull();
    });
  });

  describe("fail — retry with backoff, then dead-letter", () => {
    it("puts a retryable failure back into the queue with an exact backoff", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 3 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });

      const failed = requests.fail(request.id, "CLI beendet mit Code 1", { now: 2_000 })!;
      expect(failed.status).toBe("queued");
      expect(failed.attempts).toBe(1);
      expect(failed.not_before).toBe(2_000 + backoffMs(1));
      expect(failed.last_error).toBe("CLI beendet mit Code 1");
      expect(failed.lease_owner).toBeNull();
      expect(failed.finished_at).toBeNull();
    });

    it("makes the backoff real: not claimable until it has passed", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 3 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.fail(request.id, "timeout", { now: 2_000 });

      expect(requests.claimNext(companyId, "drain_1", { now: 2_500 })).toBeNull();
      expect(requests.claimNext(companyId, "drain_1", { now: 2_000 + backoffMs(1) })?.id).toBe(request.id);
    });

    it("lengthens the backoff with every attempt", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 5 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.fail(request.id, "eins", { now: 1_000 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 + backoffMs(1) });

      const second = requests.fail(request.id, "zwei", { now: 500_000 })!;
      expect(second.attempts).toBe(2);
      expect(second.not_before).toBe(500_000 + backoffMs(2));
    });

    it("dead-letters once the attempts are spent", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 2 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.fail(request.id, "eins", { now: 1_000 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 + backoffMs(1) });

      const dead = requests.fail(request.id, "zwei", { now: 900_000 })!;
      expect(dead.status).toBe("dead");
      expect(dead.attempts).toBe(2);
      expect(dead.finished_at).toBe(900_000);
      expect(dead.last_error).toBe("zwei");
    });

    it("leaves a dead request unclaimable forever", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 1 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.fail(request.id, "kaputt", { now: 2_000 });

      expect(requests.claimNext(companyId, "drain_1", { now: 2_000 })).toBeNull();
      expect(requests.claimNext(companyId, "drain_1", { now: 999_999_999 })).toBeNull();
      expect(requests.sweepExpired(companyId, 999_999_999)).toBe(0);
    });

    it("refuses a late failure on a cancelled request", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask(), maxAttempts: 3 });
      requests.claimNext(companyId, "drain_1");
      requests.cancel(request.id);

      // Reopening it would put a withdrawn request back into the queue.
      expect(() => requests.fail(request.id, "zu spät")).toThrow(RunRequestError);
      expect(requests.get(request.id)?.status).toBe("cancelled");
    });

    it("returns null for an unknown request", () => {
      expect(requests.fail("rreq_nope", "egal")).toBeNull();
    });
  });

  describe("cancel", () => {
    it("withdraws a queued request", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });

      const cancelled = requests.cancel(request.id, { reason: "doppelt beauftragt", now: 4_000 })!;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.finished_at).toBe(4_000);
      expect(requests.claimNext(companyId, "drain_1", { now: 9_000 })).toBeNull();
    });

    it("withdraws a running request, and the drain's late finish is refused", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });

      const cancelled = requests.cancel(request.id, { now: 2_000 })!;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.lease_owner).toBeNull();

      // We cannot stop a drain that is already working, but we can guarantee
      // its result is not accepted — which is what cancelling means here.
      expect(() => requests.complete(request.id, { now: 3_000 })).toThrow(RunRequestError);
      expect(requests.get(request.id)?.status).toBe("cancelled");
      expect(requests.renew(request.id, "drain_1", { now: 3_000 })).toBe(false);
    });

    it("is idempotent", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.cancel(request.id, { now: 4_000 });

      expect(requests.cancel(request.id, { now: 8_000 })?.finished_at).toBe(4_000);
      expect(auditActions().filter((a) => a === "run_request.cancelled")).toHaveLength(1);
    });

    it("refuses to withdraw something that already finished", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1");
      requests.complete(request.id);

      expect(() => requests.cancel(request.id)).toThrow(RunRequestError);
    });

    it("returns null for an unknown request", () => {
      expect(requests.cancel("rreq_nope")).toBeNull();
    });
  });

  describe("audit", () => {
    it("records enqueue, dead-letter and cancel, and nothing per claim", () => {
      const a = requests.enqueue({ companyId, taskId: seedTask("A"), maxAttempts: 1 });
      const b = requests.enqueue({ companyId, taskId: seedTask("B") });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.claimNext(companyId, "drain_2", { now: 1_000 });
      requests.fail(a.request.id, "kaputt", { now: 2_000 });
      requests.cancel(b.request.id, { reason: "nicht mehr nötig", now: 2_000 });

      const actions = auditActions();
      expect(actions).toContain("run_request.enqueued");
      expect(actions).toContain("run_request.dead_lettered");
      expect(actions).toContain("run_request.cancelled");
      // A drain ticking once a second would drown the log.
      expect(actions.filter((a2) => a2.startsWith("run_request.claim"))).toHaveLength(0);
      expect(actions.filter((a2) => a2 === "run_request.enqueued")).toHaveLength(2);
    });

    it("keeps the chain verifiable across the whole lifecycle", () => {
      const taskId = seedTask();
      const { request } = requests.enqueue({ companyId, taskId, maxAttempts: 2 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.fail(request.id, "eins", { now: 1_000 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 + backoffMs(1) });
      requests.fail(request.id, "zwei", { now: 900_000 });

      expect(verifyAuditChain(db, companyId).valid).toBe(true);
    });

    it("never writes the task's description or a run's error text into the log", () => {
      const secret = "Kundendaten: IBAN DE02120300000000202051";
      const taskId = tasks.create({ companyId, title: "Abrechnung", description: secret, status: "ready" }).id;
      const { request } = requests.enqueue({ companyId, taskId, maxAttempts: 1 });
      requests.claimNext(companyId, "drain_1", { now: 1_000 });
      requests.fail(request.id, `stack trace: ${secret}`, { now: 2_000 });

      const log = JSON.stringify(listAuditEvents(db, companyId, { limit: 1000 }));
      expect(log).not.toContain(secret);
      // The error is still recoverable — it lives on the row, not in the log.
      expect(requests.get(request.id)?.last_error).toContain(secret);
    });
  });

  describe("prune", () => {
    it("drops finished requests older than the cutoff", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.claimNext(companyId, "drain_1");
      requests.complete(request.id, { now: 1_000 });

      expect(requests.prune(companyId, 500, 10_000)).toBe(1);
      expect(requests.get(request.id)).toBeNull();
    });

    it("keeps finished requests that are still inside the window", () => {
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.cancel(request.id, { now: 9_000 });

      expect(requests.prune(companyId, 5_000, 10_000)).toBe(0);
      expect(requests.get(request.id)).not.toBeNull();
    });

    it("never touches an unfinished request, however old", () => {
      const queued = requests.enqueue({ companyId, taskId: seedTask("A"), now: 1 });
      const running = requests.enqueue({ companyId, taskId: seedTask("B"), now: 1 });
      requests.claimNext(companyId, "drain_1", { now: 1 });

      // Outstanding work. Pruning it would erase the intent to run without
      // anything ever having run.
      expect(requests.prune(companyId, 1, 999_999_999)).toBe(0);
      expect(requests.get(queued.request.id)).not.toBeNull();
      expect(requests.get(running.request.id)).not.toBeNull();
    });

    it("does not prune across companies", () => {
      const other = seedCompany(db, "Other");
      const { request } = requests.enqueue({ companyId, taskId: seedTask() });
      requests.cancel(request.id, { now: 1_000 });

      expect(requests.prune(other, 500, 10_000)).toBe(0);
      expect(requests.get(request.id)).not.toBeNull();
    });
  });
});

describe("defer: could-not-start is not a failed attempt", () => {
  const T0 = 1_700_000_000_000;

  it("gives the attempt back", () => {
    const taskId = seedTask();
    const { request } = requests.enqueue({ companyId, taskId, maxAttempts: 2, now: T0 });
    const claimed = requests.claimNext(companyId, "drain", { now: T0 })!;
    expect(claimed.attempts).toBe(1);

    const deferred = requests.defer(claimed.id, "Agent belegt", { now: T0 })!;
    // The claim happened; the run did not. Counting it would dead-letter a
    // healthy task for the sole reason that the company was busy.
    expect(deferred.attempts).toBe(0);
    expect(deferred.status).toBe("queued");
    expect(deferred.lease_owner).toBeNull();
    expect(deferred.id).toBe(request.id);
  });

  it("waits before offering the request again", () => {
    const taskId = seedTask();
    const { request } = requests.enqueue({ companyId, taskId, now: T0 });
    requests.claimNext(companyId, "drain", { now: T0 });
    requests.defer(request.id, "Vessel voll", { now: T0, delayMs: 5000 });

    expect(requests.claimNext(companyId, "drain", { now: T0 + 4999 })).toBeNull();
    expect(requests.claimNext(companyId, "drain", { now: T0 + 5001 })?.id).toBe(request.id);
  });

  it("still lets a real failure spend the attempt it was given", () => {
    const taskId = seedTask();
    const { request } = requests.enqueue({ companyId, taskId, maxAttempts: 1, now: T0 });
    requests.claimNext(companyId, "drain", { now: T0 });
    requests.defer(request.id, "Agent belegt", { now: T0 });

    // Deferring did not spend the single attempt, so the next claim is a real
    // one — and failing it is final.
    const again = requests.claimNext(companyId, "drain", { now: T0 + DEFAULT_DEFER_MS + 1 })!;
    expect(again.attempts).toBe(1);
    expect(requests.fail(again.id, "kaputt", { now: T0 })!.status).toBe("dead");
  });

  it("refuses to defer a finished request", () => {
    const taskId = seedTask();
    const { request } = requests.enqueue({ companyId, taskId });
    requests.cancel(request.id);
    expect(() => requests.defer(request.id, "zu spät")).toThrow(RunRequestError);
  });

  it("returns null for a request that does not exist", () => {
    expect(requests.defer("rreq_nope", "x")).toBeNull();
  });
});
