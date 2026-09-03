import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";

// ---------------------------------------------------------------------------
// Mock DB that tracks exec() calls (BEGIN / COMMIT / ROLLBACK)
// ---------------------------------------------------------------------------

interface MockSubtask {
  id: string;
  task_id: string;
  title: string;
  description: string;
  status: string;
  completed_at?: number;
  created_at: number;
}

function createMockDb(options?: { throwOnRunAfterCalls?: number }) {
  const subtasks: MockSubtask[] = [];
  const execCalls: string[] = [];
  let runCallCount = 0;

  return {
    run(sql: string, ...params: unknown[]) {
      runCallCount++;

      // If configured to throw after N calls, do so
      if (options?.throwOnRunAfterCalls !== undefined && runCallCount > options.throwOnRunAfterCalls) {
        throw new Error(`Simulated DB error on run call #${runCallCount}`);
      }

      const upper = sql.trim().toUpperCase();

      if (upper.startsWith("INSERT INTO SUBTASKS")) {
        const [id, task_id, title, description, status, created_at] = params as [
          string,
          string,
          string,
          string,
          string,
          number,
        ];
        subtasks.push({ id, task_id, title, description, status, created_at });
      } else if (upper.startsWith("UPDATE SUBTASKS SET STATUS = ?, COMPLETED_AT")) {
        const [status, completed_at, task_id, title] = params as [string, number, string, string];
        for (const st of subtasks) {
          if (st.task_id === task_id && st.title === title) {
            st.status = status;
            st.completed_at = completed_at;
          }
        }
      } else if (upper.startsWith("UPDATE SUBTASKS SET STATUS")) {
        if (params.length === 4) {
          const [status, task_id, title, _oldStatus] = params as [string, string, string, string];
          for (const st of subtasks) {
            if (st.task_id === task_id && st.title === title) {
              st.status = status;
            }
          }
        } else {
          const isLike = upper.includes("LIKE");
          const [status, task_id, title] = params as [string, string, string];
          const titleMatch = isLike ? title.replace(/%+$/, "").replace(/\\(.)/g, "$1") : title;
          for (const st of subtasks) {
            const matches = isLike ? st.title.startsWith(titleMatch) : st.title === title;
            if (st.task_id === task_id && matches) {
              st.status = status;
            }
          }
        }
      } else if (upper.startsWith("UPDATE SUBTASKS SET DESCRIPTION")) {
        const [description, id, task_id] = params as [string, string, string];
        for (const st of subtasks) {
          if (st.id === id && st.task_id === task_id) {
            st.description = description;
          }
        }
      }
    },

    get(sql: string, ...params: unknown[]) {
      const upper = sql.trim().toUpperCase();
      if (upper.includes("SELECT") && upper.includes("SUBTASKS")) {
        const task_id = params[0] as string;
        const title = params[1] as string;
        return subtasks.find((st) => st.task_id === task_id && st.title === title);
      }
      return undefined;
    },

    all(sql: string, ...params: unknown[]) {
      const upper = sql.trim().toUpperCase();
      if (!upper.includes("SUBTASKS")) return [];

      const task_id = params[0] as string;
      let results = subtasks.filter((st) => st.task_id === task_id);

      if (params.length > 1) {
        const titlePattern = params[1] as string;
        const cleanPattern = titlePattern.replace(/%/g, "").replace(/\\(.)/g, "$1");
        results = results.filter((st) => st.title.includes(cleanPattern));
      }

      if (upper.includes("AND STATUS = 'PENDING'")) {
        results = results.filter((st) => st.status === "pending");
      }

      return results;
    },

    exec(sql: string) {
      execCalls.push(sql.trim().toUpperCase());
    },

    _subtasks: subtasks,
    _execCalls: execCalls,
    _getRunCallCount() {
      return runCallCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhase(id: string, overrides: Partial<Phase> = {}): Phase {
  return {
    id,
    department: "test",
    guidance: `guidance/{lang}/${id}.md`,
    capability_mode: "hybrid" as const,
    gate: "auto" as const,
    inputs: [],
    outputs: [],
    ...overrides,
  };
}

function makePack(phases: Phase[], key = "test_pack"): LoadedPack {
  const graph = buildGraph(key, phases);
  const guidanceCache = new Map<string, string>();
  for (const phase of phases) {
    guidanceCache.set(`${phase.id}.en`, `Guidance for ${phase.id}`);
  }

  const definition: PackDefinition = {
    pack: {
      key,
      name: { en: "Test Pack" },
      version: "1.0.0",
      schema_version: 1,
      agent_routing: "single" as const,
      description: { en: "A test pack" },
    },
    input: { required: [], optional: [] },
    phases,
  };

  return { key, source: "built-in", definition, graph, guidanceCache, sharedGuidanceCache: new Map() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphRunner — transaction rollback safety", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gr-transaction-test-"));
    mkdirSync(join(tmpDir, "output"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. Commits successfully when no errors occur
  // =========================================================================

  it("calls BEGIN and COMMIT when downstream processing succeeds", async () => {
    const db = createMockDb();
    const runner = new GraphRunner();

    // 3-phase chain: a → b → c
    const phaseA = makePhase("a", {
      outputs: [{ name: "data", type: "json", path: "output/a-data.json" }],
    });
    const phaseB = makePhase("b", {
      inputs: [{ name: "data", from: "a.data" }],
      outputs: [{ name: "data", type: "json", path: "output/b-data.json" }],
    });
    const phaseC = makePhase("c", {
      inputs: [{ name: "data", from: "b.data" }],
    });

    const pack = makePack([phaseA, phaseB, phaseC]);
    await runner.seedSubtasks(db, "task-tx-1", pack, {});

    // Mark phase a as done
    db._subtasks.find((s) => s.task_id === "task-tx-1" && s.title === "[pipeline:a]")!.status = "done";

    await runner.onPhaseComplete(db, "task-tx-1", "a", pack, tmpDir);

    // Verify transaction boundaries
    expect(db._execCalls).toContain("BEGIN");
    expect(db._execCalls).toContain("COMMIT");
    expect(db._execCalls).not.toContain("ROLLBACK");

    // BEGIN should come before COMMIT
    const beginIdx = db._execCalls.indexOf("BEGIN");
    const commitIdx = db._execCalls.indexOf("COMMIT");
    expect(beginIdx).toBeLessThan(commitIdx);

    // Phase b should be unblocked to pending
    const phaseB_st = db._subtasks.find((s) => s.task_id === "task-tx-1" && s.title === "[pipeline:b]");
    expect(phaseB_st?.status).toBe("pending");
  });

  // =========================================================================
  // 2. Rolls back DB changes when downstream processing throws
  // =========================================================================

  it("calls BEGIN and ROLLBACK when db.run throws mid-transaction", async () => {
    // We need the db.run calls during seedSubtasks to succeed, then fail
    // during onPhaseComplete's downstream processing.
    // seedSubtasks does INSERT calls; onPhaseComplete does UPDATE calls.
    // We'll count the run calls during seedSubtasks, then set the threshold.

    const seedDb = createMockDb();
    const runner = new GraphRunner();

    const phaseA = makePhase("a", {
      outputs: [{ name: "data", type: "json", path: "output/a-data.json" }],
    });
    const phaseB = makePhase("b", {
      inputs: [{ name: "data", from: "a.data" }],
      outputs: [{ name: "data", type: "json", path: "output/b-data.json" }],
    });
    const phaseC = makePhase("c", {
      inputs: [{ name: "data", from: "b.data" }],
    });

    const pack = makePack([phaseA, phaseB, phaseC]);

    // First, seed with a normal db to count calls
    await runner.seedSubtasks(seedDb, "task-tx-2", pack, {});
    const seedCallCount = seedDb._getRunCallCount();

    // Now create the real db that will fail on the first db.run inside the transaction
    const db = createMockDb({ throwOnRunAfterCalls: seedCallCount });
    const runner2 = new GraphRunner();

    await runner2.seedSubtasks(db, "task-tx-2", pack, {});
    db._subtasks.find((s) => s.task_id === "task-tx-2" && s.title === "[pipeline:a]")!.status = "done";

    // onPhaseComplete should throw because db.run fails mid-transaction
    await expect(runner2.onPhaseComplete(db, "task-tx-2", "a", pack, tmpDir)).rejects.toThrow(/Simulated DB error/);

    // Verify ROLLBACK was called
    expect(db._execCalls).toContain("BEGIN");
    expect(db._execCalls).toContain("ROLLBACK");
    expect(db._execCalls).not.toContain("COMMIT");

    // BEGIN should come before ROLLBACK
    const beginIdx = db._execCalls.indexOf("BEGIN");
    const rollbackIdx = db._execCalls.indexOf("ROLLBACK");
    expect(beginIdx).toBeLessThan(rollbackIdx);

    // Verify downstream subtask state: the error during db.run interrupted
    // processing before the full advancement chain could complete. Phase c
    // depends on b and should still be in its initial "blocked" state —
    // the error prevented it from ever being considered for advancement.
    // (Note: mock DB doesn't truly revert writes like SQLite ROLLBACK would,
    // but we verify the error stopped the advancement cascade.)
    const phaseCAfterRollback = db._subtasks.find((s) => s.task_id === "task-tx-2" && s.title === "[pipeline:c]");
    expect(phaseCAfterRollback?.status).toBe("blocked");
  });

  // =========================================================================
  // 3. Transaction state is cleaned up after rollback (no stale _inTransaction)
  // =========================================================================

  it("cleans up _inTransaction set after rollback so subsequent calls can start new transactions", async () => {
    const seedDb = createMockDb();
    const runner = new GraphRunner();

    const phaseA = makePhase("a", {
      outputs: [{ name: "data", type: "json", path: "output/a-data.json" }],
    });
    const phaseB = makePhase("b", {
      inputs: [{ name: "data", from: "a.data" }],
    });

    const pack = makePack([phaseA, phaseB]);

    // Count seed calls
    await runner.seedSubtasks(seedDb, "task-tx-3", pack, {});
    const seedCallCount = seedDb._getRunCallCount();

    // Create db that fails during onPhaseComplete
    const failDb = createMockDb({ throwOnRunAfterCalls: seedCallCount });

    await runner.seedSubtasks(failDb, "task-tx-3", pack, {});
    failDb._subtasks.find((s) => s.task_id === "task-tx-3" && s.title === "[pipeline:a]")!.status = "done";

    // First call should fail and rollback
    await expect(runner.onPhaseComplete(failDb, "task-tx-3", "a", pack, tmpDir)).rejects.toThrow();
    expect(failDb._execCalls).toContain("ROLLBACK");

    // Now call again with the SAME taskId ("task-tx-3") and a working db.
    // If _inTransaction was not cleaned up in the finally block, the runner
    // would skip BEGIN (thinking it's already inside a transaction) and the
    // test would see no BEGIN/COMMIT on the good db.
    const goodDb = createMockDb();
    await runner.seedSubtasks(goodDb, "task-tx-3", pack, {});
    goodDb._subtasks.find((s) => s.task_id === "task-tx-3" && s.title === "[pipeline:a]")!.status = "done";

    await runner.onPhaseComplete(goodDb, "task-tx-3", "a", pack, tmpDir);

    // The good db should have a successful BEGIN/COMMIT — proving the
    // _inTransaction entry for "task-tx-3" was removed after rollback.
    expect(goodDb._execCalls).toContain("BEGIN");
    expect(goodDb._execCalls).toContain("COMMIT");
    expect(goodDb._execCalls).not.toContain("ROLLBACK");
  });

  // =========================================================================
  // 4. No transaction when db.exec is not available
  // =========================================================================

  it("skips transaction when db has no exec function", async () => {
    const db = createMockDb();
    // Remove exec to simulate a DB without transaction support
    const dbWithoutExec = { ...db, exec: undefined } as unknown as ReturnType<typeof createMockDb>;

    const runner = new GraphRunner();

    const phaseA = makePhase("a", {
      outputs: [{ name: "data", type: "json", path: "output/a-data.json" }],
    });
    const phaseB = makePhase("b", {
      inputs: [{ name: "data", from: "a.data" }],
    });

    const pack = makePack([phaseA, phaseB]);
    await runner.seedSubtasks(dbWithoutExec, "task-tx-4", pack, {});

    dbWithoutExec._subtasks.find((s) => s.task_id === "task-tx-4" && s.title === "[pipeline:a]")!.status = "done";

    // Should succeed without transaction
    await runner.onPhaseComplete(dbWithoutExec, "task-tx-4", "a", pack, tmpDir);

    // No exec calls should have been made
    expect(db._execCalls).toHaveLength(0);

    // Phase b should still be unblocked
    const phaseB_st = dbWithoutExec._subtasks.find((s) => s.task_id === "task-tx-4" && s.title === "[pipeline:b]");
    expect(phaseB_st?.status).toBe("pending");
  });
});
