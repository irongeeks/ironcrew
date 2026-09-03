import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  registerWorkflowPackRoutes,
  PositionsBodySchema,
  MAX_POSITIONS_KEYS,
} from "../../../modules/routes/ops/workflow-packs.ts";
import { PackRegistry } from "../../../packs/pack-registry.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import { createAdapterRegistry } from "../../../adapters/index.ts";

// ---------------------------------------------------------------------------
// Auth bypass — same pattern as other route tests
// ---------------------------------------------------------------------------

vi.mock("../../../security/auth.ts", () => ({
  shouldRequireCsrf: vi.fn(() => false),
  hasValidCsrfToken: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Schema-level tests (cheap, exhaustive)
// ---------------------------------------------------------------------------

describe("PositionsBodySchema", () => {
  it("accepts a valid Record<string, {x,y}> body", () => {
    const ok = PositionsBodySchema.safeParse({
      phase_a: { x: 10, y: 20 },
      phase_b: { x: -5.25, y: 0 },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects non-object bodies", () => {
    expect(PositionsBodySchema.safeParse("nope").success).toBe(false);
    expect(PositionsBodySchema.safeParse(42).success).toBe(false);
    expect(PositionsBodySchema.safeParse(null).success).toBe(false);
    expect(PositionsBodySchema.safeParse([{ x: 1, y: 2 }]).success).toBe(false);
  });

  it("rejects entries with non-number x/y", () => {
    expect(PositionsBodySchema.safeParse({ phase_a: { x: "10", y: 20 } }).success).toBe(false);
    expect(PositionsBodySchema.safeParse({ phase_a: { x: 10 } }).success).toBe(false);
    expect(PositionsBodySchema.safeParse({ phase_a: { x: 10, y: 20, z: 5 } }).success).toBe(false);
  });

  it("rejects non-finite numbers (NaN, Infinity)", () => {
    expect(PositionsBodySchema.safeParse({ phase_a: { x: Number.NaN, y: 0 } }).success).toBe(false);
    expect(PositionsBodySchema.safeParse({ phase_a: { x: Number.POSITIVE_INFINITY, y: 0 } }).success).toBe(false);
  });

  it(`rejects more than ${MAX_POSITIONS_KEYS} keys`, () => {
    const tooMany: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < MAX_POSITIONS_KEYS + 1; i++) {
      tooMany[`phase_${i}`] = { x: i, y: i };
    }
    expect(PositionsBodySchema.safeParse(tooMany).success).toBe(false);
  });

  it("accepts exactly the cap", () => {
    const atCap: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < MAX_POSITIONS_KEYS; i++) {
      atCap[`phase_${i}`] = { x: i, y: i };
    }
    expect(PositionsBodySchema.safeParse(atCap).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route integration via supertest — validates write-through and 400 paths
// ---------------------------------------------------------------------------

function buildLoadedPackStub(key: string): LoadedPack {
  return {
    key,
    source: "community",
    definition: {
      pack: {
        key,
        name: { en: "Test" },
        version: "1.0.0",
        description: { en: "test" },
        schema_version: 1 as const,
        agent_routing: "department" as const,
      },
      input: { required: [], optional: [] },
      phases: [],
      cost_profile: { max_rounds: 1, default_reasoning: "low" as const },
    } as LoadedPack["definition"],
    graph: {
      packKey: key,
      phases: [],
      adjacency: new Map(),
      reverseAdjacency: new Map(),
      roots: [],
      terminals: [],
    } as LoadedPack["graph"],
    guidanceCache: new Map(),
    sharedGuidanceCache: new Map(),
  };
}

function fakeDb() {
  return {
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  } as unknown as Parameters<typeof registerWorkflowPackRoutes>[0]["db"];
}

describe("PUT /api/ops/workflow-packs/:key/positions", () => {
  const PACK_KEY = "test_positions_pack";
  let tmpRoot: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octooffice-positions-"));
    fs.mkdirSync(path.join(tmpRoot, "server", "packs", "community"), { recursive: true });
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeApp() {
    const app = express();
    app.use(express.json());
    const packRegistry = new PackRegistry();
    packRegistry.load([buildLoadedPackStub(PACK_KEY)]);
    registerWorkflowPackRoutes({
      app,
      db: fakeDb(),
      nowMs: () => 0,
      normalizeTextField: (v) => (typeof v === "string" ? v : null),
      adapterRegistry: createAdapterRegistry(),
      packRegistry,
    });
    return app;
  }

  it("writes a valid positions body to disk", async () => {
    const app = makeApp();
    const body = {
      phase_a: { x: 10, y: 20 },
      phase_b: { x: 100, y: 200 },
    };
    const res = await request(app).put(`/api/ops/workflow-packs/${PACK_KEY}/positions`).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, "server", "packs", "community", PACK_KEY, ".positions.json"), "utf-8"),
    );
    expect(written).toEqual(body);
  });

  it("rejects body with non-number x/y with 400", async () => {
    const app = makeApp();
    const res = await request(app)
      .put(`/api/ops/workflow-packs/${PACK_KEY}/positions`)
      .send({ phase_a: { x: "10", y: 20 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_positions_body");
    expect(fs.existsSync(path.join(tmpRoot, "server", "packs", "community", PACK_KEY, ".positions.json"))).toBe(false);
  });

  it("rejects body with too many keys with 400", async () => {
    const app = makeApp();
    const tooMany: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < MAX_POSITIONS_KEYS + 1; i++) {
      tooMany[`phase_${i}`] = { x: i, y: i };
    }
    const res = await request(app).put(`/api/ops/workflow-packs/${PACK_KEY}/positions`).send(tooMany);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_positions_body");
  });

  it("rejects non-object body with 400", async () => {
    const app = makeApp();
    // Send a JSON array (parses fine, but schema requires a record/object)
    const res = await request(app)
      .put(`/api/ops/workflow-packs/${PACK_KEY}/positions`)
      .send([{ x: 1, y: 2 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_positions_body");
  });
});
