import { describe, it, expect, beforeEach } from "vitest";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";

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

interface MockTask {
  id: string;
  skipped_phases: string;
}

function createMockDb() {
  const subtasks: MockSubtask[] = [];
  const tasks: MockTask[] = [];

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
      }
    },
    get(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.includes("SKIPPED_PHASES") && trimmed.includes("TASKS")) {
        const taskId = params[0] as string;
        return tasks.find((t) => t.id === taskId);
      }
      if (trimmed.includes("SELECT") && trimmed.includes("SUBTASKS")) {
        const task_id = params[0] as string;
        const titlePattern = params[1] as string;
        const pattern = titlePattern.replace(/%/g, "").replace(/\\(.)/g, "$1");
        return subtasks.find((st) => st.task_id === task_id && st.title.includes(pattern));
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
    _tasks: tasks,
    addTask(id: string, skippedPhases: string[]) {
      tasks.push({ id, skipped_phases: JSON.stringify(skippedPhases) });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhase(id: string, inputs: { name: string; from: string }[] = [], outputs: { name: string }[] = []): Phase {
  return {
    id,
    department: "test",
    guidance: `guidance/{lang}/${id}.md`,
    capability_mode: "hybrid" as const,
    gate: "auto" as const,
    inputs,
    outputs: outputs.map((o) => ({ ...o, type: "markdown" as const, path: `output/${o.name}.md` })),
  };
}

function makeTestPack(): LoadedPack {
  const phases = [
    makePhase("analysis", [], [{ name: "plan" }]),
    makePhase("implementation", [{ name: "plan", from: "analysis.plan" }], [{ name: "code" }]),
    makePhase("review", [{ name: "code", from: "implementation.code" }]),
  ];

  const graph = buildGraph("test_pack", phases);
  const guidanceCache = new Map<string, string>();

  const definition: PackDefinition = {
    pack: {
      key: "test_pack",
      name: { en: "Test Pack" },
      version: "1.0.0",
      schema_version: 1,
      agent_routing: "single" as const,
      description: { en: "A test pack" },
    },
    input: { required: [], optional: [] },
    phases,
  };

  return { key: "test_pack", source: "built-in", definition, graph, guidanceCache, sharedGuidanceCache: new Map() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphRunner.seedSubtasks with skipped_phases", () => {
  let db: ReturnType<typeof createMockDb>;
  let runner: GraphRunner;

  beforeEach(() => {
    db = createMockDb();
    runner = new GraphRunner();
  });

  it("seeds all phases as normal when no phases are skipped", async () => {
    db.addTask("task-1", []);
    await runner.seedSubtasks(db, "task-1", makeTestPack(), { project: "test" });

    const subtasks = db._subtasks.filter(
      (s) => s.task_id === "task-1" && s.title.startsWith("[pipeline:") && s.title !== "[pipeline:__input__]",
    );
    expect(subtasks).toHaveLength(3);
    expect(subtasks.find((s) => s.title === "[pipeline:analysis]")?.status).toBe("pending");
    expect(subtasks.find((s) => s.title === "[pipeline:implementation]")?.status).toBe("blocked");
    expect(subtasks.find((s) => s.title === "[pipeline:review]")?.status).toBe("blocked");
  });

  it("marks skipped phases with status 'skipped'", async () => {
    db.addTask("task-2", ["implementation"]);
    await runner.seedSubtasks(db, "task-2", makeTestPack(), { project: "test" });

    const subtasks = db._subtasks.filter(
      (s) => s.task_id === "task-2" && s.title.startsWith("[pipeline:") && s.title !== "[pipeline:__input__]",
    );
    expect(subtasks.find((s) => s.title === "[pipeline:implementation]")?.status).toBe("skipped");
  });

  it("unblocks downstream of skipped phase", async () => {
    db.addTask("task-3", ["implementation"]);
    await runner.seedSubtasks(db, "task-3", makeTestPack(), { project: "test" });

    const subtasks = db._subtasks.filter(
      (s) => s.task_id === "task-3" && s.title.startsWith("[pipeline:") && s.title !== "[pipeline:__input__]",
    );
    const review = subtasks.find((s) => s.title === "[pipeline:review]");
    // review depends only on implementation which is skipped, so it should be pending
    expect(review?.status).toBe("pending");
  });

  it("keeps downstream blocked when only some deps are skipped", async () => {
    // Create a pack where review depends on both implementation AND analysis
    const phases = [
      makePhase("analysis", [], [{ name: "plan" }]),
      makePhase("implementation", [{ name: "plan", from: "analysis.plan" }], [{ name: "code" }]),
      makePhase("review", [
        { name: "code", from: "implementation.code" },
        { name: "plan", from: "analysis.plan" },
      ]),
    ];
    const graph = buildGraph("test_pack_multi", phases);
    const definition: PackDefinition = {
      pack: {
        key: "test_pack_multi",
        name: { en: "Test Pack Multi" },
        version: "1.0.0",
        schema_version: 1,
        agent_routing: "single" as const,
        description: { en: "A test pack with multiple deps" },
      },
      input: { required: [], optional: [] },
      phases,
    };
    const pack: LoadedPack = {
      key: "test_pack_multi",
      source: "built-in",
      definition,
      graph,
      guidanceCache: new Map(),
      sharedGuidanceCache: new Map(),
    };

    // Skip only implementation — analysis is NOT skipped, so review should stay blocked
    db.addTask("task-4", ["implementation"]);
    await runner.seedSubtasks(db, "task-4", pack, { project: "test" });

    const subtasks = db._subtasks.filter(
      (s) => s.task_id === "task-4" && s.title.startsWith("[pipeline:") && s.title !== "[pipeline:__input__]",
    );
    const review = subtasks.find((s) => s.title === "[pipeline:review]");
    expect(review?.status).toBe("blocked");
  });

  it("does not skip root phases even when not in skipped set", async () => {
    db.addTask("task-5", ["review"]);
    await runner.seedSubtasks(db, "task-5", makeTestPack(), { project: "test" });

    const subtasks = db._subtasks.filter(
      (s) => s.task_id === "task-5" && s.title.startsWith("[pipeline:") && s.title !== "[pipeline:__input__]",
    );
    expect(subtasks.find((s) => s.title === "[pipeline:analysis]")?.status).toBe("pending");
    expect(subtasks.find((s) => s.title === "[pipeline:implementation]")?.status).toBe("blocked");
    expect(subtasks.find((s) => s.title === "[pipeline:review]")?.status).toBe("skipped");
  });
});
