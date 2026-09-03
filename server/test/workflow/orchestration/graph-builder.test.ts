import { describe, it, expect } from "vitest";
import {
  buildGraph,
  topoSort,
  parseInputRef,
  assertAcyclic,
  assertReferentialIntegrity,
  PackValidationError,
} from "../../../packs/graph-builder.ts";
import type { Phase } from "../../../packs/pack-schema.ts";

// ---------------------------------------------------------------------------
// Helpers to build minimal Phase objects
// ---------------------------------------------------------------------------

function makePhase(id: string, inputs: { name: string; from: string }[] = [], outputs: { name: string }[] = []): Phase {
  return {
    id,
    department: "test",
    guidance: `guidance/${id}.{lang}.md`,
    capability_mode: "hybrid",
    gate: "auto",
    inputs,
    outputs: outputs.map((o) => ({ ...o, type: "markdown" as const, path: `output/${o.name}.md` })),
  };
}

// ---------------------------------------------------------------------------
// parseInputRef
// ---------------------------------------------------------------------------

describe("parseInputRef", () => {
  it("parses simple phase.output reference", () => {
    const result = parseInputRef("concept.concept_doc");
    expect(result).toEqual({
      sourcePhaseId: "concept",
      outputName: "concept_doc",
      isWildcard: false,
      indexPlaceholder: false,
      jsonPath: undefined,
      isPackInput: false,
    });
  });

  it("parses wildcard reference ending with .*", () => {
    const result = parseInputRef("image_generation.image.*");
    expect(result).toMatchObject({
      sourcePhaseId: "image_generation",
      outputName: "image",
      isWildcard: true,
      isPackInput: false,
    });
  });

  it("parses index placeholder reference with [{n}]", () => {
    const result = parseInputRef("screenplay.shot_list.scenes[{n}]");
    expect(result).toMatchObject({
      sourcePhaseId: "screenplay",
      outputName: "shot_list",
      jsonPath: ".scenes[{n}]",
      indexPlaceholder: true,
      isWildcard: false,
      isPackInput: false,
    });
  });

  it("parses sub-path reference with dot notation", () => {
    const result = parseInputRef("screenplay.shot_list.scenes.length");
    expect(result).toMatchObject({
      sourcePhaseId: "screenplay",
      outputName: "shot_list",
      jsonPath: ".scenes.length",
      indexPlaceholder: false,
      isWildcard: false,
      isPackInput: false,
    });
  });

  it("parses pack input reference starting with input.", () => {
    const result = parseInputRef("input.depth");
    expect(result).toMatchObject({
      sourcePhaseId: "input",
      outputName: "depth",
      isPackInput: true,
      isWildcard: false,
      indexPlaceholder: false,
    });
  });
});

// ---------------------------------------------------------------------------
// buildGraph — adjacency & reverse adjacency
// ---------------------------------------------------------------------------

