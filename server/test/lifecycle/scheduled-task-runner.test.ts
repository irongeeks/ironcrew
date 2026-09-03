import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ScheduledTaskRunnerDeps } from "../../modules/lifecycle/scheduled-task-runner.ts";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      cron_expression   TEXT NOT NULL,
      timezone          TEXT NOT NULL DEFAULT 'UTC',
      workflow_pack_key TEXT DEFAULT NULL,
      project_path      TEXT DEFAULT NULL,
      department_id     TEXT DEFAULT NULL,
      priority          INTEGER NOT NULL DEFAULT 5,
      enabled           INTEGER NOT NULL DEFAULT 1,
      next_run_at       INTEGER NOT NULL,
      last_run_at       INTEGER DEFAULT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  return db;
}

describe("scheduled_tasks table", () => {
  it("should allow inserting and querying a schedule", () => {
    const db = createTestDb();
    const now = Date.now();
    db.prepare("INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at) VALUES (?, ?, ?, ?)").run(
      "test-1",
      "Daily standup",
      "0 9 * * *",
      now,
    );

    const row = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get("test-1") as any;
    expect(row.title).toBe("Daily standup");
    expect(row.cron_expression).toBe("0 9 * * *");
    expect(row.enabled).toBe(1);
    expect(row.priority).toBe(5);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Runner tests
// ---------------------------------------------------------------------------

describe("createScheduledTaskRunner", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(fetches: any[]) {
    globalThis.fetch = (async (url: string | URL | Request, opts?: any) => {
      fetches.push({ url: String(url), opts });
      return {
        ok: true,
        json: async () => ({ id: `created-task-${fetches.length}` }),
        text: async () => "",
      };
    }) as any;
  }

  it("should fire a due schedule and advance next_run_at", async () => {
    const { createScheduledTaskRunner } = await import("../../modules/lifecycle/scheduled-task-runner.ts");
    const db = createTestDb();
    const now = Date.now();
    const pastTime = now - 60_000;
    db.prepare(
      "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run("sched-1", "Daily report", "0 9 * * *", pastTime);

    const fetches: any[] = [];
    const broadcasts: any[] = [];
    mockFetch(fetches);

    const runner = createScheduledTaskRunner({
      db: db as any,
      app: { get: () => 8790 } as any,
      broadcast: (type: string, payload: unknown) => broadcasts.push({ type, payload }),
      appendTaskLog: () => {},
      nowMs: () => now,
    });
    await runner.tick();

    expect(fetches.length).toBe(1);
    expect(fetches[0].url).toContain("/api/tasks");

    const row = db.prepare("SELECT next_run_at, last_run_at FROM scheduled_tasks WHERE id = ?").get("sched-1") as any;
    expect(row.next_run_at).toBeGreaterThan(pastTime);
    expect(row.last_run_at).not.toBeNull();

    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].type).toBe("autonomous_action");
    expect((broadcasts[0].payload as any).action).toBe("scheduled_task_fired");

    db.close();
  });

  it("should skip disabled schedules", async () => {
    const { createScheduledTaskRunner } = await import("../../modules/lifecycle/scheduled-task-runner.ts");
    const db = createTestDb();
    const now = Date.now();
    const pastTime = now - 60_000;
    db.prepare(
      "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, 0)",
    ).run("sched-disabled", "Disabled schedule", "0 9 * * *", pastTime);

    const fetches: any[] = [];
    mockFetch(fetches);

    const runner = createScheduledTaskRunner({
      db: db as any,
      app: { get: () => 8790 } as any,
      broadcast: () => {},
      appendTaskLog: () => {},
      nowMs: () => now,
    });
    await runner.tick();

    expect(fetches.length).toBe(0);
    db.close();
  });

  it("should not fire schedules with future next_run_at", async () => {
    const { createScheduledTaskRunner } = await import("../../modules/lifecycle/scheduled-task-runner.ts");
    const db = createTestDb();
    const now = Date.now();
    const futureTime = now + 3_600_000;
    db.prepare(
      "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run("sched-future", "Future schedule", "0 9 * * *", futureTime);

    const fetches: any[] = [];
    mockFetch(fetches);

    const runner = createScheduledTaskRunner({
      db: db as any,
      app: { get: () => 8790 } as any,
      broadcast: () => {},
      appendTaskLog: () => {},
      nowMs: () => now,
    });
    await runner.tick();

    expect(fetches.length).toBe(0);
    db.close();
  });

  it("should cap at 5 tasks per tick (burst protection)", async () => {
    const { createScheduledTaskRunner } = await import("../../modules/lifecycle/scheduled-task-runner.ts");
    const db = createTestDb();
    const now = Date.now();
    const pastTime = now - 60_000;
    for (let i = 0; i < 8; i++) {
      db.prepare(
        "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, 1)",
      ).run(`sched-burst-${i}`, `Task ${i}`, "0 9 * * *", pastTime);
    }

    const fetches: any[] = [];
    mockFetch(fetches);

    const runner = createScheduledTaskRunner({
      db: db as any,
      app: { get: () => 8790 } as any,
      broadcast: () => {},
      appendTaskLog: () => {},
      nowMs: () => now,
    });
    await runner.tick();

    expect(fetches.length).toBe(5);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Missed-run tests
// ---------------------------------------------------------------------------

/**
 * Helper that wires up runner deps with a captured fetch mock.
 * Returns the deps object plus a `fetches` array and a `cleanup` function
 * that restores the original global fetch.
 */
async function createRunnerDeps(db: DatabaseSync): Promise<
  ScheduledTaskRunnerDeps & {
    fetches: Array<{ url: string; opts: unknown }>;
    cleanup: () => void;
  }
> {
  const originalFetch = globalThis.fetch;
  const fetches: Array<{ url: string; opts: unknown }> = [];

  globalThis.fetch = (async (url: string | URL | Request, opts?: unknown) => {
    fetches.push({ url: String(url), opts });
    return {
      ok: true,
      json: async () => ({ id: `created-task-${fetches.length}` }),
      text: async () => "",
    };
  }) as typeof globalThis.fetch;

  return {
    db: db as any,
    app: { get: () => 8790 } as any,
    broadcast: () => {},
    appendTaskLog: () => {},
    nowMs: () => Date.now(),
    fetches,
    cleanup: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("scheduled task runner — failed task creation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should NOT advance next_run_at when task creation fails", async () => {
    const { createScheduledTaskRunner } = await import("../../modules/lifecycle/scheduled-task-runner.ts");
    const db = createTestDb();
    const now = Date.now();
    const pastTime = now - 30_000;
    db.prepare(
      "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run("sched-fail", "Failing task", "0 9 * * *", pastTime);

    // Mock fetch to return failure
    globalThis.fetch = (async () => {
      return { ok: false, status: 500, json: async () => ({}), text: async () => "Internal Server Error" };
    }) as any;

    const runner = createScheduledTaskRunner({
      db: db as any,
      app: { get: () => 8790 } as any,
      broadcast: () => {},
      appendTaskLog: () => {},
      nowMs: () => now,
    });
    await runner.tick();

    // next_run_at should remain unchanged (not advanced)
    const row = db
      .prepare("SELECT next_run_at, last_run_at FROM scheduled_tasks WHERE id = ?")
      .get("sched-fail") as any;
    expect(row.next_run_at).toBe(pastTime);
    expect(row.last_run_at).toBeNull();

    db.close();
  });
});

describe("scheduled task runner — missed runs", () => {
  it("should log warning and skip for missed runs", async () => {
    const { createScheduledTaskRunner } = await import("../../modules/lifecycle/scheduled-task-runner.ts");
    const db = createTestDb();
    const longAgo = Date.now() - 300_000; // 5 minutes ago (> 120s threshold)
    db.prepare(
      "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, last_run_at, enabled) VALUES (?, ?, ?, ?, ?, 1)",
    ).run("sched-missed", "Missed task", "0 9 * * *", longAgo, longAgo - 86_400_000);

    const deps = await createRunnerDeps(db);
    const runner = createScheduledTaskRunner(deps);
    await runner.tick();

    // Should NOT create a task (missed run skipped)
    expect(deps.fetches.length).toBe(0);

    // But next_run_at should be advanced to future
    const row = db.prepare("SELECT next_run_at FROM scheduled_tasks WHERE id = ?").get("sched-missed") as any;
    expect(row.next_run_at).toBeGreaterThan(Date.now());

    deps.cleanup();
    db.close();
  });

  it("should fire a schedule that is due but not missed (within threshold)", async () => {
    const { createScheduledTaskRunner } = await import("../../modules/lifecycle/scheduled-task-runner.ts");
    const db = createTestDb();
    const justPast = Date.now() - 30_000; // 30 seconds ago (< 120s threshold)
    db.prepare(
      "INSERT INTO scheduled_tasks (id, title, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run("sched-recent", "Recent task", "0 9 * * *", justPast);

    const deps = await createRunnerDeps(db);
    const runner = createScheduledTaskRunner(deps);
    await runner.tick();

    // Should create a task (not missed, it's a first run with no last_run_at)
    expect(deps.fetches.length).toBe(1);

    deps.cleanup();
    db.close();
  });
});
