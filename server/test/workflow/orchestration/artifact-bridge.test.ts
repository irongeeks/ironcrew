import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseOutput } from "../../../packs/pack-schema.ts";
import {
  resolveArtifactRef,
  validateArtifact,
  bridgeArtifactsForPhase,
  type ArtifactBridgeContext,
} from "../../../modules/workflow/orchestration/artifact-bridge.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutput(
  phaseId: string,
  name: string,
  path: string,
  type: PhaseOutput["type"] = "markdown",
  schema?: string,
): [string, PhaseOutput] {
  return [`${phaseId}.${name}`, { name, type, path, schema }];
}

let tmpRoot: string;
let packDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "artifact-bridge-test-"));
  packDir = join(tmpRoot, "pack");
  mkdirSync(packDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — direct ref
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — direct ref", () => {
  it("reads file and returns content for a simple phase.output ref", async () => {
    const filePath = join(tmpRoot, "concept_doc.md");
    writeFileSync(filePath, "# Concept\nThis is the concept.");

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("concept", "concept_doc", filePath)]);

    const result = await resolveArtifactRef(tmpRoot, "concept.concept_doc", outputDefs);
    expect(result.content).toBe("# Concept\nThis is the concept.");
    expect(result.warning).toBeUndefined();
  });

  it("returns null with warning when file does not exist", async () => {
    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("concept", "concept_doc", join(tmpRoot, "missing.md")),
    ]);

    const result = await resolveArtifactRef(tmpRoot, "concept.concept_doc", outputDefs);
    expect(result.content).toBeNull();
    expect(result.warning).toBeTruthy();
    expect(result.warning).toMatch(/missing\.md|not found/i);
  });

  it("returns null for pack input refs (isPackInput)", async () => {
    const outputDefs = new Map<string, PhaseOutput>();
    const result = await resolveArtifactRef(tmpRoot, "input.depth", outputDefs);
    expect(result.content).toBeNull();
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — wildcard ref
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — wildcard ref", () => {
  it("collects all matching files when ref ends with .*", async () => {
    const imgDir = join(tmpRoot, "images");
    mkdirSync(imgDir, { recursive: true });
    writeFileSync(join(imgDir, "image_0.png"), "img0");
    writeFileSync(join(imgDir, "image_1.png"), "img1");
    writeFileSync(join(imgDir, "image_2.png"), "img2");

    // path uses {n} placeholder pattern; wildcard replaces it with *
    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("image_generation", "image", join(imgDir, "image_{n}.png"), "image"),
    ]);

    const result = await resolveArtifactRef(tmpRoot, "image_generation.image.*", outputDefs);
    expect(result.content).toBeTruthy();
    expect(result.content).toContain("img0");
    expect(result.content).toContain("img1");
    expect(result.content).toContain("img2");
    expect(result.warning).toBeUndefined();
  });

  it("returns null with warning when no files match wildcard pattern", async () => {
    const imgDir = join(tmpRoot, "images");
    mkdirSync(imgDir, { recursive: true });

    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("image_generation", "image", join(imgDir, "image_{n}.png"), "image"),
    ]);

    const result = await resolveArtifactRef(tmpRoot, "image_generation.image.*", outputDefs);
    expect(result.content).toBeNull();
    expect(result.warning).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — indexed ref
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — indexed ref", () => {
  it("resolves correct file by fanOutIndex", async () => {
    const imgDir = join(tmpRoot, "images");
    mkdirSync(imgDir, { recursive: true });
    writeFileSync(join(imgDir, "image_0.png"), "img-zero");
    writeFileSync(join(imgDir, "image_1.png"), "img-one");

    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("image_generation", "image", join(imgDir, "image_{n}.png"), "image"),
    ]);

    const result0 = await resolveArtifactRef(tmpRoot, "image_generation.image[{n}]", outputDefs, 0);
    expect(result0.content).toBe("img-zero");

    const result1 = await resolveArtifactRef(tmpRoot, "image_generation.image[{n}]", outputDefs, 1);
    expect(result1.content).toBe("img-one");
  });

  it("returns null with warning when indexed file is missing", async () => {
    const imgDir = join(tmpRoot, "images");
    mkdirSync(imgDir, { recursive: true });

    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("image_generation", "image", join(imgDir, "image_{n}.png"), "image"),
    ]);

    const result = await resolveArtifactRef(tmpRoot, "image_generation.image[{n}]", outputDefs, 5);
    expect(result.content).toBeNull();
    expect(result.warning).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — JSON path ref
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — JSON path ref", () => {
  it("reads file, parses JSON, and extracts sub-path value", async () => {
    const shotList = {
      scenes: [
        { id: "scene_0", prompt: "A wide shot of the city" },
        { id: "scene_1", prompt: "Close-up on a face" },
      ],
    };
    const filePath = join(tmpRoot, "shot_list.json");
    writeFileSync(filePath, JSON.stringify(shotList));

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("screenplay", "shot_list", filePath, "json")]);

    // ref: "screenplay.shot_list.scenes[{n}]" with fanOutIndex=0 → jsonPath + index
    const result = await resolveArtifactRef(tmpRoot, "screenplay.shot_list.scenes[{n}]", outputDefs, 0);
    expect(result.content).toBeTruthy();
    // Content should be the serialized scene at index 0
    const parsed = JSON.parse(result.content!);
    expect(parsed.id).toBe("scene_0");
    expect(parsed.prompt).toBe("A wide shot of the city");
  });

  it("returns null with warning for invalid JSON in jsonPath ref", async () => {
    const filePath = join(tmpRoot, "bad.json");
    writeFileSync(filePath, "not json {{");

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("screenplay", "shot_list", filePath, "json")]);

    const result = await resolveArtifactRef(tmpRoot, "screenplay.shot_list.scenes[{n}]", outputDefs, 0);
    expect(result.content).toBeNull();
    expect(result.warning).toBeTruthy();
  });

  it("extracts a simple sub-path property (no index)", async () => {
    const data = { title: "My Report", sections: ["intro", "body", "conclusion"] };
    const filePath = join(tmpRoot, "report_meta.json");
    writeFileSync(filePath, JSON.stringify(data));

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("planning", "report_meta", filePath, "json")]);

    // ref: "planning.report_meta.title"
    const result = await resolveArtifactRef(tmpRoot, "planning.report_meta.title", outputDefs);
    expect(result.content).toBe("My Report");
  });
});

