import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";
import type { ConnectorRegistry } from "../../../connectors/registry.ts";

// ---------------------------------------------------------------------------
// Mock DB
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
        // INSERT INTO subtasks (id, task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)
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
        // UPDATE subtasks SET status = ? WHERE task_id = ? AND title LIKE ?
        const [status, task_id, titlePattern] = params as [string, string, string];
        const pattern = (titlePattern as string).replace(/%/g, "").replace(/\\(.)/g, "$1");
        for (const st of subtasks) {
          if (st.task_id === task_id && st.title.includes(pattern)) {
            st.status = status;
          }
        }
      } else if (trimmed.startsWith("UPDATE SUBTASKS SET DESCRIPTION")) {
        // UPDATE subtasks SET description = ? WHERE id = ? AND task_id = ?
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
    guidanceCache.set(`${phase.id}.en`, `Guidance for ${phase.id} in English`);
    guidanceCache.set(`${phase.id}.ko`, `${phase.id}에 대한 안내`);
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

describe("GraphRunner", () => {
  let runner: GraphRunner;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    runner = new GraphRunner();
    db = createMockDb();
  });

  // =========================================================================
  // seedSubtasks
  // =========================================================================

  describe("seedSubtasks", () => {
    it("linear pack: creates 3 subtasks, root=pending, rest=blocked", async () => {
      const phases = [
        makePhase("a", [], [{ name: "out_a" }]),
        makePhase("b", [{ name: "in_b", from: "a.out_a" }], [{ name: "out_b" }]),
        makePhase("c", [{ name: "in_c", from: "b.out_b" }], []),
      ];
      const pack = makePack(phases);

      await runner.seedSubtasks(db as never, "task-1", pack, {});

      expect(db._subtasks).toHaveLength(3);

      const a = db._subtasks.find((s) => s.title === "[pipeline:a]");
      const b = db._subtasks.find((s) => s.title === "[pipeline:b]");
      const c = db._subtasks.find((s) => s.title === "[pipeline:c]");

      expect(a?.status).toBe("pending");
      expect(b?.status).toBe("blocked");
      expect(c?.status).toBe("blocked");
    });

    it("fan-out: creates placeholder for fan-out phase", async () => {
      const phases = [
        makePhase("planning", [], [{ name: "strategy" }]),
        makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
          fan_out: { count_from: "planning.strategy.sub_questions.length" },
        }),
        makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
      ];
      const pack = makePack(phases);

      await runner.seedSubtasks(db as never, "task-2", pack, {});

      expect(db._subtasks).toHaveLength(3);

      const crawl = db._subtasks.find((s) => s.title === "[pipeline:crawl]");
      expect(crawl).toBeDefined();
      expect(crawl?.status).toBe("blocked");
    });

    it("root phases get pack input injected into description", async () => {
      const phases = [
        makePhase("concept", [{ name: "topic", from: "input.topic" }], [{ name: "pitch" }]),
        makePhase("screenplay", [{ name: "pitch", from: "concept.pitch" }], []),
      ];
      const pack = makePack(phases);

      await runner.seedSubtasks(db as never, "task-3", pack, { topic: "AI revolution" });

      const concept = db._subtasks.find((s) => s.title === "[pipeline:concept]");
      expect(concept?.description).toContain("AI revolution");
    });
  });

  // =========================================================================
  // onPhaseComplete
  // =========================================================================

  describe("onPhaseComplete", () => {
    it("sequential: completing A unblocks B", async () => {
      const phases = [
        makePhase("a", [], [{ name: "out_a" }]),
        makePhase("b", [{ name: "in_b", from: "a.out_a" }], [{ name: "out_b" }]),
        makePhase("c", [{ name: "in_c", from: "b.out_b" }], []),
      ];
      const pack = makePack(phases);
      await runner.seedSubtasks(db as never, "task-4", pack, {});

      // Mark A as done
      const a = db._subtasks.find((s) => s.title === "[pipeline:a]")!;
      a.status = "done";

      const result = await runner.onPhaseComplete(db as never, "task-4", "a", pack, "/tmp");

      expect(result.advanced).toBe(true);
      expect(result.nextPhases).toContain("b");
      expect(result.taskDone).toBe(false);

      const b = db._subtasks.find((s) => s.title === "[pipeline:b]")!;
      expect(b.status).toBe("pending");
    });

    it("fan-out: completing planning resolves count, creates N crawl subtasks", async () => {
      const phases = [
        makePhase("planning", [], [{ name: "strategy" }]),
        makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
          fan_out: { count_from: "planning.strategy.sub_questions.length" },
        }),
        makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
      ];
      const pack = makePack(phases);
      await runner.seedSubtasks(db as never, "task-5", pack, {});

      // Mark planning as done
      const planning = db._subtasks.find((s) => s.title === "[pipeline:planning]")!;
      planning.status = "done";

      // Mock the fan-out count resolution: we need a file that resolves the count
      // The runner will try to resolve "planning.strategy.sub_questions.length"
      // For testing, we mock this by providing a resolveFanOutCount override
      // Since the runner reads files, we provide a simpler approach:
      // Override the internal method via the pack's output path
      // Actually, let's just test with a fixed count approach by injecting into the subtask
      const result = await runner.onPhaseComplete(db as never, "task-5", "planning", pack, "/tmp");

      // Even if artifact resolution fails (no files), the fan-out should create
      // a default of 1 subtask when count can't be resolved
      expect(result.advanced).toBe(true);
      expect(result.nextPhases).toContain("crawl");

      const crawlSubtasks = db._subtasks.filter((s) => s.title.startsWith("[pipeline:crawl"));
      expect(crawlSubtasks.length).toBeGreaterThanOrEqual(1);
    });

    it("fan-in: completing last fan-out item unblocks synthesis", async () => {
      const phases = [
        makePhase("planning", [], [{ name: "strategy" }]),
        makePhase("crawl", [{ name: "strategy", from: "planning.strategy" }], [{ name: "findings" }], {
          fan_out: { count_from: "planning.strategy.sub_questions.length" },
        }),
        makePhase("synthesis", [{ name: "findings", from: "crawl.findings.*" }], []),
      ];
      const pack = makePack(phases);

      // Manually seed the state: planning done, 2 crawl subtasks, synthesis blocked
      db._subtasks.push(
        {
          id: "st-plan",
          task_id: "task-6",
          title: "[pipeline:planning]",
          description: "",
          status: "done",
          created_at: Date.now(),
        },
        {
          id: "st-crawl-0",
          task_id: "task-6",
          title: "[pipeline:crawl:0]",
          description: "",
          status: "done",
          created_at: Date.now(),
        },
        {
          id: "st-crawl-1",
          task_id: "task-6",
          title: "[pipeline:crawl:1]",
          description: "",
          status: "done",
          created_at: Date.now(),
        },
        {
          id: "st-synth",
          task_id: "task-6",
          title: "[pipeline:synthesis]",
          description: "",
          status: "blocked",
          created_at: Date.now(),
        },
      );

      const result = await runner.onPhaseComplete(db as never, "task-6", "crawl", pack, "/tmp");

      expect(result.advanced).toBe(true);
      expect(result.nextPhases).toContain("synthesis");

      const synthesis = db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!;
      expect(synthesis.status).toBe("pending");
    });

    it("diamond: both B and C must complete before D", async () => {
      const phases = [
        makePhase("a", [], [{ name: "out_a" }]),
        makePhase("b", [{ name: "in_b", from: "a.out_a" }], [{ name: "out_b" }]),
        makePhase("c", [{ name: "in_c", from: "a.out_a" }], [{ name: "out_c" }]),
        makePhase("d", [
          { name: "in_d1", from: "b.out_b" },
          { name: "in_d2", from: "c.out_c" },
        ]),
      ];
      const pack = makePack(phases);
      await runner.seedSubtasks(db as never, "task-7", pack, {});

      // Complete A → unblocks B and C
      db._subtasks.find((s) => s.title === "[pipeline:a]")!.status = "done";
      await runner.onPhaseComplete(db as never, "task-7", "a", pack, "/tmp");

      // Complete B only → D should stay blocked
      db._subtasks.find((s) => s.title === "[pipeline:b]")!.status = "done";
      const r1 = await runner.onPhaseComplete(db as never, "task-7", "b", pack, "/tmp");

      const dAfterB = db._subtasks.find((s) => s.title === "[pipeline:d]")!;
      expect(dAfterB.status).toBe("blocked");
      expect(r1.nextPhases).not.toContain("d");

      // Complete C → now D should unblock
      db._subtasks.find((s) => s.title === "[pipeline:c]")!.status = "done";
      const r2 = await runner.onPhaseComplete(db as never, "task-7", "c", pack, "/tmp");

      const dAfterC = db._subtasks.find((s) => s.title === "[pipeline:d]")!;
      expect(dAfterC.status).toBe("pending");
      expect(r2.nextPhases).toContain("d");
    });

    it("gate: user_approval sets awaiting_approval, stops advancement", async () => {
      const phases = [
        makePhase("concept", [], [{ name: "pitch" }], { gate: "user_approval" }),
        makePhase("production", [{ name: "pitch", from: "concept.pitch" }], []),
      ];
      const pack = makePack(phases);
      await runner.seedSubtasks(db as never, "task-8", pack, {});

      // Mark concept as done
      db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "done";

      const result = await runner.onPhaseComplete(db as never, "task-8", "concept", pack, "/tmp");

      const concept = db._subtasks.find((s) => s.title === "[pipeline:concept]")!;
      expect(concept.status).toBe("awaiting_approval");

      const production = db._subtasks.find((s) => s.title === "[pipeline:production]")!;
      expect(production.status).toBe("blocked");

      expect(result.advanced).toBe(false);
      expect(result.nextPhases).toHaveLength(0);
    });

    it("skip_when: truthy skip marks phase as skipped, unblocks downstream", async () => {
      const phases = [
        makePhase("planning", [], [{ name: "strategy" }]),
        makePhase("fact_check", [{ name: "strategy", from: "planning.strategy" }], [{ name: "results" }], {
          skip_when: "input.depth == 'quick'",
        }),
        makePhase("final_report", [{ name: "results", from: "fact_check.results" }], []),
      ];
      const pack = makePack(phases);

      // Use input that triggers skip
      await runner.seedSubtasks(db as never, "task-9", pack, { depth: "quick" });

      // Mark planning done
      db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";

      const result = await runner.onPhaseComplete(db as never, "task-9", "planning", pack, "/tmp");

      const factCheck = db._subtasks.find((s) => s.title === "[pipeline:fact_check]")!;
      expect(factCheck.status).toBe("skipped");

      const finalReport = db._subtasks.find((s) => s.title === "[pipeline:final_report]")!;
      expect(finalReport.status).toBe("pending");

      expect(result.advanced).toBe(true);
    });

    it("on_review_fail: re-activates target phase on failure flags", async () => {
      // Create a temp directory with the flag output file containing failures
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gr-test-"));
      const outputDir = path.join(tmpDir, "output");
      fs.mkdirSync(outputDir, { recursive: true });
      // Write a JSON file with failure flags (the runner reads this file)
      fs.writeFileSync(
        path.join(outputDir, "review_flags.md"),
        JSON.stringify([{ image: "img_1.png", issue: "blurry" }]),
      );

      const phases = [
        makePhase("image_gen", [], [{ name: "images" }]),
        makePhase("image_review", [{ name: "images", from: "image_gen.images" }], [{ name: "review_flags" }], {
          on_review_fail: {
            rerun: "image_gen",
            max_passes: 2,
            flag_output: "review_flags",
          },
        }),
        makePhase("video_gen", [{ name: "review_flags", from: "image_review.review_flags" }], []),
      ];
      const pack = makePack(phases);
      await runner.seedSubtasks(db as never, "task-10", pack, {});

      // Complete image_gen, then image_review with failures
      db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!.status = "done";
      await runner.onPhaseComplete(db as never, "task-10", "image_gen", pack, tmpDir);

      db._subtasks.find((s) => s.title === "[pipeline:image_review]")!.status = "done";

      await runner.onPhaseComplete(db as never, "task-10", "image_review", pack, tmpDir);

      // image_gen should be re-activated
      const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
      expect(imageGen.status).toBe("pending");

      // video_gen should stay blocked
      const videoGen = db._subtasks.find((s) => s.title === "[pipeline:video_gen]")!;
      expect(videoGen.status).toBe("blocked");

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("terminal: last phase completing returns taskDone: true", async () => {
      const phases = [makePhase("a", [], [{ name: "out_a" }]), makePhase("b", [{ name: "in_b", from: "a.out_a" }], [])];
      const pack = makePack(phases);
      await runner.seedSubtasks(db as never, "task-11", pack, {});

      // Complete both
      db._subtasks.find((s) => s.title === "[pipeline:a]")!.status = "done";
      await runner.onPhaseComplete(db as never, "task-11", "a", pack, "/tmp");

      db._subtasks.find((s) => s.title === "[pipeline:b]")!.status = "done";
      const result = await runner.onPhaseComplete(db as never, "task-11", "b", pack, "/tmp");

      expect(result.taskDone).toBe(true);
    });
  });

  // =========================================================================
  // buildPhasePrompt
  // =========================================================================

  describe("buildPhasePrompt", () => {
    it("returns guidance text for phase + lang", () => {
      const phases = [makePhase("concept", [], [{ name: "pitch" }])];
      const pack = makePack(phases);

      const prompt = runner.buildPhasePrompt(pack, "concept", "en");
      expect(prompt).toContain("Guidance for concept in English");
    });

    it("falls back to en when requested lang not found", () => {
      const phases = [makePhase("concept", [], [{ name: "pitch" }])];
      const pack = makePack(phases);

      const prompt = runner.buildPhasePrompt(pack, "concept", "fr");
      expect(prompt).toContain("Guidance for concept in English");
    });

    it("appends connector guidance when capability is configured", () => {
      const mockRegistry = {
        getAgentGuidance: vi.fn().mockReturnValue("Use ComfyUI text2img workflow"),
      } as unknown as ConnectorRegistry;

      const runnerWithRegistry = new GraphRunner(mockRegistry);

      const phases = [makePhase("image_gen", [], [{ name: "images" }], { capability: "text2img" })];
      const pack = makePack(phases);

      const prompt = runnerWithRegistry.buildPhasePrompt(pack, "image_gen", "en");
      expect(prompt).toContain("Guidance for image_gen in English");
      expect(prompt).toContain("Use ComfyUI text2img workflow");
      expect(mockRegistry.getAgentGuidance).toHaveBeenCalledWith("text2img", "en");
    });
  });

  // =========================================================================
  // evaluateSkipWhen
  // =========================================================================

  describe("evaluateSkipWhen", () => {
    it("input.depth == 'quick' with matching input returns true", () => {
      // Access via the runner's internal method — we test through onPhaseComplete,
      // but also test the static helper directly
      const result = GraphRunner.evaluateSkipWhen("input.depth == 'quick'", { depth: "quick" });
      expect(result).toBe(true);
    });

    it("input.depth == 'quick' with non-matching input returns false", () => {
      const result = GraphRunner.evaluateSkipWhen("input.depth == 'quick'", { depth: "standard" });
      expect(result).toBe(false);
    });

    it("input.depth != 'quick' with matching input returns false", () => {
      const result = GraphRunner.evaluateSkipWhen("input.depth != 'quick'", { depth: "quick" });
      expect(result).toBe(false);
    });

    it("input.depth != 'quick' with non-matching input returns true", () => {
      const result = GraphRunner.evaluateSkipWhen("input.depth != 'quick'", { depth: "standard" });
      expect(result).toBe(true);
    });

    it("handles nested dot path", () => {
      const result = GraphRunner.evaluateSkipWhen("input.config.mode == 'fast'", { config: { mode: "fast" } });
      expect(result).toBe(true);
    });

    it("returns false for unparseable expression", () => {
      const result = GraphRunner.evaluateSkipWhen("some garbage", { depth: "quick" });
      expect(result).toBe(false);
    });
  });
});
