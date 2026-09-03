import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";

// ---------------------------------------------------------------------------
// Mock DB (mirrors pattern from graph-runner.test.ts)
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
  outputs: { name: string; path?: string }[] = [],
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
      type: "json" as const,
      path: o.path ?? `output/${o.name}.json`,
    })),
    ...overrides,
  };
}

function makePack(phases: Phase[], key = "test_pack"): LoadedPack {
  const graph = buildGraph(key, phases);
  const guidanceCache = new Map<string, string>();
  for (const phase of phases) {
    guidanceCache.set(`${phase.id}.en`, `Guidance for ${phase.id} in English`);
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
// Shared pack builder for review-fail tests
//
// Pack structure:
//   image_gen → image_review (on_review_fail → rerun: image_gen) → video_gen
//
// The flag output path is relative (resolved against rootDir by the runner).
// ---------------------------------------------------------------------------

function makeReviewFailPack(flagRelPath: string, maxPasses = 2): LoadedPack {
  const phases = [
    makePhase("image_gen", [], [{ name: "images", path: "output/images.json" }]),
    makePhase(
      "image_review",
      [{ name: "images", from: "image_gen.images" }],
      [{ name: "regen_flags", path: flagRelPath }],
      {
        on_review_fail: {
          rerun: "image_gen",
          max_passes: maxPasses,
          flag_output: "regen_flags",
        },
      },
    ),
    makePhase("video_gen", [{ name: "regen_flags", from: "image_review.regen_flags" }], []),
  ];
  return makePack(phases);
}

/** Seed DB with pre-review state: image_gen=done, image_review=done, video_gen=blocked */
function seedReviewState(db: ReturnType<typeof createMockDb>, taskId: string) {
  const now = Date.now();
  db._subtasks.push(
    {
      id: "st-image-gen",
      task_id: taskId,
      title: "[pipeline:image_gen]",
      description: "",
      status: "done",
      created_at: now,
    },
    {
      id: "st-image-review",
      task_id: taskId,
      title: "[pipeline:image_review]",
      description: "",
      status: "done",
      created_at: now,
    },
    {
      id: "st-video-gen",
      task_id: taskId,
      title: "[pipeline:video_gen]",
      description: "",
      status: "blocked",
      created_at: now,
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphRunner – checkReviewFail", () => {
  let runner: GraphRunner;
  let tmpDir: string;

  beforeEach(() => {
    runner = new GraphRunner();
    tmpDir = mkdtempSync(join(tmpdir(), "gr-review-fail-"));
    mkdirSync(join(tmpDir, "output"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // =========================================================================
  // 1. Flag file contains failures → should re-run
  // =========================================================================

  it("returns true (re-run needed) when flag file contains failure entries", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ scene: 1, reason: "blurry" }]));

    const db = createMockDb();
    const taskId = "task-review-1";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    // checkReviewFail returns true → onPhaseComplete returns { advanced: false }
    expect(result.advanced).toBe(false);
    expect(result.taskDone).toBe(false);

    // image_gen must have been re-activated
    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("pending");

    // image_review must be reset to blocked so it re-runs after image_gen completes
    const imageReview = db._subtasks.find((s) => s.title === "[pipeline:image_review]")!;
    expect(imageReview.status).toBe("blocked");

    // video_gen must remain blocked
    const videoGen = db._subtasks.find((s) => s.title === "[pipeline:video_gen]")!;
    expect(videoGen.status).toBe("blocked");
  });

  // =========================================================================
  // 2. Flag file is an empty array → no failures → should advance
  // =========================================================================

  it("returns false (no re-run) when flag file is an empty array", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([]));

    const db = createMockDb();
    const taskId = "task-review-2";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    // Pipeline should advance to video_gen
    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("video_gen");

    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("done"); // not re-activated
  });

  // =========================================================================
  // 3. Flag file does not exist → treat as no failures → should advance
  // =========================================================================

  it("returns false (no re-run) when flag file is missing", async () => {
    // Deliberately do NOT create the flag file
    const flagPath = "output/regen_flags.json";

    const db = createMockDb();
    const taskId = "task-review-3";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    // Missing file → catch block → no failures → advance
    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("video_gen");
  });

  // =========================================================================
  // 4. max_passes enforcement
  // =========================================================================

  it("re-runs when regen_count (0) < max_passes (2)", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ scene: 1, reason: "blurry" }]));

    // No prior meta → regen_count_image_review = 0
    const db = createMockDb();
    const taskId = "task-maxpasses-1";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath, 2);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    expect(result.advanced).toBe(false);
    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("pending");
  });

  it("re-runs when regen_count (1) < max_passes (2)", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ scene: 2, reason: "too dark" }]));

    // Simulate one prior regen already recorded
    const taskId = "task-maxpasses-2";
    const existingMeta = JSON.stringify({ regen_count_image_review: 1 });
    const db = createMockDb({ [taskId]: existingMeta });
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath, 2);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    expect(result.advanced).toBe(false);
    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("pending");
  });

  it("does NOT re-run when regen_count (2) >= max_passes (2) → pipeline advances", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ scene: 3, reason: "still blurry" }]));

    // Simulate two prior regens — max_passes reached
    const taskId = "task-maxpasses-3";
    const existingMeta = JSON.stringify({ regen_count_image_review: 2 });
    const db = createMockDb({ [taskId]: existingMeta });
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath, 2);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    // Max passes exceeded → pipeline advances despite failures flag
    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("video_gen");

    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("done"); // not re-activated
  });

  // =========================================================================
  // 5. Regen counter tracking — workflow_meta_json updated correctly
  // =========================================================================

  it("increments regen_count from 0 to 1 in workflow_meta_json after first re-run", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ scene: 1, reason: "blurry" }]));

    const db = createMockDb();
    const taskId = "task-counter-1";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath, 3);
    await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    expect(db._metaUpdates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = db._metaUpdates[db._metaUpdates.length - 1];
    expect(lastUpdate.taskId).toBe(taskId);
    const meta = JSON.parse(lastUpdate.metaJson) as Record<string, unknown>;
    expect(meta.regen_count_image_review).toBe(1);
  });

  it("increments regen_count from existing value (1 → 2)", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ scene: 1, reason: "blurry" }]));

    const taskId = "task-counter-2";
    const existingMeta = JSON.stringify({ regen_count_image_review: 1 });
    const db = createMockDb({ [taskId]: existingMeta });
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath, 5);
    await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    const lastUpdate = db._metaUpdates[db._metaUpdates.length - 1];
    const meta = JSON.parse(lastUpdate.metaJson) as Record<string, unknown>;
    expect(meta.regen_count_image_review).toBe(2);
  });

  it("does NOT update workflow_meta_json when max_passes is already reached", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify([{ scene: 1, reason: "blurry" }]));

    const taskId = "task-counter-3";
    const existingMeta = JSON.stringify({ regen_count_image_review: 2 });
    const db = createMockDb({ [taskId]: existingMeta });
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath, 2);
    await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    // No meta update should occur when max_passes already exceeded
    expect(db._metaUpdates).toHaveLength(0);
  });

  // =========================================================================
  // 6. Invalid JSON in flag file → treat as no failures → should advance
  // =========================================================================

  it("returns false (no re-run) when flag file contains invalid JSON", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), "this is { not valid json }!!!");

    const db = createMockDb();
    const taskId = "task-invalid-json";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    // Invalid JSON → catch block → no failures → advance
    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("video_gen");

    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("done"); // not re-activated
  });

  // =========================================================================
  // Bonus: object-shaped flag output variants
  // =========================================================================

  it("detects failures when flag file is an object with non-empty failures array", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify({ failures: [{ scene: 1, reason: "blurry" }] }));

    const db = createMockDb();
    const taskId = "task-obj-failures";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    expect(result.advanced).toBe(false);
    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("pending");
  });

  it("detects failures when flag file is an object with regen_needed: true", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify({ regen_needed: true }));

    const db = createMockDb();
    const taskId = "task-obj-regen";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    expect(result.advanced).toBe(false);
    const imageGen = db._subtasks.find((s) => s.title === "[pipeline:image_gen]")!;
    expect(imageGen.status).toBe("pending");
  });

  it("no re-run when flag file is an object with empty failures array", async () => {
    const flagPath = "output/regen_flags.json";
    writeFileSync(join(tmpDir, flagPath), JSON.stringify({ failures: [] }));

    const db = createMockDb();
    const taskId = "task-obj-empty";
    seedReviewState(db, taskId);

    const pack = makeReviewFailPack(flagPath);
    const result = await runner.onPhaseComplete(db as never, taskId, "image_review", pack, tmpDir);

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("video_gen");
  });
});
