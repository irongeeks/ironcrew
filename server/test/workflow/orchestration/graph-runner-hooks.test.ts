import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphRunner, isHookPathSafe } from "../../../modules/workflow/orchestration/graph-runner.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PackDefinition } from "../../../packs/pack-schema.ts";
import fs from "node:fs";
import path, { dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Path resolution analysis
// ---------------------------------------------------------------------------
// graph-runner.ts is at:
//   server/modules/workflow/orchestration/graph-runner.ts
//
// runHook builds the hook path as:
//   join(__dirname, "../../../packs/built-in", pack.key, hookPath)
//
// With graph-runner __dirname = .../server/modules/workflow/orchestration
// Resolving "../../../" goes:
//   orchestration → workflow → modules → server/
// So the resulting absolute path is:
//   .../server/packs/built-in/<pack.key>/<hookPath>
//
// This correctly points to the actual hook files at:
//   server/packs/built-in/video-preprod/hooks/remotion-gate.ts  ✓
//   server/packs/built-in/video-preprod/hooks/probe-video-artifact.ts  ✓
//   server/packs/built-in/design-studio/hooks/sync-design-assets.ts  ✓
//
// PATH RESOLUTION IS CORRECT.

// ---------------------------------------------------------------------------
// Path setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = server/test/workflow/orchestration

// server/ is 3 levels up from test file's directory
const SERVER_DIR = path.resolve(__dirname, "../../..");
// server/packs/built-in
const BUILT_IN_PACKS_DIR = path.join(SERVER_DIR, "packs", "built-in");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhase(id: string, overrides: Partial<Phase> = {}): Phase {
  return {
    id,
    department: "test",
    guidance: `guidance/${id}.{lang}.md`,
    capability_mode: "hybrid" as const,
    gate: "auto" as const,
    inputs: [],
    outputs: [],
    ...overrides,
  };
}

function makePack(phases: Phase[], key = "test_pack", source: "built-in" | "community" = "built-in"): LoadedPack {
  const graph = buildGraph(key, phases);
  const guidanceCache = new Map<string, string>();

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

  return { key, source, definition, graph, guidanceCache, sharedGuidanceCache: new Map() };
}

// Minimal mock DB — hooks receive it in context but our fixture hooks don't use it
function createMockDb() {
  return {
    run: () => undefined,
    get: () => undefined,
    all: () => [],
  };
}

// ---------------------------------------------------------------------------
// Fixture hook management
//
// runHook uses dynamic import() with a path resolved relative to graph-runner's
// own __dirname.  Fixture hook files must therefore live inside:
//   server/packs/built-in/<FIXTURE_PACK_KEY>/hooks/
// so that the path built by runHook resolves to an actual file on disk.
// ---------------------------------------------------------------------------

const FIXTURE_PACK_KEY = "test-hooks-fixture";
const FIXTURE_HOOKS_DIR = path.join(BUILT_IN_PACKS_DIR, FIXTURE_PACK_KEY, "hooks");

function writeFixtureHook(filename: string, content: string): string {
  const fullPath = path.join(FIXTURE_HOOKS_DIR, filename);
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

function removeFixtureDir() {
  const packDir = path.join(BUILT_IN_PACKS_DIR, FIXTURE_PACK_KEY);
  fs.rmSync(packDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphRunner.runHook (private)", () => {
  let runner: GraphRunner;
  let db: ReturnType<typeof createMockDb>;
  let tmpRootDir: string;

  beforeEach(() => {
    runner = new GraphRunner();
    db = createMockDb();
    tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "gr-hook-test-"));
    fs.mkdirSync(FIXTURE_HOOKS_DIR, { recursive: true });
  });

  afterEach(() => {
    removeFixtureDir();
    fs.rmSync(tmpRootDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Hook executes successfully — returns { ok: true }
  // -------------------------------------------------------------------------

  it("returns { ok: true } when hook executes successfully", async () => {
    writeFixtureHook("success-hook.js", `export default async function hook(context) { return { ok: true }; }`);

    const pack = makePack([makePhase("phase_a")], FIXTURE_PACK_KEY);

    const result = await (runner as any).runHook("hooks/success-hook.js", pack, {
      taskId: "task-1",
      subtaskId: "subtask-1",
      phaseId: "phase_a",
      rootDir: tmpRootDir,
      db,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: Hook returns failure — message is propagated
  // -------------------------------------------------------------------------

  it("propagates message when hook returns { ok: false, message }", async () => {
    writeFixtureHook(
      "fail-hook.js",
      `export default async function hook(context) {
        return { ok: false, message: "validation failed" };
      }`,
    );

    const pack = makePack([makePhase("phase_b")], FIXTURE_PACK_KEY);

    const result = await (runner as any).runHook("hooks/fail-hook.js", pack, {
      taskId: "task-2",
      subtaskId: "subtask-2",
      phaseId: "phase_b",
      rootDir: tmpRootDir,
      db,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("validation failed");
  });

  // -------------------------------------------------------------------------
  // Test 3: Hook file doesn't exist
  // -------------------------------------------------------------------------

  it("returns { ok: false } with error message when hook file does not exist", async () => {
    const pack = makePack([makePhase("phase_c")], FIXTURE_PACK_KEY);

    const result = await (runner as any).runHook("hooks/nonexistent-hook.js", pack, {
      taskId: "task-3",
      subtaskId: "subtask-3",
      phaseId: "phase_c",
      rootDir: tmpRootDir,
      db,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Hook execution failed:/);
  });

  // -------------------------------------------------------------------------
  // Test 4: Hook throws an exception
  // -------------------------------------------------------------------------

  it("returns { ok: false } with caught error message when hook throws", async () => {
    writeFixtureHook(
      "throw-hook.js",
      `export default async function hook(context) {
        throw new Error("unexpected failure");
      }`,
    );

    const pack = makePack([makePhase("phase_d")], FIXTURE_PACK_KEY);

    const result = await (runner as any).runHook("hooks/throw-hook.js", pack, {
      taskId: "task-4",
      subtaskId: "subtask-4",
      phaseId: "phase_d",
      rootDir: tmpRootDir,
      db,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Hook execution failed:.*unexpected failure/);
  });

  // -------------------------------------------------------------------------
  // Test 5: Hook receives correct context (including packKey injected by runHook)
  // -------------------------------------------------------------------------

  it("passes the correct context fields to the hook function", async () => {
    writeFixtureHook(
      "context-hook.js",
      `export default async function hook(context) {
        // Exclude db from JSON serialization (circular-safe workaround)
        const { db, ...safe } = context;
        return { ok: true, message: JSON.stringify(safe) };
      }`,
    );

    const pack = makePack([makePhase("phase_e")], FIXTURE_PACK_KEY);

    const result = await (runner as any).runHook("hooks/context-hook.js", pack, {
      taskId: "task-ctx-1",
      subtaskId: "subtask-ctx-1",
      phaseId: "phase_e",
      rootDir: tmpRootDir,
      db,
    });

    expect(result.ok).toBe(true);

    const ctx = JSON.parse(result.message!);
    expect(ctx.taskId).toBe("task-ctx-1");
    expect(ctx.subtaskId).toBe("subtask-ctx-1");
    expect(ctx.phaseId).toBe("phase_e");
    expect(ctx.rootDir).toBe(tmpRootDir);
    // packKey is added by runHook via spread: { ...context, packKey: pack.key }
    expect(ctx.packKey).toBe(FIXTURE_PACK_KEY);
  });

  // -------------------------------------------------------------------------
  // Test 6: ESM path resolution — __dirname derivation is correct
  // -------------------------------------------------------------------------

  it("path resolution: graph-runner __dirname resolves correctly to server/packs/built-in", () => {
    // graph-runner.ts derives __dirname from import.meta.url:
    //   const __filename = fileURLToPath(import.meta.url)
    //   const __dirname = dirname(__filename)
    //
    // At runtime (from the project root), graph-runner __dirname is:
    //   server/modules/workflow/orchestration
    //
    // runHook builds the path as:
    //   join(__dirname, "../../../packs/built-in", pack.key, hookPath)
    //
    // Walking "../../..":
    //   orchestration → workflow → modules → server/
    // Resulting in: server/packs/built-in/<key>/<hookPath>

    const graphRunnerDir = path.resolve(SERVER_DIR, "modules", "workflow", "orchestration");
    const resolvedBuiltInDir = path.resolve(graphRunnerDir, "../../../packs/built-in");

    // Must resolve to the same directory as our BUILT_IN_PACKS_DIR constant
    expect(resolvedBuiltInDir).toBe(BUILT_IN_PACKS_DIR);

    // Actual hook files must exist at the resolved paths
    const remotionGatePath = path.join(resolvedBuiltInDir, "video-preprod", "hooks", "remotion-gate.ts");
    const probeArtifactPath = path.join(resolvedBuiltInDir, "video-preprod", "hooks", "probe-video-artifact.ts");
    const syncDesignPath = path.join(resolvedBuiltInDir, "design-studio", "hooks", "sync-design-assets.ts");

    expect(fs.existsSync(remotionGatePath)).toBe(true);
    expect(fs.existsSync(probeArtifactPath)).toBe(true);
    expect(fs.existsSync(syncDesignPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: community pack routes to packs/community path
  // -------------------------------------------------------------------------

  it("routes community packs to packs/community and fails gracefully for missing hook", async () => {
    const pack = makePack([makePhase("phase_f")], FIXTURE_PACK_KEY, "community");

    const result = await (runner as any).runHook("hooks/some-hook.js", pack, {
      taskId: "task-7",
      subtaskId: "subtask-7",
      phaseId: "phase_f",
      rootDir: tmpRootDir,
      db,
    });

    // File doesn't exist in community directory — should return ok: false
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Hook execution failed:/);
    // Path must reference packs/community, not packs/built-in
    expect(result.message).toContain("packs/community");
  });

  // -------------------------------------------------------------------------
  // Test 8: Hook with re-exported default still invoked correctly
  // -------------------------------------------------------------------------

  it("invokes hook correctly when it uses a named-then-default-export pattern", async () => {
    writeFixtureHook(
      "named-default-hook.js",
      `async function myHook(context) { return { ok: true, message: "named-default" }; }
      export default myHook;`,
    );

    const pack = makePack([makePhase("phase_h")], FIXTURE_PACK_KEY);

    const result = await (runner as any).runHook("hooks/named-default-hook.js", pack, {
      taskId: "task-8",
      subtaskId: "subtask-8",
      phaseId: "phase_h",
      rootDir: tmpRootDir,
      db,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("named-default");
  });

  // -------------------------------------------------------------------------
  // Test 9: Path traversal attempts are rejected by runHook
  // -------------------------------------------------------------------------

  it("rejects path traversal hook paths with { ok: false } before file access", async () => {
    const pack = makePack([makePhase("phase_i")], FIXTURE_PACK_KEY);

    const result = await (runner as any).runHook("../../../../etc/passwd", pack, {
      taskId: "task-9",
      subtaskId: "subtask-9",
      phaseId: "phase_i",
      rootDir: tmpRootDir,
      db,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Hook path rejected/);
  });
});

// ---------------------------------------------------------------------------
// isHookPathSafe unit tests
// ---------------------------------------------------------------------------

describe("isHookPathSafe", () => {
  it("allows relative paths within pack dir", () => {
    expect(isHookPathSafe("hooks/post-run.ts")).toBe(true);
  });
  it("blocks path traversal", () => {
    expect(isHookPathSafe("../../../../etc/passwd")).toBe(false);
  });
  it("blocks absolute paths", () => {
    expect(isHookPathSafe("/etc/passwd")).toBe(false);
  });
  it("blocks encoded traversal", () => {
    expect(isHookPathSafe("hooks/..%2F..%2Fetc/passwd")).toBe(false);
  });
});
