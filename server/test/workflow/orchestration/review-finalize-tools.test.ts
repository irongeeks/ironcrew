import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReviewFinalizeTools } from "../../../modules/workflow/orchestration/review-finalize-tools.ts";

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../modules/workflow/packs/video-artifact.ts", () => ({
  discoverVideoArtifact: vi.fn(() => null),
  resolveVideoArtifactRelativeCandidates: vi.fn(() => []),
  resolveVideoArtifactSpecForTask: vi.fn(() => ({ relativePath: "video_output/final.mp4" })),
}));

vi.mock("../../../modules/workflow/packs/video-render-engine-gate.ts", () => ({
  evaluateRemotionOnlyGateFromLogFiles: vi.fn(() => ({
    passed: true,
    checkedTaskIds: [],
    remotionEvidenceTaskIds: [],
    forbiddenEngineTaskIds: [],
  })),
}));

vi.mock("../../../modules/routes/ops/messages/decision-inbox/yolo-mode.ts", () => ({
  readYoloModeEnabled: vi.fn(() => false),
}));

vi.mock("../../../modules/workflow/orchestration/video-render-delegation-state.ts", () => ({
  reconcileVideoRenderDelegationState: vi.fn(() => ({ staleResetCount: 0, recoveredDoneCount: 0 })),
}));

vi.mock("../../../config/runtime.ts", () => ({
  SESSION_AUTH_TOKEN: "test-token",
}));

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

