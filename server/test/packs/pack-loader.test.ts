import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { PackLoader } from "../../packs/pack-loader.ts";
import { PackRegistry } from "../../packs/pack-registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pack-loader-test-"));
}

function writePackDir(
  parentDir: string,
  packKey: string,
  yaml: string,
  guidanceFiles: Record<string, string> = {},
): string {
  const dir = path.join(parentDir, packKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pack.yaml"), yaml, "utf8");

  for (const [relativePath, content] of Object.entries(guidanceFiles)) {
    const fullPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }

  return dir;
}

/** Minimal valid pack YAML with a single phase (no inter-phase inputs so no graph edges). */
const MINIMAL_PACK_YAML = `
pack:
  key: test_pack
  name:
    en: "Test Pack"
  version: "1.0.0"
  schema_version: 1
  description:
    en: "A test pack"
input:
  required: []
  optional: []
phases:
  - id: concept
    department: planning
    guidance: "guidance/concept.{lang}.md"
    outputs:
      - name: concept_doc
        type: markdown
        path: output/concept.md
`;

const PACK_YAML_TWO_PHASES = `
pack:
  key: two_phase_pack
  name:
    en: "Two Phase Pack"
  version: "1.0.0"
  schema_version: 1
  description:
    en: "A two-phase test pack"
input:
  required: []
  optional: []
phases:
  - id: planning
    department: planning
    guidance: "guidance/planning.{lang}.md"
    outputs:
      - name: plan_doc
        type: markdown
        path: output/plan.md
  - id: execution
    department: dev
    guidance: "guidance/execution.{lang}.md"
    inputs:
      - name: plan
        from: planning.plan_doc
    outputs:
      - name: result_doc
        type: markdown
        path: output/result.md
`;

const CYCLIC_PACK_YAML = `
pack:
  key: cyclic_pack
  name:
    en: "Cyclic Pack"
  version: "1.0.0"
  schema_version: 1
  description:
    en: "A cyclic pack"
input:
  required: []
  optional: []
phases:
  - id: phase_a
    department: dev
    guidance: "guidance/{lang}.md"
    outputs:
      - name: out_a
        type: markdown
        path: output/a.md
    inputs:
      - name: in_a
        from: phase_b.out_b
  - id: phase_b
    department: dev
    guidance: "guidance/{lang}.md"
    outputs:
      - name: out_b
        type: markdown
        path: output/b.md
    inputs:
      - name: in_b
        from: phase_a.out_a
`;

const INVALID_YAML = `
pack:
  key: 123invalid-key!!!
  name: "missing record format"
  version: "1.0.0"
  schema_version: 1
  description: "missing record format"
input:
  required: []
phases:
  - id: phase_one
    department: dev
    guidance: "guidance/{lang}.md"
`;

// ---------------------------------------------------------------------------
// Tests — PackLoader
// ---------------------------------------------------------------------------

describe("PackLoader", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  function tmp(): string {
    const d = makeTmpDir();
    tmpDirs.push(d);
    return d;
  }

  it("loads a valid pack.yaml and returns LoadedPack with correct key, graph, and definition", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "test_pack", MINIMAL_PACK_YAML);

    const loaded = await loader.loadPack(packDir, "built-in");

    expect(loaded.key).toBe("test_pack");
    expect(loaded.source).toBe("built-in");
    expect(loaded.definition.pack.key).toBe("test_pack");
    expect(loaded.definition.phases).toHaveLength(1);
    expect(loaded.graph.packKey).toBe("test_pack");
    expect(loaded.graph.phases).toHaveLength(1);
    expect(loaded.graph.roots).toContain("concept");
    expect(loaded.graph.terminals).toContain("concept");
  });

  it("loads guidance files into guidanceCache with correct keys", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "test_pack", MINIMAL_PACK_YAML, {
      "guidance/concept.en.md": "# English guidance",
      "guidance/concept.ko.md": "# Korean guidance",
    });

    const loaded = await loader.loadPack(packDir, "built-in");

    expect(loaded.guidanceCache.get("concept.en")).toBe("# English guidance");
    expect(loaded.guidanceCache.get("concept.ko")).toBe("# Korean guidance");
  });

  it("getGuidance returns the correct guidance for a given phase and lang", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "test_pack", MINIMAL_PACK_YAML, {
      "guidance/concept.en.md": "# English guidance",
      "guidance/concept.ko.md": "# Korean guidance",
    });

    const loaded = await loader.loadPack(packDir, "built-in");

    expect(loader.getGuidance(loaded, "concept", "ko")).toBe("# Korean guidance");
    expect(loader.getGuidance(loaded, "concept", "en")).toBe("# English guidance");
  });

  it("getGuidance falls back to 'en' when requested lang is missing", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "test_pack", MINIMAL_PACK_YAML, {
      "guidance/concept.en.md": "# English fallback guidance",
    });

    const loaded = await loader.loadPack(packDir, "built-in");

    // ja not present — should fall back to en
    expect(loader.getGuidance(loaded, "concept", "ja")).toBe("# English fallback guidance");
  });

  it("getGuidance returns empty string when no guidance exists for phase", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "test_pack", MINIMAL_PACK_YAML);

    const loaded = await loader.loadPack(packDir, "built-in");

    expect(loader.getGuidance(loaded, "concept", "en")).toBe("");
    expect(loader.getGuidance(loaded, "nonexistent", "en")).toBe("");
  });

  it("builds correct graph edges for multi-phase pack", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "two_phase_pack", PACK_YAML_TWO_PHASES);

    const loaded = await loader.loadPack(packDir, "built-in");

    expect(loaded.graph.phases).toHaveLength(2);
    expect(loaded.graph.roots).toContain("planning");
    expect(loaded.graph.terminals).toContain("execution");
    expect(loaded.graph.adjacency.get("planning")).toContain("execution");
  });

  it("rejects invalid YAML (Zod validation error)", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "invalid_pack", INVALID_YAML);

    await expect(loader.loadPack(packDir, "built-in")).rejects.toThrow();
  });

  it("rejects pack with cyclic graph", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "cyclic_pack", CYCLIC_PACK_YAML);

    await expect(loader.loadPack(packDir, "built-in")).rejects.toThrow(/[Cc]ycle/);
  });

  it("loadAll scans both directories and returns all packs", async () => {
    const loader = new PackLoader();
    const builtInDir = tmp();
    const communityDir = tmp();

    writePackDir(builtInDir, "test_pack", MINIMAL_PACK_YAML);
    writePackDir(communityDir, "two_phase_pack", PACK_YAML_TWO_PHASES);

    const packs = await loader.loadAll(builtInDir, communityDir);

    expect(packs).toHaveLength(2);
    const keys = packs.map((p) => p.key);
    expect(keys).toContain("test_pack");
    expect(keys).toContain("two_phase_pack");
  });

  it("community pack overrides built-in pack with same key", async () => {
    const loader = new PackLoader();
    const builtInDir = tmp();
    const communityDir = tmp();

    // Both have test_pack but community has a different description
    const communityPackYaml = MINIMAL_PACK_YAML.replace('"A test pack"', '"Community override"');

    writePackDir(builtInDir, "test_pack", MINIMAL_PACK_YAML);
    writePackDir(communityDir, "test_pack", communityPackYaml);

    const packs = await loader.loadAll(builtInDir, communityDir);

    // Should only have one pack (community wins)
    expect(packs).toHaveLength(1);
    expect(packs[0].source).toBe("community");
    expect(packs[0].definition.pack.description["en"]).toBe("Community override");
  });

  it("loadAll returns built-in pack when community dir is empty", async () => {
    const loader = new PackLoader();
    const builtInDir = tmp();
    const communityDir = tmp(); // empty

    writePackDir(builtInDir, "test_pack", MINIMAL_PACK_YAML);

    const packs = await loader.loadAll(builtInDir, communityDir);

    expect(packs).toHaveLength(1);
    expect(packs[0].source).toBe("built-in");
  });

  it("loadAll ignores subdirs without pack.yaml", async () => {
    const loader = new PackLoader();
    const builtInDir = tmp();
    const communityDir = tmp();

    // Valid pack
    writePackDir(builtInDir, "test_pack", MINIMAL_PACK_YAML);
    // Dir without pack.yaml
    fs.mkdirSync(path.join(builtInDir, "not_a_pack"), { recursive: true });
    fs.writeFileSync(path.join(builtInDir, "not_a_pack", "readme.txt"), "no yaml here");

    const packs = await loader.loadAll(builtInDir, communityDir);

    expect(packs).toHaveLength(1);
    expect(packs[0].key).toBe("test_pack");
  });
});

