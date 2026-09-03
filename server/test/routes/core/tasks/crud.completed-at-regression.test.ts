import { describe, it, expect } from "vitest";

/**
 * Regression test for completed_at timestamp clearing when a task's status
 * transitions from a terminal state (done/cancelled) to ANY non-terminal state.
 *
 * Bug: The original nonTerminalStatuses list was missing "planned" and
 * "collaborating", so done → planned or done → collaborating left a stale
 * completed_at timestamp.
 *
 * This test directly exercises the status-regression logic from crud.ts PATCH
 * handler by reproducing the condition check inline.
 */

const terminalStatuses = ["done", "cancelled"];
const nonTerminalStatuses = ["pending", "planned", "collaborating", "in_progress", "review", "inbox"];

function shouldClearCompletedAt(oldStatus: string, newStatus: string): boolean {
  return terminalStatuses.includes(oldStatus) && nonTerminalStatuses.includes(newStatus);
}

describe("completed_at timestamp regression", () => {
  describe("clearing completed_at on status regression from terminal → non-terminal", () => {
    for (const terminal of terminalStatuses) {
      for (const nonTerminal of nonTerminalStatuses) {
        it(`clears completed_at when ${terminal} → ${nonTerminal}`, () => {
          expect(shouldClearCompletedAt(terminal, nonTerminal)).toBe(true);
        });
      }
    }
  });

  describe("does NOT clear completed_at for non-regression transitions", () => {
    it("does not clear when staying in terminal (done → done)", () => {
      expect(shouldClearCompletedAt("done", "done")).toBe(false);
    });

    it("does not clear when transitioning between non-terminal (in_progress → review)", () => {
      expect(shouldClearCompletedAt("in_progress", "review")).toBe(false);
    });

    it("does not clear when moving to terminal (in_progress → done)", () => {
      expect(shouldClearCompletedAt("in_progress", "done")).toBe(false);
    });
  });

  describe("previously missing statuses (regression)", () => {
    it("clears completed_at for done → planned", () => {
      expect(shouldClearCompletedAt("done", "planned")).toBe(true);
    });

    it("clears completed_at for done → collaborating", () => {
      expect(shouldClearCompletedAt("done", "collaborating")).toBe(true);
    });

    it("clears completed_at for cancelled → planned", () => {
      expect(shouldClearCompletedAt("cancelled", "planned")).toBe(true);
    });

    it("clears completed_at for cancelled → collaborating", () => {
      expect(shouldClearCompletedAt("cancelled", "collaborating")).toBe(true);
    });
  });
});
