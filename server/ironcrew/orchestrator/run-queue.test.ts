/**
 * The queue between "this should run" and "this is running".
 *
 * The behaviour these tests protect is mostly about what the queue *refuses*
 * to do: it does not run work nobody delegated, it does not spend an attempt
 * on a task that never started, and it does not lose a run request when the
 * process holding it dies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { DEFAULT_LEASE_TTL_MS } from "../domain/run-request-store.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import type { RunEvent } from "../runtime/run-events.ts";
import { StubRuntime } from "../runtime/__fixtures__/stub-runtime.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Fertig." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
});

afterEach(() => db.close());

/** A runtime that always fails, to exercise the attempt budget. */
class BrokenRuntime extends StubRuntime {
  constructor() {
    super("broken");
  }
  // eslint-disable-next-line require-yield
  async *startRun(): AsyncIterable<RunEvent> {
    throw new Error("Runtime kaputt.");
  }
}

function setVessel(patch: Record<string, string | number>): void {
  const columns = Object.keys(patch)
    .map((c) => `${c} = ?`)
    .join(", ");
  db.prepare(`UPDATE crew_vessels SET ${columns} WHERE company_id = ?`).run(...Object.values(patch), companyId);
}

describe("delegation records intent that outlives the process", () => {
  it("enqueues a run when the EA delegates", () => {
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");

    const request = orc.runRequests.liveForTask(result.task!.id);
    expect(request).not.toBeNull();
    expect(request!.status).toBe("queued");
    expect(request!.requested_by).toBe("ceo");
  });

  it("does not enqueue work that was never delegated", () => {
    // A status question the EA answers itself creates no task, so there is
    // nothing to run — and nothing must appear in the queue.
    const result = orc.handleCeoMessage(companyId, "Wie ist der Status?");
    expect(result.task).toBeNull();
    expect(orc.runRequests.list(companyId)).toHaveLength(0);
  });

  it("does not enqueue a task that is waiting on an approval", () => {
    const result = orc.handleCeoMessage(companyId, "Bitte überweise 100 EUR an den Lieferanten.");
    if (result.task) {
      // Sensitive work is parked behind an approval; the queue must not
      // quietly start it before a human decided.
      expect(orc.runRequests.liveForTask(result.task.id)).toBeNull();
    }
    expect(orc.runRequests.list(companyId)).toHaveLength(0);
  });

  it("enqueues again when the owner asks for a revision", async () => {
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.");
    await orc.drainRunQueue(companyId);
    expect(orc.runRequests.liveForTask(result.task!.id)).toBeNull();

    orc.requestRevision(companyId, result.task!.id, "Zu knapp.");
    expect(orc.runRequests.liveForTask(result.task!.id)?.status).toBe("queued");
  });

  it("asks for the same task only once, however many ingresses ask", () => {
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    const again = orc.enqueueRun(companyId, result.task!.id, { requestedBy: "mail:mbx_1" });

    expect(again!.isNew).toBe(false);
    expect(orc.runRequests.list(companyId)).toHaveLength(1);
  });

  it("returns null for a task that does not exist", () => {
    expect(orc.enqueueRun(companyId, "task_nope")).toBeNull();
  });
});

describe("draining turns intent into runs", () => {
  it("runs a queued request and marks it done", async () => {
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    const drained = await orc.drainRunQueue(companyId);

    expect(drained).toEqual({ claimed: 1, completed: 1, failed: 0, deferred: 0 });
    expect(orc.tasks.get(result.task!.id)!.status).toBe("review");

    const request = orc.runRequests.list(companyId)[0];
    expect(request.status).toBe("done");
    expect(request.run_id).not.toBeNull();
  });

  it("does nothing when the queue is empty", async () => {
    expect(await orc.drainRunQueue(companyId)).toEqual({ claimed: 0, completed: 0, failed: 0, deferred: 0 });
  });

  it("stops at the limit rather than starting everything at once", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren A.");
    orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren B.");
    orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren C.");

    const drained = await orc.drainRunQueue(companyId, { limit: 2 });
    expect(drained.claimed).toBe(2);
    expect(orc.runRequests.list(companyId, { status: "queued" }).length).toBeGreaterThan(0);
  });

  it("empties the queue over repeated drains", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren A.");
    orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren B.");

    await orc.drainRunQueue(companyId, { limit: 1 });
    await orc.drainRunQueue(companyId, { limit: 1 });

    expect(orc.runRequests.list(companyId, { status: "queued" })).toHaveLength(0);
    expect(orc.runRequests.list(companyId, { status: "done" })).toHaveLength(2);
  });
});

