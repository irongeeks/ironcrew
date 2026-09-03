import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  registerTaskExecutionControlRoutes,
  type TaskExecutionControlRouteDeps,
} from "../../../../modules/routes/core/tasks/execution-control.ts";

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../../security/auth.ts", () => ({
  shouldRequireCsrf: vi.fn(() => false),
  hasValidCsrfToken: vi.fn(() => true),
  buildTaskInterruptControlToken: vi.fn(() => "mock-control-token"),
  hasValidTaskInterruptControlToken: vi.fn(() => false),
}));

vi.mock("../../../../modules/workflow/core/interrupt-injection-tools.ts", () => ({
  sanitizeInterruptPrompt: vi.fn((prompt: unknown) => {
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return { ok: false, error: "prompt_required" };
    }
    return { ok: true, value: String(prompt).trim() };
  }),
  hashInterruptPrompt: vi.fn(() => "abc123hash"),
  queueInterruptPrompt: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface MockTaskRow {
  id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  department_id: string | null;
}

function createMockDb(opts: { tasks?: MockTaskRow[] }) {
  const tasks = [...(opts.tasks ?? [])];

  return {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase();
      return {
        get: (...params: unknown[]) => {
          if (upper.includes("FROM TASKS") && upper.includes("WHERE ID")) {
            return tasks.find((t) => t.id === params[0]);
          }
          if (upper.includes("FROM AGENTS") && upper.includes("WHERE ID")) {
            return { id: params[0], cli_provider: "claude", status: "idle" };
          }
          if (upper.includes("COUNT") && upper.includes("TASK_INTERRUPT_INJECTIONS")) {
            return { cnt: 1 };
          }
          return undefined;
        },
        run: (...params: unknown[]) => {
          if (upper.includes("UPDATE TASKS SET STATUS")) {
            const task = tasks.find((t) => t.id === params[params.length - 1]);
            if (task) task.status = params[0] as string;
          }
          return { changes: 0 };
        },
        all: () => [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "ctrl-task-0001";

function defaultTask(overrides: Partial<MockTaskRow> = {}): MockTaskRow {
  return {
    id: TASK_ID,
    title: "Test task",
    status: "in_progress",
    assigned_agent_id: "agent-001",
    department_id: "dev",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function createMockDeps(
  db: ReturnType<typeof createMockDb>,
  overrides: Partial<TaskExecutionControlRouteDeps> = {},
): TaskExecutionControlRouteDeps {
  const app = express();
  app.use(express.json());

  return {
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
    resolveLang: () => "en",
    stopProgressTimer: vi.fn(),
    activeProcesses: new Map(),
    rollbackTaskWorktree: vi.fn(() => false),
    clearTaskWorkflowState: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    broadcast: vi.fn(),
    notifyCeo: vi.fn(),
    pickL: ((_pool: any, _lang: any) => "") as any,
    l: ((..._args: any[]) => ({ ko: [], en: [], ja: [], zh: [], de: [] })) as any,
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map<string, "cancel" | "pause">(),
    interruptPidTree: vi.fn(),
    killPidTree: vi.fn(),
    appendTaskLog: vi.fn(),
    delegatedTaskToSubtask: new Map(),
    subtaskDelegationCallbacks: new Map(),
    crossDeptNextCallbacks: new Map(),
    subtaskDelegationDispatchInFlight: new Set(),
    subtaskDelegationCompletionNoticeSent: new Set(),
    taskExecutionSessions: new Map(),
    ensureTaskExecutionSession: vi.fn(() => ({
      sessionId: "sess-1",
      taskId: "t1",
      agentId: "a1",
      provider: "claude",
      openedAt: Date.now(),
      lastTouchedAt: Date.now(),
    })),
    getDeptName: vi.fn(() => "Development"),
    isTaskWorkflowInterrupted: vi.fn(() => false),
    startTaskExecutionForAgent: vi.fn(),
    randomDelay: vi.fn(() => 0),
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Task Execution Control Routes", () => {
  // -------------------------------------------------------------------------
  // POST /api/tasks/:id/stop
  // -------------------------------------------------------------------------

  describe("POST /api/tasks/:id/stop", () => {
    it("returns ok for an in_progress task (no active process)", async () => {
      const db = createMockDb({ tasks: [defaultTask({ status: "in_progress" })] });
      const deps = createMockDeps(db);
      registerTaskExecutionControlRoutes(deps);

      const res = await request(deps.app).post(`/api/tasks/${TASK_ID}/stop`).send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toMatch(/No active process/i);
    });

    it("returns 404 for a missing task", async () => {
      const db = createMockDb({ tasks: [] });
      const deps = createMockDeps(db);
      registerTaskExecutionControlRoutes(deps);

      const res = await request(deps.app).post("/api/tasks/nonexistent/stop").send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/tasks/:id/resume
  // -------------------------------------------------------------------------

  describe("POST /api/tasks/:id/resume", () => {
    it("returns ok for a cancelled task", async () => {
      const db = createMockDb({ tasks: [defaultTask({ status: "cancelled", assigned_agent_id: null })] });
      const deps = createMockDeps(db);
      registerTaskExecutionControlRoutes(deps);

      const res = await request(deps.app).post(`/api/tasks/${TASK_ID}/resume`).send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // No assigned agent => goes to inbox
      expect(res.body.status).toBe("inbox");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/tasks/:id/inject
  // -------------------------------------------------------------------------

  describe("POST /api/tasks/:id/inject", () => {
    it("rejects when body has no session proof", async () => {
      const db = createMockDb({ tasks: [defaultTask({ status: "pending" })] });
      const deps = createMockDeps(db);
      registerTaskExecutionControlRoutes(deps);

      // Send empty body — no session_id or interrupt_token
      const res = await request(deps.app).post(`/api/tasks/${TASK_ID}/inject`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("session_proof_required");
    });
  });
});
