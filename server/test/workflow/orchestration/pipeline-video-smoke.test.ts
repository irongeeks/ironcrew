import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PackLoader } from "../../../packs/pack-loader.ts";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    _taskMeta: taskMeta,
  };
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const BUILT_IN_DIR = path.resolve(__dirname, "../../../packs/built-in");

async function loadVideoPack(): Promise<LoadedPack> {
  const loader = new PackLoader();
  return loader.loadPack(path.join(BUILT_IN_DIR, "video-preprod"), "built-in");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Video Pipeline smoke tests (video_preprod)", () => {
  let runner: GraphRunner;
  let db: ReturnType<typeof createMockDb>;
  let pack: LoadedPack;

  beforeEach(async () => {
    runner = new GraphRunner();
    db = createMockDb();
    pack = await loadVideoPack();
  });

  // =========================================================================
  // 1. Pack loading and seeding
  // =========================================================================

  it("pack key is video_preprod and has 7 phases", () => {
    expect(pack.key).toBe("video_preprod");
    expect(pack.graph.phases).toHaveLength(7);
  });

  it("phases have expected IDs in topological order", () => {
    const phaseIds = pack.graph.phases.map((p) => p.id);
    expect(phaseIds).toContain("concept");
    expect(phaseIds).toContain("screenplay");
    expect(phaseIds).toContain("image_generation");
    expect(phaseIds).toContain("image_review");
    expect(phaseIds).toContain("video_generation");
    expect(phaseIds).toContain("voice_prep");
    expect(phaseIds).toContain("assembly");
    // concept must come before screenplay
    expect(phaseIds.indexOf("concept")).toBeLessThan(phaseIds.indexOf("screenplay"));
    // screenplay must come before image_generation and voice_prep
    expect(phaseIds.indexOf("screenplay")).toBeLessThan(phaseIds.indexOf("image_generation"));
    expect(phaseIds.indexOf("screenplay")).toBeLessThan(phaseIds.indexOf("voice_prep"));
  });

  it("concept is the only root phase", () => {
    expect(pack.graph.roots).toEqual(["concept"]);
  });

  it("seedSubtasks creates 7 phase subtasks + 1 input meta subtask", async () => {
    await runner.seedSubtasks(db as never, "task-vid-1", pack, {
      topic: "AI revolution",
      platform: "YouTube",
      duration: "3 minutes",
    });

    // 7 phases + 1 __input__ metadata record
    expect(db._subtasks).toHaveLength(8);
  });

  it("after seeding: concept is pending, all others are blocked", async () => {
    await runner.seedSubtasks(db as never, "task-vid-2", pack, {
      topic: "AI revolution",
      platform: "YouTube",
      duration: "3 minutes",
    });

    const find = (title: string) => db._subtasks.find((s) => s.title === title);

    expect(find("[pipeline:concept]")?.status).toBe("pending");
    expect(find("[pipeline:screenplay]")?.status).toBe("blocked");
    expect(find("[pipeline:image_generation]")?.status).toBe("blocked");
    expect(find("[pipeline:image_review]")?.status).toBe("blocked");
    expect(find("[pipeline:video_generation]")?.status).toBe("blocked");
    expect(find("[pipeline:voice_prep]")?.status).toBe("blocked");
    expect(find("[pipeline:assembly]")?.status).toBe("blocked");
  });

  it("pack input (topic) is stored in the __input__ metadata subtask", async () => {
    await runner.seedSubtasks(db as never, "task-vid-3", pack, {
      topic: "Space exploration",
      platform: "TikTok",
      duration: "60 seconds",
    });

    // The concept phase has no 'from: input.*' inputs in pack.yaml, so pack input
    // is not injected into its description. Instead it is stored in the metadata subtask.
    const inputMeta = db._subtasks.find((s) => s.title === "[pipeline:__input__]");
    expect(inputMeta).toBeDefined();
    expect(inputMeta?.description).toContain("Space exploration");

    // concept's description is generic (no pack input injection for this phase)
    const concept = db._subtasks.find((s) => s.title === "[pipeline:concept]");
    expect(concept?.description).toContain("concept");
  });

  // =========================================================================
  // 2. Concept gate: user_approval behaviour
  // =========================================================================

  it("completing concept (no approval) sets awaiting_approval, does NOT unblock screenplay", async () => {
    await runner.seedSubtasks(db as never, "task-vid-4", pack, {
      topic: "AI",
      platform: "YouTube",
      duration: "2 min",
    });

    // Mark concept as done
    db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-vid-4", "concept", pack, "/tmp");

    expect(result.advanced).toBe(false);
    expect(result.nextPhases).toHaveLength(0);
    expect(result.taskDone).toBe(false);

    const concept = db._subtasks.find((s) => s.title === "[pipeline:concept]")!;
    expect(concept.status).toBe("awaiting_approval");

    const screenplay = db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!;
    expect(screenplay.status).toBe("blocked");
  });

  it("onPhaseComplete with approved:true unblocks screenplay after concept", async () => {
    await runner.seedSubtasks(db as never, "task-vid-5", pack, {
      topic: "AI",
      platform: "YouTube",
      duration: "2 min",
    });

    // concept is awaiting_approval already (as if gate fired previously)
    db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "awaiting_approval";

    // Simulate approval endpoint calling with approved: true
    // Note: the runner checks `done` or marks `awaiting_approval` only if status is `done` first
    // Let's set concept to done, then call with approved
    db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "done";

    const result = await runner.onPhaseComplete(db as never, "task-vid-5", "concept", pack, "/tmp", {
      approved: true,
    });

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("screenplay");

    const screenplay = db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!;
    expect(screenplay.status).toBe("pending");
  });

  // =========================================================================
  // 3. Screenplay → parallel branches (image_generation + voice_prep)
  // =========================================================================

  it("completing screenplay unblocks image_generation (fan-out placeholder) and voice_prep in parallel", async () => {
    await runner.seedSubtasks(db as never, "task-vid-6", pack, {
      topic: "AI",
      platform: "YouTube",
      duration: "2 min",
    });

    // Set upstream phases as done
    db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-vid-6", "concept", pack, "/tmp", { approved: true });

    db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!.status = "done";
    const result = await runner.onPhaseComplete(db as never, "task-vid-6", "screenplay", pack, "/tmp");

    expect(result.advanced).toBe(true);
    // Both image_generation and voice_prep should be in nextPhases
    expect(result.nextPhases).toContain("image_generation");
    expect(result.nextPhases).toContain("voice_prep");

    const voicePrep = db._subtasks.find((s) => s.title === "[pipeline:voice_prep]");
    expect(voicePrep?.status).toBe("pending");
  });

  it("voice_prep is independent of image_generation — completing image_generation does not affect voice_prep", async () => {
    await runner.seedSubtasks(db as never, "task-vid-7", pack, {
      topic: "AI",
      platform: "YouTube",
      duration: "2 min",
    });

    // Advance concept and screenplay
    db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-vid-7", "concept", pack, "/tmp", { approved: true });
    db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-vid-7", "screenplay", pack, "/tmp");

    // voice_prep should already be pending (unblocked by screenplay)
    const voicePrepBefore = db._subtasks.find((s) => s.title === "[pipeline:voice_prep]")!;
    expect(voicePrepBefore.status).toBe("pending");

    // Now complete image_generation (it's a fan-out, so there may be a placeholder or indexed subtasks)
    // Find all image_generation subtasks and mark them done
    const imageGenSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:image_generation"));
    for (const st of imageGenSubtasks) {
      st.status = "done";
    }
    await runner.onPhaseComplete(db as never, "task-vid-7", "image_generation", pack, "/tmp");

    // voice_prep status should be unaffected (still pending, not re-blocked)
    const voicePrepAfter = db._subtasks.find((s) => s.title === "[pipeline:voice_prep]")!;
    expect(voicePrepAfter.status).toBe("pending");
  });

  // =========================================================================
  // 4. Assembly requires both video_generation AND voice_prep
  // =========================================================================

  it("assembly stays blocked when voice_prep done but video_generation not done", async () => {
    await runner.seedSubtasks(db as never, "task-vid-8", pack, {
      topic: "AI",
      platform: "YouTube",
      duration: "2 min",
    });

    // Advance concept → screenplay
    db._subtasks.find((s) => s.title === "[pipeline:concept]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-vid-8", "concept", pack, "/tmp", { approved: true });
    db._subtasks.find((s) => s.title === "[pipeline:screenplay]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-vid-8", "screenplay", pack, "/tmp");

    // Complete voice_prep but NOT video_generation
    db._subtasks.find((s) => s.title === "[pipeline:voice_prep]")!.status = "done";
    const result = await runner.onPhaseComplete(db as never, "task-vid-8", "voice_prep", pack, "/tmp");

    // assembly should still be blocked (video_generation not done)
    const assembly = db._subtasks.find((s) => s.title === "[pipeline:assembly]")!;
    expect(assembly.status).toBe("blocked");
    expect(result.nextPhases).not.toContain("assembly");
  });

  // =========================================================================
  // 5. Guidance cache populated
  // =========================================================================

  it("guidance cache contains entries for all phase IDs", () => {
    const phaseIds = pack.graph.phases.map((p) => p.id);
    for (const phaseId of phaseIds) {
      // At least one language should have guidance
      const hasGuidance =
        pack.guidanceCache.has(`${phaseId}.en`) ||
        pack.guidanceCache.has(`${phaseId}.ko`) ||
        pack.guidanceCache.has(`${phaseId}.ja`);
      expect(hasGuidance, `Expected guidance cache entry for phase '${phaseId}'`).toBe(true);
    }
  });
});
