import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { PackLoader } from "../../packs/pack-loader.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pack-loader-edge-"));
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

/** Minimal valid pack YAML with a single phase. */
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

// ---------------------------------------------------------------------------
// Tests — PackLoader Edge Cases
// ---------------------------------------------------------------------------

describe("PackLoader edge cases", () => {
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

  // -------------------------------------------------------------------------
  // 1. Missing guidance directory
  // -------------------------------------------------------------------------

  it("loads pack without crashing when guidance/ directory does not exist", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    // Write pack.yaml but no guidance directory at all
    const packDir = writePackDir(dir, "no_guidance", MINIMAL_PACK_YAML);

    const loaded = await loader.loadPack(packDir, "built-in");

    expect(loaded.key).toBe("test_pack");
    expect(loaded.definition.phases).toHaveLength(1);
    // Guidance cache should be empty — no guidance files exist
    expect(loaded.guidanceCache.size).toBe(0);
  });

  it("getGuidance returns empty string for phases when guidance dir is missing", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "no_guidance", MINIMAL_PACK_YAML);

    const loaded = await loader.loadPack(packDir, "built-in");

    expect(loader.getGuidance(loaded, "concept", "en")).toBe("");
    expect(loader.getGuidance(loaded, "concept", "de")).toBe("");
  });

  // -------------------------------------------------------------------------
  // 2. Invalid YAML syntax (broken YAML, not just bad schema)
  // -------------------------------------------------------------------------

  it("rejects pack.yaml with broken YAML syntax", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const brokenYaml = `
pack:
  key: broken
  name:
    en: "Broken"
  this is not valid yaml: [[[unterminated
    - nope: {{{
`;
    const packDir = writePackDir(dir, "broken_yaml", brokenYaml);

    await expect(loader.loadPack(packDir, "built-in")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // 3. Missing required fields
  // -------------------------------------------------------------------------

  it("rejects pack.yaml missing the 'key' field", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const noKeyYaml = `
pack:
  name:
    en: "No Key Pack"
  version: "1.0.0"
  schema_version: 1
  description:
    en: "Missing key"
input:
  required: []
  optional: []
phases:
  - id: step_one
    department: dev
    guidance: "guidance/step_one.{lang}.md"
    outputs:
      - name: out
        type: markdown
        path: output/out.md
`;
    const packDir = writePackDir(dir, "no_key", noKeyYaml);

    await expect(loader.loadPack(packDir, "built-in")).rejects.toThrow();
  });

  it("rejects pack.yaml missing the 'phases' field entirely", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const noPhasesYaml = `
pack:
  key: no_phases
  name:
    en: "No Phases Pack"
  version: "1.0.0"
  schema_version: 1
  description:
    en: "Missing phases"
input:
  required: []
  optional: []
`;
    const packDir = writePackDir(dir, "no_phases", noPhasesYaml);

    await expect(loader.loadPack(packDir, "built-in")).rejects.toThrow();
  });

  it("rejects pack.yaml with empty phases array", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const emptyPhasesYaml = `
pack:
  key: empty_phases
  name:
    en: "Empty Phases Pack"
  version: "1.0.0"
  schema_version: 1
  description:
    en: "Empty phases array"
input:
  required: []
  optional: []
phases: []
`;
    const packDir = writePackDir(dir, "empty_phases", emptyPhasesYaml);

    await expect(loader.loadPack(packDir, "built-in")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // 4. Language fallback — only English guidance exists
  // -------------------------------------------------------------------------

  it("loads only English guidance when other language files are absent", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "en_only", MINIMAL_PACK_YAML, {
      "guidance/concept.en.md": "# English only guidance",
    });

    const loaded = await loader.loadPack(packDir, "built-in");

    // English guidance should be in cache
    expect(loaded.guidanceCache.get("concept.en")).toBe("# English only guidance");
    // German guidance should NOT be in cache (file doesn't exist)
    expect(loaded.guidanceCache.has("concept.de")).toBe(false);
    // Other languages should also not be cached
    expect(loaded.guidanceCache.has("concept.ko")).toBe(false);
    expect(loaded.guidanceCache.has("concept.ja")).toBe(false);
    expect(loaded.guidanceCache.has("concept.zh")).toBe(false);
  });

  it("getGuidance falls back to English when German guidance is missing", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "en_only", MINIMAL_PACK_YAML, {
      "guidance/concept.en.md": "# English fallback content",
    });

    const loaded = await loader.loadPack(packDir, "built-in");

    // Requesting German should fall back to English
    expect(loader.getGuidance(loaded, "concept", "de")).toBe("# English fallback content");
    // Requesting any unsupported language should also fall back to English
    expect(loader.getGuidance(loaded, "concept", "fr")).toBe("# English fallback content");
  });

  it("getGuidance returns specific language when both English and that language exist", async () => {
    const loader = new PackLoader();
    const dir = tmp();
    const packDir = writePackDir(dir, "multi_lang", MINIMAL_PACK_YAML, {
      "guidance/concept.en.md": "# English guidance",
      "guidance/concept.de.md": "# German guidance",
    });

    const loaded = await loader.loadPack(packDir, "built-in");

    // German should return German, not English
    expect(loader.getGuidance(loaded, "concept", "de")).toBe("# German guidance");
    // English should still return English
    expect(loader.getGuidance(loaded, "concept", "en")).toBe("# English guidance");
    // Japanese (missing) should fall back to English
    expect(loader.getGuidance(loaded, "concept", "ja")).toBe("# English guidance");
  });
});
