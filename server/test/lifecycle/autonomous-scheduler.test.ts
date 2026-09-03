import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutonomousScheduler, readAutonomousModeEnabled } from "../../modules/lifecycle/autonomous-scheduler.ts";
import type { AutonomousSchedulerDeps } from "../../modules/lifecycle/autonomous-scheduler.ts";

// ---------------------------------------------------------------------------
// Minimal mock DB that satisfies the scheduler's SQL queries
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

function createMockDb(settings: Record<string, string> = {}, taskRows: MockRow[] = [], _taskLogRows: MockRow[] = []) {
  // stmtMap intentionally unused — mock DB only needs prepare()

  const prepare = vi.fn((sql: string) => {
    if (sql.includes("FROM settings WHERE key =")) {
      return {
        get: vi.fn((...args: unknown[]) => {
          // Extract key from the query pattern
          for (const [settingKey, settingValue] of Object.entries(settings)) {
            if (sql.includes(`'${settingKey}'`) || (args.length > 0 && args[0] === settingKey)) {
              return { value: settingValue };
            }
          }
          // Try to match positional arg to known keys
          if (args.length > 0 && typeof args[0] === "string" && settings[args[0]]) {
            return { value: settings[args[0]] };
          }
          return undefined;
        }),
        all: vi.fn(() => []),
      };
    }
    if (sql.includes("COUNT(*)") && sql.includes("tasks") && sql.includes("in_progress")) {
      return {
        get: vi.fn(() => ({ cnt: taskRows.filter((t) => t.status === "in_progress").length })),
        all: vi.fn(() => []),
      };
    }
    if (sql.includes("FROM tasks t")) {
      return {
        get: vi.fn(() => undefined),
        all: vi.fn(() => taskRows.filter((t) => t.status === "inbox" || t.status === "planned")),
      };
    }
    // Default fallback
    return {
      get: vi.fn(() => undefined),
      all: vi.fn(() => []),
    };
  });

  return { prepare } as unknown as AutonomousSchedulerDeps["db"];
}

function createMockDeps(overrides: Partial<AutonomousSchedulerDeps> = {}): AutonomousSchedulerDeps {
  return {
    db: createMockDb(),
    app: { get: vi.fn(() => 8790) } as unknown as AutonomousSchedulerDeps["app"],
    activeProcesses: new Map(),
    broadcast: vi.fn(),
    notifyCeo: vi.fn(),
    appendTaskLog: vi.fn(),
    nowMs: () => Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readAutonomousModeEnabled", () => {
  it("returns false when no setting exists", () => {
    const db = createMockDb({});
    expect(readAutonomousModeEnabled(db)).toBe(false);
  });

  it("returns true when setting is 'true'", () => {
    // The function uses a specific query with 'autonomousMode' embedded in the SQL
    // We need a mock that matches that specific pattern
    const mockPrepare = vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes("autonomousMode")) return { value: "true" };
        return undefined;
      }),
      all: vi.fn(() => []),
    }));
    const mockDb = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    expect(readAutonomousModeEnabled(mockDb)).toBe(true);
  });

  it("returns false when setting is 'false'", () => {
    const mockPrepare = vi.fn(() => ({
      get: vi.fn(() => ({ value: "false" })),
      all: vi.fn(() => []),
    }));
    const mockDb = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    expect(readAutonomousModeEnabled(mockDb)).toBe(false);
  });

  it("returns true when setting is '1'", () => {
    const mockPrepare = vi.fn(() => ({
      get: vi.fn(() => ({ value: "1" })),
      all: vi.fn(() => []),
    }));
    const mockDb = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    expect(readAutonomousModeEnabled(mockDb)).toBe(true);
  });

  it("returns false for empty string value", () => {
    const mockPrepare = vi.fn(() => ({
      get: vi.fn(() => ({ value: "" })),
      all: vi.fn(() => []),
    }));
    const mockDb = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    expect(readAutonomousModeEnabled(mockDb)).toBe(false);
  });
});

