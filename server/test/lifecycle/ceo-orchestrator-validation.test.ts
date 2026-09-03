import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the logger module before importing the code under test.
// The ceo-orchestrator creates a module-level child logger at import time.
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("../../observability/logger.ts", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    }),
  },
}));

import { parseDecisions, UUID_RE } from "../../modules/lifecycle/ceo-orchestrator.ts";

describe("CEO Orchestrator — decision validation", () => {
  let warnSpy: typeof mockWarn;

  beforeEach(() => {
    warnSpy = mockWarn;
    warnSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // UUID_RE
  // -----------------------------------------------------------------------
  describe("UUID_RE", () => {
    it("matches a standard v4 UUID", () => {
      expect(UUID_RE.test("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
    });

    it("rejects non-UUID strings", () => {
      expect(UUID_RE.test("not-a-uuid")).toBe(false);
      expect(UUID_RE.test("")).toBe(false);
      expect(UUID_RE.test("12345")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // parseDecisions — valid inputs
  // -----------------------------------------------------------------------
  describe("parseDecisions — valid UUID task_ids", () => {
    it("accepts reprioritize with valid UUID task_id", () => {
      const raw = JSON.stringify([
        { type: "reprioritize", task_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", priority: 8 },
      ]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("reprioritize");
    });

    it("accepts reassign with valid UUID task_id", () => {
      const raw = JSON.stringify([
        { type: "reassign", task_id: "11111111-2222-3333-4444-555555555555", department_id: "qa" },
      ]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("reassign");
    });

    it("accepts approve_review with valid UUID task_id", () => {
      const raw = JSON.stringify([{ type: "approve_review", task_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("approve_review");
    });

    it("accepts create_task with non-empty title", () => {
      const raw = JSON.stringify([{ type: "create_task", title: "Fix bug", description: "Fix the login bug" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("create_task");
    });

    it("accepts message type without task_id", () => {
      const raw = JSON.stringify([{ type: "message", content: "Hello team", receiver_type: "all" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("message");
    });
  });

  // -----------------------------------------------------------------------
  // parseDecisions — invalid task_ids
  // -----------------------------------------------------------------------
  describe("parseDecisions — rejects non-UUID task_ids", () => {
    it("rejects reprioritize with non-UUID task_id", () => {
      const raw = JSON.stringify([{ type: "reprioritize", task_id: "not-a-uuid", priority: 8 }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({}), expect.stringContaining("invalid task_id"));
    });

    it("rejects reassign with missing task_id", () => {
      const raw = JSON.stringify([{ type: "reassign", department_id: "qa" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
    });

    it("rejects approve_review with numeric task_id", () => {
      const raw = JSON.stringify([{ type: "approve_review", task_id: 12345 }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // parseDecisions — SQL injection in task_id
  // -----------------------------------------------------------------------
  describe("parseDecisions — rejects SQL injection in task_id", () => {
    it("rejects task_id containing SQL injection payload", () => {
      const raw = JSON.stringify([{ type: "reprioritize", task_id: "'; DROP TABLE tasks; --", priority: 1 }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({}), expect.stringContaining("invalid task_id"));
    });

    it("rejects task_id with UNION SELECT injection", () => {
      const raw = JSON.stringify([{ type: "approve_review", task_id: "1 UNION SELECT * FROM settings --" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // parseDecisions — path traversal in task_id
  // -----------------------------------------------------------------------
  describe("parseDecisions — rejects path traversal in task_id", () => {
    it("rejects task_id containing path traversal", () => {
      const raw = JSON.stringify([{ type: "reassign", task_id: "../../etc/passwd", department_id: "dev" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({}), expect.stringContaining("invalid task_id"));
    });

    it("rejects task_id with encoded path traversal", () => {
      const raw = JSON.stringify([{ type: "reprioritize", task_id: "..%2F..%2Fetc%2Fpasswd", priority: 1 }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // parseDecisions — create_task requires non-empty title
  // -----------------------------------------------------------------------
  describe("parseDecisions — create_task requires non-empty title", () => {
    it("rejects create_task with empty title", () => {
      const raw = JSON.stringify([{ type: "create_task", title: "", description: "desc" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith("dropping create_task decision: empty or missing title");
    });

    it("rejects create_task with whitespace-only title", () => {
      const raw = JSON.stringify([{ type: "create_task", title: "   ", description: "desc" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
    });

    it("rejects create_task with missing title field", () => {
      const raw = JSON.stringify([{ type: "create_task", description: "desc" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
    });

    it("rejects create_task with numeric title", () => {
      const raw = JSON.stringify([{ type: "create_task", title: 123, description: "desc" }]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // parseDecisions — mixed valid and invalid decisions
  // -----------------------------------------------------------------------
  describe("parseDecisions — filters invalid from valid", () => {
    it("keeps valid decisions and drops invalid ones", () => {
      const raw = JSON.stringify([
        { type: "create_task", title: "Valid task", description: "yes" },
        { type: "reprioritize", task_id: "INVALID", priority: 5 },
        { type: "message", content: "Hello", receiver_type: "all" },
        { type: "approve_review", task_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      ]);
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(3);
      expect(decisions.map((d) => d.type)).toEqual(["create_task", "message", "approve_review"]);
    });
  });

  // -----------------------------------------------------------------------
  // parseDecisions — code-block wrapped JSON
  // -----------------------------------------------------------------------
  describe("parseDecisions — code-block extraction", () => {
    it("extracts JSON from markdown code blocks", () => {
      const raw = '```json\n[{"type": "create_task", "title": "Test", "description": "From code block"}]\n```';
      const decisions = parseDecisions(raw);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("create_task");
    });
  });
});
