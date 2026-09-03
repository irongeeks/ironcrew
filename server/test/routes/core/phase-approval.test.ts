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

interface MockAgent {
  id: string;
  status: string;
  current_task_id: string | null;
}

function createMockDb(opts: { tasks?: MockTaskRow[]; subtasks?: MockSubtaskRow[]; agents?: MockAgent[] }) {
  const tasks: MockTaskRow[] = opts.tasks ?? [];
  const subtasks: MockSubtaskRow[] = opts.subtasks ?? [];
  const agents: MockAgent[] = opts.agents ?? [];

  const prepareStmts: Record<string, { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => void }> = {};

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
        get: (taskId: unknown, titlePattern: unknown) => {
          const pattern = String(titlePattern).replace(/%/g, "").replace(/\\(.)/g, "$1");
          return subtasks.find(
            (s) => s.task_id === taskId && s.title.includes(pattern) && s.status === "awaiting_approval",
          );
        },
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
        run: (_updatedAt: unknown, taskId: unknown) => {
          const task = tasks.find((t) => t.id === taskId);
          if (task) {
            // status update — no field to mutate in our MockTaskRow, but that's fine
          }
        },
      };
    }

    if (upper.startsWith("SELECT * FROM TASKS WHERE ID") || upper.startsWith("SELECT * FROM TASKS")) {
      return {
        get: (id: unknown) => tasks.find((t) => t.id === id),
        run: () => {},
      };
    }

    // Default fallback
    return {
      get: (..._args: unknown[]) => undefined,
      run: (..._args: unknown[]) => {},
    };

    void prepareStmts;
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
  graphRunner?: object | null;
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

  // Approve handler now calls stopActiveRun (C-003, #57). Provide the same
  // process-management deps the production wiring supplies so the handler
  // does not crash when no active process exists.
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
    graphRunner: opts.graphRunner !== undefined ? opts.graphRunner : null,
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    endTaskExecutionSession,
  };

  // Cast to any to satisfy the strict RuntimeContext typing in the route
  registerPhaseApprovalRoutes(deps as never);

  return { app, broadcast, appendTaskLog, db };
}

