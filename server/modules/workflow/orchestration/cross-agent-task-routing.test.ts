import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createCrossAgentTaskRouter } from "./cross-agent-task-routing.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      department_id TEXT,
      current_task_id TEXT,
      cli_provider TEXT,
      personality TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      assigned_agent_id TEXT,
      status TEXT NOT NULL,
      workflow_meta_json TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("cross-agent-task-routing", () => {
  it("picks least-busy qualified specialist", () => {
    const db = setupDb();
    try {
      db.prepare(
        `
          INSERT INTO agents (id, name, role, status, department_id, current_task_id, cli_provider, personality, created_at)
          VALUES
            ('design-lead', 'Design Lead', 'team_leader', 'working', 'design', 't1', 'claude', 'design systems', 1),
            ('design-exec-busy', 'Design Busy', 'senior', 'working', 'design', 't2', 'codex', 'ui ux', 2),
            ('design-exec-idle', 'Design Idle', 'senior', 'idle', 'design', NULL, 'codex', 'ui ux docs', 3)
        `,
      ).run();

      db.prepare(
        `
          INSERT INTO tasks (id, title, description, assigned_agent_id, status, workflow_meta_json, updated_at)
          VALUES
            ('t1', 'busy1', '', 'design-exec-busy', 'in_progress', NULL, 1),
            ('t2', 'busy2', '', 'design-exec-busy', 'planned', NULL, 1)
        `,
      ).run();

      const router = createCrossAgentTaskRouter({ db: db as any, nowMs: () => 1000 });
      const plan = router.planRouting({
        parentTask: {
          id: "parent-1",
          title: "Create UI/UX wireframe and docs",
          description: "Need design and documentation handoff",
          department_id: "planning",
        },
        subtasks: [{ id: "s1", title: "Design mockup", description: "UI layout", target_department_id: "design" }],
        targetDepartmentId: "design",
        coordinator: db.prepare("SELECT * FROM agents WHERE id = 'design-lead'").get() as any,
        executorFallback: db.prepare("SELECT * FROM agents WHERE id = 'design-exec-busy'").get() as any,
        originLeaderId: "planning-lead",
        candidateAgentIds: ["design-lead", "design-exec-busy", "design-exec-idle"],
      });

      expect(plan.selected.executor_agent_id).toBe("design-exec-idle");
      expect(plan.router.required_specializations).toContain("design");
    } finally {
      db.close();
    }
  });

  it("persists chain progress and rollback in workflow_meta_json", () => {
    const db = setupDb();
    try {
      db.prepare(
        `
          INSERT INTO agents (id, name, role, status, department_id, current_task_id, cli_provider, personality, created_at)
          VALUES ('exec-1', 'Exec', 'senior', 'idle', 'dev', NULL, 'codex', 'backend', 1)
        `,
      ).run();
      db.prepare(
        `
          INSERT INTO tasks (id, title, description, assigned_agent_id, status, workflow_meta_json, updated_at)
          VALUES ('delegated-1', 'delegated', '', 'exec-1', 'planned', NULL, 1)
        `,
      ).run();

      const router = createCrossAgentTaskRouter({ db: db as any, nowMs: () => 2000 });
      const plan = router.planRouting({
        parentTask: {
          id: "parent-2",
          title: "Implement API endpoint",
          description: "code fix",
          department_id: "dev",
        },
        subtasks: [{ id: "s2", title: "Code fix", description: "bug", target_department_id: "dev" }],
        targetDepartmentId: "dev",
        coordinator: db.prepare("SELECT * FROM agents WHERE id = 'exec-1'").get() as any,
        executorFallback: db.prepare("SELECT * FROM agents WHERE id = 'exec-1'").get() as any,
        originLeaderId: "dev-lead",
        candidateAgentIds: ["exec-1"],
      });

      router.attachDelegationMeta("delegated-1", plan);
      router.updateChainStep("delegated-1", "origin_to_coordinator", "completed", "ack");
      router.markRollback("delegated-1", "launch failed");

      const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get("delegated-1") as
        | { workflow_meta_json: string }
        | undefined;
      const parsed = JSON.parse(String(row?.workflow_meta_json ?? "{}"));
      const steps = parsed?.cross_agent_routing?.chain?.steps as Array<{ step: string; status: string; note: string }>;
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.find((entry) => entry.step === "origin_to_coordinator")?.status).toBe("completed");
      expect(steps.find((entry) => entry.step === "coordinator_to_executor")?.status).toBe("rolled_back");
    } finally {
      db.close();
    }
  });
});
