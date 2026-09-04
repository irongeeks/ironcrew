import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { DecisionStore } from "./decision-store.ts";
import { ProjectStore } from "./project-store.ts";
import { TaskStore } from "./task-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: DecisionStore;
let projects: ProjectStore;
let tasks: TaskStore;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  store = new DecisionStore(db);
  projects = new ProjectStore(db);
  tasks = new TaskStore(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

describe("create / read", () => {
  it("persists a decision with defaults", () => {
    const d = store.create({ companyId, title: "Bank transfer approved", decision: "approved", decidedBy: "ceo" });
    expect(d.company_id).toBe(companyId);
    expect(d.decision).toBe("approved");
    expect(d.context).toBe("");
    expect(d.rationale).toBe("");
  });

  it("carries a project and task reference", () => {
    const project = projects.create({ companyId, title: "Website Relaunch" });
    const task = tasks.create({ companyId, title: "x", status: "ready" });
    const d = store.create({
      companyId,
      title: "x",
      decision: "approved",
      decidedBy: "ceo",
      projectId: project.id,
      taskId: task.id,
    });
    expect(d.project_id).toBe(project.id);
    expect(d.task_id).toBe(task.id);
  });

  it("audits the decision", () => {
    const d = store.create({ companyId, title: "x", decision: "approved", decidedBy: "ceo" });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    const rows = db.prepare("SELECT action FROM crew_audit_events WHERE entity_id = ?").all(d.id) as Array<{
      action: string;
    }>;
    expect(rows.map((r) => r.action)).toContain("decision.recorded");
  });
});

describe("list", () => {
  it("orders newest first", () => {
    const a = store.create({ companyId, title: "A", decision: "approved", decidedBy: "ceo" });
    const b = store.create({ companyId, title: "B", decision: "approved", decidedBy: "ceo" });
    expect(store.list(companyId).map((d) => d.id)).toEqual([b.id, a.id]);
  });

  it("filters by task", () => {
    const taskA = tasks.create({ companyId, title: "A", status: "ready" });
    const taskB = tasks.create({ companyId, title: "B", status: "ready" });
    const a = store.create({ companyId, title: "A", decision: "approved", decidedBy: "ceo", taskId: taskA.id });
    store.create({ companyId, title: "B", decision: "approved", decidedBy: "ceo", taskId: taskB.id });
    expect(store.list(companyId, { taskId: taskA.id }).map((d) => d.id)).toEqual([a.id]);
  });

  it("is scoped to the company", () => {
    const other = seedCompany(db, "Other Co");
    store.create({ companyId: other, title: "foreign", decision: "approved", decidedBy: "ceo" });
    expect(store.list(companyId)).toEqual([]);
  });
});