function createMockDb() {
  const store: Record<string, MockRow[]> = {
    subtasks: [],
    tasks: [],
  };

  function matchRow(table: string, predicate: (row: MockRow) => boolean): MockRow | undefined {
    return store[table]?.find(predicate);
  }

  function matchRows(table: string, predicate: (row: MockRow) => boolean): MockRow[] {
    return store[table]?.filter(predicate) ?? [];
  }

  return {
    _store: store,

    addTask(row: MockRow) {
      store.tasks.push(row);
    },

    addSubtask(row: MockRow) {
      store.subtasks.push(row);
    },

    prepare(sql: string) {
      const trimmed = sql.trim().toUpperCase();

      return {
        get(...params: unknown[]): MockRow | undefined {
          if (trimmed.includes("COUNT(*)") && trimmed.includes("SUBTASKS")) {
            const taskId = params[0] as string;
            const cnt = matchRows(
              "subtasks",
              (r) => r.task_id === taskId && r.status !== "done" && r.status !== "cancelled",
            ).length;
            return { cnt };
          }

          if (trimmed.includes("FROM SUBTASKS")) {
            // not used in get context for this module — return undefined
            return undefined;
          }

          if (trimmed.includes("FROM TASKS") && trimmed.includes("WHERE ID")) {
            const taskId = params[0] as string;
            return matchRow("tasks", (r) => r.id === taskId);
          }

          if (trimmed.includes("FROM TASKS") && trimmed.includes("SOURCE_TASK_ID")) {
            // child progress query
            const parentId = params[0] as string;
            const children = matchRows("tasks", (r) => r.source_task_id === parentId);
            const total = children.length;
            const review_cnt = children.filter((c) => c.status === "review").length;
            const done_cnt = children.filter((c) => c.status === "done").length;
            return { total, review_cnt, done_cnt };
          }

          if (trimmed.includes("FROM PROJECTS")) {
            return { name: "TestProject" };
          }

          return undefined;
        },

        all(...params: unknown[]): MockRow[] {
          if (trimmed.includes("FROM SUBTASKS") && trimmed.includes("DELEGATED_TASK_ID")) {
            if (trimmed.includes("WHERE DELEGATED_TASK_ID = ?")) {
              const delegatedTaskId = params[0] as string;
              return matchRows(
                "subtasks",
                (r) => r.delegated_task_id === delegatedTaskId && r.status !== "done" && r.status !== "cancelled",
              );
            }
            // render delegation rows
            const taskId = params[0] as string;
            return matchRows(
              "subtasks",
              (r) =>
                r.task_id === taskId && String(r.title ?? "").includes("[VIDEO_FINAL_RENDER]") && !!r.delegated_task_id,
            );
          }

          if (trimmed.includes("FROM SUBTASKS") && trimmed.includes("VIDEO_FINAL_RENDER")) {
            const taskId = params[0] as string;
            return matchRows(
              "subtasks",
              (r) =>
                r.task_id === taskId &&
                String(r.title ?? "").includes("[VIDEO_FINAL_RENDER]") &&
                r.status !== "done" &&
                r.status !== "cancelled",
            );
          }

          if (trimmed.includes("FROM TASKS") && trimmed.includes("SOURCE_TASK_ID")) {
            const parentId = params[0] as string;
            return matchRows("tasks", (r) => r.source_task_id === parentId);
          }

          return [];
        },

        run(..._params: unknown[]) {
          // Track updates to subtask status
          if (trimmed.includes("UPDATE SUBTASKS SET STATUS = 'DONE'")) {
            const id = _params[_params.length - 1] as string;
            const row = matchRow("subtasks", (r) => r.id === id);
            if (row) row.status = "done";
          }
          if (trimmed.includes("UPDATE SUBTASKS SET STATUS = 'BLOCKED'")) {
            const id = _params[_params.length - 1] as string;
            const row = matchRow("subtasks", (r) => r.id === id);
            if (row) row.status = "blocked";
          }
          if (trimmed.includes("UPDATE TASKS SET STATUS = 'DONE'")) {
            const taskId = _params[_params.length - 1] as string;
            const row = matchRow("tasks", (r) => r.id === taskId);
            if (row) row.status = "done";
          }
          return { changes: 0 };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(dbOverride?: ReturnType<typeof createMockDb>) {
  const db = dbOverride ?? createMockDb();
  return {
    db,
    nowMs: () => Date.now(),
    logsDir: "/tmp/test-logs",
    broadcast: vi.fn(),
    appendTaskLog: vi.fn(),
    getPreferredLanguage: () => "en",
    pickL: (_arr: string[][], _lang: string) => _arr[1]?.[0] ?? "",
    l: (...args: string[][]) => args,
    resolveLang: () => "en",
    getProjectReviewGateSnapshot: vi.fn(() => ({ ready: false, activeReview: 1, activeTotal: 2 })),
    projectReviewGateNotifiedAt: new Map<string, number>(),
    notifyCeo: vi.fn(),
    taskWorktrees: new Map(),
    mergeToDevAndCreatePR: vi.fn(() => ({ success: true, message: "merged" })),
    mergeWorktree: vi.fn(() => ({ success: true, message: "merged" })),
    cleanupWorktree: vi.fn(),
    findTeamLeader: vi.fn(() => null),
    getAgentDisplayName: vi.fn((_a: any, _l: string) => "TestAgent"),
    setTaskCreationAuditCompletion: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    notifyTaskStatus: vi.fn(),
    refreshCliUsageData: vi.fn(() => Promise.resolve({})),
    shouldDeferTaskReportUntilPlanningArchive: vi.fn(() => false),
    emitTaskReportEvent: vi.fn(),
    formatTaskSubtaskProgressSummary: vi.fn(() => ""),
    reviewRoundState: new Map(),
    reviewInFlight: new Map(),
    archivePlanningConsolidatedReport: vi.fn(),
    crossDeptNextCallbacks: new Map(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map(),
    startReviewConsensusMeeting: vi.fn((_id: string, _title: string, _deptId: string | null, cb: () => void) => cb()),
    processSubtaskDelegations: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createReviewFinalizeTools", () => {
  it("returns reconcileDelegatedSubtasksAfterRun and finishReview functions", () => {
    const deps = createMockDeps();
    const tools = createReviewFinalizeTools(deps);
    expect(typeof tools.reconcileDelegatedSubtasksAfterRun).toBe("function");
    expect(typeof tools.finishReview).toBe("function");
  });
});

describe("reconcileDelegatedSubtasksAfterRun", () => {
  let db: ReturnType<typeof createMockDb>;
  let deps: ReturnType<typeof createMockDeps>;
  let tools: ReturnType<typeof createReviewFinalizeTools>;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = createMockDb();
    deps = createMockDeps(db);
    tools = createReviewFinalizeTools(deps);
  });

  it("does nothing when no linked subtasks exist", () => {
    tools.reconcileDelegatedSubtasksAfterRun("task-1", 0);
    expect(deps.appendTaskLog).not.toHaveBeenCalled();
  });

  it("marks linked subtasks as done on success (exitCode 0)", () => {
    db.addSubtask({
      id: "sub-1",
      task_id: "parent-1",
      delegated_task_id: "task-1",
      status: "in_progress",
      title: "Test sub",
    });
    db.addTask({ id: "parent-1", title: "Parent", status: "in_progress" });

    tools.reconcileDelegatedSubtasksAfterRun("task-1", 0);

    const sub = db._store.subtasks.find((s) => s.id === "sub-1");
    expect(sub?.status).toBe("done");
    expect(deps.broadcast).toHaveBeenCalled();
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("marked 1 linked subtask(s) as done"),
    );
  });

  it("marks linked subtasks as blocked on failure (exitCode != 0)", () => {
    db.addSubtask({
      id: "sub-2",
      task_id: "parent-2",
      delegated_task_id: "task-2",
      status: "in_progress",
      title: "Test sub",
    });

    tools.reconcileDelegatedSubtasksAfterRun("task-2", 1);

    const sub = db._store.subtasks.find((s) => s.id === "sub-2");
    expect(sub?.status).toBe("blocked");
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-2",
      "system",
      expect.stringContaining("marked 1 linked subtask(s) as blocked"),
    );
  });

  it("retries finishReview when all delegated subtasks for parent are done and parent is in review", () => {
    vi.useFakeTimers();
    db.addSubtask({
      id: "sub-3",
      task_id: "parent-3",
      delegated_task_id: "task-3",
      status: "in_progress",
      title: "Test sub",
    });
    db.addTask({ id: "parent-3", title: "Parent Task", status: "review" });

    tools.reconcileDelegatedSubtasksAfterRun("task-3", 0);

    // finishReview is called via setTimeout(1200)
    vi.advanceTimersByTime(1300);
    // finishReview would be called on parent-3 — we just verify the log
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "parent-3",
      "system",
      expect.stringContaining("retrying review completion"),
    );
    vi.useRealTimers();
  });
});

describe("finishReview", () => {
  let db: ReturnType<typeof createMockDb>;
  let deps: ReturnType<typeof createMockDeps>;
  let tools: ReturnType<typeof createReviewFinalizeTools>;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = createMockDb();
    deps = createMockDeps(db);
    tools = createReviewFinalizeTools(deps);
  });

  it("returns early if task does not exist", () => {
    tools.finishReview("nonexistent", "Title");
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("returns early if task is not in review status", () => {
    db.addTask({
      id: "task-1",
      title: "Title",
      status: "in_progress",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-1", "Title");
    expect(deps.notifyCeo).not.toHaveBeenCalled();
  });

  it("activates project review gate when project_id present and not bypassed", () => {
    db.addTask({
      id: "task-1",
      title: "Title",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: "proj-1",
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-1", "Title");
    expect(deps.getProjectReviewGateSnapshot).toHaveBeenCalledWith("proj-1");
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("Review gate: waiting"),
    );
  });

  it("bypasses project review gate when bypassProjectDecisionGate option set", () => {
    db.addTask({
      id: "task-1",
      title: "Title",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: "proj-1",
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-1", "Title", { bypassProjectDecisionGate: true, trigger: "manual" });
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("Review gate bypassed"),
    );
  });

  it("waits when remaining subtasks exist", () => {
    db.addTask({
      id: "task-2",
      title: "Title",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });
    db.addSubtask({ id: "sub-1", task_id: "task-2", status: "in_progress", title: "Pending sub" });

    tools.finishReview("task-2", "Title");
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-2",
      "system",
      expect.stringContaining("Review hold: waiting for 1 unfinished subtasks"),
    );
  });

  it("finalizes task to done when no remaining subtasks and no children", () => {
    db.addTask({
      id: "task-3",
      title: "Done Task",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-3", "Done Task");

    const task = db._store.tasks.find((t) => t.id === "task-3");
    expect(task?.status).toBe("done");
    expect(deps.setTaskCreationAuditCompletion).toHaveBeenCalledWith("task-3", true);
    expect(deps.endTaskExecutionSession).toHaveBeenCalledWith("task-3", "task_done");
    expect(deps.broadcast).toHaveBeenCalled();
    expect(deps.notifyTaskStatus).toHaveBeenCalledWith("task-3", "Done Task", "done", "en");
  });

  it("skips review consensus for delegated collaboration tasks (source_task_id set)", () => {
    db.addTask({
      id: "task-4",
      title: "Child Task",
      status: "review",
      department_id: "d1",
      source_task_id: "parent-1",
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-4", "Child Task");

    expect(deps.startReviewConsensusMeeting).not.toHaveBeenCalled();
    const task = db._store.tasks.find((t) => t.id === "task-4");
    expect(task?.status).toBe("done");
  });

  it("starts review consensus meeting for non-delegated tasks", () => {
    db.addTask({
      id: "task-5",
      title: "Root Task",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-5", "Root Task");

    expect(deps.startReviewConsensusMeeting).toHaveBeenCalledWith("task-5", "Root Task", "d1", expect.any(Function));
  });

  it("waits for collaboration children not yet in review", () => {
    db.addTask({
      id: "task-6",
      title: "Parent",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });
    db.addTask({ id: "child-1", title: "Child 1", status: "in_progress", source_task_id: "task-6" });

    tools.finishReview("task-6", "Parent");

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-6",
      "system",
      expect.stringContaining("Review hold: waiting for collaboration children"),
    );
  });

  it("cleans up review state maps after finalization", () => {
    deps.reviewRoundState.set("task-7", { round: 1 });
    deps.reviewInFlight.set("task-7", true);
    db.addTask({
      id: "task-7",
      title: "Task 7",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-7", "Task 7");

    expect(deps.reviewRoundState.has("task-7")).toBe(false);
    expect(deps.reviewInFlight.has("task-7")).toBe(false);
  });

  it("calls crossDeptNextCallbacks after finalization", () => {
    const callback = vi.fn();
    deps.crossDeptNextCallbacks.set("task-8", callback);
    db.addTask({
      id: "task-8",
      title: "Task 8",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-8", "Task 8");

    expect(callback).toHaveBeenCalled();
    expect(deps.crossDeptNextCallbacks.has("task-8")).toBe(false);
  });

  it("calls subtaskDelegationCallbacks after finalization", () => {
    const callback = vi.fn();
    deps.subtaskDelegationCallbacks.set("task-9", callback);
    db.addTask({
      id: "task-9",
      title: "Task 9",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-9", "Task 9");

    expect(callback).toHaveBeenCalled();
    expect(deps.subtaskDelegationCallbacks.has("task-9")).toBe(false);
  });

  it("recovers cross-dept queue when no callback found", () => {
    db.addTask({
      id: "task-10",
      title: "Task 10",
      status: "review",
      department_id: "d1",
      source_task_id: null,
      project_id: null,
      workflow_pack_key: null,
      project_path: null,
    });

    tools.finishReview("task-10", "Task 10");

    expect(deps.recoverCrossDeptQueueAfterMissingCallback).toHaveBeenCalledWith("task-10");
  });
});
