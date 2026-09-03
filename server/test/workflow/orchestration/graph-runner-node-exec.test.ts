import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import { NodeTypeRegistry } from "../../../node-types/node-type-registry.ts";
import type {
  NodeTypeDefinition,
  NodeExecuteContext,
  NodeExecuteResult,
} from "../../../node-types/node-type-interface.ts";
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
  completed_at?: number;
  created_at: number;
}

function createMockDb() {
  const subtasks: MockSubtask[] = [];

  return {
    run(sql: string, ...params: unknown[]) {
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
        // Two-arg form: (status, task_id, title) — supports LIKE patterns (trailing %)
        const [status, task_id, title] = params as [string, string, string];
        const isLike = upper.includes("LIKE");
        const titleMatch = isLike ? title.replace(/%+$/, "") : title;
        for (const st of subtasks) {
          const matches = isLike ? st.title.startsWith(titleMatch) : st.title === titleMatch;
          if (st.task_id === task_id && matches) {
            st.status = status;
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

      // Filter by LIKE title pattern if provided
      if (params.length > 1) {
        const titlePattern = params[1] as string;
        const cleanPattern = titlePattern.replace(/%/g, "").replace(/\\/g, "");
        results = results.filter((st) => st.title.includes(cleanPattern));
      }

      // Filter by status = 'pending' when the SQL contains that literal
      if (upper.includes("AND STATUS = 'PENDING'")) {
        results = results.filter((st) => st.status === "pending");
      }

      return results;
    },

    exec(_sql: string) {
      // no-op — transaction support not needed in tests
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
    guidance: `guidance/${id}.{lang}.md`,
    capability_mode: "hybrid" as const,
    gate: "auto" as const,
    inputs,
    outputs: outputs.map((o) => ({
      name: o.name,
      type: (o.type ?? "markdown") as "markdown",
      path: o.path ?? `output/${o.name}.md`,
    })),
    ...overrides,
  };
}

function makePack(phases: Phase[], key = "test_pack"): LoadedPack {
  const graph = buildGraph(key, phases);
  const definition: PackDefinition = {
    pack: {
      key,
      name: { en: "Test Pack" },
      version: "1.0.0",
      schema_version: 1,
      agent_routing: "single" as const,
      description: { en: "Test" },
    },
    input: { required: [], optional: [] },
    phases,
  };
  return { key, source: "built-in", definition, graph, guidanceCache: new Map(), sharedGuidanceCache: new Map() };
}

function makeNodeTypeDef(
  key: string,
  executeFn: (ctx: NodeExecuteContext) => Promise<NodeExecuteResult>,
): NodeTypeDefinition {
  return {
    key,
    meta: { label: key, description: "test", icon: "🔧", color: "#aaa", category: "custom" },
    configSchema: [],
    inputs: [],
    outputs: [],
    execute: executeFn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("graph-runner node-type execution", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createMockDb>;
  let registry: NodeTypeRegistry;
  let runner: GraphRunner;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gr-node-test-"));
    db = createMockDb();
    registry = new NodeTypeRegistry();
    runner = new GraphRunner(undefined, undefined, undefined, registry);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Issue 1: output persistence ───────────────────────────────────────────

  describe("Issue 1 – outputs are written to declared artifact paths", () => {
    it("writes string output to the declared path on success", async () => {
      const phase = makePhase("gen", [], [{ name: "report", path: "out/report.md" }], {
        node_type: "test_writer",
      });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("test_writer", async () => ({
          status: "success",
          outputs: { report: "# Hello world" },
        })),
      );

      await runner.seedSubtasks(db, "t1", pack, {});
      const { dispatched } = await runner.dispatchAutoPhases(db, "t1", pack, tmpDir);

      expect(dispatched).toContain("gen");
      const writtenPath = join(tmpDir, "out/report.md");
      expect(existsSync(writtenPath)).toBe(true);
      expect(readFileSync(writtenPath, "utf-8")).toBe("# Hello world");
    });

    it("JSON-serialises non-string output values", async () => {
      const phase = makePhase("gen", [], [{ name: "data", path: "out/data.json", type: "json" }], {
        node_type: "test_json_writer",
      });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("test_json_writer", async () => ({
          status: "success",
          outputs: { data: { items: [1, 2, 3] } },
        })),
      );

      await runner.seedSubtasks(db, "t2", pack, {});
      await runner.dispatchAutoPhases(db, "t2", pack, tmpDir);

      const written = JSON.parse(readFileSync(join(tmpDir, "out/data.json"), "utf-8"));
      expect(written).toEqual({ items: [1, 2, 3] });
    });

    it("marks subtask done after writing outputs", async () => {
      const phase = makePhase("gen", [], [{ name: "result", path: "out/r.md" }], {
        node_type: "test_done",
      });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("test_done", async () => ({
          status: "success",
          outputs: { result: "done" },
        })),
      );

      await runner.seedSubtasks(db, "t3", pack, {});
      await runner.dispatchAutoPhases(db, "t3", pack, tmpDir);

      const st = db._subtasks.find((s) => s.task_id === "t3" && s.title === "[pipeline:gen]");
      expect(st?.status).toBe("done");
      expect(st?.completed_at).toBeGreaterThan(0);
    });

    it("does not write output files when status is error", async () => {
      const phase = makePhase("gen", [], [{ name: "result", path: "out/r.md" }], {
        node_type: "test_err",
      });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("test_err", async () => ({
          status: "error",
          outputs: {},
          error: "something went wrong",
        })),
      );

      await runner.seedSubtasks(db, "t4", pack, {});
      await runner.dispatchAutoPhases(db, "t4", pack, tmpDir);

      expect(existsSync(join(tmpDir, "out/r.md"))).toBe(false);
    });
  });

  // ── Issue 2: root node_type phase auto-dispatch ───────────────────────────

  describe("Issue 2 – root node_type phases are auto-dispatched", () => {
    it("dispatches a root phase with node_type without needing an agent", async () => {
      const phase = makePhase("root", [], [{ name: "out", path: "out.md" }], {
        node_type: "echo_node",
      });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("echo_node", async () => ({
          status: "success",
          outputs: { out: "echo" },
        })),
      );

      await runner.seedSubtasks(db, "t5", pack, {});

      // Before dispatch, root phase is pending
      const before = db._subtasks.find((s) => s.task_id === "t5" && s.title === "[pipeline:root]");
      expect(before?.status).toBe("pending");

      const { dispatched } = await runner.dispatchAutoPhases(db, "t5", pack, tmpDir);

      expect(dispatched).toEqual(["root"]);
      const after = db._subtasks.find((s) => s.task_id === "t5" && s.title === "[pipeline:root]");
      expect(after?.status).toBe("done");
    });

    it("auto-dispatches a chain of node_type phases in one call", async () => {
      const phaseA = makePhase("step_a", [], [{ name: "val", path: "a.md" }], { node_type: "producer" });
      const phaseB = makePhase("step_b", [{ name: "val", from: "step_a.val" }], [{ name: "out", path: "b.md" }], {
        node_type: "consumer",
      });
      const pack = makePack([phaseA, phaseB]);

      // Write the artifact that phaseB will try to read (produced by phaseA at runtime)
      // — the node's execute fn produces outputs which get written to disk, so phaseB
      // can read them when it runs.
      registry.register(
        makeNodeTypeDef("producer", async () => ({
          status: "success",
          outputs: { val: "produced" },
        })),
      );

      let receivedInput: unknown;
      registry.register(
        makeNodeTypeDef("consumer", async (ctx) => {
          receivedInput = ctx.inputs["val"];
          return { status: "success", outputs: { out: "consumed" } };
        }),
      );

      await runner.seedSubtasks(db, "t6", pack, {});
      const { dispatched } = await runner.dispatchAutoPhases(db, "t6", pack, tmpDir);

      // step_a is dispatched directly; step_b is dispatched recursively through
      // _onPhaseComplete, so only step_a appears in the dispatchAutoPhases return value.
      expect(dispatched).toContain("step_a");
      // Both phases must be done
      const stA = db._subtasks.find((s) => s.task_id === "t6" && s.title === "[pipeline:step_a]");
      const stB = db._subtasks.find((s) => s.task_id === "t6" && s.title === "[pipeline:step_b]");
      expect(stA?.status).toBe("done");
      expect(stB?.status).toBe("done");
      // phaseB received the value that phaseA wrote to disk
      expect(receivedInput).toBe("produced");
    });

    it("does not dispatch agent phases (no node_type) via dispatchAutoPhases", async () => {
      const agentPhase = makePhase("agent_work", [], []);
      const pack = makePack([agentPhase]);

      await runner.seedSubtasks(db, "t7", pack, {});
      const { dispatched } = await runner.dispatchAutoPhases(db, "t7", pack, tmpDir);

      expect(dispatched).toHaveLength(0);
      const st = db._subtasks.find((s) => s.task_id === "t7" && s.title === "[pipeline:agent_work]");
      expect(st?.status).toBe("pending");
    });

    it("stops chain dispatch when a phase has awaiting_approval status", async () => {
      const phaseA = makePhase("gate", [], [{ name: "val", path: "gate.md" }], { node_type: "gated_node" });
      const phaseB = makePhase("after_gate", [{ name: "val", from: "gate.val" }], [], { node_type: "after_node" });
      const pack = makePack([phaseA, phaseB]);

      registry.register(
        makeNodeTypeDef("gated_node", async () => ({
          status: "awaiting_approval",
          outputs: {},
        })),
      );
      const afterExecuted: boolean[] = [];
      registry.register(
        makeNodeTypeDef("after_node", async () => {
          afterExecuted.push(true);
          return { status: "success", outputs: {} };
        }),
      );

      await runner.seedSubtasks(db, "t8", pack, {});
      const { dispatched } = await runner.dispatchAutoPhases(db, "t8", pack, tmpDir);

      expect(dispatched).toHaveLength(0);
      expect(afterExecuted).toHaveLength(0);
      const gateSt = db._subtasks.find((s) => s.task_id === "t8" && s.title === "[pipeline:gate]");
      expect(gateSt?.status).toBe("awaiting_approval");
    });

    it("persists outputs to disk even when status is awaiting_approval", async () => {
      const phase = makePhase(
        "review_gate",
        [],
        [
          { name: "plan", path: "review/plan.json", type: "json" },
          { name: "summary", path: "review/summary.md" },
        ],
        { node_type: "approval_writer" },
      );
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("approval_writer", async () => ({
          status: "awaiting_approval",
          outputs: {
            plan: { items: [{ title: "Task A" }, { title: "Task B" }] },
            summary: "# Review\n\n2 items require approval.",
          },
        })),
      );

      await runner.seedSubtasks(db, "t_approval", pack, {});
      await runner.dispatchAutoPhases(db, "t_approval", pack, tmpDir);

      // Subtask must be awaiting_approval
      const st = db._subtasks.find((s) => s.task_id === "t_approval" && s.title === "[pipeline:review_gate]");
      expect(st?.status).toBe("awaiting_approval");

      // Output files must exist on disk so the UI can display them
      const planPath = join(tmpDir, "review/plan.json");
      expect(existsSync(planPath)).toBe(true);
      const planContent = JSON.parse(readFileSync(planPath, "utf-8"));
      expect(planContent.items).toHaveLength(2);
      expect(planContent.items[0].title).toBe("Task A");

      const summaryPath = join(tmpDir, "review/summary.md");
      expect(existsSync(summaryPath)).toBe(true);
      expect(readFileSync(summaryPath, "utf-8")).toContain("2 items require approval");
    });
  });

  // ── Issue 3: input resolution uses all ref forms ──────────────────────────

  describe("Issue 3 – node inputs support all from: forms", () => {
    it("resolves a direct from: reference from a prior phase artifact", async () => {
      const phaseA = makePhase("writer", [], [{ name: "doc", path: "a/doc.md" }], { node_type: "write_phase" });
      const phaseB = makePhase("reader", [{ name: "content", from: "writer.doc" }], [], { node_type: "read_phase" });
      const pack = makePack([phaseA, phaseB]);

      registry.register(
        makeNodeTypeDef("write_phase", async () => ({
          status: "success",
          outputs: { doc: "artifact content" },
        })),
      );

      let capturedContent: unknown;
      registry.register(
        makeNodeTypeDef("read_phase", async (ctx) => {
          capturedContent = ctx.inputs["content"];
          return { status: "success", outputs: {} };
        }),
      );

      await runner.seedSubtasks(db, "t9", pack, {});
      await runner.dispatchAutoPhases(db, "t9", pack, tmpDir);

      expect(capturedContent).toBe("artifact content");
    });

    it("parses JSON output when the output type is json", async () => {
      const phaseA = makePhase("json_writer", [], [{ name: "payload", path: "p/data.json", type: "json" }], {
        node_type: "json_producer",
      });
      const phaseB = makePhase("json_reader", [{ name: "data", from: "json_writer.payload" }], [], {
        node_type: "json_consumer",
      });
      const pack = makePack([phaseA, phaseB]);

      registry.register(
        makeNodeTypeDef("json_producer", async () => ({
          status: "success",
          outputs: { payload: { score: 42 } },
        })),
      );

      let capturedData: unknown;
      registry.register(
        makeNodeTypeDef("json_consumer", async (ctx) => {
          capturedData = ctx.inputs["data"];
          return { status: "success", outputs: {} };
        }),
      );

      await runner.seedSubtasks(db, "t10", pack, {});
      await runner.dispatchAutoPhases(db, "t10", pack, tmpDir);

      expect(capturedData).toEqual({ score: 42 });
    });

    it("resolves flat input.* pack inputs from task metadata", async () => {
      const phase = makePhase("node", [{ name: "depth", from: "input.depth" }], [], {
        node_type: "pack_input_reader",
      });
      const pack = makePack([phase]);

      let capturedDepth: unknown;
      registry.register(
        makeNodeTypeDef("pack_input_reader", async (ctx) => {
          capturedDepth = ctx.inputs["depth"];
          return { status: "success", outputs: {} };
        }),
      );

      await runner.seedSubtasks(db, "t11", pack, { depth: "standard" });
      await runner.dispatchAutoPhases(db, "t11", pack, tmpDir);

      expect(capturedDepth).toBe("standard");
    });

    it("resolves nested input.* paths (e.g. input.meta.depth)", async () => {
      const phase = makePhase("node", [{ name: "level", from: "input.meta.depth" }], [], {
        node_type: "nested_reader",
      });
      const pack = makePack([phase]);

      let capturedLevel: unknown;
      registry.register(
        makeNodeTypeDef("nested_reader", async (ctx) => {
          capturedLevel = ctx.inputs["level"];
          return { status: "success", outputs: {} };
        }),
      );

      await runner.seedSubtasks(db, "t14", pack, { meta: { depth: "deep" } });
      await runner.dispatchAutoPhases(db, "t14", pack, tmpDir);

      expect(capturedLevel).toBe("deep");
    });

    it("returns undefined for a missing nested input path", async () => {
      const phase = makePhase("node", [{ name: "val", from: "input.missing.key" }], [], {
        node_type: "missing_reader",
      });
      const pack = makePack([phase]);

      let capturedVal: unknown = "SENTINEL";
      registry.register(
        makeNodeTypeDef("missing_reader", async (ctx) => {
          capturedVal = ctx.inputs["val"];
          return { status: "success", outputs: {} };
        }),
      );

      await runner.seedSubtasks(db, "t15", pack, { other: "data" });
      await runner.dispatchAutoPhases(db, "t15", pack, tmpDir);

      // undefined path → key not set in ctx.inputs
      expect(capturedVal).toBeUndefined();
    });
  });

  // ── awaiting_approval guard (Issue 1 regression) ─────────────────────────

  describe("awaiting_approval guard", () => {
    it("leaves a phase in awaiting_approval after dispatch — remainingActive must be non-zero", async () => {
      // Simulates: node_type → node_type(awaiting_approval) chain.
      // After the first phase succeeds the second is awaiting_approval.
      // A caller checking only 'pending' would see 0 and falsely mark autoCompleted.
      // This test verifies the DB reflects awaiting_approval so the caller can detect it.
      const phaseA = makePhase("step_a", [], [{ name: "val", path: "a.md" }], { node_type: "ok_node" });
      const phaseB = makePhase("step_b", [{ name: "val", from: "step_a.val" }], [], { node_type: "gate_node" });
      const pack = makePack([phaseA, phaseB]);

      registry.register(makeNodeTypeDef("ok_node", async () => ({ status: "success", outputs: { val: "ok" } })));
      registry.register(makeNodeTypeDef("gate_node", async () => ({ status: "awaiting_approval", outputs: {} })));

      await runner.seedSubtasks(db, "t16", pack, {});
      const { dispatched, taskDone } = await runner.dispatchAutoPhases(db, "t16", pack, tmpDir);

      expect(dispatched).toContain("step_a");
      expect(taskDone).toBe(false);

      // step_b must be awaiting_approval — NOT pending
      const stB = db._subtasks.find((s) => s.task_id === "t16" && s.title === "[pipeline:step_b]");
      expect(stB?.status).toBe("awaiting_approval");

      // Caller query: pending OR awaiting_approval must be > 0
      const activeCount = db._subtasks.filter(
        (s) =>
          s.task_id === "t16" &&
          s.title.startsWith("[pipeline:") &&
          ["pending", "awaiting_approval"].includes(s.status),
      ).length;
      expect(activeCount).toBeGreaterThan(0);
    });
  });

  // ── taskDone propagation ──────────────────────────────────────────────────

  describe("taskDone flag", () => {
    it("returns taskDone=true when all terminal phases complete via auto-dispatch", async () => {
      const phase = makePhase("only", [], [{ name: "out", path: "out.md" }], { node_type: "terminal_node" });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("terminal_node", async () => ({
          status: "success",
          outputs: { out: "done" },
        })),
      );

      await runner.seedSubtasks(db, "t12", pack, {});
      const { taskDone } = await runner.dispatchAutoPhases(db, "t12", pack, tmpDir);

      expect(taskDone).toBe(true);
    });

    it("returns taskDone=false when agent phases remain pending after auto-dispatch", async () => {
      const nodePhase = makePhase("auto", [], [{ name: "val", path: "v.md" }], { node_type: "quick_node" });
      const agentPhase = makePhase("manual", [{ name: "val", from: "auto.val" }], []);
      const pack = makePack([nodePhase, agentPhase]);

      registry.register(
        makeNodeTypeDef("quick_node", async () => ({
          status: "success",
          outputs: { val: "x" },
        })),
      );

      await runner.seedSubtasks(db, "t13", pack, {});
      const { taskDone } = await runner.dispatchAutoPhases(db, "t13", pack, tmpDir);

      expect(taskDone).toBe(false);
      // agent phase should now be unblocked
      const agentSt = db._subtasks.find((s) => s.task_id === "t13" && s.title === "[pipeline:manual]");
      expect(agentSt?.status).toBe("pending");
    });
  });

  // ── broadcast on awaiting_approval ───────────────────────────────────────

  describe("broadcast on awaiting_approval", () => {
    it("calls broadcast with subtask_update when a node type returns awaiting_approval", async () => {
      const phase = makePhase("approval_node", [], [{ name: "draft", path: "out/draft.md" }], {
        node_type: "gate_node",
      });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("gate_node", async () => ({
          status: "awaiting_approval",
          outputs: { draft: "pending review content" },
          summary: "ready for approval",
        })),
      );

      const broadcast = vi.fn();
      runner.setBroadcast(broadcast);

      await runner.seedSubtasks(db, "tb1", pack, {});
      await runner.dispatchAutoPhases(db, "tb1", pack, tmpDir);

      expect(broadcast).toHaveBeenCalledOnce();
      const [event, payload] = broadcast.mock.calls[0] as [string, unknown];
      expect(event).toBe("subtask_update");
      const subtask = payload as { title: string; status: string };
      expect(subtask.title).toBe("[pipeline:approval_node]");
      expect(subtask.status).toBe("awaiting_approval");
    });

    it("does not call broadcast when broadcast is not set", async () => {
      const phase = makePhase("gate_phase", [], [], { node_type: "silent_gate" });
      const pack = makePack([phase]);

      registry.register(
        makeNodeTypeDef("silent_gate", async () => ({
          status: "awaiting_approval",
          outputs: {},
        })),
      );

      // No setBroadcast call — should not throw
      await runner.seedSubtasks(db, "tb2", pack, {});
      await expect(runner.dispatchAutoPhases(db, "tb2", pack, tmpDir)).resolves.not.toThrow();
    });

    it("calls broadcast when _onPhaseComplete hits a user_approval gate", async () => {
      const gatedPhase = makePhase("review", [], [{ name: "artifact", path: "out/art.md" }], {
        gate: "user_approval",
      });
      const pack = makePack([gatedPhase]);

      const broadcast = vi.fn();
      runner.setBroadcast(broadcast);

      await runner.seedSubtasks(db, "tb3", pack, {});

      // Simulate the phase completing (as if an agent finished it)
      const st = db._subtasks.find((s) => s.task_id === "tb3" && s.title === "[pipeline:review]");
      if (st) st.status = "done";

      await runner.onPhaseComplete(db, "tb3", "review", pack, tmpDir);

      expect(broadcast).toHaveBeenCalledOnce();
      const [event, payload] = broadcast.mock.calls[0] as [string, unknown];
      expect(event).toBe("subtask_update");
      const subtask = payload as { title: string; status: string };
      expect(subtask.title).toBe("[pipeline:review]");
      expect(subtask.status).toBe("awaiting_approval");
    });
  });
});
