import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  escapeLikePattern,
  isHookPathSafe,
  wrapDatabaseSync,
  GraphRunner,
} from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";

// ---------------------------------------------------------------------------
// escapeLikePattern
// ---------------------------------------------------------------------------

describe("escapeLikePattern", () => {
  it("escapes percent sign", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
  });

  it("escapes underscore", () => {
    expect(escapeLikePattern("phase_one")).toBe("phase\\_one");
  });

  it("escapes backslash", () => {
    expect(escapeLikePattern("path\\to\\thing")).toBe("path\\\\to\\\\thing");
  });

  it("escapes all metacharacters together", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("returns unchanged string when no metacharacters present", () => {
    expect(escapeLikePattern("simple-phase-id")).toBe("simple-phase-id");
  });

  it("handles empty string", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isHookPathSafe
// ---------------------------------------------------------------------------

describe("isHookPathSafe", () => {
  it("accepts simple relative path", () => {
    expect(isHookPathSafe("hooks/post_run.sh")).toBe(true);
  });

  it("accepts nested relative path", () => {
    expect(isHookPathSafe("scripts/hooks/validate.sh")).toBe(true);
  });

  it("rejects absolute path", () => {
    expect(isHookPathSafe("/etc/passwd")).toBe(false);
  });

  it("rejects path with leading ..", () => {
    expect(isHookPathSafe("../../../etc/passwd")).toBe(false);
  });

  it("rejects path with embedded directory traversal", () => {
    expect(isHookPathSafe("hooks/../../../etc/passwd")).toBe(false);
  });

  it("rejects URL-encoded traversal", () => {
    expect(isHookPathSafe("hooks/%2e%2e/%2e%2e/etc/passwd")).toBe(false);
  });

  it("accepts path without traversal patterns", () => {
    expect(isHookPathSafe("my-hook.sh")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wrapDatabaseSync
// ---------------------------------------------------------------------------

describe("wrapDatabaseSync", () => {
  it("wraps prepare-based DB to run/get/all interface", () => {
    const mockStmt = {
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn().mockReturnValue({ id: "1", name: "test" }),
      all: vi.fn().mockReturnValue([{ id: "1" }, { id: "2" }]),
    };
    const realDb = {
      prepare: vi.fn().mockReturnValue(mockStmt),
      exec: vi.fn(),
    };

    const wrapped = wrapDatabaseSync(realDb);

    // run
    wrapped.run("INSERT INTO tasks (id) VALUES (?)", "task-1");
    expect(realDb.prepare).toHaveBeenCalledWith("INSERT INTO tasks (id) VALUES (?)");
    expect(mockStmt.run).toHaveBeenCalledWith("task-1");

    // get
    const row = wrapped.get("SELECT * FROM tasks WHERE id = ?", "task-1");
    expect(row).toEqual({ id: "1", name: "test" });
    expect(mockStmt.get).toHaveBeenCalledWith("task-1");

    // all
    const rows = wrapped.all("SELECT * FROM tasks");
    expect(rows).toEqual([{ id: "1" }, { id: "2" }]);

    // exec
    wrapped.exec!("BEGIN");
    expect(realDb.exec).toHaveBeenCalledWith("BEGIN");
  });

  it("exec is undefined when realDb has no exec", () => {
    const mockStmt = {
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(),
    };
    const realDb = {
      prepare: vi.fn().mockReturnValue(mockStmt),
    };

    const wrapped = wrapDatabaseSync(realDb);
    expect(wrapped.exec).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GraphRunner — missing phase in onPhaseComplete
// ---------------------------------------------------------------------------

function makePhase(
  id: string,
  inputs: { name: string; from: string }[] = [],
  outputs: { name: string }[] = [],
  overrides: Partial<Phase> = {},
): Phase {
  return {
    id,
    department: "test",
    guidance: `guidance/{lang}/${id}.md`,
    capability_mode: "hybrid" as const,
    gate: "auto" as const,
    inputs,
    outputs: outputs.map((o) => ({ ...o, type: "markdown" as const, path: `output/${o.name}.md` })),
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

interface MockSubtask {
  id: string;
  task_id: string;
  title: string;
  description: string;
  status: string;
  created_at: number;
}

function createMockDb() {
  const subtasks: MockSubtask[] = [];

  return {
    run(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim().toUpperCase();

      if (trimmed.startsWith("INSERT INTO SUBTASKS")) {
        const [id, task_id, title, description, status, created_at] = params as [
          string,
          string,
          string,
          string,
          string,
          number,
        ];
        subtasks.push({ id, task_id, title, description, status, created_at });
      } else if (trimmed.startsWith("UPDATE SUBTASKS SET STATUS")) {
        if (params.length === 4) {
          const [status, task_id, title, _oldStatus] = params as [string, string, string, string];
          for (const st of subtasks) {
            if (st.task_id === task_id && st.title === title) {
              st.status = status;
            }
          }
        } else {
          const isLike = trimmed.includes("LIKE");
          const [status, task_id, titlePattern] = params as [string, string, string];
          const pattern = isLike ? titlePattern.replace(/%/g, "").replace(/\\(.)/g, "$1") : titlePattern;
          for (const st of subtasks) {
            const matches = isLike ? st.title.startsWith(pattern) : st.title === titlePattern;
            if (st.task_id === task_id && matches) {
              st.status = status;
            }
          }
        }
      } else if (trimmed.startsWith("UPDATE SUBTASKS SET DESCRIPTION")) {
        const [description, id, task_id] = params as [string, string, string];
        for (const st of subtasks) {
          if (st.id === id && st.task_id === task_id) {
            st.description = description;
          }
        }
      }
    },
    get(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.includes("SELECT") && trimmed.includes("SUBTASKS")) {
        const task_id = params[0] as string;
        const title = params[1] as string;
        return subtasks.find((st) => st.task_id === task_id && st.title === title);
      }
      if (trimmed.includes("WORKFLOW_META_JSON") && trimmed.includes("TASKS")) {
        return { workflow_meta_json: null };
      }
      return undefined;
    },
    all(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.includes("SELECT") && trimmed.includes("SUBTASKS")) {
        const task_id = params[0] as string;
        if (params.length > 1) {
          const titlePattern = params[1] as string;
          const pattern = titlePattern.replace(/%/g, "").replace(/\\(.)/g, "$1");
          return subtasks.filter((st) => st.task_id === task_id && st.title.includes(pattern));
        }
        return subtasks.filter((st) => st.task_id === task_id);
      }
      return [];
    },
    exec(_sql: string) {
      // no-op
    },
    _subtasks: subtasks,
  };
}

describe("GraphRunner — missing phase edge case", () => {
  let runner: GraphRunner;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    runner = new GraphRunner();
    db = createMockDb();
  });

  it("returns { advanced: false, nextPhases: [], taskDone: false } for unknown phase", async () => {
    const phases = [makePhase("a", [], [{ name: "out" }]), makePhase("b", [{ name: "in", from: "a.out" }], [])];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-1", pack, {});

    const result = await runner.onPhaseComplete(db as never, "task-1", "nonexistent_phase", pack, "/tmp");

    expect(result.advanced).toBe(false);
    expect(result.nextPhases).toHaveLength(0);
    expect(result.taskDone).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GraphRunner — cleanupTask
// ---------------------------------------------------------------------------

describe("GraphRunner — cleanupTask", () => {
  it("does not throw when called for a task with no trace state", () => {
    const runner = new GraphRunner();
    expect(() => runner.cleanupTask("nonexistent-task")).not.toThrow();
  });

  it("clears trace state and is idempotent", () => {
    const runner = new GraphRunner();
    // Call cleanup twice — second call should not throw
    runner.cleanupTask("task-1");
    runner.cleanupTask("task-1");
  });
});

// ---------------------------------------------------------------------------
// GraphRunner — setBroadcast
// ---------------------------------------------------------------------------

describe("GraphRunner — setBroadcast", () => {
  it("wires broadcast function for user_approval gate notifications", async () => {
    const broadcastFn = vi.fn();
    const runner = new GraphRunner();
    runner.setBroadcast(broadcastFn);

    const db = createMockDb();

    const phases = [
      makePhase("concept", [], [{ name: "pitch" }], { gate: "user_approval" }),
      makePhase("production", [{ name: "pitch", from: "concept.pitch" }], []),
    ];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-gate", pack, {});

    db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "done";

    await runner.onPhaseComplete(db as never, "task-gate", "concept", pack, "/tmp");

    // broadcastFn should have been called with the subtask_update event
    expect(broadcastFn).toHaveBeenCalledWith(
      "subtask_update",
      expect.objectContaining({ title: "[pipeline:concept]" }),
    );
  });
});

// ---------------------------------------------------------------------------
// GraphRunner — seedSubtasks with skipped_phases
// ---------------------------------------------------------------------------

describe("GraphRunner — seedSubtasks with skipped phases", () => {
  it("marks phases in skipped_phases as skipped and promotes blocked phases whose deps are all skipped", async () => {
    const runner = new GraphRunner();
    const db = createMockDb();

    // Inject task with skipped_phases
    (db as unknown as { get(sql: string, ...params: unknown[]): unknown }).get = (
      sql: string,
      ...params: unknown[]
    ) => {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.includes("SKIPPED_PHASES")) {
        return { skipped_phases: JSON.stringify(["a"]) };
      }
      if (trimmed.includes("SELECT") && trimmed.includes("SUBTASKS")) {
        const task_id = params[0] as string;
        const title = params[1] as string;
        return db._subtasks.find((st) => st.task_id === task_id && st.title === title);
      }
      return undefined;
    };

    const phases = [makePhase("a", [], [{ name: "out_a" }]), makePhase("b", [{ name: "in_b", from: "a.out_a" }], [])];
    const pack = makePack(phases);

    await runner.seedSubtasks(db as never, "task-skip", pack, {});

    const a = db._subtasks.find((s) => s.title === "[pipeline:a]");
    const b = db._subtasks.find((s) => s.title === "[pipeline:b]");

    expect(a?.status).toBe("skipped");
    // b's only dependency (a) is skipped, so b should be promoted to pending
    expect(b?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// GraphRunner — seedSubtasks stores __input__ metadata subtask
// ---------------------------------------------------------------------------

describe("GraphRunner — __input__ metadata subtask", () => {
  it("creates __input__ subtask when taskInput is non-empty", async () => {
    const runner = new GraphRunner();
    const db = createMockDb();

    const phases = [makePhase("a", [], [])];
    const pack = makePack(phases);

    await runner.seedSubtasks(db as never, "task-input", pack, { topic: "AI" });

    const inputSubtask = db._subtasks.find((s) => s.title === "[pipeline:__input__]");
    expect(inputSubtask).toBeDefined();
    expect(inputSubtask?.status).toBe("done");
    expect(JSON.parse(inputSubtask!.description)).toEqual({ topic: "AI" });
  });

  it("does not create __input__ subtask when taskInput is empty", async () => {
    const runner = new GraphRunner();
    const db = createMockDb();

    const phases = [makePhase("a", [], [])];
    const pack = makePack(phases);

    await runner.seedSubtasks(db as never, "task-noinput", pack, {});

    const inputSubtask = db._subtasks.find((s) => s.title === "[pipeline:__input__]");
    expect(inputSubtask).toBeUndefined();
  });
});
