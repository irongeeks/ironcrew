/**
 * Integration test: inbox "approve <phaseId>" message → bridge → approval endpoint.
 *
 * The bridge makes an internal fetch to POST /api/core/tasks/:taskId/phases/:phaseId/approve.
 * This test intercepts that fetch and routes it through a real supertest Express app that has
 * the actual approval route registered, verifying that the full round-trip — lookup, HTTP
 * delegate, DB mutation — works correctly with shared state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { createPhaseApprovalBridge } from "../../../../modules/routes/ops/messages/phase-approval-bridge.ts";
import { registerPhaseApprovalRoutes } from "../../../../modules/routes/core/tasks/phase-approval.ts";
import { SESSION_AUTH_TOKEN } from "../../../../config/runtime.ts";

// ---------------------------------------------------------------------------
// Mocks shared by the bridge
// ---------------------------------------------------------------------------

vi.mock("../../../../gateway/client.ts", () => ({
  sendMessengerMessage: vi.fn().mockResolvedValue(undefined),
  notifyPhaseApprovalNeeded: vi.fn(),
}));
vi.mock("../../../../messenger/channels.ts", () => ({
  isMessengerChannel: vi.fn().mockReturnValue(false),
}));
vi.mock("../../../../messenger/session-agent-routing.ts", () => ({
  resolveSourceChatRoute: vi.fn().mockReturnValue(null),
}));
vi.mock("../../../../observability/logger.ts", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

// PORT will be set dynamically per test (see fetchSpy below).
vi.mock("../../../../config/runtime.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../../config/runtime.ts")>();
  return { ...orig }; // keep SESSION_AUTH_TOKEN; PORT unused — we intercept fetch
});

// ---------------------------------------------------------------------------
// Shared mock DB
// ---------------------------------------------------------------------------

interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  status: string;
  completed_at: number | null;
}

interface TaskRow {
  id: string;
  title: string;
  workflow_pack_key: string | null;
  project_path: string | null;
  assigned_agent_id: string | null;
}

function createSharedDb(tasks: TaskRow[], subtasks: SubtaskRow[]) {
  // The bridge uses `.all()` on prepared statements; the approval route uses
  // `prepare().get()` and `prepare().run()`.  We build a single object that
  // satisfies both interfaces.
  return {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase();

      return {
        get: (...params: unknown[]): unknown => {
          // bridge: SELECT task_id FROM … WHERE title = ? AND status = 'awaiting_approval'
          // bridge: SELECT title FROM tasks WHERE id = ?
          // approval route: SELECT * FROM tasks WHERE id = ?
          // approval route: SELECT * FROM subtasks WHERE task_id = ? AND title = ? AND status = 'awaiting_approval' LIMIT 1
          // approval route: SELECT * FROM subtasks WHERE id = ?
          if (upper.includes("FROM TASKS")) {
            const id = params[0] as string;
            return tasks.find((t) => t.id === id);
          }
          if (upper.includes("FROM SUBTASKS") && upper.includes("WHERE ID")) {
            const id = params[0] as string;
            return subtasks.find((s) => s.id === id);
          }
          if (upper.includes("FROM SUBTASKS")) {
            // Could be task_id + title + optional status filter
            const [taskId, titleOrPattern] = params as [string, string];
            const title = String(titleOrPattern).replace(/%/g, "").replace(/\\(.)/g, "$1");
            return subtasks.find(
              (s) =>
                s.task_id === taskId &&
                s.title.includes(title) &&
                (!upper.includes("AWAITING_APPROVAL") || s.status === "awaiting_approval"),
            );
          }
          return undefined;
        },
        all: (...params: unknown[]): unknown[] => {
          // bridge: SELECT task_id FROM subtasks WHERE title = ? AND status = 'awaiting_approval'
          if (upper.includes("FROM SUBTASKS")) {
            const titlePattern = params[0] as string;
            return subtasks.filter((s) => s.title === titlePattern && s.status === "awaiting_approval");
          }
          return [];
        },
        run: (...params: unknown[]) => {
          // approval route: UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?
          if (
            upper.startsWith("UPDATE SUBTASKS SET STATUS = 'DONE'") ||
            upper.includes("SET STATUS = ?, COMPLETED_AT")
          ) {
            const [completedAt, id] = upper.includes("SET STATUS = ?, COMPLETED_AT")
              ? [params[1] as number, params[2] as string]
              : [params[0] as number, params[1] as string];
            const st = subtasks.find((s) => s.id === id);
            if (st) {
              st.status = "done";
              st.completed_at = completedAt;
            }
            return;
          }
          // Other UPDATEs (tasks, agents) — no-op for this test
        },
      };
    },
    _subtasks: subtasks,
    _tasks: tasks,
  };
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe("phase-approval-bridge integration: bridge → approval endpoint", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = undefined as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup() {
    const tasks: TaskRow[] = [
      {
        id: "task-int-1",
        title: "Integration Task",
        workflow_pack_key: null,
        project_path: null,
        assigned_agent_id: null,
      },
    ];
    const subtasks: SubtaskRow[] = [
      {
        id: "sub-int-1",
        task_id: "task-int-1",
        title: "[pipeline:review]",
        status: "awaiting_approval",
        completed_at: null,
      },
    ];

    const db = createSharedDb(tasks, subtasks);

    // Build the approval Express app backed by the same shared DB
    const approvalApp = express();
    approvalApp.use(express.json());
    registerPhaseApprovalRoutes({
      app: approvalApp,
      db: db as never,
      nowMs: () => Date.now(),
      broadcast: vi.fn(),
      appendTaskLog: vi.fn(),
      packRegistry: null as never,
      graphRunner: null as never,
      activeProcesses: new Map(),
      stopRequestedTasks: new Set(),
      killPidTree: vi.fn(),
      endTaskExecutionSession: vi.fn(),
      runTask: vi.fn(),
    });

    // Intercept the bridge's internal fetch and forward it to a supertest agent
    // backed by the real approval route.  This is the integration seam being tested.
    const supertestAgent = request(approvalApp);
    fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockImplementation(async (input: unknown, opts: unknown) => {
      const urlStr = String(input);
      const m = urlStr.match(/\/api\/core\/tasks\/([^/]+)\/phases\/([^/]+)\/approve/);
      if (m) {
        const [, taskId, phaseId] = m;
        const res = await supertestAgent
          .post(`/api/core/tasks/${taskId}/phases/${phaseId}/approve`)
          .set(
            "Authorization",
            (((opts as Record<string, unknown>)?.headers ?? {}) as Record<string, string>)["Authorization"] ?? "",
          )
          .send({});
        return new Response(JSON.stringify(res.body), { status: res.status });
      }
      return new Response("{}", { status: 200 });
    });

    // Bridge backed by the same shared DB
    const bridge = createPhaseApprovalBridge({ db: db as never });

    return { bridge, db, fetchSpy };
  }

  it("approve <phaseId> routes through the real approval endpoint and marks the subtask done", async () => {
    const { bridge, db } = setup();

    const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve review" });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.payload.approved).toBe(true);
    expect(result.payload.task_id).toBe("task-int-1");
    expect(result.payload.phase_id).toBe("review");

    // The subtask should now be 'done' — mutated by the real approval route
    const st = db._subtasks.find((s) => s.id === "sub-int-1");
    expect(st?.status).toBe("done");
    expect(st?.completed_at).toBeGreaterThan(0);
  });

  it("approve <taskId>/<phaseId> scoped form also routes to the approval endpoint", async () => {
    const { bridge, db } = setup();

    const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve task-int-1/review" });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.payload.task_id).toBe("task-int-1");

    const st = db._subtasks.find((s) => s.id === "sub-int-1");
    expect(st?.status).toBe("done");
  });

  it("approval failure from the endpoint propagates back as an error result", async () => {
    const { bridge } = setup();

    // Override fetch to simulate the approval endpoint returning 404
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "phase_not_awaiting_approval" }), { status: 404 }),
    );

    const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve review" });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(404);
    expect(result.payload.error).toBe("approval_failed");
  });

  it("the approval endpoint requires the session auth token (auth check is live)", async () => {
    const { db } = setup();

    // Call the bridge but intercept fetch and intentionally strip the auth header
    vi.restoreAllMocks();
    const approvalApp = express();
    approvalApp.use(express.json());
    registerPhaseApprovalRoutes({
      app: approvalApp,
      db: db as never,
      nowMs: () => Date.now(),
      broadcast: vi.fn(),
      appendTaskLog: vi.fn(),
      packRegistry: null as never,
      graphRunner: null as never,
      activeProcesses: new Map(),
      stopRequestedTasks: new Set(),
      killPidTree: vi.fn(),
      endTaskExecutionSession: vi.fn(),
      runTask: vi.fn(),
    });

    const res = await request(approvalApp)
      .post("/api/core/tasks/task-int-1/phases/review/approve")
      .set("Authorization", "Bearer wrong-token")
      .send({});

    // The approval route must reject a bad token — confirming auth is enforced
    expect(res.status).toBe(401);

    // But the real bridge always sends SESSION_AUTH_TOKEN, so it succeeds
    const res2 = await request(approvalApp)
      .post("/api/core/tasks/task-int-1/phases/review/approve")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .send({});

    expect(res2.status).toBe(200);
  });
});
