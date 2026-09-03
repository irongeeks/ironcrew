import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
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
  updated_at: number;
}

function createMockDb() {
  const subtasks: MockSubtask[] = [];
  const taskMeta: Record<string, string> = {};

  return {
    run(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim().toUpperCase();

      if (trimmed.startsWith("INSERT INTO SUBTASKS")) {
        const [id, task_id, title, description, status, created_at, updated_at] = params as [
          string,
          string,
          string,
          string,
          string,
          number,
          number,
        ];
        subtasks.push({ id, task_id, title, description, status, created_at, updated_at });
      } else if (trimmed.startsWith("UPDATE SUBTASKS SET STATUS")) {
        const [status, task_id, titlePattern] = params as [string, string, string];
        const pattern = (titlePattern as string).replace(/%/g, "").replace(/\\(.)/g, "$1");
        for (const st of subtasks) {
          if (st.task_id === task_id && st.title.includes(pattern)) {
            st.status = status;
          }
        }
      } else if (trimmed.startsWith("UPDATE SUBTASKS SET DESCRIPTION")) {
        const [description, _updated_at, id, task_id] = params as [string, number, string, string];
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
// Helpers
// ---------------------------------------------------------------------------

const BUILT_IN_DIR = path.resolve(__dirname, "../../../packs/built-in");

async function loadResearchPack(): Promise<LoadedPack> {
  const loader = new PackLoader();
  return loader.loadPack(path.join(BUILT_IN_DIR, "web-research"), "built-in");
}

/** Create a temp dir with a search_strategy.json that has N sub_questions. */
function makeTmpDirWithStrategy(subQuestionCount: number): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-smoke-"));
  const outputDir = path.join(tmpDir, "research_output");
  fs.mkdirSync(outputDir, { recursive: true });

  const strategy = {
    topic: "Test topic",
    sub_questions: Array.from({ length: subQuestionCount }, (_, i) => ({
      question: `Sub-question ${i + 1}`,
      keywords: ["keyword"],
      source_types: ["web"],
      priority: "high",
    })),
  };
  fs.writeFileSync(path.join(outputDir, "search_strategy.json"), JSON.stringify(strategy));
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Research Pipeline smoke tests (web_research_report)", () => {
  let runner: GraphRunner;
  let db: ReturnType<typeof createMockDb>;
  let pack: LoadedPack;

  beforeEach(async () => {
    runner = new GraphRunner();
    db = createMockDb();
    pack = await loadResearchPack();
  });

  // =========================================================================
  // 1. Pack loading
  // =========================================================================

  it("pack key is web_research_report and has 5 phases", () => {
    expect(pack.key).toBe("web_research_report");
    expect(pack.graph.phases).toHaveLength(5);
  });

  it("phases have expected IDs in topological order", () => {
    const phaseIds = pack.graph.phases.map((p) => p.id);
    expect(phaseIds).toContain("planning");
    expect(phaseIds).toContain("crawl");
    expect(phaseIds).toContain("synthesis");
    expect(phaseIds).toContain("fact_check");
    expect(phaseIds).toContain("final_report");

    // planning must come before crawl and synthesis
    expect(phaseIds.indexOf("planning")).toBeLessThan(phaseIds.indexOf("crawl"));
    expect(phaseIds.indexOf("crawl")).toBeLessThan(phaseIds.indexOf("synthesis"));
    expect(phaseIds.indexOf("synthesis")).toBeLessThan(phaseIds.indexOf("fact_check"));
    expect(phaseIds.indexOf("fact_check")).toBeLessThan(phaseIds.indexOf("final_report"));
  });

  it("planning is the only root phase", () => {
    expect(pack.graph.roots).toEqual(["planning"]);
  });

  it("final_report is the terminal phase", () => {
    expect(pack.graph.terminals).toContain("final_report");
  });

  // =========================================================================
  // 2. Seeding with standard depth
  // =========================================================================

  it("seedSubtasks with standard depth: planning=pending, rest=blocked", async () => {
    await runner.seedSubtasks(db as never, "task-res-1", pack, {
      topic: "AI in healthcare",
      time_range: "2024",
      depth: "standard",
    });

    const find = (title: string) => db._subtasks.find((s) => s.title === title);

    expect(find("[pipeline:planning]")?.status).toBe("pending");
    expect(find("[pipeline:crawl]")?.status).toBe("blocked");
    expect(find("[pipeline:synthesis]")?.status).toBe("blocked");
    expect(find("[pipeline:fact_check]")?.status).toBe("blocked");
    expect(find("[pipeline:final_report]")?.status).toBe("blocked");
  });

  it("seedSubtasks creates 5 phase subtasks + 1 input meta subtask", async () => {
    await runner.seedSubtasks(db as never, "task-res-2", pack, {
      topic: "Climate change",
      time_range: "2024",
      depth: "standard",
    });

    // 5 phases + 1 __input__ metadata record
    expect(db._subtasks).toHaveLength(6);
  });

  // =========================================================================
  // 3. Planning → fan-out crawl (standard depth = 3 crawlers)
  // =========================================================================

  it("completing planning with 3 sub_questions creates 3 crawl subtasks (fan-out)", async () => {
    const tmpDir = makeTmpDirWithStrategy(3);

    try {
      await runner.seedSubtasks(db as never, "task-res-3", pack, {
        topic: "AI in healthcare",
        time_range: "2024",
        depth: "standard",
      });

      db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";
      const result = await runner.onPhaseComplete(db as never, "task-res-3", "planning", pack, tmpDir);

      expect(result.advanced).toBe(true);
      expect(result.nextPhases).toContain("crawl");

      // Fan-out should create crawl subtasks (placeholder + 2 more = 3 total)
      const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
      expect(crawlSubtasks.length).toBe(3);

      // All crawl subtasks should be pending
      for (const st of crawlSubtasks) {
        expect(st.status).toBe("pending");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("completing only crawl:0 and crawl:1 (of 3) keeps synthesis blocked (fan-in)", async () => {
    const tmpDir = makeTmpDirWithStrategy(3);

    try {
      await runner.seedSubtasks(db as never, "task-res-4", pack, {
        topic: "AI in healthcare",
        time_range: "2024",
        depth: "standard",
      });

      // Advance planning to seed the 3 crawl subtasks
      db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";
      await runner.onPhaseComplete(db as never, "task-res-4", "planning", pack, tmpDir);

      // Verify 3 crawl subtasks exist
      const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
      expect(crawlSubtasks.length).toBe(3);

      // Complete crawl:0 and crawl:1, but not the third
      crawlSubtasks[0].status = "done";
      const r0 = await runner.onPhaseComplete(db as never, "task-res-4", "crawl", pack, tmpDir);
      // synthesis should still be blocked
      const synthAfter0 = db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!;
      expect(synthAfter0.status).toBe("blocked");
      expect(r0.nextPhases).not.toContain("synthesis");

      crawlSubtasks[1].status = "done";
      const r1 = await runner.onPhaseComplete(db as never, "task-res-4", "crawl", pack, tmpDir);
      // synthesis should still be blocked (one crawl remaining)
      const synthAfter1 = db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!;
      expect(synthAfter1.status).toBe("blocked");
      expect(r1.nextPhases).not.toContain("synthesis");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("completing all 3 crawl subtasks unblocks synthesis (fan-in gate)", async () => {
    const tmpDir = makeTmpDirWithStrategy(3);

    try {
      await runner.seedSubtasks(db as never, "task-res-5", pack, {
        topic: "AI in healthcare",
        time_range: "2024",
        depth: "standard",
      });

      // Advance planning
      db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";
      await runner.onPhaseComplete(db as never, "task-res-5", "planning", pack, tmpDir);

      const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
      expect(crawlSubtasks.length).toBe(3);

      // Complete crawl:0 and crawl:1 first
      crawlSubtasks[0].status = "done";
      await runner.onPhaseComplete(db as never, "task-res-5", "crawl", pack, tmpDir);
      crawlSubtasks[1].status = "done";
      await runner.onPhaseComplete(db as never, "task-res-5", "crawl", pack, tmpDir);

      // synthesis still blocked
      expect(db._subtasks.find((s) => s.title === "[pipeline:synthesis]")?.status).toBe("blocked");

      // Complete the last crawl → synthesis unblocks
      crawlSubtasks[2].status = "done";
      const result = await runner.onPhaseComplete(db as never, "task-res-5", "crawl", pack, tmpDir);

      expect(result.advanced).toBe(true);
      expect(result.nextPhases).toContain("synthesis");

      const synthesis = db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!;
      expect(synthesis.status).toBe("pending");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 4. Quick depth: fact_check skipped
  // =========================================================================

  it("quick depth seeds all phases; after synthesis completes, fact_check is skipped and final_report unblocks", async () => {
    await runner.seedSubtasks(db as never, "task-res-6", pack, {
      topic: "Brief research",
      time_range: "2024",
      depth: "quick",
    });

    // Advance through planning → crawl (single, quick depth still runs crawl unless depth=='none')
    db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-res-6", "planning", pack, "/tmp");

    // Mark crawl subtask(s) done
    const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
    for (const st of crawlSubtasks) {
      st.status = "done";
    }
    await runner.onPhaseComplete(db as never, "task-res-6", "crawl", pack, "/tmp");

    // synthesis should now be pending
    const synthesis = db._subtasks.find((s) => s.title === "[pipeline:synthesis]");
    expect(synthesis?.status).toBe("pending");

    // Complete synthesis → fact_check should be SKIPPED (depth == 'quick'), final_report unblocks
    db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!.status = "done";
    const result = await runner.onPhaseComplete(db as never, "task-res-6", "synthesis", pack, "/tmp");

    const factCheck = db._subtasks.find((s) => s.title === "[pipeline:fact_check]")!;
    expect(factCheck.status).toBe("skipped");

    const finalReport = db._subtasks.find((s) => s.title === "[pipeline:final_report]")!;
    expect(finalReport.status).toBe("pending");

    expect(result.advanced).toBe(true);
    expect(result.nextPhases).toContain("final_report");
  });

  it("standard depth: fact_check is NOT skipped", async () => {
    await runner.seedSubtasks(db as never, "task-res-7", pack, {
      topic: "Thorough research",
      time_range: "2024",
      depth: "standard",
    });

    // Advance through planning
    db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-res-7", "planning", pack, "/tmp");

    // Mark all crawl subtasks done
    const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
    for (const st of crawlSubtasks) {
      st.status = "done";
    }
    await runner.onPhaseComplete(db as never, "task-res-7", "crawl", pack, "/tmp");

    // Complete synthesis
    db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!.status = "done";
    const result = await runner.onPhaseComplete(db as never, "task-res-7", "synthesis", pack, "/tmp");

    // fact_check should be pending (not skipped)
    const factCheck = db._subtasks.find((s) => s.title === "[pipeline:fact_check]")!;
    expect(factCheck.status).toBe("pending");
    expect(result.nextPhases).toContain("fact_check");

    // final_report should still be blocked
    const finalReport = db._subtasks.find((s) => s.title === "[pipeline:final_report]")!;
    expect(finalReport.status).toBe("blocked");
  });

  // =========================================================================
  // 5. Full pipeline completion (taskDone)
  // =========================================================================

  it("completing final_report returns taskDone: true", async () => {
    await runner.seedSubtasks(db as never, "task-res-8", pack, {
      topic: "Final test",
      time_range: "2024",
      depth: "quick",
    });

    // Advance through all phases quickly
    db._subtasks.find((s) => s.title === "[pipeline:planning]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-res-8", "planning", pack, "/tmp");

    const crawlSubtasks = db._subtasks.filter((s) => s.title.includes("[pipeline:crawl"));
    for (const st of crawlSubtasks) {
      st.status = "done";
    }
    await runner.onPhaseComplete(db as never, "task-res-8", "crawl", pack, "/tmp");

    db._subtasks.find((s) => s.title === "[pipeline:synthesis]")!.status = "done";
    await runner.onPhaseComplete(db as never, "task-res-8", "synthesis", pack, "/tmp");

    // fact_check is skipped for quick depth
    db._subtasks.find((s) => s.title === "[pipeline:final_report]")!.status = "done";
    const result = await runner.onPhaseComplete(db as never, "task-res-8", "final_report", pack, "/tmp");

    expect(result.taskDone).toBe(true);
  });

  // =========================================================================
  // 6. Guidance cache populated
  // =========================================================================

  it("guidance cache contains entries for all phase IDs", () => {
    const phaseIds = pack.graph.phases.map((p) => p.id);
    for (const phaseId of phaseIds) {
      const hasGuidance =
        pack.guidanceCache.has(`${phaseId}.en`) ||
        pack.guidanceCache.has(`${phaseId}.ko`) ||
        pack.guidanceCache.has(`${phaseId}.ja`);
      expect(hasGuidance, `Expected guidance cache entry for phase '${phaseId}'`).toBe(true);
    }
  });
});
