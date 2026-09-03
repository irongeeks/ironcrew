import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerPhaseApprovalRoutes } from "../../../../modules/routes/core/tasks/phase-approval.ts";
import { SESSION_AUTH_TOKEN } from "../../../../config/runtime.ts";

/**
 * Regression test for issue #59 (C-005):
 *   Re-run after phase approval must invoke deps.runTask(taskId) directly
 *   instead of the legacy fetch self-loop to http://127.0.0.1:PORT/api/tasks/.../run.
 *
 * The fetch self-loop is brittle (auth/port coupling) and inconsistent with
 * run-complete-handler.ts which already migrated to deps.runTask.
 */

interface MockTaskRow {
  id: string;
  title: string;
  workflow_pack_key: string | null;
  project_path: string | null;
  assigned_agent_id: string | null;
  status?: string;
}

interface MockSubtaskRow {
  id: string;
  task_id: string;
  title: string;
  description: string;
  status: string;
  completed_at: number | null;
  updated_at: number | null;
}

interface MockAgent {
  id: string;
  status: string;
  current_task_id: string | null;
}

function createMockDb(opts: { tasks?: MockTaskRow[]; subtasks?: MockSubtaskRow[]; agents?: MockAgent[] }) {
  const tasks: MockTaskRow[] = opts.tasks ?? [];
  const subtasks: MockSubtaskRow[] = opts.subtasks ?? [];
  const agents: MockAgent[] = opts.agents ?? [];

  function prepare(sql: string) {
    const upper = sql.trim().toUpperCase();

    if (upper.startsWith("SELECT * FROM TASKS WHERE ID")) {
      return {
        get: (id: unknown) => tasks.find((t) => t.id === id),
        run: () => {},
      };
    }

    if (upper.startsWith("SELECT * FROM SUBTASKS WHERE TASK_ID") && upper.includes("AWAITING_APPROVAL")) {
      return {
        get: (taskId: unknown, exactTitle: unknown) =>
          subtasks.find(
            (s) => s.task_id === taskId && s.title === String(exactTitle) && s.status === "awaiting_approval",
          ),
        run: () => {},
      };
    }

    if (upper.startsWith("UPDATE SUBTASKS SET STATUS = 'DONE'")) {
      return {
        get: () => undefined,
        run: (completedAt: unknown, id: unknown) => {
          const st = subtasks.find((s) => s.id === id);
          if (st) {
            st.status = "done";
            st.completed_at = completedAt as number;
            st.updated_at = completedAt as number;
          }
        },
      };
    }

    if (upper.startsWith("SELECT * FROM SUBTASKS WHERE ID")) {
      return {
        get: (id: unknown) => subtasks.find((s) => s.id === id),
        run: () => {},
      };
    }

    if (upper.startsWith("UPDATE AGENTS SET STATUS")) {
      return {
        get: () => undefined,
        run: (agentId: unknown) => {
          const agent = agents.find((a) => a.id === agentId);
          if (agent) {
            agent.status = "idle";
            agent.current_task_id = null;
          }
        },
      };
    }

    if (upper.startsWith("SELECT * FROM AGENTS WHERE ID")) {
      return {
        get: (id: unknown) => agents.find((a) => a.id === id),
        run: () => {},
      };
    }

    if (upper.startsWith("UPDATE TASKS SET STATUS")) {
      return {
        get: () => undefined,
        run: (_updatedAt: unknown, _taskId: unknown) => {},
      };
    }

    return {
      get: (..._args: unknown[]) => undefined,
      run: (..._args: unknown[]) => {},
    };
  }

  return { prepare, _tasks: tasks, _subtasks: subtasks, _agents: agents };
}

function buildApp(opts: {
  tasks?: MockTaskRow[];
  subtasks?: MockSubtaskRow[];
  agents?: MockAgent[];
  packRegistry?: object | null;
  graphRunner?: object | null;
  runTask?: (taskId: string) => Promise<void>;
}) {
  const app = express();
  app.use(express.json());

  const db = createMockDb({
    tasks: opts.tasks ?? [],
    subtasks: opts.subtasks ?? [],
    agents: opts.agents ?? [],
  });

  const broadcast = vi.fn();
  const appendTaskLog = vi.fn();
  const nowMs = () => Date.now();
  const runTask = opts.runTask ?? vi.fn(async () => {});

  const deps = {
    app,
    db,
    nowMs,
    broadcast,
    appendTaskLog,
    packRegistry: opts.packRegistry !== undefined ? opts.packRegistry : null,
    graphRunner: opts.graphRunner !== undefined ? opts.graphRunner : null,
    activeProcesses: new Map(),
    stopRequestedTasks: new Set(),
    killPidTree: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    runTask,
  };

  registerPhaseApprovalRoutes(deps as never);

  return { app, broadcast, appendTaskLog, db, runTask };
}

