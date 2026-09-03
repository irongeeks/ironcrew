import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerPhaseApprovalRoutes } from "../../../modules/routes/core/tasks/phase-approval.ts";
import { SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

interface MockTaskRow {
  id: string;
  title: string;
  status: string;
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

    // Single phase lookup by exact title match
    if (
      upper.startsWith("SELECT * FROM SUBTASKS WHERE TASK_ID") &&
      upper.includes("TITLE = ?") &&
      upper.includes("LIMIT")
    ) {
      return {
        get: (taskId: unknown, title: unknown) => {
          return subtasks.find((s) => s.task_id === taskId && s.title === String(title));
        },
        run: () => {},
      };
    }

    // All pipeline subtasks for a task
    if (
      upper.includes("FROM SUBTASKS") &&
      upper.includes("LIKE") &&
      upper.includes("PIPELINE") &&
      !upper.includes("LIMIT")
    ) {
      return {
        get: () => undefined,
        all: (taskId: unknown) =>
          subtasks.filter(
            (s) => s.task_id === taskId && s.title.startsWith("[pipeline:") && s.title !== "[pipeline:__input__]",
          ),
        run: () => {},
      };
    }

    // "UPDATE subtasks SET status = 'pending', completed_at = NULL WHERE id = ?" — 1 param (id)
    if (upper.startsWith("UPDATE SUBTASKS SET STATUS = 'PENDING'")) {
      return {
        get: () => undefined,
        run: (id: unknown) => {
          const st = subtasks.find((s) => s.id === id);
          if (st) {
            st.status = "pending";
            st.completed_at = null;
          }
        },
      };
    }

    // "UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?" — 2 params
    if (upper.startsWith("UPDATE SUBTASKS SET STATUS = 'DONE'")) {
      return {
        get: () => undefined,
        run: (completedAt: unknown, id: unknown) => {
          const st = subtasks.find((s) => s.id === id);
          if (st) {
            st.status = "done";
            st.completed_at = completedAt as number;
          }
        },
      };
    }

    // "UPDATE subtasks SET status = ?, completed_at = NULL WHERE id = ?" — 2 params (status, id)
    if (upper.startsWith("UPDATE SUBTASKS SET STATUS = ?,")) {
      return {
        get: () => undefined,
        run: (status: unknown, id: unknown) => {
          const st = subtasks.find((s) => s.id === id);
          if (st) {
            st.status = status as string;
            st.completed_at = null;
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

    if (upper.startsWith("UPDATE AGENTS")) {
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

    if (upper.startsWith("SELECT * FROM AGENTS")) {
      return {
        get: (id: unknown) => agents.find((a) => a.id === id),
        run: () => {},
      };
    }

    if (upper.startsWith("UPDATE TASKS SET STATUS")) {
      return {
        get: () => undefined,
        run: (_updatedAt: unknown, taskId: unknown) => {
          const task = tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = "planned";
          }
        },
      };
    }

    // Default fallback
    return {
      get: (..._args: unknown[]) => undefined,
      all: (..._args: unknown[]) => [],
      run: (..._args: unknown[]) => {},
    };
  }

  return { prepare, _tasks: tasks, _subtasks: subtasks, _agents: agents };
}

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

function buildApp(opts: {
  tasks?: MockTaskRow[];
  subtasks?: MockSubtaskRow[];
  agents?: MockAgent[];
  packRegistry?: object | null;
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
  const activeProcesses = new Map();
  const stopRequestedTasks = new Set<string>();
  const killPidTree = vi.fn();
  const endTaskExecutionSession = vi.fn();

  const deps = {
    app,
    db,
    nowMs,
    broadcast,
    appendTaskLog,
    packRegistry: opts.packRegistry !== undefined ? opts.packRegistry : null,
    graphRunner: null,
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    endTaskExecutionSession,
  };

  registerPhaseApprovalRoutes(deps as never);

  return {
    app,
    broadcast,
    appendTaskLog,
    db,
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    endTaskExecutionSession,
  };
}

function authHeader() {
  return { Authorization: `Bearer ${SESSION_AUTH_TOKEN}` };
}

// ---------------------------------------------------------------------------
// Tests — POST /api/core/tasks/:taskId/phases/:phaseId/reset
// ---------------------------------------------------------------------------

describe("POST /api/core/tasks/:taskId/phases/:phaseId/reset", () => {
  it("returns 404 when task does not exist", async () => {
    const { app } = buildApp({ tasks: [] });

    const res = await request(app).post("/api/core/tasks/missing/phases/concept/reset").set(authHeader()).send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "task_not_found" });
  });

  it("returns 404 when phase subtask is not found", async () => {
    const { app } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [],
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/concept/reset").set(authHeader()).send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "phase_not_found", phaseId: "concept" });
  });

  it("resets a single phase back to pending", async () => {
    const { app, db, broadcast, appendTaskLog } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:concept]", description: "", status: "done", completed_at: 1000 },
      ],
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/concept/reset").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reset: true, phaseId: "concept" });

    // Subtask should be reset to pending
    const st = db._subtasks.find((s) => s.id === "st1");
    expect(st?.status).toBe("pending");
    expect(st?.completed_at).toBeNull();

    // broadcast and log should be called
    expect(broadcast).toHaveBeenCalledWith("subtask_update", expect.any(Object));
    expect(appendTaskLog).toHaveBeenCalledWith("t1", "system", expect.stringContaining("concept"));
  });

  it("releases assigned agent to idle on reset", async () => {
    const { app, db, broadcast } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: "agent-1",
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:concept]", description: "", status: "done", completed_at: 1000 },
      ],
      agents: [{ id: "agent-1", status: "working", current_task_id: "t1" }],
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/concept/reset").set(authHeader()).send({});

    expect(res.status).toBe(200);

    const agent = db._agents.find((a) => a.id === "agent-1");
    expect(agent?.status).toBe("idle");
    expect(agent?.current_task_id).toBeNull();

    const broadcastEvents = (broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(broadcastEvents).toContain("agent_status");
  });

  it("moves task from review back to planned on reset", async () => {
    const { app, db, broadcast } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:concept]", description: "", status: "done", completed_at: 1000 },
      ],
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/concept/reset").set(authHeader()).send({});

    expect(res.status).toBe(200);

    const task = db._tasks.find((t) => t.id === "t1");
    expect(task?.status).toBe("planned");

    const broadcastEvents = (broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(broadcastEvents).toContain("task_update");
  });

  it("stops active agent process before reset", async () => {
    const mockChild = { pid: 12345 };
    const { app, activeProcesses, killPidTree, endTaskExecutionSession, stopRequestedTasks } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "in_progress",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        {
          id: "st1",
          task_id: "t1",
          title: "[pipeline:concept]",
          description: "",
          status: "in_progress",
          completed_at: null,
        },
      ],
    });

    activeProcesses.set("t1", mockChild);

    const res = await request(app).post("/api/core/tasks/t1/phases/concept/reset").set(authHeader()).send({});

    expect(res.status).toBe(200);

    // Active process should have been cleaned up
    expect(activeProcesses.has("t1")).toBe(false);
    expect(killPidTree).toHaveBeenCalledWith(12345);
    expect(stopRequestedTasks.has("t1")).toBe(true);
    expect(endTaskExecutionSession).toHaveBeenCalledWith("t1");
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/core/tasks/:taskId/phases/reset-from/:phaseId
// ---------------------------------------------------------------------------

