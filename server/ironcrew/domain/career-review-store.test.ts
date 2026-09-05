import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { CareerReviewStore } from "./career-review-store.ts";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { TaskStore } from "./task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ApprovalEngine } from "../policy/approval-policy.ts";
import { ApprovalReviewStore } from "./approval-review-store.ts";
import { UserStore } from "../auth/user-store.ts";
import { verifyAuditChain } from "./audit.ts";
let db: DatabaseSync, c: string, worker: string, lead: string, qa: string, dept: string, store: CareerReviewStore;
beforeEach(() => {
  db = createTestDb();
  c = seedCompany(db);
  worker = seedAgent(db, c, "worker");
  lead = seedAgent(db, c, "lead");
  qa = seedAgent(db, c, "qa");
  dept = "dept-test";
  db.prepare("INSERT INTO crew_departments(id,company_id,key,name) VALUES (?,?,?,?)").run(
    dept,
    c,
    "engineering",
    "Engineering",
  );
  db.prepare("UPDATE crew_agents SET department_id=? WHERE company_id=?").run(dept, c);
  db.prepare("INSERT INTO crew_career_levels VALUES (?,?,1,'lead','seed-lead',?)").run(c, lead, Date.now());
  store = new CareerReviewStore(db);
  store.updateConfig(
    c,
    {
      baseRevision: 0,
      enabled: true,
      departments: [{ departmentId: dept, enabled: true, leadAgentId: lead, fallbackReviewerAgentId: qa }],
    },
    "ceo",
  );
});
afterEach(() => db.close());
function task(agentId = worker) {
  return new TaskStore(db).create({ companyId: c, title: "Work", assignedAgentId: agentId, status: "ready" });
}
function run(taskId: string, agentId: string, model = "actual-model") {
  const r = new RunStore(db).create({
    companyId: c,
    taskId,
    agentId,
    runtimeType: "codex",
    model,
    routingVesselId: "actual-vessel",
  });
  db.prepare("UPDATE crew_runs SET status='completed',ended_at=? WHERE id=?").run(Date.now(), r.id);
  return r;
}
function review(work = task(), model = "actual-model", reviewer = lead) {
  const w = run(work.id, work.assigned_agent_id!, model);
  const rt = task(reviewer);
  const link = store.createReview(c, {
    workTaskId: work.id,
    workRunId: w.id,
    internalTaskId: rt.id,
    reviewerAgentId: reviewer,
    difficulty: "normal",
  });
  const rr = run(rt.id, reviewer, "review-model");
  return { work, w, rt, link, rr };
}
const result = (reviewRunId: string, score = 4) => ({
  reviewRunId,
  score,
  rationale: "Geprüft anhand konkreter Ergebnisse.",
  rubricDimensions: { correctness: 4, completeness: 4, quality: 4 },
  evidence: ["Arbeitsrun und Ergebnis geprüft"],
});
describe("career governance", () => {
  it("keeps grades separate, requires approval, quorum and version, persists across service restart", async () => {
    const owner = await new UserStore(db).create({
      email: "owner@example.invalid",
      password: "a-test-password",
      role: "owner",
    });
    const a = store.requestLevel(
      c,
      worker,
      { baseRevision: 0, level: "junior", reason: "Einfache Aufträge" },
      owner.id,
    );
    expect(store.forAgent(c, worker).level).toBe("senior");
    expect(store.settleApproval(c, a.approval.id)).toBeNull();
    const reviews = new ApprovalReviewStore(db);
    reviews.record({ approvalId: a.approval.id, reviewerId: owner.id, verdict: "approved" });
    new ApprovalEngine(db).decide(a.approval.id, "approved", owner.id);
    expect(new CareerReviewStore(db).settleApproval(c, a.approval.id)?.level).toBe("junior");
    expect(store.settleApproval(c, a.approval.id)?.revision).toBe(1);
    expect(() => store.requestLevel(c, worker, { baseRevision: 0, level: "lead", reason: "old" }, owner.id)).toThrow(
      /geändert/,
    );
    expect(
      db
        .prepare("SELECT professional_role FROM crew_talents WHERE id=(SELECT talent_id FROM crew_agents WHERE id=?)")
        .get(worker),
    ).toMatchObject({ professional_role: "worker" });
    expect(verifyAuditChain(db, c).valid).toBe(true);
  });
  it("rejects cross-company, stale config and unapproved lead assignment", () => {
    const foreign = seedAgent(db, seedCompany(db), "foreign");
    expect(() => store.forAgent(c, foreign)).toThrow(/Firma/);
    expect(() => store.updateConfig(c, { baseRevision: 0, enabled: false, departments: [] }, "ceo")).toThrow(
      /geändert/,
    );
    expect(() =>
      store.updateConfig(
        c,
        {
          baseRevision: 1,
          enabled: true,
          departments: [{ departmentId: dept, enabled: true, leadAgentId: worker, fallbackReviewerAgentId: qa }],
        },
        "ceo",
      ),
    ).toThrow(/Lead/);
  });
  it("does not accept key alone as QA authority", () => {
    db.prepare(
      "UPDATE crew_talents SET professional_role='sales' WHERE id=(SELECT talent_id FROM crew_agents WHERE id=?)",
    ).run(qa);
    expect(() =>
      store.updateConfig(
        c,
        {
          baseRevision: 1,
          enabled: true,
          departments: [{ departmentId: dept, enabled: true, leadAgentId: lead, fallbackReviewerAgentId: qa }],
        },
        "ceo",
      ),
    ).toThrow(/QA/);
  });
});
describe("run-bound immutable reviews", () => {
  it("binds work runtime/model/vessel independent of changed agent profile and rejects mutable scores", () => {
    const f = review();
    db.prepare("UPDATE crew_vessels SET model='changed' WHERE id=(SELECT vessel_id FROM crew_agents WHERE id=?)").run(
      worker,
    );
    const rating = store.completeReview(c, f.link.id, result(f.rr.id));
    expect(rating).toMatchObject({
      model: "actual-model",
      runtimeType: "codex",
      vesselId: "actual-vessel",
      reviewerAgentId: lead,
      isCurrent: true,
    });
    expect(() => db.prepare("UPDATE crew_career_reviews SET score=5 WHERE id=?").run(rating.id)).toThrow(/immutable/);
    expect(() => store.completeReview(c, f.link.id, result(f.rr.id))).toThrow(/offen/);
    expect(verifyAuditChain(db, c).valid).toBe(true);
  });
  it("rejects self-review, foreign evidence, wrong reviewer and uncompleted runs", () => {
    const t = task(lead),
      w = run(t.id, lead);
    expect(() =>
      store.createReview(c, {
        workTaskId: t.id,
        workRunId: w.id,
        internalTaskId: task(lead).id,
        reviewerAgentId: lead,
        difficulty: "simple",
      }),
    ).toThrow(/Selbst/);
    const f = review();
    expect(() => store.completeReview(c, f.link.id, result(w.id))).toThrow(/Reviewrun/);
    db.prepare("UPDATE crew_runs SET status='running' WHERE id=?").run(f.rr.id);
    expect(() => store.completeReview(c, f.link.id, result(f.rr.id))).toThrow(/Abgeschlossener/);
  });
  it("revalidates current reviewer role on completion and validates score range and integer", () => {
    const f = review();
    expect(() => store.completeReview(c, f.link.id, result(f.rr.id, 5.5))).toThrow();
    expect(() => store.completeReview(c, f.link.id, result(f.rr.id, 0))).toThrow();
    store.updateConfig(c, { baseRevision: 1, enabled: false, departments: [] }, "ceo");
    expect(() => store.completeReview(c, f.link.id, result(f.rr.id))).toThrow(/Abteilungsleitung/);
  });
  it("permits explicit QA fallback only for lead own work", () => {
    const f = review(task(lead), "lead-model", qa);
    expect(store.completeReview(c, f.link.id, result(f.rr.id)).reviewerAgentId).toBe(qa);
    expect(() => review(task(worker), "model", qa)).toThrow(/Abteilungsleitung/);
  });
  it("counts each current task once, preserves late historical reviews and scopes filters", () => {
    const original = task();
    const first = review(original, "old");
    const second = review(original, "new");
    store.completeReview(c, second.link.id, result(second.rr.id, 5));
    store.completeReview(c, first.link.id, result(first.rr.id, 1));
    let snap = store.snapshot(c);
    expect(snap.reviews).toHaveLength(2);
    expect(snap.aggregates.agents[0]).toMatchObject({ count: 1, mean: 5, revisions: 1 });
    expect(snap.reviews.find((r) => r.workRunId === first.w.id)?.isCurrent).toBe(false);
    expect(store.snapshot(c, { model: "old" }).aggregates.agents).toHaveLength(0);
    const third = review(task(), "new");
    store.completeReview(c, third.link.id, result(third.rr.id, 3));
    snap = store.snapshot(c);
    expect(snap.aggregates.agents[0]).toMatchObject({ count: 2, mean: 4 });
    expect(snap.aggregates.models).toHaveLength(1);
    expect(store.snapshot(seedCompany(db)).reviews).toHaveLength(0);
  });
  it("retains owner-required evidence without fabricating a score", () => {
    const t = task(),
      w = run(t.id, worker);
    const l = store.createReview(c, {
      workTaskId: t.id,
      workRunId: w.id,
      internalTaskId: null,
      reviewerAgentId: null,
      difficulty: "complex",
    });
    expect(l.status).toBe("owner_required");
    expect(store.snapshot(c).reviews).toHaveLength(0);
  });
});

