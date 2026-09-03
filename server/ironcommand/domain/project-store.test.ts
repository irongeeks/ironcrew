import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { GoalStore } from "./goal-store.ts";
import { ProjectStore, ProjectMutationError } from "./project-store.ts";
import { InvalidProjectTransitionError, InvalidMilestoneTransitionError } from "./project-state.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: ProjectStore;
let goals: GoalStore;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  store = new ProjectStore(db);
  goals = new GoalStore(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

describe("create / read", () => {
  it("persists a project with defaults and a slugified key", () => {
    const p = store.create({ companyId, title: "Website Relaunch" });
    expect(p.company_id).toBe(companyId);
    expect(p.status).toBe("active");
    expect(p.key).toBe("website-relaunch");
    expect(p.goal_id).toBeNull();
  });

  it("strips diacritics and non-alphanumerics from the derived key", () => {
    const p = store.create({ companyId, title: "Übersicht: Q3-Planung!" });
    expect(p.key).toBe("ubersicht-q3-planung");
  });

  it("de-duplicates a colliding key rather than failing", () => {
    const a = store.create({ companyId, title: "Launch" });
    const b = store.create({ companyId, title: "Launch" });
    expect(a.key).toBe("launch");
    expect(b.key).not.toBe("launch");
    expect(b.key).toMatch(/^launch-\d+$/);
  });

  it("accepts an explicit key", () => {
    const p = store.create({ companyId, title: "Website Relaunch", key: "WR-2026" });
    expect(p.key).toBe("wr-2026");
  });

  it("links a project to a goal", () => {
    const goal = goals.create({ companyId, title: "Grow revenue" });
    const p = store.create({ companyId, title: "Pricing page", goalId: goal.id });
    expect(p.goal_id).toBe(goal.id);
  });

  it("refuses a goal that does not exist", () => {
    expect(() => store.create({ companyId, title: "x", goalId: "goal_nope" })).toThrow(ProjectMutationError);
  });

  it("refuses a goal from another company", () => {
    const otherCompany = seedCompany(db, "Other Co");
    const foreignGoal = goals.create({ companyId: otherCompany, title: "foreign" });
    expect(() => store.create({ companyId, title: "x", goalId: foreignGoal.id })).toThrow(ProjectMutationError);
  });

  it("links a project to its owner agent", () => {
    const agentId = seedAgent(db, companyId, "cto");
    const p = store.create({ companyId, title: "Infra overhaul", ownerAgentId: agentId });
    expect(p.owner_agent_id).toBe(agentId);
  });

  it("refuses an owner agent that does not exist", () => {
    expect(() => store.create({ companyId, title: "x", ownerAgentId: "agt_nope" })).toThrow(ProjectMutationError);
  });

  it("audits creation", () => {
    const p = store.create({ companyId, title: "Website Relaunch" });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    const rows = db.prepare("SELECT action FROM ic_audit_events WHERE entity_id = ?").all(p.id) as Array<{
      action: string;
    }>;
    expect(rows.map((r) => r.action)).toContain("project.created");
  });

  it("finds a project by its key", () => {
    const p = store.create({ companyId, title: "Website Relaunch" });
    expect(store.getByKey(companyId, "website-relaunch")!.id).toBe(p.id);
  });
});

describe("list", () => {
  it("filters by status", () => {
    const a = store.create({ companyId, title: "A" });
    store.setStatus(a.id, "on_hold");
    const b = store.create({ companyId, title: "B" });
    expect(store.list(companyId, { status: "active" }).map((p) => p.id)).toEqual([b.id]);
    expect(store.list(companyId, { status: "on_hold" }).map((p) => p.id)).toEqual([a.id]);
  });

  it("filters by goal", () => {
    const goal = goals.create({ companyId, title: "Grow revenue" });
    const p = store.create({ companyId, title: "A", goalId: goal.id });
    store.create({ companyId, title: "B" });
    expect(store.list(companyId, { goalId: goal.id }).map((x) => x.id)).toEqual([p.id]);
  });
});

describe("update", () => {
  it("changes title and summary", () => {
    const p = store.create({ companyId, title: "old" });
    const updated = store.update(p.id, { title: "new", summary: "why it matters" });
    expect(updated!.title).toBe("new");
    expect(updated!.summary).toBe("why it matters");
  });

  it("re-links to a different goal", () => {
    const goalA = goals.create({ companyId, title: "A" });
    const goalB = goals.create({ companyId, title: "B" });
    const p = store.create({ companyId, title: "x", goalId: goalA.id });
    const updated = store.update(p.id, { goalId: goalB.id });
    expect(updated!.goal_id).toBe(goalB.id);
  });

  it("unsets the goal when goalId is explicitly null", () => {
    const goal = goals.create({ companyId, title: "A" });
    const p = store.create({ companyId, title: "x", goalId: goal.id });
    const updated = store.update(p.id, { goalId: null });
    expect(updated!.goal_id).toBeNull();
  });

  it("returns null for a project that does not exist", () => {
    expect(store.update("prj_nope", { title: "x" })).toBeNull();
  });
});

describe("status transitions", () => {
  it("moves draft -> active -> done", () => {
    const p = store.create({ companyId, title: "A", status: "draft" });
    expect(store.setStatus(p.id, "active")!.status).toBe("active");
    expect(store.setStatus(p.id, "done")!.status).toBe("done");
  });

  it("rejects a transition out of a terminal state", () => {
    const p = store.create({ companyId, title: "A" });
    store.setStatus(p.id, "done");
    expect(() => store.setStatus(p.id, "active")).toThrow(InvalidProjectTransitionError);
  });

  it("audits every status change", () => {
    const p = store.create({ companyId, title: "A" });
    store.setStatus(p.id, "on_hold");
    const rows = db
      .prepare("SELECT action FROM ic_audit_events WHERE entity_id = ? AND action = 'project.status_changed'")
      .all(p.id);
    expect(rows).toHaveLength(1);
  });
});

describe("milestones", () => {
  it("adds a milestone to a project", () => {
    const p = store.create({ companyId, title: "Website Relaunch" });
    const m = store.addMilestone({ companyId, projectId: p.id, title: "Design freeze", dueAt: 1234 });
    expect(m.project_id).toBe(p.id);
    expect(m.status).toBe("pending");
    expect(m.due_at).toBe(1234);
  });

  it("refuses a milestone on a project that does not exist", () => {
    expect(() => store.addMilestone({ companyId, projectId: "prj_nope", title: "x" })).toThrow(ProjectMutationError);
  });

  it("refuses a milestone on a project from another company", () => {
    const otherCompany = seedCompany(db, "Other Co");
    const foreignProject = store.create({ companyId: otherCompany, title: "foreign" });
    expect(() => store.addMilestone({ companyId, projectId: foreignProject.id, title: "x" })).toThrow(
      ProjectMutationError,
    );
  });

  it("lists milestones in sort order", () => {
    const p = store.create({ companyId, title: "A" });
    const second = store.addMilestone({ companyId, projectId: p.id, title: "second", sortOrder: 2 });
    const first = store.addMilestone({ companyId, projectId: p.id, title: "first", sortOrder: 1 });
    expect(store.listMilestones(p.id).map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it("moves a milestone through pending -> done and sets completed_at", () => {
    const p = store.create({ companyId, title: "A" });
    const m = store.addMilestone({ companyId, projectId: p.id, title: "x" });
    const done = store.setMilestoneStatus(m.id, "done");
    expect(done!.status).toBe("done");
    expect(done!.completed_at).not.toBeNull();
  });

  it("allows rescheduling a missed milestone back to pending", () => {
    const p = store.create({ companyId, title: "A" });
    const m = store.addMilestone({ companyId, projectId: p.id, title: "x" });
    store.setMilestoneStatus(m.id, "missed");
    expect(store.setMilestoneStatus(m.id, "pending")!.status).toBe("pending");
  });

  it("rejects a transition out of a terminal milestone state", () => {
    const p = store.create({ companyId, title: "A" });
    const m = store.addMilestone({ companyId, projectId: p.id, title: "x" });
    store.setMilestoneStatus(m.id, "done");
    expect(() => store.setMilestoneStatus(m.id, "pending")).toThrow(InvalidMilestoneTransitionError);
  });

  it("updates a milestone's title, due date and sort order", () => {
    const p = store.create({ companyId, title: "A" });
    const m = store.addMilestone({ companyId, projectId: p.id, title: "old" });
    const updated = store.updateMilestone(m.id, { title: "new", dueAt: 9999, sortOrder: 5 });
    expect(updated!.title).toBe("new");
    expect(updated!.due_at).toBe(9999);
    expect(updated!.sort_order).toBe(5);
  });
});
