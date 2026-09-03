import { describe, it, expect } from "vitest";
import { deserializePack, type PhaseNodeData } from "../pack-deserializer";
import type { PackDefinitionResponse } from "../types";

const SIMPLE_PACK: PackDefinitionResponse = {
  key: "development",
  source: "built-in",
  definition: {
    pack: {
      key: "development",
      name: { en: "Development" },
      version: "1.0.0",
      schema_version: 1,
      description: { en: "Dev" },
    },
    input: { required: [], optional: [] },
    phases: [
      {
        id: "implementation",
        department: "dev",
        guidance: "guidance/implementation.{lang}.md",
        inputs: [],
        outputs: [{ name: "summary", type: "markdown", path: "dev_output/summary.md" }],
      },
    ],
  },
  guidanceLanguages: { implementation: ["en"] },
};

const MULTI_PHASE_PACK: PackDefinitionResponse = {
  key: "web_research_report",
  source: "built-in",
  definition: {
    pack: {
      key: "web_research_report",
      name: { en: "Web Research" },
      version: "1.0.0",
      schema_version: 1,
      description: { en: "Research" },
    },
    input: { required: [], optional: [] },
    phases: [
      {
        id: "planning",
        department: "planning",
        guidance: "guidance/planning.{lang}.md",
        inputs: [],
        outputs: [{ name: "search_strategy", type: "json", path: "research_output/search_strategy.json" }],
      },
      {
        id: "crawl",
        department: "dev",
        guidance: "guidance/crawl.{lang}.md",
        fan_out: { count_from: "planning.search_strategy.sub_questions.length" },
        inputs: [{ name: "strategy", from: "planning.search_strategy" }],
        outputs: [{ name: "findings", type: "markdown", path: "research_output/findings/crawler_{n}.md" }],
      },
      {
        id: "synthesis",
        department: "planning",
        guidance: "guidance/synthesis.{lang}.md",
        inputs: [
          { name: "findings", from: "crawl.findings" },
          { name: "strategy", from: "planning.search_strategy" },
        ],
        outputs: [{ name: "draft_report", type: "markdown", path: "research_output/draft_report.md" }],
      },
    ],
  },
  guidanceLanguages: { planning: ["en"], crawl: ["en"], synthesis: ["en"] },
};

describe("deserializePack", () => {
  it("creates one node for a single-phase pack", () => {
    const { nodes, edges } = deserializePack(SIMPLE_PACK);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("implementation");
    expect(nodes[0].type).toBe("phaseNode");
    expect((nodes[0].data as unknown as PhaseNodeData).phase.id).toBe("implementation");
    expect(edges).toHaveLength(0);
  });

  it("creates nodes and edges for a multi-phase pack", () => {
    const { nodes, edges } = deserializePack(MULTI_PHASE_PACK);
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.id)).toEqual(["planning", "crawl", "synthesis"]);

    // crawl.strategy ← planning.search_strategy
    const edge1 = edges.find((e) => e.target === "crawl" && e.source === "planning");
    expect(edge1).toBeDefined();
    expect(edge1!.sourceHandle).toBe("output-search_strategy");
    expect(edge1!.targetHandle).toBe("input-strategy");

    // synthesis.findings ← crawl.findings
    const edge2 = edges.find((e) => e.target === "synthesis" && e.source === "crawl");
    expect(edge2).toBeDefined();

    // synthesis.strategy ← planning.search_strategy
    const edge3 = edges.find(
      (e) => e.target === "synthesis" && e.source === "planning" && e.targetHandle === "input-strategy",
    );
    expect(edge3).toBeDefined();
  });

  it("marks fan-out nodes with fanOutGroup type", () => {
    const { nodes } = deserializePack(MULTI_PHASE_PACK);
    const crawlNode = nodes.find((n) => n.id === "crawl");
    expect(crawlNode!.type).toBe("fanOutGroup");
    expect((crawlNode!.data as unknown as PhaseNodeData).phase.fan_out).toBeDefined();
  });

  it("assigns dagre-computed positions", () => {
    const { nodes } = deserializePack(MULTI_PHASE_PACK);
    for (const node of nodes) {
      expect(typeof node.position.x).toBe("number");
      expect(typeof node.position.y).toBe("number");
    }
    // planning (root) should be above crawl and synthesis (TB layout)
    const planning = nodes.find((n) => n.id === "planning")!;
    const crawl = nodes.find((n) => n.id === "crawl")!;
    expect(planning.position.y).toBeLessThan(crawl.position.y);
  });

  it("uses saved positions when provided", () => {
    const saved = { implementation: { x: 100, y: 200 } };
    const { nodes } = deserializePack(SIMPLE_PACK, saved);
    expect(nodes[0].position).toEqual({ x: 100, y: 200 });
  });

  it("falls back to dagre when saved positions are null", () => {
    const { nodes: withNull } = deserializePack(MULTI_PHASE_PACK, null);
    const { nodes: withoutArg } = deserializePack(MULTI_PHASE_PACK);
    expect(withNull[0].position.x).toBe(withoutArg[0].position.x);
  });
});