describe("POST /api/core/tasks/:taskId/phases/reset-from/:phaseId", () => {
  it("returns 404 when task does not exist", async () => {
    const { app } = buildApp({ tasks: [] });

    const res = await request(app).post("/api/core/tasks/missing/phases/reset-from/concept").set(authHeader()).send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "task_not_found" });
  });

  it("returns 404 when no matching phase subtasks are found (no graph, no subtasks)", async () => {
    const { app } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [],
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/reset-from/concept").set(authHeader()).send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "phase_not_found" });
  });

  it("resets target phase to pending and downstream to blocked using graph BFS", async () => {
    // Build a mock pack registry with adjacency: concept → design → implementation
    const mockPackRegistry = {
      get: vi.fn().mockReturnValue({
        key: "dev_pack",
        graph: {
          adjacency: new Map([
            ["concept", ["design"]],
            ["design", ["implementation"]],
            ["implementation", []],
          ]),
        },
      }),
    };

    const { app, db, broadcast, appendTaskLog } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: "dev_pack",
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:concept]", description: "", status: "done", completed_at: 1000 },
        { id: "st2", task_id: "t1", title: "[pipeline:design]", description: "", status: "done", completed_at: 2000 },
        {
          id: "st3",
          task_id: "t1",
          title: "[pipeline:implementation]",
          description: "",
          status: "done",
          completed_at: 3000,
        },
      ],
      packRegistry: mockPackRegistry,
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/reset-from/concept").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    expect(res.body.resetPhases).toContain("concept");
    expect(res.body.resetPhases).toContain("design");
    expect(res.body.resetPhases).toContain("implementation");
    expect(res.body.resetPhases).toHaveLength(3);

    // concept → pending, downstream → blocked
    const concept = db._subtasks.find((s) => s.id === "st1");
    expect(concept?.status).toBe("pending");

    const design = db._subtasks.find((s) => s.id === "st2");
    expect(design?.status).toBe("blocked");

    const impl = db._subtasks.find((s) => s.id === "st3");
    expect(impl?.status).toBe("blocked");

    // Should have broadcast updates for each reset subtask
    const subtaskUpdates = (broadcast as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "subtask_update",
    );
    expect(subtaskUpdates).toHaveLength(3);

    expect(appendTaskLog).toHaveBeenCalledWith("t1", "system", expect.stringContaining("3 phases reset"));
  });

  it("falls back to creation-order reset when no pack registry is available", async () => {
    const { app, db } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:concept]", description: "", status: "done", completed_at: 1000 },
        { id: "st2", task_id: "t1", title: "[pipeline:design]", description: "", status: "done", completed_at: 2000 },
        {
          id: "st3",
          task_id: "t1",
          title: "[pipeline:implementation]",
          description: "",
          status: "done",
          completed_at: 3000,
        },
      ],
      packRegistry: null,
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/reset-from/concept").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    // Should reset concept + everything after it
    expect(res.body.resetPhases).toContain("concept");
    expect(res.body.resetPhases).toContain("design");
    expect(res.body.resetPhases).toContain("implementation");

    // concept → pending, rest → blocked
    expect(db._subtasks.find((s) => s.id === "st1")?.status).toBe("pending");
    expect(db._subtasks.find((s) => s.id === "st2")?.status).toBe("blocked");
    expect(db._subtasks.find((s) => s.id === "st3")?.status).toBe("blocked");
  });

  it("releases assigned agent on cascade reset", async () => {
    const { app, db } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: "agent-1",
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:concept]", description: "", status: "done", completed_at: 1000 },
      ],
      agents: [{ id: "agent-1", status: "working", current_task_id: "t1" }],
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/reset-from/concept").set(authHeader()).send({});

    expect(res.status).toBe(200);

    const agent = db._agents.find((a) => a.id === "agent-1");
    expect(agent?.status).toBe("idle");
    expect(agent?.current_task_id).toBeNull();
  });

  it("stops active process before cascade reset", async () => {
    const mockChild = { pid: 99999 };
    const { app, activeProcesses, killPidTree, endTaskExecutionSession } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "in_progress",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        {
          id: "st1",
          task_id: "t1",
          title: "[pipeline:concept]",
          description: "",
          status: "in_progress",
          completed_at: null,
        },
      ],
    });

    activeProcesses.set("t1", mockChild);

    const res = await request(app).post("/api/core/tasks/t1/phases/reset-from/concept").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(activeProcesses.has("t1")).toBe(false);
    expect(killPidTree).toHaveBeenCalledWith(99999);
    expect(endTaskExecutionSession).toHaveBeenCalledWith("t1");
  });

  it("handles fan-out phase IDs with index suffix (e.g., crawl:0)", async () => {
    const mockPackRegistry = {
      get: vi.fn().mockReturnValue({
        key: "research",
        graph: {
          adjacency: new Map([
            ["crawl", ["synthesis"]],
            ["synthesis", []],
          ]),
        },
      }),
    };

    const { app } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "review",
          workflow_pack_key: "research",
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:crawl:0]", description: "", status: "done", completed_at: 1000 },
        { id: "st2", task_id: "t1", title: "[pipeline:crawl:1]", description: "", status: "done", completed_at: 2000 },
        {
          id: "st3",
          task_id: "t1",
          title: "[pipeline:synthesis]",
          description: "",
          status: "done",
          completed_at: 3000,
        },
      ],
      packRegistry: mockPackRegistry,
    });

    // Using crawl:0 as phaseId — should strip the :0 for graph lookup
    const res = await request(app).post("/api/core/tasks/t1/phases/reset-from/crawl:0").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    // Should reset both crawl instances and synthesis
    expect(res.body.resetPhases).toContain("crawl:0");
    expect(res.body.resetPhases).toContain("crawl:1");
    expect(res.body.resetPhases).toContain("synthesis");
  });

  it("moves task back to planned when status is done or review", async () => {
    const { app, db } = buildApp({
      tasks: [
        {
          id: "t1",
          title: "Task",
          status: "done",
          workflow_pack_key: null,
          project_path: null,
          assigned_agent_id: null,
        },
      ],
      subtasks: [
        { id: "st1", task_id: "t1", title: "[pipeline:concept]", description: "", status: "done", completed_at: 1000 },
      ],
    });

    const res = await request(app).post("/api/core/tasks/t1/phases/reset-from/concept").set(authHeader()).send({});

    expect(res.status).toBe(200);
    expect(db._tasks.find((t) => t.id === "t1")?.status).toBe("planned");
  });
});