// ---------------------------------------------------------------------------
// Tests — PackRegistry
// ---------------------------------------------------------------------------

describe("PackRegistry", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  function tmp(): string {
    const d = makeTmpDir();
    tmpDirs.push(d);
    return d;
  }

  async function loadTestPack(key: string = "test_pack", yaml: string = MINIMAL_PACK_YAML) {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, key, yaml);
    return loader.loadPack(packDir, "built-in");
  }

  it("load and list work correctly", async () => {
    const registry = new PackRegistry();
    const pack = await loadTestPack();

    registry.load([pack]);

    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe("test_pack");
  });

  it("get returns the correct pack by key", async () => {
    const registry = new PackRegistry();
    const pack = await loadTestPack();
    registry.load([pack]);

    const retrieved = registry.get("test_pack");
    expect(retrieved.key).toBe("test_pack");
    expect(retrieved.definition.pack.key).toBe("test_pack");
  });

  it("get throws when pack key is not found", () => {
    const registry = new PackRegistry();

    expect(() => registry.get("nonexistent_pack")).toThrow();
  });

  it("load multiple packs and list returns all", async () => {
    const registry = new PackRegistry();
    const pack1 = await loadTestPack("test_pack", MINIMAL_PACK_YAML);
    const twoPhaseYaml = PACK_YAML_TWO_PHASES;
    const pack2 = await loadTestPack("two_phase_pack", twoPhaseYaml);

    registry.load([pack1, pack2]);

    expect(registry.list()).toHaveLength(2);
  });

  it("listEnabled returns all packs (future filter placeholder)", async () => {
    const registry = new PackRegistry();
    const pack = await loadTestPack();
    registry.load([pack]);

    expect(registry.listEnabled()).toHaveLength(1);
    expect(registry.listEnabled()[0].key).toBe("test_pack");
  });

  it("bulk load replaces existing packs on subsequent load calls", async () => {
    const registry = new PackRegistry();
    const pack1 = await loadTestPack();
    registry.load([pack1]);
    expect(registry.list()).toHaveLength(1);

    // Load again with a different pack — same key replaces
    const pack2 = await loadTestPack();
    registry.load([pack2]);
    expect(registry.list()).toHaveLength(1);
  });
});