function authHeader() {
  return { Authorization: `Bearer ${SESSION_AUTH_TOKEN}` };
}

describe("phase-approval rerun trigger (C-005, #59)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes deps.runTask(taskId) once after approving a phase that unblocks downstream phases", async () => {
    const mockPackRegistry = {
      get: vi.fn().mockReturnValue({ key: "video_preprod", phases: [] }),
    };
    const mockGraphRunner = {
      onPhaseComplete: vi.fn().mockResolvedValue({
        advanced: true,
        nextPhases: ["production"],
        taskDone: false,
      }),
    };

    const runTask = vi.fn(async (_taskId: string) => {});

    const { app } = buildApp({
      tasks: [
        {
          id: "task-rerun-1",
          title: "Task With Rerun",
          workflow_pack_key: "video_preprod",
          project_path: "/tmp/project",
          assigned_agent_id: "agent-1",
          status: "awaiting_approval",
        },
      ],
      subtasks: [
        {
          id: "st-concept-rerun",
          task_id: "task-rerun-1",
          title: "[pipeline:concept]",
          description: "",
          status: "awaiting_approval",
          completed_at: null,
          updated_at: null,
        },
      ],
      agents: [{ id: "agent-1", status: "working", current_task_id: "task-rerun-1" }],
      packRegistry: mockPackRegistry,
      graphRunner: mockGraphRunner,
      runTask,
    });

    const res = await request(app)
      .post("/api/core/tasks/task-rerun-1/phases/concept/approve")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: true, phaseId: "concept" });
    expect(res.body.nextPhases).toContain("production");

    // Advance the rerun setTimeout (2.5s), then flush the microtask queue so
    // the async runTask call resolves before assertions.
    await vi.advanceTimersByTimeAsync(2500);

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith("task-rerun-1");
  });

  it("does NOT call deps.runTask when the approval finishes the task (taskDone=true)", async () => {
    const mockPackRegistry = {
      get: vi.fn().mockReturnValue({ key: "video_preprod", phases: [] }),
    };
    const mockGraphRunner = {
      onPhaseComplete: vi.fn().mockResolvedValue({
        advanced: true,
        nextPhases: [],
        taskDone: true,
      }),
    };

    const runTask = vi.fn(async (_taskId: string) => {});

    const { app } = buildApp({
      tasks: [
        {
          id: "task-final",
          title: "Final Task",
          workflow_pack_key: "video_preprod",
          project_path: "/tmp/project",
          assigned_agent_id: null,
          status: "awaiting_approval",
        },
      ],
      subtasks: [
        {
          id: "st-final",
          task_id: "task-final",
          title: "[pipeline:assembly]",
          description: "",
          status: "awaiting_approval",
          completed_at: null,
          updated_at: null,
        },
      ],
      packRegistry: mockPackRegistry,
      graphRunner: mockGraphRunner,
      runTask,
    });

    const res = await request(app)
      .post("/api/core/tasks/task-final/phases/assembly/approve")
      .set(authHeader())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.taskDone).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(runTask).not.toHaveBeenCalled();
  });

  it("logs the failure when deps.runTask rejects", async () => {
    const mockPackRegistry = {
      get: vi.fn().mockReturnValue({ key: "video_preprod", phases: [] }),
    };
    const mockGraphRunner = {
      onPhaseComplete: vi.fn().mockResolvedValue({
        advanced: true,
        nextPhases: ["production"],
        taskDone: false,
      }),
    };

    const runTask = vi.fn(async (_taskId: string) => {
      throw new Error("boom");
    });

    const { app, appendTaskLog } = buildApp({
      tasks: [
        {
          id: "task-rerun-fail",
          title: "Failing Rerun",
          workflow_pack_key: "video_preprod",
          project_path: "/tmp/project",
          assigned_agent_id: null,
          status: "awaiting_approval",
        },
      ],
      subtasks: [
        {
          id: "st-fail",
          task_id: "task-rerun-fail",
          title: "[pipeline:concept]",
          description: "",
          status: "awaiting_approval",
          completed_at: null,
          updated_at: null,
        },
      ],
      packRegistry: mockPackRegistry,
      graphRunner: mockGraphRunner,
      runTask,
    });

    const res = await request(app)
      .post("/api/core/tasks/task-rerun-fail/phases/concept/approve")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(2500);
    // allow the rejection to flush
    await Promise.resolve();
    await Promise.resolve();

    expect(runTask).toHaveBeenCalledTimes(1);
    const errorLog = appendTaskLog.mock.calls.find(
      (c: unknown[]) => c[1] === "error" && String(c[2]).includes("re-run"),
    );
    expect(errorLog).toBeDefined();
    expect(String(errorLog?.[2])).toContain("boom");
  });
});