function authHeader() {
  return { Authorization: `Bearer ${SESSION_AUTH_TOKEN}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/core/tasks/:taskId/phases/:phaseId/approve", () => {
  // =========================================================================
  // 1. Auth required — no Authorization header → 401
  // =========================================================================
  describe("auth required", () => {
    it("returns 401 when no auth token is provided", async () => {
      const { app } = buildApp({
        tasks: [
          {
            id: "task-1",
            title: "My Task",
            workflow_pack_key: null,
            project_path: null,
            assigned_agent_id: null,
          },
        ],
      });

      const res = await request(app).post("/api/core/tasks/task-1/phases/concept/approve").send({});

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "unauthorized" });
    });

    it("returns 401 for a wrong auth token", async () => {
      const { app } = buildApp({});

      const res = await request(app)
        .post("/api/core/tasks/task-1/phases/concept/approve")
        .set("Authorization", "Bearer wrong-token")
        .send({});

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "unauthorized" });
    });
  });

  // =========================================================================
  // 2. Task not found → 404 { error: "task_not_found" }
  // =========================================================================
  describe("task not found", () => {
    it("returns 404 task_not_found when task does not exist", async () => {
      const { app } = buildApp({ tasks: [] }); // no tasks in DB

      const res = await request(app)
        .post("/api/core/tasks/nonexistent-task/phases/concept/approve")
        .set(authHeader())
        .send({});

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "task_not_found" });
    });
  });

  // =========================================================================
  // 3. Phase not awaiting approval → 404 { error: "phase_not_awaiting_approval" }
  // =========================================================================
  describe("phase not awaiting approval", () => {
    it("returns 404 when no subtask matches phaseId with awaiting_approval status", async () => {
      const { app } = buildApp({
        tasks: [
          {
            id: "task-2",
            title: "Task 2",
            workflow_pack_key: null,
            project_path: null,
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-1",
            task_id: "task-2",
            title: "[pipeline:concept]",
            description: "",
            status: "done", // not awaiting_approval
            completed_at: null,
            updated_at: null,
          },
        ],
      });

      const res = await request(app).post("/api/core/tasks/task-2/phases/concept/approve").set(authHeader()).send({});

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "phase_not_awaiting_approval", phaseId: "concept" });
    });

    it("returns 404 when no subtask at all matches the phaseId", async () => {
      const { app } = buildApp({
        tasks: [
          {
            id: "task-3",
            title: "Task 3",
            workflow_pack_key: null,
            project_path: null,
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-2",
            task_id: "task-3",
            title: "[pipeline:other_phase]",
            description: "",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
      });

      const res = await request(app)
        .post("/api/core/tasks/task-3/phases/concept/approve") // 'concept' not in DB
        .set(authHeader())
        .send({});

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "phase_not_awaiting_approval", phaseId: "concept" });
    });
  });

  // =========================================================================
  // 4. Successful approval
  // =========================================================================
  describe("successful approval", () => {
    it("sets subtask status to done and returns { approved: true, phaseId }", async () => {
      const { app, db, broadcast, appendTaskLog } = buildApp({
        tasks: [
          {
            id: "task-4",
            title: "Task 4",
            workflow_pack_key: null,
            project_path: null,
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-concept",
            task_id: "task-4",
            title: "[pipeline:concept]",
            description: "Concept phase",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
      });

      const res = await request(app).post("/api/core/tasks/task-4/phases/concept/approve").set(authHeader()).send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true, phaseId: "concept" });
      expect(res.body.nextPhases).toEqual([]);
      expect(res.body.taskDone).toBe(false);

      // Subtask should be set to done
      const updatedSubtask = db._subtasks.find((s) => s.id === "st-concept");
      expect(updatedSubtask?.status).toBe("done");

      // broadcast and appendTaskLog should have been called
      expect(broadcast).toHaveBeenCalledWith("subtask_update", expect.any(Object));
      expect(appendTaskLog).toHaveBeenCalledWith("task-4", "system", expect.stringContaining("concept"));
    });

    it("matches subtask by LIKE pattern [pipeline:phaseId]", async () => {
      const { app, db } = buildApp({
        tasks: [
          {
            id: "task-5",
            title: "Task 5",
            workflow_pack_key: null,
            project_path: null,
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-planning",
            task_id: "task-5",
            title: "My custom [pipeline:planning] subtask title",
            description: "Planning phase",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
      });

      const res = await request(app).post("/api/core/tasks/task-5/phases/planning/approve").set(authHeader()).send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true, phaseId: "planning" });

      // Subtask should be updated
      const updatedSubtask = db._subtasks.find((s) => s.id === "st-planning");
      expect(updatedSubtask?.status).toBe("done");
    });
  });

  // =========================================================================
  // 5. Graph-runner advancement — next phases unblocked after approval
  // =========================================================================
  describe("graph-runner advancement", () => {
    it("calls graphRunner.onPhaseComplete when pack and runner are provided", async () => {
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

      const { app } = buildApp({
        tasks: [
          {
            id: "task-6",
            title: "Task 6",
            workflow_pack_key: "video_preprod",
            project_path: "/tmp/project",
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-concept-6",
            task_id: "task-6",
            title: "[pipeline:concept]",
            description: "",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
        packRegistry: mockPackRegistry,
        graphRunner: mockGraphRunner,
      });

      const res = await request(app).post("/api/core/tasks/task-6/phases/concept/approve").set(authHeader()).send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true, phaseId: "concept" });
      expect(res.body.nextPhases).toContain("production");
      expect(mockGraphRunner.onPhaseComplete).toHaveBeenCalledWith(
        expect.any(Object), // db
        "task-6",
        "concept",
        expect.any(Object), // pack
        "/tmp/project",
        { approved: true },
      );
    });

    it("returns nextPhases and taskDone: true when last terminal phase is approved", async () => {
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

      const { app, appendTaskLog } = buildApp({
        tasks: [
          {
            id: "task-7",
            title: "Task 7",
            workflow_pack_key: "video_preprod",
            project_path: "/tmp/project",
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-final",
            task_id: "task-7",
            title: "[pipeline:assembly]",
            description: "",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
        packRegistry: mockPackRegistry,
        graphRunner: mockGraphRunner,
      });

      const res = await request(app).post("/api/core/tasks/task-7/phases/assembly/approve").set(authHeader()).send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true, phaseId: "assembly", taskDone: true });
      expect(res.body.nextPhases).toHaveLength(0);
      expect(appendTaskLog).toHaveBeenCalledWith("task-7", "system", expect.stringContaining("terminal"));
    });

    it("skips graph-runner when packRegistry.get throws", async () => {
      const mockPackRegistry = {
        get: vi.fn().mockImplementation(() => {
          throw new Error("pack not found");
        }),
      };

      const mockGraphRunner = {
        onPhaseComplete: vi.fn().mockResolvedValue({
          advanced: false,
          nextPhases: [],
          taskDone: false,
        }),
      };

      const { app } = buildApp({
        tasks: [
          {
            id: "task-8",
            title: "Task 8",
            workflow_pack_key: "unknown_pack",
            project_path: null,
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-phase-8",
            task_id: "task-8",
            title: "[pipeline:concept]",
            description: "",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
        packRegistry: mockPackRegistry,
        graphRunner: mockGraphRunner,
      });

      const res = await request(app).post("/api/core/tasks/task-8/phases/concept/approve").set(authHeader()).send({});

      // Should still succeed — graph runner errors are swallowed gracefully
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true, phaseId: "concept" });
      // graphRunner.onPhaseComplete should NOT have been called (pack not found)
      expect(mockGraphRunner.onPhaseComplete).not.toHaveBeenCalled();
    });

    it("skips graph-runner when workflow_pack_key is null", async () => {
      const mockPackRegistry = { get: vi.fn() };
      const mockGraphRunner = { onPhaseComplete: vi.fn() };

      const { app } = buildApp({
        tasks: [
          {
            id: "task-9",
            title: "Task 9",
            workflow_pack_key: null, // no pack
            project_path: null,
            assigned_agent_id: null,
          },
        ],
        subtasks: [
          {
            id: "st-phase-9",
            task_id: "task-9",
            title: "[pipeline:concept]",
            description: "",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
        packRegistry: mockPackRegistry,
        graphRunner: mockGraphRunner,
      });

      const res = await request(app).post("/api/core/tasks/task-9/phases/concept/approve").set(authHeader()).send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true, phaseId: "concept" });
      expect(mockPackRegistry.get).not.toHaveBeenCalled();
      expect(mockGraphRunner.onPhaseComplete).not.toHaveBeenCalled();
    });

    it("resets assigned agent to idle when next phases are available", async () => {
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

      const { app, db, broadcast } = buildApp({
        tasks: [
          {
            id: "task-10",
            title: "Task 10",
            workflow_pack_key: "video_preprod",
            project_path: "/tmp/project",
            assigned_agent_id: "agent-1",
          },
        ],
        subtasks: [
          {
            id: "st-concept-10",
            task_id: "task-10",
            title: "[pipeline:concept]",
            description: "",
            status: "awaiting_approval",
            completed_at: null,
            updated_at: null,
          },
        ],
        agents: [
          {
            id: "agent-1",
            status: "working",
            current_task_id: "task-10",
          },
        ],
        packRegistry: mockPackRegistry,
        graphRunner: mockGraphRunner,
      });

      const res = await request(app).post("/api/core/tasks/task-10/phases/concept/approve").set(authHeader()).send({});

      expect(res.status).toBe(200);
      expect(res.body.nextPhases).toContain("production");

      // Agent should be reset to idle
      const agent = db._agents.find((a) => a.id === "agent-1");
      expect(agent?.status).toBe("idle");
      expect(agent?.current_task_id).toBeNull();

      // broadcast should include agent_status and task_update events
      const broadcastCalls = (broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(broadcastCalls).toContain("agent_status");
      expect(broadcastCalls).toContain("task_update");
    });
  });
});
