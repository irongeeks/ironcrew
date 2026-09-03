import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { PackLoader } from "../../packs/pack-loader.ts";

// ---------------------------------------------------------------------------
// Resolve the built-in packs directory relative to this test file.
// __dirname is not available in ESM; derive from import.meta.url instead.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/test/packs/ → server/packs/built-in/
const BUILT_IN_DIR = path.resolve(__dirname, "../../packs/built-in");
const COMMUNITY_DIR = path.resolve(__dirname, "../../packs/community");

// ---------------------------------------------------------------------------
// Expected built-in packs
// ---------------------------------------------------------------------------

const EXPECTED_BUILT_IN_PACK_KEYS = ["video_preprod", "web_research_report", "design_studio", "development"] as const;

const EXPECTED_COMMUNITY_PACK_KEYS = [] as const;

const EXPECTED_PACK_KEYS = [...EXPECTED_BUILT_IN_PACK_KEYS, ...EXPECTED_COMMUNITY_PACK_KEYS] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Built-in pack YAML files", () => {
  it("loads all built-in and community packs without error", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const loadedKeys = packs.map((p) => p.key).sort();
    const expectedSorted = [...EXPECTED_PACK_KEYS].sort();

    expect(loadedKeys).toEqual(expectedSorted);
  });

  it("all built-in packs pass Zod schema validation", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    for (const pack of packs) {
      expect(pack.definition.pack.schema_version).toBe(1);
      expect(pack.definition.pack.key).toMatch(/^[a-z_]+$/);
      expect(pack.definition.pack.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pack.definition.phases.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("all built-in packs have a valid graph (no cycles, no orphans)", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    for (const pack of packs) {
      expect(pack.graph.packKey).toBe(pack.key);
      expect(pack.graph.phases.length).toBe(pack.definition.phases.length);
      expect(pack.graph.roots.length).toBeGreaterThanOrEqual(1);
      expect(pack.graph.terminals.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("all packs are marked with correct source", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const builtInKeys = new Set<string>(EXPECTED_BUILT_IN_PACK_KEYS);
    for (const pack of packs) {
      const expectedSource = builtInKeys.has(pack.key) ? "built-in" : "community";
      expect(pack.source, `Pack ${pack.key} should have source=${expectedSource}`).toBe(expectedSource);
    }
  });

  // -------------------------------------------------------------------------
  // Per-pack structural checks
  // -------------------------------------------------------------------------

  it("video_preprod has 7 phases in correct order", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const videoPack = packs.find((p) => p.key === "video_preprod");
    expect(videoPack).toBeDefined();

    const phaseIds = videoPack!.graph.phases.map((p) => p.id);
    expect(phaseIds).toHaveLength(7);
    expect(phaseIds[0]).toBe("concept");
    expect(phaseIds[phaseIds.length - 1]).toBe("assembly");
  });

  it("video_preprod concept phase has gate=user_approval", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const videoPack = packs.find((p) => p.key === "video_preprod");
    expect(videoPack).toBeDefined();

    const conceptPhase = videoPack!.definition.phases.find((p) => p.id === "concept");
    expect(conceptPhase).toBeDefined();
    expect(conceptPhase!.gate).toBe("user_approval");
  });

  it("video_preprod image_generation and video_generation phases have fan_out", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const videoPack = packs.find((p) => p.key === "video_preprod");
    expect(videoPack).toBeDefined();

    const imageGen = videoPack!.definition.phases.find((p) => p.id === "image_generation");
    expect(imageGen?.fan_out).toBeDefined();

    const videoGen = videoPack!.definition.phases.find((p) => p.id === "video_generation");
    expect(videoGen?.fan_out).toBeDefined();
  });

  it("video_preprod image_review has on_review_fail configured", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const videoPack = packs.find((p) => p.key === "video_preprod");
    expect(videoPack).toBeDefined();

    const imageReview = videoPack!.definition.phases.find((p) => p.id === "image_review");
    expect(imageReview?.on_review_fail).toBeDefined();
    expect(imageReview?.on_review_fail?.rerun).toBe("image_generation");
    expect(imageReview?.on_review_fail?.max_passes).toBe(2);
  });

  it("web_research_report has 5 phases with correct department routing", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const researchPack = packs.find((p) => p.key === "web_research_report");
    expect(researchPack).toBeDefined();

    const phases = researchPack!.definition.phases;
    expect(phases).toHaveLength(5);

    const deptMap: Record<string, string> = {};
    for (const phase of phases) {
      deptMap[phase.id] = phase.department;
    }

    expect(deptMap["planning"]).toBe("strategy");
    expect(deptMap["crawl"]).toBe("fieldwork");
    expect(deptMap["synthesis"]).toBe("strategy");
    expect(deptMap["fact_check"]).toBe("verification");
    expect(deptMap["final_report"]).toBe("verification");
  });

  it("web_research_report crawl phase has fan_out and web_search capability", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const researchPack = packs.find((p) => p.key === "web_research_report");
    expect(researchPack).toBeDefined();

    const crawlPhase = researchPack!.definition.phases.find((p) => p.id === "crawl");
    expect(crawlPhase?.fan_out).toBeDefined();
    expect(crawlPhase?.capability).toBe("web_search");
  });

  it("web_research_report depth input field has none/quick/standard/deep enum", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const researchPack = packs.find((p) => p.key === "web_research_report");
    expect(researchPack).toBeDefined();

    const depthField = researchPack!.definition.input.optional?.find((f) => f.key === "depth");
    expect(depthField).toBeDefined();
    expect(depthField!.enum).toEqual(["none", "quick", "standard", "deep"]);
  });

  it("design_studio has 4 phases with pack-specific departments", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const designPack = packs.find((p) => p.key === "design_studio");
    expect(designPack).toBeDefined();
    expect(designPack!.definition.phases).toHaveLength(4);

    const phaseIds = designPack!.definition.phases.map((p) => p.id);
    expect(phaseIds).toEqual(["brief", "exploration", "execution", "handoff"]);
  });

  it("development has 7 phases (research → analysis → planning → architecture → implementation → testing → review)", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const devPack = packs.find((p) => p.key === "development");
    expect(devPack).toBeDefined();
    expect(devPack!.definition.phases).toHaveLength(7);

    const phaseIds = devPack!.definition.phases.map((p) => p.id);
    expect(phaseIds).toEqual([
      "research",
      "analysis",
      "planning",
      "architecture",
      "implementation",
      "testing",
      "review",
    ]);
  });

  it("all packs with staff have at least one team_leader", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    for (const pack of packs) {
      const staff = pack.definition.staff;
      if (!staff || staff.name_pool.length === 0) continue;

      const hasLeader = staff.name_pool.some((m) => m.role === "team_leader");
      expect(hasLeader, `Pack ${pack.key} should have at least one team_leader`).toBe(true);
    }
  });

  it("all packs have cost_profile with valid default_reasoning", async () => {
    const loader = new PackLoader();
    const packs = await loader.loadAll(BUILT_IN_DIR, COMMUNITY_DIR);

    const validReasoning = ["low", "medium", "high"];
    for (const pack of packs) {
      const reasoning = pack.definition.cost_profile?.default_reasoning;
      if (reasoning !== undefined) {
        expect(validReasoning, `Pack ${pack.key} has invalid default_reasoning: ${reasoning}`).toContain(reasoning);
      }
    }
  });
});
