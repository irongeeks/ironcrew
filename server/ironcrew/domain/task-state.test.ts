import { describe, it, expect } from "vitest";
import {
  assertTransition,
  canTransition,
  deriveAgentStatus,
  InvalidTransitionError,
  isTaskStatus,
  isTerminal,
  nextStates,
  TASK_STATUSES,
  TRANSITIONS,
  type TaskStatus,
} from "./task-state.ts";

describe("task state machine shape", () => {
  it("declares a transition list for every status", () => {
    for (const s of TASK_STATUSES) {
      expect(Array.isArray(TRANSITIONS[s])).toBe(true);
    }
  });

  it("never points at a status that is not in the enum", () => {
    for (const s of TASK_STATUSES) {
      for (const target of TRANSITIONS[s]) {
        expect(isTaskStatus(target)).toBe(true);
      }
    }
  });

  it("has no self-transitions", () => {
    for (const s of TASK_STATUSES) {
      expect(TRANSITIONS[s]).not.toContain(s);
    }
  });

  it("treats done and cancelled as terminal", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(nextStates("done")).toEqual([]);
    expect(nextStates("cancelled")).toEqual([]);
    expect(isTerminal("failed")).toBe(false); // revision is possible
  });

  it("makes every non-terminal status reachable from inbox", () => {
    const seen = new Set<TaskStatus>(["inbox"]);
    const queue: TaskStatus[] = ["inbox"];
    while (queue.length) {
      for (const next of TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const s of TASK_STATUSES) expect(seen.has(s)).toBe(true);
  });

  it("lets every non-terminal status reach a terminal one", () => {
    for (const start of TASK_STATUSES) {
      const seen = new Set<TaskStatus>([start]);
      const queue: TaskStatus[] = [start];
      let reachedTerminal = isTerminal(start);
      while (queue.length && !reachedTerminal) {
        for (const next of TRANSITIONS[queue.shift()!]) {
          if (isTerminal(next)) {
            reachedTerminal = true;
            break;
          }
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(reachedTerminal).toBe(true);
    }
  });
});

describe("transition validation", () => {
  it("permits the happy path", () => {
    const path: TaskStatus[] = ["inbox", "planned", "ready", "assigned", "running", "review", "done"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("permits the revision path review -> ready", () => {
    expect(canTransition("review", "ready")).toBe(true);
  });

  it("permits retry after failure", () => {
    expect(canTransition("failed", "ready")).toBe(true);
  });

  it("rejects skipping straight from inbox to done", () => {
    expect(canTransition("inbox", "done")).toBe(false);
    expect(() => assertTransition("inbox", "done")).toThrow(InvalidTransitionError);
  });

  it("rejects resurrecting a completed task", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("cancelled", "ready")).toBe(false);
  });

  it("error message lists the legal targets", () => {
    try {
      assertTransition("ready", "done");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("assigned");
    }
  });
});

describe("deriveAgentStatus", () => {
  it("reports offline regardless of work when not online", () => {
    expect(deriveAgentStatus({ online: false, taskStatuses: ["running"] })).toBe("offline");
  });

  it("prioritises paused over work", () => {
    expect(deriveAgentStatus({ online: true, paused: true, taskStatuses: ["running"] })).toBe("paused");
  });

  it("prioritises rate limiting over working", () => {
    expect(deriveAgentStatus({ online: true, rateLimited: true, taskStatuses: ["running"] })).toBe("rate_limited");
  });

  it("surfaces waiting_for_approval above working", () => {
    expect(deriveAgentStatus({ online: true, taskStatuses: ["running", "approval_required"] })).toBe(
      "waiting_for_approval",
    );
  });

  it.each([
    [["running"], "working"],
    [["waiting"], "waiting_for_input"],
    [["assigned"], "thinking"],
    [[], "idle"],
  ] as Array<[TaskStatus[], string]>)("maps %s to %s", (statuses, expected) => {
    expect(deriveAgentStatus({ online: true, taskStatuses: statuses })).toBe(expected);
  });

  it("reports error only when idle after a failed run", () => {
    expect(deriveAgentStatus({ online: true, taskStatuses: [], lastRunFailed: true })).toBe("error");
    expect(deriveAgentStatus({ online: true, taskStatuses: ["running"], lastRunFailed: true })).toBe("working");
  });

  it("reports in_meeting above task-derived states", () => {
    expect(deriveAgentStatus({ online: true, inMeeting: true, taskStatuses: ["running"] })).toBe("in_meeting");
  });
});
