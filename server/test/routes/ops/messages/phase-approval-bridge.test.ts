import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPhaseApprovalBridge } from "../../../../modules/routes/ops/messages/phase-approval-bridge.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock gateway client so sendMessengerMessage never makes real HTTP calls
vi.mock("../../../../gateway/client.ts", () => ({
  sendMessengerMessage: vi.fn().mockResolvedValue(undefined),
}));

// Mock messenger helpers — just return null routes for all tests
vi.mock("../../../../messenger/channels.ts", () => ({
  isMessengerChannel: vi.fn().mockReturnValue(false),
}));
vi.mock("../../../../messenger/session-agent-routing.ts", () => ({
  resolveSourceChatRoute: vi.fn().mockReturnValue(null),
}));

// Mock logger
vi.mock("../../../../observability/logger.ts", () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  },
}));

// Mock config so PORT/SESSION_AUTH_TOKEN are deterministic
vi.mock("../../../../config/runtime.ts", () => ({
  PORT: 8790,
  SESSION_AUTH_TOKEN: "test-token",
}));

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

interface MockSubtask {
  id: string;
  task_id: string;
  title: string;
  status: string;
}

function createMockDb(subtasks: MockSubtask[] = [], taskTitle = "Test Task") {
  return {
    prepare: (sql: string) => ({
      get: (...params: unknown[]) => {
        const upper = sql.trim().toUpperCase();
        if (upper.includes("FROM SUBTASKS")) {
          const [p0, p1] = params;
          return subtasks.find((s) => s.task_id === p0 && s.title === p1 && s.status === "awaiting_approval");
        }
        if (upper.includes("FROM TASKS")) {
          return { title: taskTitle };
        }
        return undefined;
      },
      run: vi.fn(),
      all: (...params: unknown[]) => {
        const upper = sql.trim().toUpperCase();
        if (upper.includes("FROM SUBTASKS")) {
          const [p0] = params;
          return subtasks.filter((s) => s.title === p0 && s.status === "awaiting_approval");
        }
        return [];
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("phase-approval-bridge", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch" as never)
      .mockResolvedValue(new Response(JSON.stringify({ approved: true }), { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("message matching", () => {
    it("does not handle unrelated messages", async () => {
      const bridge = createPhaseApprovalBridge({ db: createMockDb() });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "hello world" });
      expect(result.handled).toBe(false);
    });

    it("does not handle empty text", async () => {
      const bridge = createPhaseApprovalBridge({ db: createMockDb() });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "" });
      expect(result.handled).toBe(false);
    });

    it("handles German 'genehmigen' keyword", async () => {
      const subtasks = [{ id: "s1", task_id: "task-1", title: "[pipeline:review]", status: "awaiting_approval" }];
      const bridge = createPhaseApprovalBridge({ db: createMockDb(subtasks) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "genehmigen review" });
      expect(result.handled).toBe(true);
    });
  });

  describe("unscoped form: approve <phaseId>", () => {
    it("returns 404 when no phase is awaiting approval", async () => {
      const bridge = createPhaseApprovalBridge({ db: createMockDb([]) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve planning" });
      expect(result.handled).toBe(true);
      expect(result.status).toBe(404);
      expect(result.payload.error).toBe("phase_not_awaiting_approval");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("delegates to HTTP approval endpoint for a unique match", async () => {
      const subtasks = [{ id: "s1", task_id: "task-42", title: "[pipeline:planning]", status: "awaiting_approval" }];
      const bridge = createPhaseApprovalBridge({ db: createMockDb(subtasks) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve planning" });

      expect(result.handled).toBe(true);
      expect(result.status).toBe(200);
      expect(result.payload.approved).toBe(true);
      expect(result.payload.task_id).toBe("task-42");
      expect(result.payload.phase_id).toBe("planning");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/core/tasks/task-42/phases/planning/approve");
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-token");
    });

    it("returns 409 and lists task IDs when multiple tasks await the same phase", async () => {
      const subtasks = [
        { id: "s1", task_id: "task-1", title: "[pipeline:review]", status: "awaiting_approval" },
        { id: "s2", task_id: "task-2", title: "[pipeline:review]", status: "awaiting_approval" },
      ];
      const bridge = createPhaseApprovalBridge({ db: createMockDb(subtasks) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve review" });

      expect(result.handled).toBe(true);
      expect(result.status).toBe(409);
      expect(result.payload.error).toBe("ambiguous_phase_approval");
      expect(result.payload.taskIds).toEqual(["task-1", "task-2"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("scoped form: approve <taskId>/<phaseId>", () => {
    it("delegates using the explicit task ID", async () => {
      const subtasks = [
        { id: "s1", task_id: "task-A", title: "[pipeline:review]", status: "awaiting_approval" },
        { id: "s2", task_id: "task-B", title: "[pipeline:review]", status: "awaiting_approval" },
      ];
      const bridge = createPhaseApprovalBridge({ db: createMockDb(subtasks) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve task-A/review" });

      expect(result.handled).toBe(true);
      expect(result.status).toBe(200);
      expect(result.payload.task_id).toBe("task-A");

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain("/api/core/tasks/task-A/phases/review/approve");
    });

    it("returns 404 when the specified task/phase combo is not awaiting", async () => {
      const subtasks = [{ id: "s1", task_id: "task-B", title: "[pipeline:review]", status: "awaiting_approval" }];
      const bridge = createPhaseApprovalBridge({ db: createMockDb(subtasks) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve task-A/review" });

      expect(result.handled).toBe(true);
      expect(result.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("HTTP delegate failure handling", () => {
    it("returns error status when the approval HTTP call fails with non-OK status", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
      const subtasks = [{ id: "s1", task_id: "task-1", title: "[pipeline:planning]", status: "awaiting_approval" }];
      const bridge = createPhaseApprovalBridge({ db: createMockDb(subtasks) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve planning" });

      expect(result.handled).toBe(true);
      expect(result.status).toBe(404);
      expect(result.payload.error).toBe("approval_failed");
    });

    it("returns 500 when the fetch throws a network error", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const subtasks = [{ id: "s1", task_id: "task-1", title: "[pipeline:planning]", status: "awaiting_approval" }];
      const bridge = createPhaseApprovalBridge({ db: createMockDb(subtasks) });
      const result = await bridge.tryHandlePhaseApprovalReply({ text: "approve planning" });

      expect(result.handled).toBe(true);
      expect(result.status).toBe(500);
      expect(result.payload.error).toBe("approval_failed");
    });
  });
});
