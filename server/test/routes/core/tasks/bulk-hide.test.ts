import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerTaskCrudRoutes, type TaskCrudRouteDeps } from "../../../../modules/routes/core/tasks/crud.ts";

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../../security/auth.ts", () => ({
  shouldRequireCsrf: vi.fn(() => false),
  hasValidCsrfToken: vi.fn(() => true),
}));

vi.mock("../../../../modules/workflow/packs/definitions.ts", () => ({
  isWorkflowPackKey: vi.fn(() => false),
}));

vi.mock("../../../../modules/workflow/packs/task-pack-resolver.ts", () => ({
  resolveWorkflowPackKeyForTask: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// In-memory SQLite-like mock DB
// ---------------------------------------------------------------------------

interface MockTaskRow {
  id: string;
  title: string;
  status: string;
  hidden: number;
  assigned_agent_id: string | null;
  department_id: string | null;
  updated_at: number;
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
          return undefined;
        },
        run: (...params: unknown[]) => {
          if (upper.includes("UPDATE TASKS SET HIDDEN")) {
            // params: hidden, updated_at, ...statuses, hidden (for WHERE hidden != ?)
            const hiddenVal = params[0] as number;
            const statuses = params.slice(2, params.length - 1) as string[];
            const notHidden = params[params.length - 1] as number;
            let changes = 0;
            for (const t of tasks) {
              if (statuses.includes(t.status) && t.hidden !== notHidden) {
                t.hidden = hiddenVal;
                changes++;
              }
            }
            return { changes };
          }
          return { changes: 0 };
        },
        all: () => [],
      };
    },
    exec: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function createTestDeps(db: ReturnType<typeof createMockDb>) {
  const app = express();
  app.use(express.json());

  const deps: TaskCrudRouteDeps = {
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
    firstQueryValue: vi.fn(),
    reconcileCrossDeptSubtasks: vi.fn(),
    normalizeTextField: vi.fn((v: unknown) => (typeof v === "string" ? v.trim() || null : null)),
    recordTaskCreationAudit: vi.fn(),
    appendTaskLog: vi.fn(),
    broadcast: vi.fn(),
    setTaskCreationAuditCompletion: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    activeProcesses: new Map(),
    stopRequestedTasks: new Set(),
    killPidTree: vi.fn(),
    logsDir: "/tmp/test-logs",
  };

  return deps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<MockTaskRow> = {}): MockTaskRow {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test task",
    status: "done",
    hidden: 0,
    assigned_agent_id: null,
    department_id: null,
    updated_at: Date.now(),
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("POST /api/tasks/bulk-hide", () => {
  it("hides tasks matching given statuses", async () => {
    const tasks = [
      makeTask({ id: "t1", status: "done", hidden: 0 }),
      makeTask({ id: "t2", status: "done", hidden: 0 }),
      makeTask({ id: "t3", status: "in_progress", hidden: 0 }),
    ];
    const db = createMockDb({ tasks });
    const deps = createTestDeps(db);
    registerTaskCrudRoutes(deps);

    const res = await request(deps.app)
      .post("/api/tasks/bulk-hide")
      .send({ statuses: ["done"], hidden: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.affected).toBe(2);
  });

  it("rejects empty statuses array", async () => {
    const db = createMockDb({ tasks: [] });
    const deps = createTestDeps(db);
    registerTaskCrudRoutes(deps);

    const res = await request(deps.app).post("/api/tasks/bulk-hide").send({ statuses: [], hidden: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects invalid hidden value", async () => {
    const db = createMockDb({ tasks: [] });
    const deps = createTestDeps(db);
    registerTaskCrudRoutes(deps);

    const res = await request(deps.app)
      .post("/api/tasks/bulk-hide")
      .send({ statuses: ["done"], hidden: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});
