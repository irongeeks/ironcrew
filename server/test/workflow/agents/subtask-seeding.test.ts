import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubtaskSeedingTools } from "../../../modules/workflow/agents/subtask-seeding.ts";

// ---------------------------------------------------------------------------
// Mock: resolveConstrainedAgentScopeForTask — must be hoisted before import
// ---------------------------------------------------------------------------
vi.mock("../../../modules/routes/core/tasks/execution-run-auto-assign.ts", () => ({
  resolveConstrainedAgentScopeForTask: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Helpers — lightweight in-memory DB stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface StmtTracker {
  inserts: Row[];
  updates: Row[];
}

function createMockDb() {
  const tables: Record<string, Row[]> = {
    tasks: [],
    subtasks: [],
  };
  const tracker: StmtTracker = { inserts: [], updates: [] };

  function prepare(sql: string) {
    const normalised = sql.replace(/\s+/g, " ").trim();

    return {
      get(...params: unknown[]): Row | undefined {
        // SELECT assigned_agent_id FROM tasks WHERE id = ?
        if (normalised.includes("FROM tasks") && normalised.includes("WHERE id")) {
          return tables.tasks.find((r) => r.id === params[0]);
        }
        // SELECT * FROM subtasks WHERE id = ?
        if (normalised.includes("FROM subtasks") && normalised.includes("WHERE id =")) {
          return tables.subtasks.find((r) => r.id === params[0]);
        }
        // SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ?
        if (normalised.includes("COUNT(*)")) {
          const cnt = tables.subtasks.filter((r) => r.task_id === params[0]).length;
          return { cnt };
        }
        // SELECT id, status FROM subtasks WHERE cli_tool_use_id = ?
        if (normalised.includes("cli_tool_use_id")) {
          return tables.subtasks.find((r) => r.cli_tool_use_id === params[0]);
        }
        // SELECT 1 FROM subtasks WHERE task_id = ? AND title = ? AND status != 'done' LIMIT 1
        if (normalised.includes("title =") && normalised.includes("status != 'done'")) {
          const match = tables.subtasks.find(
            (r) => r.task_id === params[0] && r.title === params[1] && r.status !== "done",
          );
          return match ? { 1: 1 } : undefined;
        }
        return undefined;
      },
      run(...params: unknown[]) {
        if (normalised.startsWith("INSERT INTO subtasks")) {
          const row: Row = {
            id: params[0],
            task_id: params[1],
            title: params[2],
          };
          // Two INSERT shapes: 6-param (createSubtaskFromCli) or 9-param (seed*)
          if (params.length === 6) {
            Object.assign(row, {
              status: "in_progress",
              assigned_agent_id: params[3],
              cli_tool_use_id: params[4],
              created_at: params[5],
            });
          } else {
            Object.assign(row, {
              description: params[3],
              status: params[4],
              assigned_agent_id: params[5],
              blocked_reason: params[6],
              target_department_id: params[7],
              created_at: params[8],
            });
          }
          tables.subtasks.push(row);
          tracker.inserts.push(row);
          return { changes: 1 };
        }
        if (normalised.startsWith("UPDATE subtasks")) {
          const update: Row = { sql: normalised, params };
          tracker.updates.push(update);
          // Apply status/blocked_reason updates
          if (normalised.includes("target_department_id")) {
            const sub = tables.subtasks.find((r) => r.id === params[2]);
            if (sub) {
              sub.target_department_id = params[0];
              sub.status = "blocked";
              sub.blocked_reason = params[1];
            }
          }
          // Apply done update
          if (normalised.includes("status = 'done'")) {
            const sub = tables.subtasks.find((r) => r.id === params[1]);
            if (sub) {
              sub.status = "done";
              sub.completed_at = params[0];
            }
          }
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      all(..._params: unknown[]): Row[] {
        return [];
      },
    };
  }

  return { prepare, tables, tracker };
}

// ---------------------------------------------------------------------------
// Default deps factory
// ---------------------------------------------------------------------------

function createDeps(dbOverride?: ReturnType<typeof createMockDb>) {
  const db = dbOverride ?? createMockDb();
  const nowMs = vi.fn().mockReturnValue(1700000000000);
  const broadcast = vi.fn();
  const analyzeSubtaskDepartment = vi.fn().mockReturnValue(null);
  const rerouteSubtasksByPlanningLeader = vi.fn().mockResolvedValue(undefined);
  const findTeamLeader = vi.fn().mockReturnValue(null);
  const getDeptName = vi.fn().mockImplementation((id: string) => `Dept-${id}`);
  const getPreferredLanguage = vi.fn().mockReturnValue("en");
  const resolveLang = vi.fn().mockReturnValue("en");
  const l = vi.fn().mockImplementation((_ko: string[], en: string[]) => ({ en: en[0] }));
  const pickL = vi
    .fn()
    .mockImplementation((choices: Record<string, string>) => choices.en ?? Object.values(choices)[0]);
  const appendTaskLog = vi.fn();
  const notifyCeo = vi.fn();

  return {
    db,
    nowMs,
    broadcast,
    analyzeSubtaskDepartment,
    rerouteSubtasksByPlanningLeader,
    findTeamLeader,
    getDeptName,
    getPreferredLanguage,
    resolveLang,
    l,
    pickL,
    appendTaskLog,
    notifyCeo,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("createSubtaskFromCli", () => {
  let deps: ReturnType<typeof createDeps>;
  let tools: ReturnType<typeof createSubtaskSeedingTools>;

  beforeEach(() => {
    deps = createDeps();
    deps.db.tables.tasks.push({
      id: "task-1",
      title: "Build feature",
      description: "Some desc",
      assigned_agent_id: "agent-A",
      department_id: "dept-dev",
      project_id: null,
      workflow_pack_key: null,
    });
    tools = createSubtaskSeedingTools(deps);
  });

  it("inserts a subtask with status 'in_progress'", () => {
    tools.createSubtaskFromCli("task-1", "tool-use-1", "Implement login");

    const inserted = deps.db.tables.subtasks.filter((r: Row) => r.task_id === "task-1");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("in_progress");
    expect(inserted[0].title).toBe("Implement login");
    expect(inserted[0].cli_tool_use_id).toBe("tool-use-1");
  });

  it("assigns the parent task's agent to the subtask", () => {
    tools.createSubtaskFromCli("task-1", "tool-use-2", "Write tests");

    const inserted = deps.db.tables.subtasks.find((r: Row) => r.cli_tool_use_id === "tool-use-2");
    expect(inserted?.assigned_agent_id).toBe("agent-A");
  });

  it("calls analyzeSubtaskDepartment with title and parent dept", () => {
    tools.createSubtaskFromCli("task-1", "tool-use-3", "Design mockup");

    expect(deps.analyzeSubtaskDepartment).toHaveBeenCalledWith("Design mockup", "dept-dev");
  });

  it("updates subtask to 'blocked' when foreign department is detected", () => {
    deps.analyzeSubtaskDepartment.mockReturnValue("dept-design");
    deps.pickL.mockReturnValue("Waiting for Dept-design collaboration");

    tools.createSubtaskFromCli("task-1", "tool-use-4", "Create UI mockup");

    const sub = deps.db.tables.subtasks.find((r: Row) => r.cli_tool_use_id === "tool-use-4");
    expect(sub?.status).toBe("blocked");
    expect(sub?.blocked_reason).toBe("Waiting for Dept-design collaboration");
    expect(sub?.target_department_id).toBe("dept-design");
  });

  it("does not block subtask when no foreign department detected", () => {
    deps.analyzeSubtaskDepartment.mockReturnValue(null);

    tools.createSubtaskFromCli("task-1", "tool-use-5", "Internal work");

    const sub = deps.db.tables.subtasks.find((r: Row) => r.cli_tool_use_id === "tool-use-5");
    expect(sub?.status).toBe("in_progress");
    expect(sub?.blocked_reason).toBeUndefined();
  });

  it("broadcasts subtask_update event", () => {
    tools.createSubtaskFromCli("task-1", "tool-use-6", "Something");

    expect(deps.broadcast).toHaveBeenCalledWith("subtask_update", expect.objectContaining({ title: "Something" }));
  });
});

// ===========================================================================

describe("completeSubtaskFromCli", () => {
  let deps: ReturnType<typeof createDeps>;
  let tools: ReturnType<typeof createSubtaskSeedingTools>;

  beforeEach(() => {
    deps = createDeps();
    deps.db.tables.tasks.push({
      id: "task-1",
      title: "Build feature",
      description: null,
      assigned_agent_id: "agent-A",
      department_id: "dept-dev",
      project_id: null,
      workflow_pack_key: null,
    });
    tools = createSubtaskSeedingTools(deps);
  });

  it("finds existing subtask by cli_tool_use_id and marks it done", () => {
    deps.db.tables.subtasks.push({
      id: "sub-1",
      task_id: "task-1",
      title: "Do something",
      status: "in_progress",
      cli_tool_use_id: "tool-use-100",
    });

    tools.completeSubtaskFromCli("tool-use-100");

    const sub = deps.db.tables.subtasks.find((r: Row) => r.id === "sub-1");
    expect(sub?.status).toBe("done");
    expect(sub?.completed_at).toBeDefined();
  });

  it("broadcasts subtask_update after completion", () => {
    deps.db.tables.subtasks.push({
      id: "sub-2",
      task_id: "task-1",
      title: "Another task",
      status: "in_progress",
      cli_tool_use_id: "tool-use-200",
    });

    tools.completeSubtaskFromCli("tool-use-200");

    expect(deps.broadcast).toHaveBeenCalledWith(
      "subtask_update",
      expect.objectContaining({ id: "sub-2", status: "done" }),
    );
  });

  it("skips if subtask is already done", () => {
    deps.db.tables.subtasks.push({
      id: "sub-3",
      task_id: "task-1",
      title: "Done task",
      status: "done",
      cli_tool_use_id: "tool-use-300",
    });

    tools.completeSubtaskFromCli("tool-use-300");

    // No updates should have been made
    expect(deps.db.tracker.updates).toHaveLength(0);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("skips if subtask not found", () => {
    tools.completeSubtaskFromCli("nonexistent-tool-use-id");

    expect(deps.db.tracker.updates).toHaveLength(0);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
});

// ===========================================================================

describe("seedApprovedPlanSubtasks", () => {
  let deps: ReturnType<typeof createDeps>;
  let tools: ReturnType<typeof createSubtaskSeedingTools>;

  beforeEach(() => {
    deps = createDeps();
    deps.db.tables.tasks.push({
      id: "task-10",
      title: "Project Alpha",
      description: "Build the Alpha platform",
      assigned_agent_id: "agent-B",
      department_id: "dept-dev",
      project_id: "proj-1",
      workflow_pack_key: null,
    });
    tools = createSubtaskSeedingTools(deps);
  });

  it("skips if subtasks already exist for the task", () => {
    deps.db.tables.subtasks.push({ id: "existing-sub", task_id: "task-10", title: "Old", status: "pending" });

    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", ["Note 1"]);

    // Only the pre-existing subtask should be there — no new inserts
    expect(deps.db.tracker.inserts).toHaveLength(0);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("creates initial 'Finalize detailed execution plan' subtask", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", []);

    const titles = deps.db.tables.subtasks.map((r: Row) => r.title);
    expect(titles[0]).toContain("Finalize detailed execution plan");
    // Also has the consolidation subtask
    expect(titles).toHaveLength(2);
  });

  it("creates plan note subtasks from provided notes", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", ["Fix auth flow", "Improve DB schema"]);

    const planItems = deps.db.tables.subtasks.filter((r: Row) => (r.title as string).includes("[Plan Item]"));
    expect(planItems).toHaveLength(2);
  });

  it("deduplicates plan notes (case-insensitive)", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", [
      "fix auth flow",
      "Fix Auth Flow",
      "FIX AUTH FLOW",
      "Improve DB schema",
    ]);

    const planItems = deps.db.tables.subtasks.filter((r: Row) => (r.title as string).includes("[Plan Item]"));
    expect(planItems).toHaveLength(2);
  });

  it("limits plan notes to max 8", () => {
    const notes = Array.from({ length: 12 }, (_, i) => `Note item number ${i + 1}`);
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", notes);

    const planItems = deps.db.tables.subtasks.filter((r: Row) => (r.title as string).includes("[Plan Item]"));
    expect(planItems).toHaveLength(8);
  });

  it("creates cross-dept collaboration subtasks for foreign departments", () => {
    deps.analyzeSubtaskDepartment.mockImplementation((title: string) => {
      if (title.includes("Design")) return "dept-design";
      return null;
    });
    deps.findTeamLeader.mockReturnValue({ id: "agent-designer" });

    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", ["Design: Create mockups"]);

    const collabItems = deps.db.tables.subtasks.filter((r: Row) => (r.title as string).includes("[Collaboration]"));
    expect(collabItems).toHaveLength(1);
    expect(collabItems[0].status).toBe("blocked");
    expect(collabItems[0].assigned_agent_id).toBe("agent-designer");
    expect(collabItems[0].target_department_id).toBe("dept-design");
  });

  it("creates final consolidation subtask", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", ["Some note"]);

    const subtasks = deps.db.tables.subtasks;
    const last = subtasks[subtasks.length - 1];
    expect(last.title).toContain("Consolidate department deliverables");
    expect(last.status).toBe("pending");
    expect(last.assigned_agent_id).toBe("agent-B");
  });

  it("adds VIDEO_FINAL_RENDER subtask for video_preprod pack", () => {
    deps.db.tables.tasks[0].workflow_pack_key = "video_preprod";
    deps.findTeamLeader.mockReturnValue({ id: "agent-video" });

    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", []);

    const videoSub = deps.db.tables.subtasks.find((r: Row) => (r.title as string).includes("VIDEO_FINAL_RENDER"));
    expect(videoSub).toBeDefined();
    expect(videoSub!.status).toBe("blocked");
    expect(videoSub!.target_department_id).toBe("dev");
    expect(videoSub!.description as string).toContain("Remotion");
  });

  it("does not add VIDEO_FINAL_RENDER for non-video packs", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", []);

    const videoSub = deps.db.tables.subtasks.find((r: Row) => (r.title as string).includes("VIDEO_FINAL_RENDER"));
    expect(videoSub).toBeUndefined();
  });

  it("calls rerouteSubtasksByPlanningLeader with 'planned' phase", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", []);

    expect(deps.rerouteSubtasksByPlanningLeader).toHaveBeenCalledWith("task-10", "dept-dev", "planned");
  });

  it("broadcasts subtask_update for every inserted subtask", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", ["Note A", "Note B"]);

    // 1 plan init + 2 notes + 1 consolidation = 4
    expect(deps.broadcast).toHaveBeenCalledTimes(4);
    for (const call of deps.broadcast.mock.calls) {
      expect(call[0]).toBe("subtask_update");
    }
  });

  it("logs and notifies CEO", () => {
    tools.seedApprovedPlanSubtasks("task-10", "dept-dev", ["One note"]);

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-10",
      "system",
      expect.stringContaining("Planned meeting seeded"),
    );
    expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("subtasks"), "task-10");
  });

  it("falls back to task.department_id when ownerDeptId is null", () => {
    tools.seedApprovedPlanSubtasks("task-10", null, ["A note"]);

    // analyzeSubtaskDepartment should be called with task.department_id
    for (const call of deps.analyzeSubtaskDepartment.mock.calls) {
      expect(call[1]).toBe("dept-dev");
    }
  });
});

// ===========================================================================

describe("seedReviewRevisionSubtasks", () => {
  let deps: ReturnType<typeof createDeps>;
  let tools: ReturnType<typeof createSubtaskSeedingTools>;

  beforeEach(() => {
    deps = createDeps();
    deps.db.tables.tasks.push({
      id: "task-20",
      title: "Review Alpha",
      description: "Review the Alpha platform",
      assigned_agent_id: "agent-C",
      department_id: "dept-qa",
      project_id: null,
      workflow_pack_key: null,
    });
    tools = createSubtaskSeedingTools(deps);
  });

  it("creates revision subtasks from notes", () => {
    const count = tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Fix typo in docs", "Update API tests"]);

    const revisionItems = deps.db.tables.subtasks.filter((r: Row) => (r.title as string).includes("[Review Revision]"));
    // 2 notes + 1 consolidation = 3 total, all with [Review Revision]
    expect(revisionItems).toHaveLength(3);
    expect(count).toBe(3);
  });

  it("deduplicates revision notes (case-insensitive)", () => {
    const count = tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["fix typo", "Fix Typo", "different note"]);

    // 2 unique notes + 1 consolidation = 3
    const revisionItems = deps.db.tables.subtasks.filter((r: Row) => (r.title as string).includes("[Review Revision]"));
    expect(revisionItems).toHaveLength(3);
    expect(count).toBe(3);
  });

  it("limits revision notes to max 8", () => {
    const notes = Array.from({ length: 12 }, (_, i) => `Revision note ${i + 1}`);
    const count = tools.seedReviewRevisionSubtasks("task-20", "dept-qa", notes);

    // 8 notes + 1 consolidation = 9
    expect(count).toBe(9);
  });

  it("creates final consolidation subtask", () => {
    tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Fix something"]);

    const subtasks = deps.db.tables.subtasks;
    const last = subtasks[subtasks.length - 1];
    expect(last.title).toContain("Consolidate updates and resubmit");
    expect(last.status).toBe("pending");
    expect(last.assigned_agent_id).toBe("agent-C");
  });

  it("skips if subtask with same title already exists (not done)", () => {
    // Seed once
    tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Fix edge case"]);
    const firstCount = deps.db.tables.subtasks.length;

    // Seed again with same notes — should skip all existing titles
    const count = tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Fix edge case"]);

    expect(count).toBe(0);
    expect(deps.db.tables.subtasks.length).toBe(firstCount);
  });

  it("returns count of created subtasks", () => {
    const count = tools.seedReviewRevisionSubtasks("task-20", "dept-qa", []);

    // Only consolidation subtask
    expect(count).toBe(1);
  });

  it("returns 0 when task not found", () => {
    const count = tools.seedReviewRevisionSubtasks("nonexistent-task", "dept-qa", ["A note"]);

    expect(count).toBe(0);
    expect(deps.db.tables.subtasks).toHaveLength(0);
  });

  it("calls rerouteSubtasksByPlanningLeader with 'review' phase when subtasks created", () => {
    tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Fix a thing"]);

    expect(deps.rerouteSubtasksByPlanningLeader).toHaveBeenCalledWith("task-20", "dept-qa", "review");
  });

  it("does not call rerouteSubtasksByPlanningLeader when zero subtasks created", () => {
    // Seed once to populate
    tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Fix a thing"]);
    deps.rerouteSubtasksByPlanningLeader.mockClear();

    // Seed again with same notes — 0 created
    tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Fix a thing"]);

    expect(deps.rerouteSubtasksByPlanningLeader).not.toHaveBeenCalled();
  });

  it("marks foreign-department revision subtasks as blocked", () => {
    deps.analyzeSubtaskDepartment.mockReturnValue("dept-design");
    deps.findTeamLeader.mockReturnValue({ id: "agent-lead-design" });

    tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Update design tokens"]);

    const blockedItems = deps.db.tables.subtasks.filter((r: Row) => r.status === "blocked");
    // The note subtask should be blocked (consolidation is pending)
    expect(blockedItems.length).toBeGreaterThanOrEqual(1);
    const noteSub = blockedItems.find((r: Row) => (r.title as string).includes("Update design tokens"));
    expect(noteSub?.assigned_agent_id).toBe("agent-lead-design");
    expect(noteSub?.target_department_id).toBe("dept-design");
  });

  it("broadcasts subtask_update for each created subtask", () => {
    tools.seedReviewRevisionSubtasks("task-20", "dept-qa", ["Note X"]);

    // 1 note + 1 consolidation = 2
    expect(deps.broadcast).toHaveBeenCalledTimes(2);
    for (const call of deps.broadcast.mock.calls) {
      expect(call[0]).toBe("subtask_update");
    }
  });
});
