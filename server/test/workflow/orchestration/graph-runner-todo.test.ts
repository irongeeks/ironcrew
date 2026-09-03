import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";

// ---------------------------------------------------------------------------
// Mock DB (same pattern as graph-runner.test.ts)
// ---------------------------------------------------------------------------

interface MockSubtask {
  id: string;
  task_id: string;
  title: string;
  description: string;
  status: string;
  created_at: number;
}

function createMockDb(initialMeta?: Record<string, string>) {
  const subtasks: MockSubtask[] = [];
  const taskMeta: Record<string, string> = { ...(initialMeta ?? {}) };
  const metaUpdates: Array<{ taskId: string; metaJson: string }> = [];

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
        const [status, task_id, titlePattern] = params as [string, string, string];
        const pattern = (titlePattern as string).replace(/%/g, "").replace(/\\(.)/g, "$1");
        for (const st of subtasks) {
          if (st.task_id === task_id && st.title.includes(pattern)) {
            st.status = status;
          }
        }
      } else if (trimmed.startsWith("UPDATE SUBTASKS SET DESCRIPTION")) {
        const [description, id, task_id] = params as [string, string, string];
        for (const st of subtasks) {
          if (st.id === id && st.task_id === task_id) {
            st.description = description;
          }
        }
      } else if (trimmed.includes("UPDATE TASKS SET WORKFLOW_META_JSON")) {
        const [metaJson, taskId] = params as [string, string];
        taskMeta[taskId] = metaJson;
        metaUpdates.push({ taskId, metaJson });
      }
    },
    get(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.includes("SELECT") && trimmed.includes("SUBTASKS")) {
        const task_id = params[0] as string;
        const titlePattern = params[1] as string;
        const pattern = titlePattern.replace(/%/g, "").replace(/\\(.)/g, "$1");
        return subtasks.find((st) => st.task_id === task_id && st.title.includes(pattern));
      }
      if (trimmed.includes("WORKFLOW_META_JSON") && trimmed.includes("TASKS")) {
        const taskId = params[0] as string;
        return { workflow_meta_json: taskMeta[taskId] ?? null };
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
    _subtasks: subtasks,
    _taskMeta: taskMeta,
    _metaUpdates: metaUpdates,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhase(
  id: string,
  inputs: { name: string; from: string }[] = [],
  outputs: { name: string; path?: string; type?: "json" | "markdown" }[] = [],
  overrides: Partial<Phase> = {},
): Phase {
  return {
    id,
    department: "test",
    guidance: `guidance/{lang}/${id}.md`,
    capability_mode: "hybrid" as const,
    gate: "auto" as const,
    inputs,
    outputs: outputs.map((o) => ({
      name: o.name,
      type: (o.type ?? "json") as "json",
      path: o.path ?? `output/${o.name}.json`,
    })),
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
// Tests: resolveFanOutCount — JSON path navigation for count_from references
// ---------------------------------------------------------------------------

describe("GraphRunner — resolveFanOutCount (additional coverage)", () => {
  let runner: GraphRunner;
  let tmpDir: string;

  beforeEach(() => {
    runner = new GraphRunner();
    tmpDir = mkdtempSync(join(tmpdir(), "gr-todo-fanout-"));
    mkdirSync(join(tmpDir, "output"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("navigates deeply nested JSON path (data.items.list.length → 4)", async () => {
    writeFileSync(
      join(tmpDir, "output", "config.json"),
      JSON.stringify({ data: { items: { list: ["a", "b", "c", "d"] } } }),
    );

    const phases = [
      makePhase("setup", [], [{ name: "config", path: "output/config.json", type: "json" }]),
      makePhase("worker", [{ name: "config", from: "setup.config" }], [{ name: "result" }], {
        fan_out: { count_from: "setup.config.data.items.list.length" },
      }),
      makePhase("merge", [{ name: "result", from: "worker.result.*" }], []),
    ];
    const pack = makePack(phases);
    const workerPhase = phases.find((p) => p.id === "worker")!;

    const count = await (
      runner as never as {
        resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
      }
    ).resolveFanOutCount(tmpDir, workerPhase, pack);

    expect(count).toBe(4);
  });

  it("returns numeric value for non-length JSON path (config.count = 7)", async () => {
    writeFileSync(join(tmpDir, "output", "config.json"), JSON.stringify({ count: 7 }));

    const phases = [
      makePhase("setup", [], [{ name: "config", path: "output/config.json", type: "json" }]),
      makePhase("worker", [{ name: "config", from: "setup.config" }], [{ name: "result" }], {
        fan_out: { count_from: "setup.config.count" },
      }),
      makePhase("merge", [{ name: "result", from: "worker.result.*" }], []),
    ];
    const pack = makePack(phases);
    const workerPhase = phases.find((p) => p.id === "worker")!;

    const count = await (
      runner as never as {
        resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
      }
    ).resolveFanOutCount(tmpDir, workerPhase, pack);

    expect(count).toBe(7);
  });

  it("returns 1 when JSON path resolves to null (missing nested key)", async () => {
    writeFileSync(join(tmpDir, "output", "config.json"), JSON.stringify({ other_key: "value" }));

    const phases = [
      makePhase("setup", [], [{ name: "config", path: "output/config.json", type: "json" }]),
      makePhase("worker", [{ name: "config", from: "setup.config" }], [{ name: "result" }], {
        fan_out: { count_from: "setup.config.missing.key.length" },
      }),
      makePhase("merge", [{ name: "result", from: "worker.result.*" }], []),
    ];
    const pack = makePack(phases);
    const workerPhase = phases.find((p) => p.id === "worker")!;

    const count = await (
      runner as never as {
        resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
      }
    ).resolveFanOutCount(tmpDir, workerPhase, pack);

    expect(count).toBe(1);
  });

  it("returns 1 when fan_out is undefined on phase", async () => {
    const phases = [
      makePhase("setup", [], [{ name: "config", path: "output/config.json", type: "json" }]),
      makePhase("worker", [{ name: "config", from: "setup.config" }], [{ name: "result" }]),
      makePhase("merge", [{ name: "result", from: "worker.result.*" }], []),
    ];
    const pack = makePack(phases);
    const workerPhase = phases.find((p) => p.id === "worker")!;

    const count = await (
      runner as never as {
        resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
      }
    ).resolveFanOutCount(tmpDir, workerPhase, pack);

    expect(count).toBe(1);
  });

  it("returns 1 when output def is not found in pack (unknown source phase)", async () => {
    const phases = [
      makePhase("setup", [], [{ name: "config", path: "output/config.json", type: "json" }]),
      makePhase("worker", [{ name: "config", from: "setup.config" }], [{ name: "result" }], {
        fan_out: { count_from: "nonexistent.output.items.length" },
      }),
      makePhase("merge", [{ name: "result", from: "worker.result.*" }], []),
    ];
    const pack = makePack(phases);
    const workerPhase = phases.find((p) => p.id === "worker")!;

    const count = await (
      runner as never as {
        resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
      }
    ).resolveFanOutCount(tmpDir, workerPhase, pack);

    expect(count).toBe(1);
  });

  it("returns string-to-number coercion fallback for non-numeric path value", async () => {
    writeFileSync(join(tmpDir, "output", "config.json"), JSON.stringify({ count: "not_a_number" }));

    const phases = [
      makePhase("setup", [], [{ name: "config", path: "output/config.json", type: "json" }]),
      makePhase("worker", [{ name: "config", from: "setup.config" }], [{ name: "result" }], {
        fan_out: { count_from: "setup.config.count" },
      }),
      makePhase("merge", [{ name: "result", from: "worker.result.*" }], []),
    ];
    const pack = makePack(phases);
    const workerPhase = phases.find((p) => p.id === "worker")!;

    const count = await (
      runner as never as {
        resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
      }
    ).resolveFanOutCount(tmpDir, workerPhase, pack);

    // parseInt("not_a_number") is NaN → fallback to 1
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkReviewFail — structured flag_output parsing and max_passes
// ---------------------------------------------------------------------------

describe("GraphRunner — checkReviewFail (additional coverage)", () => {
  let runner: GraphRunner;
  let tmpDir: string;

  beforeEach(() => {
    runner = new GraphRunner();
    tmpDir = mkdtempSync(join(tmpdir(), "gr-todo-review-"));
    mkdirSync(join(tmpDir, "output"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeReviewPack(flagRelPath: string, maxPasses = 2): LoadedPack {
    const phases = [
      makePhase("gen", [], [{ name: "images", path: "output/images.json" }]),
      makePhase("review", [{ name: "images", from: "gen.images" }], [{ name: "flags", path: flagRelPath }], {
        on_review_fail: {
          rerun: "gen",
          max_passes: maxPasses,
          flag_output: "flags",
        },
      }),
      makePhase("next", [{ name: "flags", from: "review.flags" }], []),
    ];
    return makePack(phases);
  }

  function seedState(db: ReturnType<typeof createMockDb>, taskId: string) {
    const now = Date.now();
    db._subtasks.push(
      { id: "st-gen", task_id: taskId, title: "[pipeline:gen]", description: "", status: "done", created_at: now },
      {
        id: "st-review",
        task_id: taskId,
        title: "[pipeline:review]",
        description: "",
        status: "done",
        created_at: now,
      },
      { id: "st-next", task_id: taskId, title: "[pipeline:next]", description: "", status: "blocked", created_at: now },
    );
  }

  it("detects failures from object with items array", async () => {
    const flagPath = "output/flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify({ items: [{ id: 1, issue: "blurry" }] }));

    const db = createMockDb();
    const taskId = "task-items-array";
    seedState(db, taskId);

    const pack = makeReviewPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "review", pack, tmpDir);

    expect(result.advanced).toBe(false);
    const gen = db._subtasks.find((s) => s.title === "[pipeline:gen]")!;
    expect(gen.status).toBe("pending");
  });

  it("max_passes = 1 allows exactly one re-run then advances", async () => {
    const flagPath = "output/flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ issue: "bad" }]));

    // First call: regen_count = 0, should re-run
    const db1 = createMockDb();
    const taskId = "task-max1";
    seedState(db1, taskId);

    const pack = makeReviewPack(flagPath, 1);
    const r1 = await runner.onPhaseComplete(db1 as never, taskId, "review", pack, tmpDir);
    expect(r1.advanced).toBe(false);
    expect(db1._subtasks.find((s) => s.title === "[pipeline:gen]")!.status).toBe("pending");

    // Second call: regen_count = 1, max_passes = 1 → should advance
    const db2 = createMockDb({ [taskId]: JSON.stringify({ regen_count_review: 1 }) });
    seedState(db2, taskId);
    const r2 = await runner.onPhaseComplete(db2 as never, taskId, "review", pack, tmpDir);
    expect(r2.advanced).toBe(true);
    expect(r2.nextPhases).toContain("next");
  });

  it("returns no failures when flag file is a simple object without known keys", async () => {
    const flagPath = "output/flags.json";
    // Object without failures, items, or regen_needed keys
    writeFileSync(join(tmpDir, flagPath), JSON.stringify({ summary: "all good", score: 100 }));

    const db = createMockDb();
    const taskId = "task-no-keys";
    seedState(db, taskId);

    const pack = makeReviewPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "review", pack, tmpDir);

    // No recognized failure keys → advance
    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("next");
  });

  it("returns no re-run when flag_output name does not match any phase output", async () => {
    // Build a pack where flag_output points to a non-existent output name
    const phases = [
      makePhase("gen", [], [{ name: "images", path: "output/images.json" }]),
      makePhase("review", [{ name: "images", from: "gen.images" }], [{ name: "report", path: "output/report.json" }], {
        on_review_fail: {
          rerun: "gen",
          max_passes: 2,
          flag_output: "nonexistent_output",
        },
      }),
      makePhase("next", [{ name: "report", from: "review.report" }], []),
    ];
    const pack = makePack(phases);

    const db = createMockDb();
    const taskId = "task-bad-flag-ref";
    const now = Date.now();
    db._subtasks.push(
      { id: "st-gen", task_id: taskId, title: "[pipeline:gen]", description: "", status: "done", created_at: now },
      {
        id: "st-review",
        task_id: taskId,
        title: "[pipeline:review]",
        description: "",
        status: "done",
        created_at: now,
      },
      { id: "st-next", task_id: taskId, title: "[pipeline:next]", description: "", status: "blocked", created_at: now },
    );

    const result = await runner.onPhaseComplete(db as never, taskId, "review", pack, tmpDir);

    // flag_output def not found → checkReviewFail returns false → advance
    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("next");
  });
});

// ---------------------------------------------------------------------------
// Tests: onPhaseComplete — fan-out phase ID stripping
// ---------------------------------------------------------------------------

describe("GraphRunner — onPhaseComplete fan-out phase ID stripping", () => {
  let runner: GraphRunner;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    runner = new GraphRunner();
    db = createMockDb();
  });

  it("completing all fan-out instances unblocks downstream (crawl:0, crawl:1 → synthesis)", async () => {
    const phases = [
      makePhase("planning", [], [{ name: "strategy" }]),
      makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
        fan_out: { count_from: "planning.strategy.sub_questions.length" },
      }),
      makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
    ];
    const pack = makePack(phases);

    // Manually seed fan-out state
    const now = Date.now();
    db._subtasks.push(
      { id: "st-plan", task_id: "t1", title: "[pipeline:planning]", description: "", status: "done", created_at: now },
      { id: "st-c0", task_id: "t1", title: "[pipeline:crawl:0]", description: "", status: "done", created_at: now },
      { id: "st-c1", task_id: "t1", title: "[pipeline:crawl:1]", description: "", status: "done", created_at: now },
      { id: "st-c2", task_id: "t1", title: "[pipeline:crawl:2]", description: "", status: "done", created_at: now },
      {
        id: "st-synth",
        task_id: "t1",
        title: "[pipeline:synthesis]",
        description: "",
        status: "blocked",
        created_at: now,
      },
    );

    // Pass "crawl" (base ID, stripped of fan-out index) to onPhaseComplete
    const result = await runner.onPhaseComplete(db as never, "t1", "crawl", pack, "/tmp");

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("synthesis");

    const synthesis = db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!;
    expect(synthesis.status).toBe("pending");
  });

  it("partially completed fan-out instances do NOT unblock downstream", async () => {
    const phases = [
      makePhase("planning", [], [{ name: "strategy" }]),
      makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
        fan_out: { count_from: "planning.strategy.sub_questions.length" },
      }),
      makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
    ];
    const pack = makePack(phases);

    const now = Date.now();
    db._subtasks.push(
      { id: "st-plan", task_id: "t2", title: "[pipeline:planning]", description: "", status: "done", created_at: now },
      { id: "st-c0", task_id: "t2", title: "[pipeline:crawl:0]", description: "", status: "done", created_at: now },
      {
        id: "st-c1",
        task_id: "t2",
        title: "[pipeline:crawl:1]",
        description: "",
        status: "in_progress",
        created_at: now,
      },
      {
        id: "st-synth",
        task_id: "t2",
        title: "[pipeline:synthesis]",
        description: "",
        status: "blocked",
        created_at: now,
      },
    );

    const result = await runner.onPhaseComplete(db as never, "t2", "crawl", pack, "/tmp");

    // crawl:1 is still in_progress, so synthesis should stay blocked
    expect(result.nextPhases).not.toContain("synthesis");
    const synthesis = db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!;
    expect(synthesis.status).toBe("blocked");
  });

  it("fan-out with single instance (:0 only) still unblocks downstream", async () => {
    const phases = [
      makePhase("planning", [], [{ name: "strategy" }]),
      makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
        fan_out: { count_from: "planning.strategy.sub_questions.length" },
      }),
      makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
    ];
    const pack = makePack(phases);

    const now = Date.now();
    db._subtasks.push(
      { id: "st-plan", task_id: "t3", title: "[pipeline:planning]", description: "", status: "done", created_at: now },
      { id: "st-c0", task_id: "t3", title: "[pipeline:crawl]", description: "", status: "done", created_at: now },
      {
        id: "st-synth",
        task_id: "t3",
        title: "[pipeline:synthesis]",
        description: "",
        status: "blocked",
        created_at: now,
      },
    );

    const result = await runner.onPhaseComplete(db as never, "t3", "crawl", pack, "/tmp");

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("synthesis");
  });
});
