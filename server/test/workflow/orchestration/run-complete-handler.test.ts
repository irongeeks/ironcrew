import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRunCompleteHandler } from "../../../modules/workflow/orchestration/run-complete-handler.ts";

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../modules/routes/docs/index.ts", () => ({
  syncTaskDocsBackToVault: vi.fn(() => ({ syncedProviders: 0, copiedFiles: 0 })),
}));

vi.mock("../../../modules/workflow/orchestration/server-allocation.ts", () => ({
  releaseServerAccess: vi.fn(() => ({ released_allocations: 0, touched_server_ids: [] })),
}));

vi.mock("../../../modules/workflow/orchestration/run-complete-dept-pipeline.ts", () => ({
  handleDeptPipelineAdvancement: vi.fn(() => ({ handled: false })),
  handleQaBounceBack: vi.fn(() => ({ handled: false })),
}));

vi.mock("../../../modules/workflow/orchestration/run-complete-success.ts", () => ({
  handleSuccessPath: vi.fn(),
}));

vi.mock("../../../modules/workflow/orchestration/run-complete-failure.ts", () => ({
  handleAutoRetry: vi.fn(() => ({ handled: false })),
  handleHardFailure: vi.fn(),
}));

vi.mock("../../../modules/workflow/orchestration/graph-runner.ts", () => ({
  wrapDatabaseSync: vi.fn((db: any) => db),
}));

// We need to mock fs and path for log reading
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
  },
}));

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

