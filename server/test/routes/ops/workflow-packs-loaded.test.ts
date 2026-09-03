import { describe, it, expect } from "vitest";
import { extractPhases } from "../../../modules/routes/ops/workflow-packs.ts";
import type { LoadedPack } from "../../../packs/pack-loader.ts";

// ---------------------------------------------------------------------------
// Helpers — minimal LoadedPack stubs
// ---------------------------------------------------------------------------

function stubPack(phases: LoadedPack["definition"]["phases"], overrides?: Partial<LoadedPack>): LoadedPack {
  return {
    key: "test_pack",
    source: "built-in",
    definition: {
      pack: {
        key: "test_pack",
        name: { en: "Test Pack" },
        version: "1.0.0",
        description: { en: "test" },
        schema_version: 1 as const,
        agent_routing: "department" as const,
      },
      input: { required: [], optional: [] },
      phases,
      cost_profile: { max_rounds: 3, default_reasoning: "medium" as const },
    } as LoadedPack["definition"],
    graph: {
      packKey: "test_pack",
      phases,
      adjacency: new Map(),
      reverseAdjacency: new Map(),
      roots: phases.length ? [phases[0].id] : [],
      terminals: phases.length ? [phases[phases.length - 1].id] : [],
    } as LoadedPack["graph"],
    guidanceCache: new Map(),
    sharedGuidanceCache: new Map(),
    ...overrides,
  };
}

function minimalPhase(id: string, department: string, fanOut?: boolean): LoadedPack["definition"]["phases"][number] {
  return {
    id,
    department,
    guidance: `guidance/${id}.{lang}.md`,
    capability_mode: "agent" as const,
    gate: "auto" as const,
    inputs: [],
    outputs: [],
    ...(fanOut ? { fan_out: { count_from: "previous.output.length" } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractPhases", () => {
  it("extracts id and department from all phases", () => {
    const pack = stubPack([
      minimalPhase("research", "research"),
      minimalPhase("analysis", "research"),
      minimalPhase("planning", "planning"),
      minimalPhase("implementation", "dev"),
    ]);

    const result = extractPhases(pack);

    expect(result).toEqual([
      { id: "research", department: "research" },
      { id: "analysis", department: "research" },
      { id: "planning", department: "planning" },
      { id: "implementation", department: "dev" },
    ]);
  });

  it("marks fan-out phases with fanOut: true", () => {
    const pack = stubPack([
      minimalPhase("planning", "strategy"),
      minimalPhase("crawl", "fieldwork", true),
      minimalPhase("synthesis", "strategy"),
    ]);

    const result = extractPhases(pack);

    expect(result).toEqual([
      { id: "planning", department: "strategy" },
      { id: "crawl", department: "fieldwork", fanOut: true },
      { id: "synthesis", department: "strategy" },
    ]);
  });

  it("does not include fanOut key when phase has no fan_out", () => {
    const pack = stubPack([minimalPhase("review", "qa")]);
    const result = extractPhases(pack);

    expect(result).toEqual([{ id: "review", department: "qa" }]);
    expect("fanOut" in result[0]).toBe(false);
  });

  it("uses actual pack.yaml department names (not legacy aliases)", () => {
    // Mirrors the real web-research pack.yaml departments
    const pack = stubPack([
      minimalPhase("planning", "strategy"),
      minimalPhase("crawl", "fieldwork", true),
      minimalPhase("synthesis", "strategy"),
      minimalPhase("fact_check", "verification"),
      minimalPhase("final_report", "verification"),
    ]);

    const result = extractPhases(pack);

    // Should use actual department names, not hardcoded legacy values
    expect(result.map((p) => p.department)).toEqual([
      "strategy",
      "fieldwork",
      "strategy",
      "verification",
      "verification",
    ]);
  });

  it("returns empty array for pack with no phases", () => {
    const pack = stubPack([]);
    const result = extractPhases(pack);
    expect(result).toEqual([]);
  });
});
