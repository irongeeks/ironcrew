import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphRunner } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import { ConnectorRegistry } from "../../../connectors/registry.ts";
import type { Connector, ConnectorExecuteResult } from "../../../connectors/connector-interface.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";

// ---------------------------------------------------------------------------
// Mock DB (same pattern as other graph-runner tests)
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
        // Supports both 3-arg (status, task_id, title) and 4-arg (status, task_id, title, oldStatus) forms
        const isLike = upper.includes("LIKE");
        if (params.length === 4) {
          // (status, task_id, title, oldStatus) — conditional update
          const [status, task_id, title, _oldStatus] = params as [string, string, string, string];
          for (const st of subtasks) {
            if (st.task_id === task_id && st.title === title) {
              st.status = status;
            }
          }
        } else {
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

function createMockConnector(
  name: string,
  capabilities: string[],
  executeFn: (capability: string, input: Record<string, unknown>) => Promise<ConnectorExecuteResult>,
): Connector {
  return {
    name,
    capabilities: capabilities.map((c) => ({
      name: c,
      description: `Mock ${c}`,
      inputSchema: {},
      outputSchema: {},
    })),
    execute: (capability, input, _config) => executeFn(capability, input),
    testConnection: async () => ({ ok: true, message: "mock" }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphRunner — connector phase execution (capability_mode: server)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createMockDb>;
  let connectorRegistry: ConnectorRegistry;
  let runner: GraphRunner;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gr-connector-test-"));
    mkdirSync(join(tmpDir, "output"), { recursive: true });
    db = createMockDb();
    connectorRegistry = new ConnectorRegistry();
    runner = new GraphRunner(connectorRegistry);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Happy path: prepare (agent) → generate (connector, capability_mode: server)
  // =========================================================================

  it("invokes connector when predecessor completes and phase has capability_mode=server", async () => {
    const executeSpy = vi.fn<(cap: string, input: Record<string, unknown>) => Promise<ConnectorExecuteResult>>(
      async () => ({
        status: "success",
        artifacts: [{ path: "output/image.png", type: "image/png" }],
        costInfo: { durationMs: 1200 },
      }),
    );

    const connector = createMockConnector("comfyui", ["text2img"], executeSpy);
    connectorRegistry.registerConnector(connector);
    connectorRegistry.setBinding("text2img", {
      connector: "comfyui",
      connector_config: { server_url: "http://localhost:8188" },
    });

    // Write the input artifact that the generate phase will read
    const promptData = { prompt: "a sunset over mountains", negative: "blurry" };
    writeFileSync(join(tmpDir, "output", "prompt.json"), JSON.stringify(promptData));

    const preparePhase = makePhase("prepare", [], [{ name: "prompt", path: "output/prompt.json", type: "json" }]);
    const generatePhase = makePhase(
      "generate",
      [{ name: "prompt", from: "prepare.prompt" }],
      [{ name: "image", path: "output/image.png" }],
      {
        capability: "text2img",
        capability_mode: "server",
      },
    );

    const pack = makePack([preparePhase, generatePhase]);
    await runner.seedSubtasks(db, "task-1", pack, {});

    // Mark prepare phase as done (simulating agent completion)
    const prepareSt = db._subtasks.find((s) => s.task_id === "task-1" && s.title === "[pipeline:prepare]");
    prepareSt!.status = "done";

    // Trigger onPhaseComplete for the prepare phase
    const result = await runner.onPhaseComplete(db, "task-1", "prepare", pack, tmpDir);

    // The connector should have been called
    expect(executeSpy).toHaveBeenCalledOnce();
    const [calledCapability, calledInput] = executeSpy.mock.calls[0];
    expect(calledCapability).toBe("text2img");
    // The input should contain the resolved prompt artifact
    expect(calledInput.prompt).toEqual(promptData);

    // The generate subtask should be marked as done
    const genSt = db._subtasks.find((s) => s.task_id === "task-1" && s.title === "[pipeline:generate]");
    expect(genSt?.status).toBe("done");
    expect(genSt?.completed_at).toBeGreaterThan(0);

    // When the connector phase is the terminal phase with no further downstream,
    // advanced is false (no agent phases were unblocked) but taskDone is true.
    expect(result.taskDone).toBe(true);
  });

  // =========================================================================
  // Connector phase marks subtask in_progress before execution
  // =========================================================================

  it("transitions subtask through in_progress → done on success", async () => {
    const statusHistory: string[] = [];

    const connector = createMockConnector("comfyui", ["text2img"], async () => {
      // Capture the status at the time the connector is called
      const st = db._subtasks.find((s) => s.task_id === "task-2" && s.title === "[pipeline:generate]");
      if (st) statusHistory.push(st.status);
      return {
        status: "success",
        artifacts: [],
        costInfo: { durationMs: 500 },
      };
    });

    connectorRegistry.registerConnector(connector);
    connectorRegistry.setBinding("text2img", {
      connector: "comfyui",
      connector_config: {},
    });

    const preparePhase = makePhase("prepare", [], [{ name: "data", path: "output/data.json", type: "json" }]);
    const generatePhase = makePhase("generate", [{ name: "data", from: "prepare.data" }], [], {
      capability: "text2img",
      capability_mode: "server",
    });

    writeFileSync(join(tmpDir, "output", "data.json"), JSON.stringify({ key: "value" }));

    const pack = makePack([preparePhase, generatePhase]);
    await runner.seedSubtasks(db, "task-2", pack, {});

    db._subtasks.find((s) => s.task_id === "task-2" && s.title === "[pipeline:prepare]")!.status = "done";

    await runner.onPhaseComplete(db, "task-2", "prepare", pack, tmpDir);

    // During execution, the subtask should have been in_progress
    expect(statusHistory).toContain("in_progress");

    // After execution, it should be done
    const genSt = db._subtasks.find((s) => s.task_id === "task-2" && s.title === "[pipeline:generate]");
    expect(genSt?.status).toBe("done");
  });

  // =========================================================================
  // Connector phase with no inputs still executes
  // =========================================================================

  it("executes connector phase with resolved input artifact", async () => {
    const executeSpy = vi.fn<(cap: string, input: Record<string, unknown>) => Promise<ConnectorExecuteResult>>(
      async () => ({
        status: "success",
        artifacts: [],
      }),
    );

    const connector = createMockConnector("web-search", ["web_search"], executeSpy);
    connectorRegistry.registerConnector(connector);
    connectorRegistry.setBinding("web_search", {
      connector: "web-search",
      connector_config: {},
    });

    const triggerPhase = makePhase("trigger", [], [{ name: "query", path: "output/query.json", type: "json" }]);
    const searchPhaseWithInput = makePhase("search", [{ name: "query", from: "trigger.query" }], [], {
      capability: "web_search",
      capability_mode: "server",
    });

    writeFileSync(join(tmpDir, "output", "query.json"), JSON.stringify({ q: "test query" }));

    const pack = makePack([triggerPhase, searchPhaseWithInput]);
    await runner.seedSubtasks(db, "task-3", pack, {});

    db._subtasks.find((s) => s.task_id === "task-3" && s.title === "[pipeline:trigger]")!.status = "done";

    await runner.onPhaseComplete(db, "task-3", "trigger", pack, tmpDir);

    expect(executeSpy).toHaveBeenCalledOnce();
    const genSt = db._subtasks.find((s) => s.task_id === "task-3" && s.title === "[pipeline:search]");
    expect(genSt?.status).toBe("done");
  });

  // =========================================================================
  // Connector success triggers downstream advancement (3-phase chain)
  // =========================================================================

  it("advances downstream phases after connector phase completes", async () => {
    const connector = createMockConnector("comfyui", ["text2img"], async () => ({
      status: "success",
      artifacts: [],
    }));

    connectorRegistry.registerConnector(connector);
    connectorRegistry.setBinding("text2img", {
      connector: "comfyui",
      connector_config: {},
    });

    const preparePhase = makePhase("prepare", [], [{ name: "prompt", path: "output/prompt.json", type: "json" }]);
    const generatePhase = makePhase(
      "generate",
      [{ name: "prompt", from: "prepare.prompt" }],
      [{ name: "image", path: "output/image.json", type: "json" }],
      {
        capability: "text2img",
        capability_mode: "server",
      },
    );
    // assembly is a regular agent phase downstream of generate
    const assemblyPhase = makePhase("assembly", [{ name: "image", from: "generate.image" }], []);

    writeFileSync(join(tmpDir, "output", "prompt.json"), JSON.stringify({ prompt: "test" }));

    const pack = makePack([preparePhase, generatePhase, assemblyPhase]);
    await runner.seedSubtasks(db, "task-4", pack, {});

    db._subtasks.find((s) => s.task_id === "task-4" && s.title === "[pipeline:prepare]")!.status = "done";

    const result = await runner.onPhaseComplete(db, "task-4", "prepare", pack, tmpDir);

    // generate should be done (connector executed)
    const genSt = db._subtasks.find((s) => s.task_id === "task-4" && s.title === "[pipeline:generate]");
    expect(genSt?.status).toBe("done");

    // assembly should be unblocked to pending (it's an agent phase, no auto-dispatch)
    const asmSt = db._subtasks.find((s) => s.task_id === "task-4" && s.title === "[pipeline:assembly]");
    expect(asmSt?.status).toBe("pending");

    // The result should list assembly as a next phase
    expect(result.nextPhases).toContain("assembly");
  });

  // =========================================================================
  // taskDone when connector phase is terminal
  // =========================================================================

  it("reports taskDone=true when connector phase is the terminal phase", async () => {
    const connector = createMockConnector("comfyui", ["text2img"], async () => ({
      status: "success",
      artifacts: [],
    }));

    connectorRegistry.registerConnector(connector);
    connectorRegistry.setBinding("text2img", {
      connector: "comfyui",
      connector_config: {},
    });

    const preparePhase = makePhase("prepare", [], [{ name: "prompt", path: "output/prompt.json", type: "json" }]);
    const generatePhase = makePhase("generate", [{ name: "prompt", from: "prepare.prompt" }], [], {
      capability: "text2img",
      capability_mode: "server",
    });

    writeFileSync(join(tmpDir, "output", "prompt.json"), JSON.stringify({ prompt: "test" }));

    const pack = makePack([preparePhase, generatePhase]);
    await runner.seedSubtasks(db, "task-5", pack, {});

    db._subtasks.find((s) => s.task_id === "task-5" && s.title === "[pipeline:prepare]")!.status = "done";

    const result = await runner.onPhaseComplete(db, "task-5", "prepare", pack, tmpDir);

    expect(result.taskDone).toBe(true);
    const genSt = db._subtasks.find((s) => s.task_id === "task-5" && s.title === "[pipeline:generate]");
    expect(genSt?.status).toBe("done");
  });

  // =========================================================================
  // Input artifact resolution
  // =========================================================================

  describe("input artifact resolution", () => {
    it("handles missing input artifact file without crashing", async () => {
      const executeSpy = vi.fn<(cap: string, input: Record<string, unknown>) => Promise<ConnectorExecuteResult>>(
        async () => ({
          status: "success",
          artifacts: [{ path: "output/image.png", type: "image/png" }],
          costInfo: { durationMs: 800 },
        }),
      );

      const connector = createMockConnector("comfyui", ["text2img"], executeSpy);
      connectorRegistry.registerConnector(connector);
      connectorRegistry.setBinding("text2img", {
        connector: "comfyui",
        connector_config: { server_url: "http://localhost:8188" },
      });

      // Define prepare phase with an output, but do NOT write the file to disk
      const preparePhase = makePhase("prepare", [], [{ name: "prompt", path: "output/prepare/prompt.txt" }]);
      const generatePhase = makePhase(
        "generate",
        [{ name: "prompt", from: "prepare.prompt" }],
        [{ name: "image", path: "output/image.png" }],
        {
          capability: "text2img",
          capability_mode: "server",
        },
      );

      // Deliberately NOT writing output/prepare/prompt.txt — it doesn't exist on disk

      const pack = makePack([preparePhase, generatePhase]);
      await runner.seedSubtasks(db, "task-artifact-1", pack, {});

      db._subtasks.find((s) => s.task_id === "task-artifact-1" && s.title === "[pipeline:prepare]")!.status = "done";

      // Should NOT throw — missing artifact is handled gracefully
      const result = await runner.onPhaseComplete(db, "task-artifact-1", "prepare", pack, tmpDir);

      // The connector should still be called (missing input is omitted, not a crash)
      expect(executeSpy).toHaveBeenCalledOnce();
      const [calledCapability] = executeSpy.mock.calls[0];
      expect(calledCapability).toBe("text2img");

      // The generate subtask should complete successfully
      const genSt = db._subtasks.find((s) => s.task_id === "task-artifact-1" && s.title === "[pipeline:generate]");
      expect(genSt?.status).toBe("done");

      // Task should be done since generate is the terminal phase
      expect(result.taskDone).toBe(true);
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe("error handling", () => {
    it("resets subtask to pending when connector returns success=false", async () => {
      const executeSpy = vi.fn<(cap: string, input: Record<string, unknown>) => Promise<ConnectorExecuteResult>>(
        async () => ({
          status: "error" as const,
          artifacts: [],
          error: "GPU out of memory",
        }),
      );

      const connector = createMockConnector("comfyui", ["text2img"], executeSpy);
      connectorRegistry.registerConnector(connector);
      connectorRegistry.setBinding("text2img", {
        connector: "comfyui",
        connector_config: {},
      });

      const preparePhase = makePhase("prepare", [], [{ name: "prompt", path: "output/prompt.json", type: "json" }]);
      const generatePhase = makePhase("generate", [{ name: "prompt", from: "prepare.prompt" }], [], {
        capability: "text2img",
        capability_mode: "server",
      });

      writeFileSync(join(tmpDir, "output", "prompt.json"), JSON.stringify({ prompt: "test" }));

      const pack = makePack([preparePhase, generatePhase]);
      await runner.seedSubtasks(db, "task-err-1", pack, {});

      db._subtasks.find((s) => s.task_id === "task-err-1" && s.title === "[pipeline:prepare]")!.status = "done";

      const result = await runner.onPhaseComplete(db, "task-err-1", "prepare", pack, tmpDir);

      // Connector was called
      expect(executeSpy).toHaveBeenCalledOnce();

      // Subtask should be reset to pending, not left as in_progress
      const genSt = db._subtasks.find((s) => s.task_id === "task-err-1" && s.title === "[pipeline:generate]");
      expect(genSt?.status).toBe("pending");

      // taskDone should be false since the phase didn't complete
      expect(result.taskDone).toBe(false);
    });

    it("does not call connector when no binding exists for the capability", async () => {
      const executeSpy = vi.fn<(cap: string, input: Record<string, unknown>) => Promise<ConnectorExecuteResult>>(
        async () => ({
          status: "success",
          artifacts: [],
        }),
      );

      // Register connector but do NOT set a binding for "text2img"
      const connector = createMockConnector("comfyui", ["text2img"], executeSpy);
      connectorRegistry.registerConnector(connector);

      const preparePhase = makePhase("prepare", [], [{ name: "prompt", path: "output/prompt.json", type: "json" }]);
      const generatePhase = makePhase("generate", [{ name: "prompt", from: "prepare.prompt" }], [], {
        capability: "text2img",
        capability_mode: "server",
      });

      writeFileSync(join(tmpDir, "output", "prompt.json"), JSON.stringify({ prompt: "test" }));

      const pack = makePack([preparePhase, generatePhase]);
      await runner.seedSubtasks(db, "task-err-2", pack, {});

      db._subtasks.find((s) => s.task_id === "task-err-2" && s.title === "[pipeline:prepare]")!.status = "done";

      const result = await runner.onPhaseComplete(db, "task-err-2", "prepare", pack, tmpDir);

      // Connector should NOT have been called since there's no binding
      expect(executeSpy).not.toHaveBeenCalled();

      // Subtask should be reset to pending (the thrown error is caught)
      const genSt = db._subtasks.find((s) => s.task_id === "task-err-2" && s.title === "[pipeline:generate]");
      expect(genSt?.status).toBe("pending");

      // Task is not done
      expect(result.taskDone).toBe(false);
    });

    it("catches connector exception and resets subtask to pending", async () => {
      const executeSpy = vi.fn<(cap: string, input: Record<string, unknown>) => Promise<ConnectorExecuteResult>>(
        async () => {
          throw new Error("Connection refused: ECONNREFUSED 127.0.0.1:8188");
        },
      );

      const connector = createMockConnector("comfyui", ["text2img"], executeSpy);
      connectorRegistry.registerConnector(connector);
      connectorRegistry.setBinding("text2img", {
        connector: "comfyui",
        connector_config: {},
      });

      const preparePhase = makePhase("prepare", [], [{ name: "prompt", path: "output/prompt.json", type: "json" }]);
      const generatePhase = makePhase("generate", [{ name: "prompt", from: "prepare.prompt" }], [], {
        capability: "text2img",
        capability_mode: "server",
      });

      writeFileSync(join(tmpDir, "output", "prompt.json"), JSON.stringify({ prompt: "test" }));

      const pack = makePack([preparePhase, generatePhase]);
      await runner.seedSubtasks(db, "task-err-3", pack, {});

      db._subtasks.find((s) => s.task_id === "task-err-3" && s.title === "[pipeline:prepare]")!.status = "done";

      // Should NOT throw — the runner catches the exception internally
      const result = await runner.onPhaseComplete(db, "task-err-3", "prepare", pack, tmpDir);

      // Connector was called and threw
      expect(executeSpy).toHaveBeenCalledOnce();

      // Subtask should be reset to pending, not left as in_progress
      const genSt = db._subtasks.find((s) => s.task_id === "task-err-3" && s.title === "[pipeline:generate]");
      expect(genSt?.status).toBe("pending");

      // Task is not done
      expect(result.taskDone).toBe(false);
    });
  });
});