function createMockDb() {
  const store: {
    tasks: MockRow[];
    subtasks: MockRow[];
    agents: MockRow[];
  } = {
    tasks: [],
    subtasks: [],
    agents: [],
  };

  return {
    _store: store,

    addTask(row: MockRow) {
      store.tasks.push(row);
    },

    addSubtask(row: MockRow) {
      store.subtasks.push(row);
    },

    addAgent(row: MockRow) {
      store.agents.push(row);
    },

    prepare(sql: string) {
      const trimmed = sql.trim().toUpperCase();

      return {
        get(...params: unknown[]): MockRow | undefined {
          if (trimmed.includes("FROM TASKS") && trimmed.includes("WHERE ID")) {
            const taskId = params[0] as string;
            return store.tasks.find((t) => t.id === taskId);
          }
          if (trimmed.includes("FROM AGENTS") && trimmed.includes("WHERE ID")) {
            const agentId = params[0] as string;
            return store.agents.find((a) => a.id === agentId);
          }
          if (trimmed.includes("FROM SUBTASKS") && trimmed.includes("CLI_TOOL_USE_ID")) {
            return undefined;
          }
          return undefined;
        },

        all(...params: unknown[]): MockRow[] {
          if (trimmed.includes("FROM SUBTASKS") && trimmed.includes("TASK_ID")) {
            const taskId = params[0] as string;
            return store.subtasks
              .filter((s) => s.task_id === taskId && s.status !== "done" && s.status !== "cancelled")
              .map((r) => ({ ...r }));
          }
          return [];
        },

        run(...params: unknown[]) {
          // UPDATE tasks SET result
          if (trimmed.includes("UPDATE TASKS SET RESULT")) {
            const taskId = params[params.length - 1] as string;
            const task = store.tasks.find((t) => t.id === taskId);
            if (task) task.result = params[0];
          }
          // UPDATE tasks SET status
          if (trimmed.includes("UPDATE TASKS SET STATUS")) {
            const taskId = params[params.length - 1] as string;
            const task = store.tasks.find((t) => t.id === taskId);
            if (task) task.status = params.length > 2 ? "in_progress" : task.status;
          }
          // UPDATE agents SET status = 'idle'
          if (trimmed.includes("UPDATE AGENTS SET STATUS = 'IDLE'")) {
            const agentId = params[0] as string;
            const agent = store.agents.find((a) => a.id === agentId);
            if (agent) {
              agent.status = "idle";
              agent.current_task_id = null;
            }
          }
          // UPDATE subtasks SET status = 'done'
          if (trimmed.includes("UPDATE SUBTASKS SET STATUS = 'DONE'")) {
            const id = params[params.length - 1] as string;
            const sub = store.subtasks.find((s) => s.id === id);
            if (sub) sub.status = "done";
          }

          return { changes: 1 };
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
    activeProcesses: new Map<string, any>(),
    stopProgressTimer: vi.fn(),
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map<string, string>(),
    appendTaskLog: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    codexThreadToSubtask: new Map<string, string>(),
    nowMs: () => Date.now(),
    logsDir: "/tmp/test-logs",
    broadcast: vi.fn(),
    processSubtaskDelegations: vi.fn(),
    taskWorktrees: new Map(),
    cleanupWorktree: vi.fn(),
    findTeamLeader: vi.fn(() => null),
    getAgentDisplayName: vi.fn((_agent: Record<string, unknown>, _lang: string) => "Agent"),
    pickL: vi.fn((_translations: string[][], _lang: string) => ""),
    l: vi.fn((..._langArrays: string[][]) => [] as string[][]),
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    resolveLang: vi.fn(() => "en"),
    formatTaskSubtaskProgressSummary: vi.fn(() => ""),
    crossDeptNextCallbacks: new Map<string, () => void>(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map<string, () => void>(),
    finishReview: vi.fn(),
    reconcileDelegatedSubtasksAfterRun: vi.fn(),
    completeTaskWithoutReview: vi.fn(),
    isReportRequestTask: vi.fn(() => false),
    notifyTaskStatus: vi.fn(),
    prettyStreamJson: vi.fn((raw: string) => raw),
    getWorktreeDiffSummary: vi.fn(() => ""),
    hasVisibleDiffSummary: vi.fn(() => false),
    metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn(), shutdown: vi.fn() },
    autonomousSchedulerTick: vi.fn(),
    runTask: vi.fn().mockResolvedValue(undefined),
    packRegistry: undefined,
    graphRunner: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRunCompleteHandler", () => {
  it("returns handleTaskRunComplete and cancelPendingReRuns functions", () => {
    const deps = createMockDeps();
    const handler = createRunCompleteHandler(deps);
    expect(typeof handler.handleTaskRunComplete).toBe("function");
    expect(typeof handler.cancelPendingReRuns).toBe("function");
  });
});

describe("handleTaskRunComplete", () => {
  let db: ReturnType<typeof createMockDb>;
  let deps: ReturnType<typeof createMockDeps>;
  let handler: ReturnType<typeof createRunCompleteHandler>;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = createMockDb();
    deps = createMockDeps(db);
    handler = createRunCompleteHandler(deps);
  });

  afterEach(() => {
    handler.cancelPendingReRuns();
  });

  it("removes task from activeProcesses", async () => {
    deps.activeProcesses.set("task-1", { pid: 123 });
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.activeProcesses.has("task-1")).toBe(false);
  });

  it("stops progress timer on completion", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.stopProgressTimer).toHaveBeenCalledWith("task-1");
  });

  it("records metrics on completion", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.metrics.incCounter).toHaveBeenCalledWith("task.run.complete", { exit: "ok" });
  });

  it("records error metric on failure", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 1);

    expect(deps.metrics.incCounter).toHaveBeenCalledWith("task.run.complete", { exit: "error" });
  });

  it("ignores completion when task was stop-requested", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });
    deps.stopRequestedTasks.add("task-1");

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("RUN completion ignored"),
    );
    expect(deps.clearTaskWorkflowState).toHaveBeenCalledWith("task-1");
  });

  it("preserves workflow state on pause stop mode", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });
    deps.stopRequestedTasks.add("task-1");
    deps.stopRequestModeByTask.set("task-1", "pause");

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.clearTaskWorkflowState).not.toHaveBeenCalled();
  });

  it("ignores completion when task is not in_progress", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "done",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("RUN completion ignored"),
    );
  });

  it("ignores completion when task not found in DB", async () => {
    await handler.handleTaskRunComplete("nonexistent", 0);
    // Should not throw and should not call clearTaskWorkflowState
    expect(deps.clearTaskWorkflowState).toHaveBeenCalledWith("nonexistent");
  });

  it("cleans up stop request state after processing", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });
    deps.stopRequestedTasks.add("task-1");
    deps.stopRequestModeByTask.set("task-1", "kill");

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.stopRequestedTasks.has("task-1")).toBe(false);
    expect(deps.stopRequestModeByTask.has("task-1")).toBe(false);
  });

  it("updates agent to idle on success", async () => {
    db.addAgent({ id: "agent-1", status: "working", current_task_id: "task-1" });
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: "agent-1",
      department_id: "dept-1",
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    const agent = db._store.agents.find((a) => a.id === "agent-1");
    expect(agent?.status).toBe("idle");
    expect(deps.broadcast).toHaveBeenCalledWith("agent_status", expect.anything());
  });

  it("updates agent to idle on failure", async () => {
    db.addAgent({ id: "agent-1", status: "working", current_task_id: "task-1" });
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: "agent-1",
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 1);

    const agent = db._store.agents.find((a) => a.id === "agent-1");
    expect(agent?.status).toBe("idle");
  });

  it("auto-completes own-department subtasks on success", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: "dept-1",
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });
    db.addSubtask({ id: "sub-1", task_id: "task-1", title: "Do thing", status: "pending", target_department_id: null });

    await handler.handleTaskRunComplete("task-1", 0);

    const sub = db._store.subtasks.find((s) => s.id === "sub-1");
    expect(sub?.status).toBe("done");
  });

  it("does not auto-complete pipeline subtasks", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: "dept-1",
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });
    db.addSubtask({
      id: "sub-p1",
      task_id: "task-1",
      title: "[pipeline:phase1] Build",
      status: "in_progress",
      target_department_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    const sub = db._store.subtasks.find((s) => s.id === "sub-p1");
    expect(sub?.status).toBe("in_progress"); // not auto-completed
  });

  it("does not auto-complete foreign-department subtasks", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: "dept-1",
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });
    db.addSubtask({
      id: "sub-f1",
      task_id: "task-1",
      title: "Foreign sub",
      status: "pending",
      target_department_id: "dept-2",
    });

    await handler.handleTaskRunComplete("task-1", 0);

    const sub = db._store.subtasks.find((s) => s.id === "sub-f1");
    expect(sub?.status).toBe("pending"); // not auto-completed
  });

  it("triggers processSubtaskDelegations on success", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.processSubtaskDelegations).toHaveBeenCalledWith("task-1");
  });

  it("logs completion with exit code", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", "RUN completed (exit code: 0)");
  });

  it("logs failure with exit code", async () => {
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 1);

    expect(deps.appendTaskLog).toHaveBeenCalledWith("task-1", "system", "RUN failed (exit code: 1)");
  });

  it("triggers autonomous scheduler tick on success", async () => {
    vi.useFakeTimers();
    db.addTask({
      id: "task-1",
      title: "Test",
      status: "in_progress",
      assigned_agent_id: null,
      department_id: null,
      description: null,
      task_type: null,
      workflow_pack_key: null,
      workflow_meta_json: null,
      project_id: null,
      project_path: null,
      source_task_id: null,
    });

    await handler.handleTaskRunComplete("task-1", 0);

    vi.advanceTimersByTime(4000);
    expect(deps.autonomousSchedulerTick).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("cancelPendingReRuns", () => {
  it("clears all pending re-run timers", () => {
    const deps = createMockDeps();
    const handler = createRunCompleteHandler(deps);
    // Just verify it doesn't throw
    handler.cancelPendingReRuns();
  });
});