// ---------------------------------------------------------------------------
// validateArtifact
// ---------------------------------------------------------------------------

describe("validateArtifact", () => {
  it("returns valid:true when content matches the JSON schema", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    };
    const schemaFile = "schema.json";
    writeFileSync(join(packDir, schemaFile), JSON.stringify(schema));

    const content = JSON.stringify({ name: "test", count: 3 });
    const result = await validateArtifact(content, schemaFile, packDir);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns valid:false with error when content is not valid JSON", async () => {
    const schema = { type: "object" };
    writeFileSync(join(packDir, "schema.json"), JSON.stringify(schema));

    const result = await validateArtifact("not-json{{", "schema.json", packDir);
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns valid:false with error when content fails schema validation", async () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    };
    writeFileSync(join(packDir, "schema.json"), JSON.stringify(schema));

    // Missing required "name" field
    const content = JSON.stringify({ count: 5 });
    const result = await validateArtifact(content, "schema.json", packDir);
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns valid:false when schema file does not exist", async () => {
    const result = await validateArtifact("{}", "nonexistent-schema.json", packDir);
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// bridgeArtifactsForPhase
// ---------------------------------------------------------------------------

describe("bridgeArtifactsForPhase", () => {
  it("injects resolved artifact content into subtask description", async () => {
    const conceptFile = join(tmpRoot, "concept.md");
    writeFileSync(conceptFile, "The concept content goes here.");

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("concept", "concept_doc", conceptFile)]);

    const subtasks: Record<string, string> = {
      "sub-1": "Original description.",
    };

    const mockDb = {
      run: (sql: string, ...args: unknown[]) => {
        // Capture description updates — the UPDATE call is:
        // UPDATE subtasks SET description = ? WHERE id = ? AND task_id = ?
        if (sql.includes("UPDATE subtasks")) {
          const [newDesc, subtaskId] = args as [string, string];
          subtasks[subtaskId] = newDesc;
        }
      },
      get: (_sql: string, ..._args: unknown[]) => {
        // Return the first (and only) subtask row
        return { id: "sub-1", description: subtasks["sub-1"] ?? null };
      },
    };

    const ctx: ArtifactBridgeContext = {
      taskId: "task-abc",
      rootDir: tmpRoot,
      packDir,
    };

    const result = await bridgeArtifactsForPhase(
      mockDb,
      ctx,
      "screenplay",
      [{ name: "concept_doc", from: "concept.concept_doc" }],
      outputDefs,
      undefined,
    );

    expect(result.bridged).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(subtasks["sub-1"]).toContain("Original description.");
    expect(subtasks["sub-1"]).toContain("concept_doc");
    expect(subtasks["sub-1"]).toContain("The concept content goes here.");
  });

  it("returns bridged:false and warns when artifact file is missing", async () => {
    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("concept", "concept_doc", join(tmpRoot, "missing.md")),
    ]);

    const mockDb = {
      run: () => {},
      get: () => ({ description: "Original." }),
    };

    const ctx: ArtifactBridgeContext = {
      taskId: "task-xyz",
      rootDir: tmpRoot,
      packDir,
    };

    const result = await bridgeArtifactsForPhase(
      mockDb,
      ctx,
      "screenplay",
      [{ name: "concept_doc", from: "concept.concept_doc" }],
      outputDefs,
    );

    expect(result.bridged).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("skips pack input refs and still succeeds", async () => {
    const outputDefs = new Map<string, PhaseOutput>();

    const mockDb = {
      run: () => {},
      get: () => ({ description: "Base description." }),
    };

    const ctx: ArtifactBridgeContext = {
      taskId: "task-pack",
      rootDir: tmpRoot,
      packDir,
    };

    const result = await bridgeArtifactsForPhase(
      mockDb,
      ctx,
      "phase_b",
      [{ name: "depth", from: "input.depth" }],
      outputDefs,
    );

    // Pack inputs are skipped; no file needed → no warnings, bridged=true (nothing to inject)
    expect(result.warnings).toHaveLength(0);
  });

  it("injects resolved artifacts and warns for missing ones (mixed results)", async () => {
    const presentFile = join(tmpRoot, "present.md");
    writeFileSync(presentFile, "Present content.");

    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("phase_a", "present_doc", presentFile),
      makeOutput("phase_a", "missing_doc", join(tmpRoot, "does_not_exist.md")),
    ]);

    const subtasks: Record<string, string> = { "sub-1": "Initial description." };

    const mockDb = {
      run: (sql: string, ...args: unknown[]) => {
        if (sql.includes("UPDATE subtasks")) {
          const [newDesc, subtaskId] = args as [string, string];
          subtasks[subtaskId as string] = newDesc as string;
        }
      },
      get: (_sql: string, ..._args: unknown[]) => ({ id: "sub-1", description: subtasks["sub-1"] ?? null }),
    };

    const ctx: ArtifactBridgeContext = { taskId: "task-mixed", rootDir: tmpRoot, packDir };

    const result = await bridgeArtifactsForPhase(
      mockDb,
      ctx,
      "synthesis",
      [
        { name: "present_doc", from: "phase_a.present_doc" },
        { name: "missing_doc", from: "phase_a.missing_doc" },
      ],
      outputDefs,
    );

    // Resolved artifact should be injected; missing one should produce a warning
    expect(result.bridged).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/missing_doc|does_not_exist\.md/i);
    expect(subtasks["sub-1"]).toContain("Present content.");
    expect(subtasks["sub-1"]).toContain("present_doc");
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — multiple wildcards in same dir
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — multiple wildcards in same dir", () => {
  it("collects scene_0 through scene_4 files in sorted order", async () => {
    const imgDir = join(tmpRoot, "video_output", "images");
    mkdirSync(imgDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(imgDir, `scene_${i}.png`), `scene-content-${i}`);
    }
    // Also write a non-matching file to ensure filtering works
    writeFileSync(join(imgDir, "scene_extra.txt"), "should not appear");

    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("image_gen", "scene", join(imgDir, "scene_{n}.png"), "image"),
    ]);

    const result = await resolveArtifactRef(tmpRoot, "image_gen.scene.*", outputDefs);
    expect(result.content).toBeTruthy();
    expect(result.warning).toBeUndefined();

    // All five scene files should appear in order
    for (let i = 0; i < 5; i++) {
      expect(result.content).toContain(`scene-content-${i}`);
    }

    // Non-matching file must not appear
    expect(result.content).not.toContain("should not appear");

    // Verify order: scene_0 appears before scene_4
    const idx0 = result.content!.indexOf("scene-content-0");
    const idx4 = result.content!.indexOf("scene-content-4");
    expect(idx0).toBeLessThan(idx4);
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — rootDir with trailing slash
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — rootDir with trailing slash", () => {
  it("does not produce a double-slash path when rootDir has trailing slash", async () => {
    const filePath = "concept.md"; // relative path in output def
    const absFilePath = join(tmpRoot, filePath);
    writeFileSync(absFilePath, "Trailing slash content.");

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("concept", "concept_doc", filePath)]);

    // rootDir with trailing slash
    const rootDirWithSlash = tmpRoot + "/";
    const result = await resolveArtifactRef(rootDirWithSlash, "concept.concept_doc", outputDefs);
    expect(result.content).toBe("Trailing slash content.");
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — absolute path in output def
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — absolute path in output def", () => {
  it("uses absolute path directly when it is within rootDir", async () => {
    const absFilePath = join(tmpRoot, "absolute_target.md");
    writeFileSync(absFilePath, "Absolute path content.");

    // The output def path is already absolute (starts with "/")
    const outputDefs = new Map<string, PhaseOutput>([
      makeOutput("phase_x", "abs_doc", absFilePath), // absFilePath already starts with "/"
    ]);

    // Use tmpRoot as rootDir so the absolute path is within bounds
    const result = await resolveArtifactRef(tmpRoot, "phase_x.abs_doc", outputDefs);
    expect(result.content).toBe("Absolute path content.");
    expect(result.warning).toBeUndefined();
  });

  it("rejects absolute path that escapes rootDir", async () => {
    const absFilePath = join(tmpRoot, "absolute_target.md");
    writeFileSync(absFilePath, "Absolute path content.");

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("phase_x", "abs_doc", absFilePath)]);

    // Use a different rootDir to verify the boundary check blocks access
    const differentRoot = join(tmpRoot, "other_dir");
    mkdirSync(differentRoot, { recursive: true });

    const result = await resolveArtifactRef(differentRoot, "phase_x.abs_doc", outputDefs);
    expect(result.content).toBeNull();
    expect(result.warning).toMatch(/escapes project root/);
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — JSON path to nested object property (not array)
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — JSON path nested object property", () => {
  it("extracts a string value from a deeply nested object property", async () => {
    const data = {
      planning: {
        strategy: {
          metadata: {
            title: "Deep nested title",
            version: 3,
          },
        },
      },
    };
    const filePath = join(tmpRoot, "strategy.json");
    writeFileSync(filePath, JSON.stringify(data));

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("planning", "strategy", filePath, "json")]);

    // ref: "planning.strategy.planning.strategy.metadata.title"
    const result = await resolveArtifactRef(tmpRoot, "planning.strategy.planning.strategy.metadata.title", outputDefs);
    expect(result.content).toBe("Deep nested title");
    expect(result.warning).toBeUndefined();
  });

  it("extracts a numeric value from nested object and returns it as string", async () => {
    const data = { meta: { stats: { count: 42 } } };
    const filePath = join(tmpRoot, "meta.json");
    writeFileSync(filePath, JSON.stringify(data));

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("planning", "meta", filePath, "json")]);

    const result = await resolveArtifactRef(tmpRoot, "planning.meta.meta.stats.count", outputDefs);
    expect(result.content).toBe("42");
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — empty file content
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — empty file content", () => {
  it("returns empty string (not null) when file exists but is empty", async () => {
    const filePath = join(tmpRoot, "empty.md");
    writeFileSync(filePath, ""); // explicitly empty

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("phase_a", "empty_doc", filePath)]);

    const result = await resolveArtifactRef(tmpRoot, "phase_a.empty_doc", outputDefs);
    expect(result.content).toBe("");
    expect(result.content).not.toBeNull();
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactRef — binary-like content
// ---------------------------------------------------------------------------

describe("resolveArtifactRef — binary-like content", () => {
  it("handles file with non-UTF8 bytes gracefully (no throw)", async () => {
    const filePath = join(tmpRoot, "binary.bin");
    // Write raw bytes that are not valid UTF-8 sequences
    const binaryBuffer = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0xd8, 0x00]);
    writeFileSync(filePath, binaryBuffer);

    const outputDefs = new Map<string, PhaseOutput>([makeOutput("phase_bin", "bin_doc", filePath)]);

    // Should not throw — either returns content (with replacement chars) or null with warning
    const result = await resolveArtifactRef(tmpRoot, "phase_bin.bin_doc", outputDefs);
    // The key requirement: no unhandled exception; result is a valid object
    expect(result).toBeDefined();
    expect(typeof result.content === "string" || result.content === null).toBe(true);
  });
});
