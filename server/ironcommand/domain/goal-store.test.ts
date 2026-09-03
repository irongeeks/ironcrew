import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { GoalStore, GoalMutationError } from "./goal-store.ts";
import { InvalidGoalTransitionError } from "./goal-state.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: GoalStore;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  store = new GoalStore(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

describe("create / read", () => {
  it("persists a goal with defaults", () => {
    const g = store.create({ companyId, title: "Grow revenue 20%" });
    expect(g.company_id).toBe(companyId);
    expect(g.status).toBe("active");
    expect(g.parent_id).toBeNull();
    expect(g.description).toBe("");
  });

  it("links a child to its parent", () => {
    const parent = store.create({ companyId, title: "Grow revenue" });
    const child = store.create({ companyId, title: "Ship the pricing page", parentId: parent.id });
    expect(child.parent_id).toBe(parent.id);
  });

  it("refuses a parent that does not exist", () => {
    expect(() => store.create({ companyId, title: "orphan", parentId: "goal_nope" })).toThrow(GoalMutationError);
  });

  it("refuses a parent from another company", () => {
    const otherCompany = seedCompany(db, "Other Co");
    const foreignParent = store.create({ companyId: otherCompany, title: "foreign" });
    expect(() => store.create({ companyId, title: "child", parentId: foreignParent.id })).toThrow(GoalMutationError);
  });

  it("audits creation", () => {
    const g = store.create({ companyId, title: "Grow revenue 20%" });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    const rows = db.prepare("SELECT action FROM ic_audit_events WHERE entity_id = ?").all(g.id) as Array<{
      action: string;
    }>;
    expect(rows.map((r) => r.action)).toContain("goal.created");
  });
});

describe("list / children", () => {
  it("filters by status", () => {
    const a = store.create({ companyId, title: "A" });
    store.setStatus(a.id, "on_hold");
    const b = store.create({ companyId, title: "B" });
    expect(store.list(companyId, { status: "active" }).map((g) => g.id)).toEqual([b.id]);
    expect(store.list(companyId, { status: "on_hold" }).map((g) => g.id)).toEqual([a.id]);
  });

  it("filters to top-level goals with parentId: null", () => {
    const root = store.create({ companyId, title: "root" });
    store.create({ companyId, title: "child", parentId: root.id });
    expect(store.list(companyId, { parentId: null }).map((g) => g.id)).toEqual([root.id]);
  });

  it("lists direct children only, not grandchildren", () => {
    const root = store.create({ companyId, title: "root" });
    const child = store.create({ companyId, title: "child", parentId: root.id });
    store.create({ companyId, title: "grandchild", parentId: child.id });
    expect(store.children(root.id).map((g) => g.id)).toEqual([child.id]);
  });
});

describe("ancestry", () => {
  it("returns the chain from root to the goal itself", () => {
    const root = store.create({ companyId, title: "Grow the company" });
    const mid = store.create({ companyId, title: "Grow revenue", parentId: root.id });
    const leaf = store.create({ companyId, title: "Ship pricing page", parentId: mid.id });
    expect(store.ancestry(leaf.id).map((g) => g.title)).toEqual([
      "Grow the company",
      "Grow revenue",
      "Ship pricing page",
    ]);
  });

  it("is a single-element chain for a top-level goal", () => {
    const root = store.create({ companyId, title: "root" });
    expect(store.ancestry(root.id).map((g) => g.id)).toEqual([root.id]);
  });

  it("is empty for a goal that does not exist", () => {
    expect(store.ancestry("goal_nope")).toEqual([]);
  });
});

describe("reparent", () => {
  it("moves a goal under a new parent", () => {
    const a = store.create({ companyId, title: "A" });
    const b = store.create({ companyId, title: "B" });
    const moved = store.reparent(b.id, a.id);
    expect(moved!.parent_id).toBe(a.id);
  });

  it("moves a goal to the top level with null", () => {
    const a = store.create({ companyId, title: "A" });
    const b = store.create({ companyId, title: "B", parentId: a.id });
    const moved = store.reparent(b.id, null);
    expect(moved!.parent_id).toBeNull();
  });

  it("refuses to become its own parent", () => {
    const a = store.create({ companyId, title: "A" });
    expect(() => store.reparent(a.id, a.id)).toThrow(GoalMutationError);
  });

  it("refuses a move that would create a cycle", () => {
    const root = store.create({ companyId, title: "root" });
    const child = store.create({ companyId, title: "child", parentId: root.id });
    const grandchild = store.create({ companyId, title: "grandchild", parentId: child.id });
    // root -> child -> grandchild; moving root under grandchild would loop.
    expect(() => store.reparent(root.id, grandchild.id)).toThrow(/cycle/);
  });

  it("returns null for a goal that does not exist", () => {
    expect(store.reparent("goal_nope", null)).toBeNull();
  });
});

describe("status transitions", () => {
  it("moves active -> on_hold -> active", () => {
    const g = store.create({ companyId, title: "A" });
    expect(store.setStatus(g.id, "on_hold")!.status).toBe("on_hold");
    expect(store.setStatus(g.id, "active")!.status).toBe("active");
  });

  it("rejects a transition out of a terminal state", () => {
    const g = store.create({ companyId, title: "A" });
    store.setStatus(g.id, "achieved");
    expect(() => store.setStatus(g.id, "active")).toThrow(InvalidGoalTransitionError);
  });

  it("audits every status change", () => {
    const g = store.create({ companyId, title: "A" });
    store.setStatus(g.id, "achieved");
    const rows = db
      .prepare("SELECT action FROM ic_audit_events WHERE entity_id = ? AND action = 'goal.status_changed'")
      .all(g.id);
    expect(rows).toHaveLength(1);
  });
});

describe("update", () => {
  it("changes title and description without touching status or parent", () => {
    const g = store.create({ companyId, title: "old", parentId: null });
    const updated = store.update(g.id, { title: "new", description: "why it matters" });
    expect(updated!.title).toBe("new");
    expect(updated!.description).toBe("why it matters");
    expect(updated!.status).toBe("active");
  });

  it("returns null for a goal that does not exist", () => {
    expect(store.update("goal_nope", { title: "x" })).toBeNull();
  });
});