describe("buildGraph — linear chain A → B → C", () => {
  const phases: Phase[] = [
    makePhase("a", [], [{ name: "doc_a" }]),
    makePhase("b", [{ name: "in_b", from: "a.doc_a" }], [{ name: "doc_b" }]),
    makePhase("c", [{ name: "in_c", from: "b.doc_b" }], [{ name: "doc_c" }]),
  ];

  it("builds correct adjacency map", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.adjacency.get("a")).toEqual(["b"]);
    expect(graph.adjacency.get("b")).toEqual(["c"]);
    expect(graph.adjacency.get("c") ?? []).toEqual([]);
  });

  it("builds correct reverse adjacency map", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.reverseAdjacency.get("b")).toEqual(["a"]);
    expect(graph.reverseAdjacency.get("c")).toEqual(["b"]);
    expect(graph.reverseAdjacency.get("a") ?? []).toEqual([]);
  });

  it("identifies correct roots and terminals", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.roots).toEqual(["a"]);
    expect(graph.terminals).toEqual(["c"]);
  });

  it("topo-sort returns [a, b, c]", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.phases.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// buildGraph — fan-out (A → B, A → C)
// ---------------------------------------------------------------------------

describe("buildGraph — fan-out A → B, A → C", () => {
  const phases: Phase[] = [
    makePhase("a", [], [{ name: "data" }]),
    makePhase("b", [{ name: "in", from: "a.data" }], [{ name: "out_b" }]),
    makePhase("c", [{ name: "in", from: "a.data" }], [{ name: "out_c" }]),
  ];

  it("a is upstream of both b and c", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.adjacency.get("a")).toContain("b");
    expect(graph.adjacency.get("a")).toContain("c");
  });

  it("b and c have no common downstream", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.adjacency.get("b") ?? []).toEqual([]);
    expect(graph.adjacency.get("c") ?? []).toEqual([]);
  });

  it("roots = [a], terminals = [b, c]", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.roots).toEqual(["a"]);
    expect(graph.terminals.sort()).toEqual(["b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// buildGraph — fan-in via wildcard (B.* → C)
// ---------------------------------------------------------------------------

describe("buildGraph — fan-in via wildcard B.* → C", () => {
  const phases: Phase[] = [
    makePhase("a", [], [{ name: "data" }]),
    makePhase("b", [{ name: "in", from: "a.data" }], [{ name: "items" }]),
    makePhase("c", [{ name: "all_items", from: "b.items.*" }], [{ name: "result" }]),
  ];

  it("b is upstream of c via wildcard reference", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.adjacency.get("b")).toContain("c");
    expect(graph.reverseAdjacency.get("c")).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// buildGraph — diamond A → B, A → C, B+C → D
// ---------------------------------------------------------------------------

describe("buildGraph — diamond A → B, A → C, B+C → D", () => {
  const phases: Phase[] = [
    makePhase("a", [], [{ name: "root_out" }]),
    makePhase("b", [{ name: "from_a", from: "a.root_out" }], [{ name: "b_out" }]),
    makePhase("c", [{ name: "from_a", from: "a.root_out" }], [{ name: "c_out" }]),
    makePhase(
      "d",
      [
        { name: "from_b", from: "b.b_out" },
        { name: "from_c", from: "c.c_out" },
      ],
      [{ name: "final" }],
    ),
  ];

  it("topo-sort has a first and d last", () => {
    const graph = buildGraph("test_pack", phases);
    const ids = graph.phases.map((p) => p.id);
    expect(ids[0]).toBe("a");
    expect(ids[ids.length - 1]).toBe("d");
  });

  it("topo-sort contains all 4 phases", () => {
    const graph = buildGraph("test_pack", phases);
    expect(graph.phases).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// topoSort standalone
// ---------------------------------------------------------------------------

describe("topoSort", () => {
  it("returns stable ordering for linear chain", () => {
    const phases: Phase[] = [
      makePhase("x", [], [{ name: "out" }]),
      makePhase("y", [{ name: "in", from: "x.out" }], [{ name: "out" }]),
      makePhase("z", [{ name: "in", from: "y.out" }], []),
    ];
    const adjacency = new Map([
      ["x", ["y"]],
      ["y", ["z"]],
      ["z", []],
    ]);
    const order = topoSort(phases, adjacency);
    expect(order).toEqual(["x", "y", "z"]);
  });
});

// ---------------------------------------------------------------------------
// assertAcyclic — cycle detection
// ---------------------------------------------------------------------------

describe("assertAcyclic", () => {
  it("throws PackValidationError for A → B → A cycle", () => {
    const adjacency = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(() => assertAcyclic(adjacency)).toThrowError(PackValidationError);
  });

  it("throws PackValidationError for 3-node cycle A → B → C → A", () => {
    const adjacency = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    expect(() => assertAcyclic(adjacency)).toThrowError(PackValidationError);
  });

  it("does not throw for a valid DAG", () => {
    const adjacency = new Map([
      ["a", ["b", "c"]],
      ["b", ["d"]],
      ["c", ["d"]],
      ["d", []],
    ]);
    expect(() => assertAcyclic(adjacency)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildGraph — cycle throws PackValidationError
// ---------------------------------------------------------------------------

describe("buildGraph — cycle detection", () => {
  it("throws PackValidationError when phases form a cycle", () => {
    const phases: Phase[] = [
      makePhase("a", [{ name: "in", from: "b.out_b" }], [{ name: "out_a" }]),
      makePhase("b", [{ name: "in", from: "a.out_a" }], [{ name: "out_b" }]),
    ];
    expect(() => buildGraph("cyclic_pack", phases)).toThrowError(PackValidationError);
  });
});

// ---------------------------------------------------------------------------
// assertNoOrphans — orphan detection
// ---------------------------------------------------------------------------

describe("assertNoOrphans", () => {
  it("throws PackValidationError for a disconnected orphan phase", () => {
    const phases: Phase[] = [
      makePhase("a", [], [{ name: "out" }]),
      makePhase("b", [{ name: "in", from: "a.out" }], []),
      makePhase("orphan", [], [{ name: "isolated" }]), // no one depends on this, and it depends on no one
    ];
    expect(() => buildGraph("orphan_pack", phases)).toThrowError(PackValidationError);
  });

  it("does not throw when all phases are reachable from roots", () => {
    const phases: Phase[] = [
      makePhase("a", [], [{ name: "out" }]),
      makePhase("b", [{ name: "in", from: "a.out" }], []),
    ];
    expect(() => buildGraph("connected_pack", phases)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertReferentialIntegrity
// ---------------------------------------------------------------------------

describe("assertReferentialIntegrity", () => {
  it("throws PackValidationError when referencing a non-existent phase", () => {
    const phases: Phase[] = [makePhase("a", [{ name: "in", from: "nonexistent.output" }], [])];
    expect(() => assertReferentialIntegrity(phases)).toThrowError(PackValidationError);
  });

  it("throws PackValidationError when referencing a non-existent output on an existing phase", () => {
    const phases: Phase[] = [
      makePhase("a", [], [{ name: "real_output" }]),
      makePhase("b", [{ name: "in", from: "a.fake_output" }], []),
    ];
    expect(() => assertReferentialIntegrity(phases)).toThrowError(PackValidationError);
  });

  it("does not throw for valid cross-phase references", () => {
    const phases: Phase[] = [
      makePhase("a", [], [{ name: "doc" }]),
      makePhase("b", [{ name: "in", from: "a.doc" }], []),
    ];
    expect(() => assertReferentialIntegrity(phases)).not.toThrow();
  });

  it("does not throw for pack input references (input.*)", () => {
    const phases: Phase[] = [makePhase("a", [{ name: "depth", from: "input.depth" }], [])];
    expect(() => assertReferentialIntegrity(phases)).not.toThrow();
  });

  it("does not throw for wildcard references pointing to valid phase+output", () => {
    const phases: Phase[] = [
      makePhase("a", [], [{ name: "items" }]),
      makePhase("b", [{ name: "all", from: "a.items.*" }], []),
    ];
    expect(() => assertReferentialIntegrity(phases)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// on_review_fail.rerun upstream validation
// ---------------------------------------------------------------------------

describe("on_review_fail.rerun upstream validation", () => {
  it("throws PackValidationError when rerun targets a downstream phase", () => {
    const phases: Phase[] = [
      makePhase("generate", [], [{ name: "image" }]),
      {
        ...makePhase("review", [{ name: "img", from: "generate.image" }], [{ name: "result" }]),
        on_review_fail: { rerun: "assemble", max_passes: 2, flag_output: "flags.json" },
      },
      makePhase("assemble", [{ name: "r", from: "review.result" }], []),
    ];
    expect(() => buildGraph("bad_rerun", phases)).toThrowError(PackValidationError);
  });

  it("throws PackValidationError when rerun targets an unrelated phase", () => {
    const phases: Phase[] = [
      makePhase("phase_a", [], [{ name: "out_a" }]),
      makePhase("phase_b", [], [{ name: "out_b" }]),
      {
        ...makePhase("review", [{ name: "in", from: "phase_a.out_a" }], [{ name: "result" }]),
        on_review_fail: { rerun: "phase_b", max_passes: 2, flag_output: "flags.json" },
      },
    ];
    // phase_b is not upstream of review (review only depends on phase_a)
    expect(() => buildGraph("unrelated_rerun", phases)).toThrowError(PackValidationError);
  });

  it("accepts rerun targeting a direct upstream phase", () => {
    const phases: Phase[] = [
      makePhase("generate", [], [{ name: "image" }]),
      {
        ...makePhase("review", [{ name: "img", from: "generate.image" }], [{ name: "result" }]),
        on_review_fail: { rerun: "generate", max_passes: 2, flag_output: "flags.json" },
      },
    ];
    expect(() => buildGraph("valid_rerun", phases)).not.toThrow();
  });

  it("accepts rerun targeting a transitive upstream phase", () => {
    const phases: Phase[] = [
      makePhase("concept", [], [{ name: "doc" }]),
      makePhase("generate", [{ name: "c", from: "concept.doc" }], [{ name: "image" }]),
      {
        ...makePhase("review", [{ name: "img", from: "generate.image" }], [{ name: "result" }]),
        on_review_fail: { rerun: "concept", max_passes: 2, flag_output: "flags.json" },
      },
    ];
    expect(() => buildGraph("transitive_rerun", phases)).not.toThrow();
  });

  it("accepts self-referencing rerun", () => {
    const phases: Phase[] = [
      makePhase("generate", [], [{ name: "image" }]),
      {
        ...makePhase("review", [{ name: "img", from: "generate.image" }], [{ name: "result" }]),
        on_review_fail: { rerun: "review", max_passes: 2, flag_output: "flags.json" },
      },
    ];
    expect(() => buildGraph("self_rerun", phases)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Root and terminal identification edge cases
// ---------------------------------------------------------------------------

describe("root and terminal identification", () => {
  it("single-phase pack has same phase as root and terminal", () => {
    const phases: Phase[] = [makePhase("solo", [], [{ name: "out" }])];
    const graph = buildGraph("solo_pack", phases);
    expect(graph.roots).toEqual(["solo"]);
    expect(graph.terminals).toEqual(["solo"]);
  });

  it("pack input references do not make a phase a non-root", () => {
    // a phase that only consumes pack inputs (input.*) is still a root
    const phases: Phase[] = [
      makePhase("a", [{ name: "depth", from: "input.depth" }], [{ name: "out" }]),
      makePhase("b", [{ name: "in", from: "a.out" }], []),
    ];
    const graph = buildGraph("pack_input_pack", phases);
    expect(graph.roots).toEqual(["a"]);
    expect(graph.terminals).toEqual(["b"]);
  });
});