describe("routing and approval boundaries", () => {
  it("enforces junior difficulty/risk and rejects stale routing replay", () => {
    db.prepare("INSERT INTO crew_career_levels VALUES (?,?,1,'junior','seed-junior',?)").run(c, worker, Date.now());
    const root = task(),
      internal = task(lead);
    const l = store.createRouting(c, { taskId: root.id, internalTaskId: internal.id, leadAgentId: lead });
    const r = run(internal.id, lead);
    const output = {
      runId: r.id,
      assignedAgentId: worker,
      difficulty: "complex" as const,
      rationale: "Zuordnung geprüft",
    };
    expect(() => store.completeRouting(c, l.id, output)).toThrow(/Junior/);
    db.prepare("UPDATE crew_tasks SET sensitive=1 WHERE id=?").run(root.id);
    expect(() => store.completeRouting(c, l.id, { ...output, difficulty: "simple" })).toThrow(/Junior/);
    db.prepare("UPDATE crew_tasks SET sensitive=0 WHERE id=?").run(root.id);
    expect(store.completeRouting(c, l.id, { ...output, difficulty: "simple" }).status).toBe("completed");
    expect(() => store.completeRouting(c, l.id, { ...output, difficulty: "simple" })).toThrow(/abgeschlossen/);
  });
  it("checks completed evidence company and reviewer role again after the job was queued", () => {
    const f = review(task(lead), "work", qa);
    db.prepare(
      "UPDATE crew_talents SET professional_role='sales' WHERE id=(SELECT talent_id FROM crew_agents WHERE id=?)",
    ).run(qa);
    expect(() => store.completeReview(c, f.link.id, result(f.rr.id))).toThrow(/QA/);
    const other = seedCompany(db);
    expect(() => store.completeReview(other, f.link.id, result(f.rr.id))).toThrow(/Firma/);
  });
  it("does not apply incomplete quorum, tampered actions or a stale approved grade", async () => {
    const owner = await new UserStore(db).create({
      email: "owner2@example.invalid",
      password: "a-test-password",
      role: "owner",
    });
    const request = () =>
      store.requestLevel(c, worker, { baseRevision: 0, level: "junior", reason: "Kontrollierte Aufgaben" }, owner.id);
    const first = request(),
      second = request();
    new ApprovalReviewStore(db).record({ approvalId: first.approval.id, reviewerId: owner.id, verdict: "approved" });
    db.prepare("UPDATE crew_approvals SET required_approvals=2 WHERE id=?").run(first.approval.id);
    new ApprovalEngine(db).decide(first.approval.id, "approved", owner.id);
    expect(store.settleApproval(c, first.approval.id)).toBeNull();
    db.prepare("UPDATE crew_approvals SET required_approvals=1 WHERE id=?").run(first.approval.id);
    const original = first.approval.proposed_action;
    db.prepare("UPDATE crew_approvals SET proposed_action='{}' WHERE id=?").run(first.approval.id);
    expect(() => store.settleApproval(c, first.approval.id)).toThrow(/Freigabe/);
    db.prepare("UPDATE crew_approvals SET proposed_action=? WHERE id=?").run(original, first.approval.id);
    expect(store.settleApproval(c, first.approval.id)?.revision).toBe(1);
    new ApprovalReviewStore(db).record({ approvalId: second.approval.id, reviewerId: owner.id, verdict: "approved" });
    new ApprovalEngine(db).decide(second.approval.id, "approved", owner.id);
    expect(store.settleApproval(c, second.approval.id)).toBeNull();
    expect(store.snapshot(c).pendingChanges.find((x) => x.id === second.change.id)?.status).toBe("stale");
  });
});
it("allows only explicit owner recovery of failed links and never reopens completed evidence", async () => {
  const f = review();
  store.failLink(c, f.link.id, "Ungültige Ausgabe");
  expect(() => store.reopenLink(c, f.link.id, "intruder")).toThrow(/Owner/);
  expect(store.reopenLink(c, f.link.id, "ceo").status).toBe("pending");
  store.completeReview(c, f.link.id, result(f.rr.id));
  expect(() => store.reopenLink(c, f.link.id, "ceo")).toThrow(/fehlgeschlagene/);
});
it("snapshots existing tasks on activation without depending on clocks, preserving already enrolled workflows", () => {
  store.updateConfig(c, { baseRevision: 1, enabled: false, departments: [] }, "ceo");
  const old = task();
  store.updateConfig(
    c,
    {
      baseRevision: 2,
      enabled: true,
      departments: [{ departmentId: dept, enabled: true, leadAgentId: lead, fallbackReviewerAgentId: qa }],
    },
    "ceo",
  );
  const current = task();
  expect(store.appliesToTask(c, old.id)).toBe(false);
  expect(store.appliesToTask(c, current.id)).toBe(true);
  const internal = task(lead);
  store.createRouting(c, { taskId: current.id, internalTaskId: internal.id, leadAgentId: lead });
  store.updateConfig(c, { baseRevision: 3, enabled: false, departments: [] }, "ceo");
  store.updateConfig(
    c,
    {
      baseRevision: 4,
      enabled: true,
      departments: [{ departmentId: dept, enabled: true, leadAgentId: lead, fallbackReviewerAgentId: qa }],
    },
    "ceo",
  );
  expect(store.appliesToTask(c, current.id)).toBe(true);
  expect(store.appliesToTask(c, old.id)).toBe(false);
});