describe("createAutonomousScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an object with schedulerTick and readAutonomousModeEnabled", () => {
    const deps = createMockDeps();
    const scheduler = createAutonomousScheduler(deps);
    expect(scheduler).toBeDefined();
    expect(typeof scheduler.schedulerTick).toBe("function");
    expect(typeof scheduler.readAutonomousModeEnabled).toBe("function");
  });

  it("schedulerTick does nothing when autonomous mode is disabled", () => {
    const mockPrepare = vi.fn(() => ({
      get: vi.fn(() => undefined), // no autonomousMode setting -> disabled
      all: vi.fn(() => []),
    }));
    const db = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    const broadcast = vi.fn();
    const deps = createMockDeps({ db, broadcast });
    const scheduler = createAutonomousScheduler(deps);

    scheduler.schedulerTick();

    // Should not broadcast anything if autonomous mode is off
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("schedulerTick broadcasts skip when slots are full", () => {
    const mockPrepare = vi.fn((sql: string) => {
      if (sql.includes("autonomousMode")) {
        return {
          get: vi.fn(() => ({ value: "true" })),
          all: vi.fn(() => []),
        };
      }
      if (sql.includes("autonomousMaxConcurrent")) {
        return {
          get: vi.fn(() => ({ value: "1" })),
          all: vi.fn(() => []),
        };
      }
      if (sql.includes("COUNT(*)") && sql.includes("in_progress")) {
        return {
          get: vi.fn(() => ({ cnt: 1 })),
          all: vi.fn(() => []),
        };
      }
      return {
        get: vi.fn(() => undefined),
        all: vi.fn(() => []),
      };
    });
    const db = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    const broadcast = vi.fn();
    const activeProcesses = new Map([["task-1", {} as any]]);
    const deps = createMockDeps({ db, broadcast, activeProcesses });
    const scheduler = createAutonomousScheduler(deps);

    scheduler.schedulerTick();

    expect(broadcast).toHaveBeenCalledWith(
      "autonomous_action",
      expect.objectContaining({
        action: "scheduler_skip",
        reason: expect.stringContaining("1/1"),
      }),
    );
  });

  it("schedulerTick does nothing when no schedulable tasks exist", () => {
    const mockPrepare = vi.fn((sql: string) => {
      if (sql.includes("autonomousMode")) {
        return { get: vi.fn(() => ({ value: "true" })), all: vi.fn(() => []) };
      }
      if (sql.includes("autonomousMaxConcurrent")) {
        return { get: vi.fn(() => ({ value: "2" })), all: vi.fn(() => []) };
      }
      if (sql.includes("COUNT(*)") && sql.includes("in_progress")) {
        return { get: vi.fn(() => ({ cnt: 0 })), all: vi.fn(() => []) };
      }
      if (sql.includes("FROM tasks t")) {
        return { get: vi.fn(() => undefined), all: vi.fn(() => []) };
      }
      return { get: vi.fn(() => undefined), all: vi.fn(() => []) };
    });
    const db = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    const broadcast = vi.fn();
    const notifyCeo = vi.fn();
    const deps = createMockDeps({ db, broadcast, notifyCeo });
    const scheduler = createAutonomousScheduler(deps);

    scheduler.schedulerTick();

    // No tasks to schedule, so no CEO notification
    expect(notifyCeo).not.toHaveBeenCalled();
  });

  it("readAutonomousModeEnabled wrapper reads from deps db", () => {
    const mockPrepare = vi.fn(() => ({
      get: vi.fn(() => ({ value: "true" })),
      all: vi.fn(() => []),
    }));
    const db = { prepare: mockPrepare } as unknown as AutonomousSchedulerDeps["db"];
    const deps = createMockDeps({ db });
    const scheduler = createAutonomousScheduler(deps);

    expect(scheduler.readAutonomousModeEnabled()).toBe(true);
  });
});
