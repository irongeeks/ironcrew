import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleAutoRetry, handleHardFailure } from "../../../modules/workflow/orchestration/run-complete-failure.ts";
import * as assignment from "../../../modules/routes/core/tasks/execution-run-auto-assign.ts";
import { agentFixture, translations } from "../../../modules/workflow/orchestration/test-fixtures.ts";

describe("run-complete-failure exports", () => {
  it("handleAutoRetry is a function", () => {
    expect(typeof handleAutoRetry).toBe("function");
  });

  it("handleHardFailure is a function", () => {
    expect(typeof handleHardFailure).toBe("function");
  });
});

describe("auto-retry attribution", () => {
  it.each([true, false])(
    "logs the previously assigned agent (row present: %s), then persists reassignment",
    (present) => {
      const db = new DatabaseSync(":memory:");
      const previous = agentFixture({ id: "previous-agent", name: "Previous operator" });
      const replacement = { ...agentFixture({ id: "replacement-agent", name: "Replacement operator" }), created_at: 0 };
      const select = vi
        .spyOn(assignment, "selectAgentForDepartment")
        .mockReturnValue({ packKey: "development", agent: replacement });
      try {
        db.exec(`CREATE TABLE agents (${Object.keys(previous)
          .map((key) => `"${key}" TEXT`)
          .join(",")});
        CREATE TABLE tasks (id TEXT PRIMARY KEY, assigned_agent_id TEXT, status TEXT, updated_at INTEGER, workflow_meta_json TEXT);`);
        if (present)
          db.prepare(
            `INSERT INTO agents VALUES (${Object.keys(previous)
              .map(() => "?")
              .join(",")})`,
          ).run(...Object.values(previous));
        const workflowMeta = JSON.stringify({ auto_retry: { enabled: true, max: 2, count: 0, failed_agents: [] } });
        db.prepare("INSERT INTO tasks VALUES (?, ?, 'in_progress', 0, ?)").run("retry-task", previous.id, workflowMeta);
        const deps = {
          db,
          nowMs: () => 100,
          appendTaskLog: vi.fn(),
          broadcast: vi.fn(),
          taskWorktrees: new Map(),
          cleanupWorktree: vi.fn(),
          getAgentDisplayName: vi.fn((agent: typeof previous) => agent.name),
          notifyCeo: vi.fn(),
          l: translations,
          pickL: (pool, lang) => pool[lang][0] ?? "",
          resolveLang: () => "en",
        } satisfies Parameters<typeof handleAutoRetry>[0];
        const rerun = vi.fn();
        const result = handleAutoRetry(
          deps,
          {
            title: "Task title is not an agent name",
            description: null,
            workflow_pack_key: "development",
            workflow_meta_json: workflowMeta,
            assigned_agent_id: previous.id,
            department_id: "planning",
            project_id: null,
          },
          "retry-task",
          1,
          "unused.log",
          {},
          rerun,
        );
        expect(result.handled).toBe(true);
        expect(deps.appendTaskLog).toHaveBeenCalledWith(
          "retry-task",
          "system",
          `Auto-retry 1/2: ${present ? previous.name : previous.id} → ${replacement.name}`,
        );
        if (present)
          expect(deps.getAgentDisplayName).toHaveBeenCalledWith(
            expect.objectContaining({ id: previous.id, name: previous.name }),
            "en",
          );
        else expect(deps.getAgentDisplayName).not.toHaveBeenCalled();
        expect(db.prepare("SELECT assigned_agent_id, status FROM tasks WHERE id = ?").get("retry-task")).toMatchObject({
          assigned_agent_id: replacement.id,
          status: "planned",
        });
        expect(rerun).toHaveBeenCalledWith("retry-task", "auto_retry_1");
      } finally {
        select.mockRestore();
        db.close();
      }
    },
  );
});
