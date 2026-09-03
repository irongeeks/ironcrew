import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { ChildProcess } from "node:child_process";
import { registerPhaseApprovalRoutes } from "../../../modules/routes/core/tasks/phase-approval.ts";
import { SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";

// ---------------------------------------------------------------------------
// Regression tests for C-003 (#57)
//
// POST /api/core/tasks/:taskId/phases/:phaseId/approve must stop any active
// agent process for the task BEFORE mutating subtask state, mirroring the
// existing behavior of /reset and /reset-from. Otherwise the old agent
// process can race with the next-phase re-trigger.
// ---------------------------------------------------------------------------

interface MockTaskRow {
  id: string;
  title: string;
  workflow_pack_key: string | null;
  project_path: string | null;
  assigned_agent_id: string | null;
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

function createMockDb(opts: {
  tasks: MockTaskRow[];
  subtasks: MockSubtaskRow[];
  // Records SQL operations in execution order so tests can assert
  // that stopActiveRun (kill / removal from activeProcesses) happens
  // BEFORE the subtask UPDATE.
  recorder: string[];
}) {
  const { tasks, subtasks, recorder } = opts;

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
        get: (taskId: unknown, title: unknown) =>
          subtasks.find((s) => s.task_id === taskId && s.title === String(title) && s.status === "awaiting_approval"),
        run: () => {},
      };
    }

    if (upper.startsWith("UPDATE SUBTASKS SET STATUS = 'DONE'")) {
      return {
        get: () => undefined,
        run: (completedAt: unknown, id: unknown) => {
          recorder.push("UPDATE_SUBTASK_DONE");
          const st = subtasks.find((s) => s.id === id);
          if (st) {
            st.status = "done";
            st.completed_at = completedAt as number;
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

    return {
      get: () => undefined,
      run: () => {},
    };
  }

  return { prepare };
}

function buildApp(opts: { activeProcesses: Map<string, ChildProcess>; recorder: string[] }) {
  const app = express();
  app.use(express.json());

  const tasks: MockTaskRow[] = [
    {
      id: "task-stop",
      title: "Task with active run",
      workflow_pack_key: null,
      project_path: null,
      assigned_agent_id: null,
    },
  ];
  const subtasks: MockSubtaskRow[] = [
    {
      id: "st-stop-1",
      task_id: "task-stop",
      title: "[pipeline:concept]",
      description: "",
      status: "awaiting_approval",
      completed_at: null,
      updated_at: null,
    },
  ];

  const db = createMockDb({ tasks, subtasks, recorder: opts.recorder });

  const broadcast = vi.fn();
  const appendTaskLog = vi.fn();

  const stopRequestedTasks = new Set<string>();
  const killPidTree = vi.fn((pid: number) => {
    opts.recorder.push(`KILL_PID:${pid}`);
  });
  const endTaskExecutionSession = vi.fn((taskId: string) => {
    opts.recorder.push(`END_SESSION:${taskId}`);
  });

  const deps = {
    app,
    db,
    nowMs: () => 1_000,
    broadcast,
    appendTaskLog,
    packRegistry: null,
    graphRunner: null,
    activeProcesses: opts.activeProcesses,
    stopRequestedTasks,
    killPidTree,
    endTaskExecutionSession,
  };

  registerPhaseApprovalRoutes(deps as never);

  return { app, broadcast, appendTaskLog, killPidTree, endTaskExecutionSession, stopRequestedTasks };
}

function authHeader() {
  return { Authorization: `Bearer ${SESSION_AUTH_TOKEN}` };
}

describe("POST /api/core/tasks/:taskId/phases/:phaseId/approve — stop active run (C-003 #57)", () => {
  it("stops the active agent process BEFORE updating the subtask status", async () => {
    const recorder: string[] = [];
    const fakeChild = { pid: 4242 } as ChildProcess;
    const activeProcesses = new Map<string, ChildProcess>([["task-stop", fakeChild]]);

    const { app, killPidTree, endTaskExecutionSession, stopRequestedTasks } = buildApp({
      activeProcesses,
      recorder,
    });

    const res = await request(app).post("/api/core/tasks/task-stop/phases/concept/approve").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: true, phaseId: "concept" });

    // killPidTree should have been called exactly once with the right pid
    expect(killPidTree).toHaveBeenCalledTimes(1);
    expect(killPidTree).toHaveBeenCalledWith(4242);

    // endTaskExecutionSession should have been called for the right task
    expect(endTaskExecutionSession).toHaveBeenCalledWith("task-stop");

    // stopRequestedTasks should record the stop intent
    expect(stopRequestedTasks.has("task-stop")).toBe(true);

    // activeProcesses entry should have been cleared
    expect(activeProcesses.has("task-stop")).toBe(false);

    // Order: KILL_PID before UPDATE_SUBTASK_DONE
    const killIdx = recorder.indexOf("KILL_PID:4242");
    const updateIdx = recorder.indexOf("UPDATE_SUBTASK_DONE");
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeLessThan(updateIdx);
  });

  it("is a no-op (does not call killPidTree) when no process is active", async () => {
    const recorder: string[] = [];
    const activeProcesses = new Map<string, ChildProcess>();

    const { app, killPidTree, endTaskExecutionSession } = buildApp({ activeProcesses, recorder });

    const res = await request(app).post("/api/core/tasks/task-stop/phases/concept/approve").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: true, phaseId: "concept" });

    // killPidTree must not be invoked when there is no active process
    expect(killPidTree).not.toHaveBeenCalled();

    // endTaskExecutionSession is still called (idempotent cleanup) — matches existing /reset behavior
    expect(endTaskExecutionSession).toHaveBeenCalledWith("task-stop");

    // The subtask update still happens
    expect(recorder).toContain("UPDATE_SUBTASK_DONE");
  });
});
