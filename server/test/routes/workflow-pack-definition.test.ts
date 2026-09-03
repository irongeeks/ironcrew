import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerWorkflowPackRoutes } from "../../modules/routes/ops/workflow-packs.ts";

function createMockDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    }),
  } as unknown as import("node:sqlite").DatabaseSync;
}

function createMockPackRegistry() {
  const mockDefinition = {
    pack: {
      key: "development",
      name: { en: "Development" },
      version: "1.0.0",
      schema_version: 1,
      description: { en: "Dev pack" },
    },
    input: { required: [], optional: [] },
    phases: [
      {
        id: "implementation",
        department: "dev",
        guidance: "guidance/implementation.{lang}.md",
        capability_mode: "hybrid",
        gate: "auto",
        inputs: [],
        outputs: [{ name: "summary", type: "markdown", path: "dev_output/summary.md" }],
      },
    ],
    cost_profile: { max_rounds: 3, default_reasoning: "high" },
    qa_rules: { require_test_evidence: true, max_auto_fix_passes: 1 },
  };

  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === "development") {
        return {
          key: "development",
          source: "built-in",
          definition: mockDefinition,
          graph: {
            packKey: "development",
            phases: [],
            adjacency: new Map(),
            reverseAdjacency: new Map(),
            roots: ["implementation"],
            terminals: ["implementation"],
          },
          guidanceCache: new Map([["implementation.en", "# Implementation Guide"]]),
          sharedGuidanceCache: new Map(),
        };
      }
      throw new Error(`Pack not found: "${key}"`);
    }),
    list: vi.fn().mockReturnValue([]),
    listEnabled: vi.fn().mockReturnValue([]),
    load: vi.fn(),
  };
}

describe("GET /api/ops/workflow-packs/:key/definition", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    registerWorkflowPackRoutes({
      app,
      db: createMockDb(),
      nowMs: () => Date.now(),
      normalizeTextField: (v: unknown) => (typeof v === "string" ? v : null),
      packRegistry: createMockPackRegistry() as never,
      adapterRegistry: { getAll: () => [] } as never,
    });
  });

  it("returns full pack definition for a valid key", async () => {
    const res = await request(app).get("/api/ops/workflow-packs/development/definition");
    expect(res.status).toBe(200);
    expect(res.body.key).toBe("development");
    expect(res.body.source).toBe("built-in");
    expect(res.body.definition.pack.key).toBe("development");
    expect(res.body.definition.phases).toHaveLength(1);
    expect(res.body.definition.phases[0].id).toBe("implementation");
    expect(res.body.guidanceLanguages).toEqual({ implementation: ["en"] });
  });

  it("returns 404 for unknown pack key", async () => {
    const res = await request(app).get("/api/ops/workflow-packs/nonexistent/definition");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