describe("a busy company defers rather than failing", () => {
  it("does not spend an attempt when the vessel is full", async () => {
    setVessel({ max_concurrency: 1 });
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");

    // Occupy the vessel's only seat with a live run.
    const agent = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!;
    const busy = orc.tasks.create({ companyId, title: "Läuft", description: "x", status: "inbox" });
    const run = orc.runs.create({ companyId, taskId: busy.id, agentId: agent.id, runtimeType: "mock" });
    db.prepare("UPDATE crew_runs SET status = 'running', heartbeat_at = ? WHERE id = ?").run(Date.now(), run.id);

    const drained = await orc.drainRunQueue(companyId);

    expect(drained.deferred).toBe(1);
    expect(drained.failed).toBe(0);
    const request = orc.runRequests.liveForTask(result.task!.id)!;
    // The whole point: being busy must not eat the request's budget.
    expect(request.attempts).toBe(0);
    expect(request.status).toBe("queued");
    expect(request.not_before).toBeGreaterThan(Date.now());
  });

  it("runs it later, once the company is free again", async () => {
    setVessel({ max_concurrency: 1 });
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");

    const agent = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!;
    const busy = orc.tasks.create({ companyId, title: "Läuft", description: "x", status: "inbox" });
    const run = orc.runs.create({ companyId, taskId: busy.id, agentId: agent.id, runtimeType: "mock" });
    db.prepare("UPDATE crew_runs SET status = 'running', heartbeat_at = ? WHERE id = ?").run(Date.now(), run.id);

    await orc.drainRunQueue(companyId);

    // The seat frees, and the deferral's delay passes.
    orc.runs.setStatus(run.id, "completed");
    const request = orc.runRequests.liveForTask(result.task!.id)!;
    db.prepare("UPDATE crew_run_requests SET not_before = 0 WHERE id = ?").run(request.id);

    const second = await orc.drainRunQueue(companyId);
    expect(second.completed).toBe(1);
    expect(orc.tasks.get(result.task!.id)!.status).toBe("review");
  });
});

describe("a failing run spends its attempts and then stops", () => {
  it("retries up to the vessel's budget, then dead-letters", async () => {
    orc.registerRuntime(new BrokenRuntime());
    setVessel({ runtime_provider: "broken", max_retries: 1 });

    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    const requestId = orc.runRequests.liveForTask(result.task!.id)!.id;
    // max_retries 1 means two attempts in total: the first go is not a retry.
    expect(orc.runRequests.get(requestId)!.max_attempts).toBe(2);

    const first = await orc.drainRunQueue(companyId);
    expect(first.failed).toBe(1);
    expect(orc.runRequests.get(requestId)!.status).toBe("queued");

    // Backoff is real time; the test moves the clock rather than waiting.
    db.prepare("UPDATE crew_run_requests SET not_before = 0 WHERE id = ?").run(requestId);

    const second = await orc.drainRunQueue(companyId);
    expect(second.failed).toBe(1);

    const dead = orc.runRequests.get(requestId)!;
    expect(dead.status).toBe("dead");
    expect(dead.last_error).toBeTruthy();
  });

  it("leaves a dead request alone on the next drain", async () => {
    orc.registerRuntime(new BrokenRuntime());
    setVessel({ runtime_provider: "broken", max_retries: 0 });

    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    await orc.drainRunQueue(companyId);
    expect(orc.runRequests.list(companyId, { status: "dead" })).toHaveLength(1);

    // A dead letter is a request for a human, not something the drain keeps
    // chewing on.
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
  });
});

describe("a crashed drain does not strand the queue", () => {
  it("reclaims a request whose lease expired", async () => {
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    const requestId = orc.runRequests.liveForTask(result.task!.id)!.id;

    // Claimed by a drain that then died: still `running`, lease long gone.
    orc.runRequests.claimNext(companyId, "drain:dead");
    db.prepare("UPDATE crew_run_requests SET lease_expires_at = ? WHERE id = ?").run(
      Date.now() - DEFAULT_LEASE_TTL_MS,
      requestId,
    );

    const drained = await orc.drainRunQueue(companyId);
    expect(drained.claimed).toBe(1);
    expect(orc.runRequests.get(requestId)!.status).toBe("done");
  });
});

it("keeps the audit chain intact across a full cycle", async () => {
  orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
  await orc.drainRunQueue(companyId);
  expect(verifyAuditChain(db, companyId).valid).toBe(true);
});
