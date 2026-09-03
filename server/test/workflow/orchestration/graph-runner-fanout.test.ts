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

function createMockDb() {
  const subtasks: MockSubtask[] = [];
  const taskMeta: Record<string, string> = {};

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
// Tests
// ---------------------------------------------------------------------------

describe("GraphRunner — resolveFanOutCount (via onPhaseComplete)", () => {
  let runner: GraphRunner;
  let db: ReturnType<typeof createMockDb>;
  let tmpDir: string;

  beforeEach(() => {
    runner = new GraphRunner();
    db = createMockDb();
    tmpDir = mkdtempSync(join(tmpdir(), "gr-fanout-test-"));
    mkdirSync(join(tmpDir, "output"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. JSON Array.length — screenplay.shot_list.scenes.length → 3
  // =========================================================================

  it("resolves fan-out count from JSON array length (3 scenes → 3 subtasks)", async () => {
    // Write the JSON file that count_from points to.
    // count_from = "screenplay.shot_list.scenes.length"
    //   → sourcePhaseId = "screenplay", outputName = "shot_list", jsonPath = ".scenes.length"
    // The output path for "screenplay.shot_list" needs to be at output/shot_list.json
    const shotListContent = { scenes: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    writeFileSync(join(tmpDir, "output", "shot_list.json"), JSON.stringify(shotListContent));

    const phases = [
      makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
      makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
        fan_out: { count_from: "screenplay.shot_list.scenes.length" },
      }),
      makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
    ];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-fo-1", pack, {});

    // Mark screenplay as done
    db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-fo-1", "screenplay", pack, tmpDir);

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("image_gen");

    // The placeholder subtask [pipeline:image_gen] gets set to pending (count=1 path),
    // plus 2 additional subtasks for instances 1 and 2 → total 3 subtasks with "image_gen"
    const imageGenSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:image_gen"));
    expect(imageGenSubtasks).toHaveLength(3);
    // All should be pending
    for (const st of imageGenSubtasks) {
      expect(st.status).toBe("pending");
    }
    // Named :0, :1, :2 — the first one keeps the placeholder title, extras get index suffixes
    const instance1 = db._subtasks.find((s) => s.title === "[pipeline:image_gen:1]");
    const instance2 = db._subtasks.find((s) => s.title === "[pipeline:image_gen:2]");
    expect(instance1).toBeDefined();
    expect(instance2).toBeDefined();
  });

  // =========================================================================
  // 2. Nested JSON path — planning.strategy.sub_questions.length → 2
  // =========================================================================

  it("resolves nested JSON path (sub_questions array of 2 → 2 subtasks)", async () => {
    // count_from = "planning.strategy.sub_questions.length"
    //   → sourcePhaseId = "planning", outputName = "strategy", jsonPath = ".sub_questions.length"
    writeFileSync(join(tmpDir, "output", "strategy.json"), JSON.stringify({ sub_questions: ["q1", "q2"] }));

    const phases = [
      makePhase("planning", [], [{ name: "strategy", path: "output/strategy.json", type: "json" }]),
      makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
        fan_out: { count_from: "planning.strategy.sub_questions.length" },
      }),
      makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
    ];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-fo-2", pack, {});

    db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-fo-2", "planning", pack, tmpDir);

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("crawl");

    const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
    expect(crawlSubtasks).toHaveLength(2);
    for (const st of crawlSubtasks) {
      expect(st.status).toBe("pending");
    }
  });

  // =========================================================================
  // 3. Missing file — count_from points to non-existent file → fallback to 1
  // =========================================================================

  it("falls back to 1 when the referenced file does not exist", async () => {
    // Do NOT write any file — the output path won't exist on disk
    const phases = [
      makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
      makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
        fan_out: { count_from: "screenplay.shot_list.scenes.length" },
      }),
      makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
    ];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-fo-3", pack, {});

    db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-fo-3", "screenplay", pack, tmpDir);

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("image_gen");

    // Only 1 subtask — the original placeholder updated to pending
    const imageGenSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:image_gen"));
    expect(imageGenSubtasks).toHaveLength(1);
    expect(imageGenSubtasks[0].status).toBe("pending");
  });

  // =========================================================================
  // 4. Invalid JSON — file exists but isn't valid JSON → fallback to 1
  // =========================================================================

  it("falls back to 1 when the referenced file contains invalid JSON", async () => {
    writeFileSync(join(tmpDir, "output", "shot_list.json"), "this is not { valid json ]");

    const phases = [
      makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
      makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
        fan_out: { count_from: "screenplay.shot_list.scenes.length" },
      }),
      makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
    ];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-fo-4", pack, {});

    db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-fo-4", "screenplay", pack, tmpDir);

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("image_gen");

    const imageGenSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:image_gen"));
    expect(imageGenSubtasks).toHaveLength(1);
    expect(imageGenSubtasks[0].status).toBe("pending");
  });

  // =========================================================================
  // 5. Empty array — {"scenes": []} → fallback to 1
  // =========================================================================

  it("falls back to 1 when the JSON array is empty", async () => {
    // The implementation: `return current.length > 0 ? current.length : 1`
    // So empty array → 1 (fallback)
    writeFileSync(join(tmpDir, "output", "shot_list.json"), JSON.stringify({ scenes: [] }));

    const phases = [
      makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
      makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
        fan_out: { count_from: "screenplay.shot_list.scenes.length" },
      }),
      makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
    ];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-fo-5", pack, {});

    db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-fo-5", "screenplay", pack, tmpDir);

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("image_gen");

    // Empty array → fallback to 1 (not 0)
    const imageGenSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:image_gen"));
    expect(imageGenSubtasks).toHaveLength(1);
    expect(imageGenSubtasks[0].status).toBe("pending");
  });

  // =========================================================================
  // 6. Pack input reference — input.crawler_count → returns 1 (not a file ref)
  // =========================================================================

  it("returns 1 for input.* pack input references (no file resolution attempted)", async () => {
    // count_from = "input.crawler_count" → starts with "input." → early return 1
    // We provide taskInput with crawler_count=5 but the implementation ignores it for count,
    // returning 1 (seeding-time resolution is the intended behavior for pack inputs)
    const phases = [
      makePhase("planning", [], [{ name: "strategy" }]),
      makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
        fan_out: { count_from: "input.crawler_count" },
      }),
      makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
    ];
    const pack = makePack(phases);
    await runner.seedSubtasks(db as never, "task-fo-6", pack, { crawler_count: 5 });

    db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-fo-6", "planning", pack, tmpDir);

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("crawl");

    // input.* → count = 1 → only the placeholder subtask unblocked
    const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
    expect(crawlSubtasks).toHaveLength(1);
    expect(crawlSubtasks[0].status).toBe("pending");
  });

  // =========================================================================
  // 7. Direct private method access test via (runner as any)
  // =========================================================================

  describe("resolveFanOutCount (direct access via any cast)", () => {
    it("returns 3 for a 3-element array via JSON path", async () => {
      writeFileSync(join(tmpDir, "output", "shot_list.json"), JSON.stringify({ scenes: [1, 2, 3] }));

      const phases = [
        makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
        makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
          fan_out: { count_from: "screenplay.shot_list.scenes.length" },
        }),
        makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
      ];
      const pack = makePack(phases);
      const imageGenPhase = phases.find((p) => p.id === "image_gen")!;

      const count = await (
        runner as never as {
          resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
        }
      ).resolveFanOutCount(tmpDir, imageGenPhase, pack);

      expect(count).toBe(3);
    });

    it("returns 2 for nested path sub_questions.length", async () => {
      writeFileSync(join(tmpDir, "output", "strategy.json"), JSON.stringify({ sub_questions: ["q1", "q2"] }));

      const phases = [
        makePhase("planning", [], [{ name: "strategy", path: "output/strategy.json", type: "json" }]),
        makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
          fan_out: { count_from: "planning.strategy.sub_questions.length" },
        }),
        makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
      ];
      const pack = makePack(phases);
      const crawlPhase = phases.find((p) => p.id === "crawl")!;

      const count = await (
        runner as never as {
          resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
        }
      ).resolveFanOutCount(tmpDir, crawlPhase, pack);

      expect(count).toBe(2);
    });

    it("returns 1 when file does not exist (missing file fallback)", async () => {
      const phases = [
        makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
        makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
          fan_out: { count_from: "screenplay.shot_list.scenes.length" },
        }),
        makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
      ];
      const pack = makePack(phases);
      const imageGenPhase = phases.find((p) => p.id === "image_gen")!;

      const count = await (
        runner as never as {
          resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
        }
      ).resolveFanOutCount(tmpDir, imageGenPhase, pack);

      expect(count).toBe(1);
    });

    it("returns 1 for invalid JSON file (parse error fallback)", async () => {
      writeFileSync(join(tmpDir, "output", "shot_list.json"), "{ broken json");

      const phases = [
        makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
        makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
          fan_out: { count_from: "screenplay.shot_list.scenes.length" },
        }),
        makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
      ];
      const pack = makePack(phases);
      const imageGenPhase = phases.find((p) => p.id === "image_gen")!;

      const count = await (
        runner as never as {
          resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
        }
      ).resolveFanOutCount(tmpDir, imageGenPhase, pack);

      expect(count).toBe(1);
    });

    it("returns 1 for empty array (empty array fallback)", async () => {
      writeFileSync(join(tmpDir, "output", "shot_list.json"), JSON.stringify({ scenes: [] }));

      const phases = [
        makePhase("screenplay", [], [{ name: "shot_list", path: "output/shot_list.json", type: "json" }]),
        makePhase("image_gen", [{ name: "shot_list", from: "screenplay.shot_list" }], [{ name: "images" }], {
          fan_out: { count_from: "screenplay.shot_list.scenes.length" },
        }),
        makePhase("assembly", [{ name: "images", from: "image_gen.images.*" }], []),
      ];
      const pack = makePack(phases);
      const imageGenPhase = phases.find((p) => p.id === "image_gen")!;

      const count = await (
        runner as never as {
          resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
        }
      ).resolveFanOutCount(tmpDir, imageGenPhase, pack);

      expect(count).toBe(1);
    });

    it("returns 1 for input.* reference (pack input, no file resolution)", async () => {
      const phases = [
        makePhase("planning", [], [{ name: "strategy" }]),
        makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
          fan_out: { count_from: "input.crawler_count" },
        }),
        makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
      ];
      const pack = makePack(phases);
      const crawlPhase = phases.find((p) => p.id === "crawl")!;

      const count = await (
        runner as never as {
          resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number>;
        }
      ).resolveFanOutCount(tmpDir, crawlPhase, pack);

      expect(count).toBe(1);
    });
  });
});
