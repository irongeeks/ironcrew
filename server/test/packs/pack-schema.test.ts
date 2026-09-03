import { describe, it, expect } from "vitest";
import {
  PackDefinitionSchema,
  PhaseSchema,
  PhaseOutputSchema,
  PhaseInputSchema,
  OnReviewFailSchema,
  PhaseHooksSchema,
  PackInputFieldSchema,
  CostProfileSchema,
  QaRulesSchema,
  StaffMemberSchema,
  StaffSchema,
} from "../../packs/pack-schema.ts";

const minimalPhase = {
  id: "my_phase",
  department: "dev",
  guidance: "guidance/my_phase.{lang}.md",
};

const minimalPack = {
  pack: {
    key: "my_pack",
    name: { en: "My Pack" },
    version: "1.0.0",
    schema_version: 1,
    description: { en: "A pack" },
  },
  input: {},
  phases: [minimalPhase],
};

describe("PhaseOutputSchema", () => {
  it("accepts valid output definition", () => {
    const valid = { name: "report", type: "markdown", path: "output/report.md" };
    expect(PhaseOutputSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts output with optional schema", () => {
    const valid = { name: "data", type: "json", path: "output/data.json", schema: "DataSchema" };
    expect(PhaseOutputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid type", () => {
    const invalid = { name: "file", type: "pdf", path: "output/file.pdf" };
    expect(PhaseOutputSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts all valid types", () => {
    const types = ["markdown", "json", "image", "video", "audio", "document"] as const;
    for (const type of types) {
      expect(PhaseOutputSchema.safeParse({ name: "x", type, path: "output/x" }).success).toBe(true);
    }
  });
});

describe("PhaseInputSchema", () => {
  it("accepts valid input definition", () => {
    const valid = { name: "report", from: "phase_a" };
    expect(PhaseInputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing from", () => {
    expect(PhaseInputSchema.safeParse({ name: "report" }).success).toBe(false);
  });
});

describe("OnReviewFailSchema", () => {
  it("accepts valid on_review_fail", () => {
    const valid = { rerun: "phase_a", max_passes: 3, flag_output: "flag.json" };
    expect(OnReviewFailSchema.safeParse(valid).success).toBe(true);
  });

  it("defaults max_passes to 2", () => {
    const result = OnReviewFailSchema.safeParse({ rerun: "phase_a", flag_output: "flag.json" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_passes).toBe(2);
    }
  });

  it("rejects max_passes less than 1", () => {
    const invalid = { rerun: "phase_a", max_passes: 0, flag_output: "flag.json" };
    expect(OnReviewFailSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("PhaseHooksSchema", () => {
  it("accepts empty hooks", () => {
    expect(PhaseHooksSchema.safeParse({}).success).toBe(true);
  });

  it("accepts hooks with pre_run and post_run", () => {
    const valid = { pre_run: "scripts/pre.sh", post_run: "scripts/post.sh" };
    expect(PhaseHooksSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts hooks with only one field", () => {
    expect(PhaseHooksSchema.safeParse({ pre_run: "scripts/pre.sh" }).success).toBe(true);
    expect(PhaseHooksSchema.safeParse({ post_run: "scripts/post.sh" }).success).toBe(true);
  });
});

describe("PhaseSchema", () => {
  it("accepts minimal phase", () => {
    expect(PhaseSchema.safeParse(minimalPhase).success).toBe(true);
  });

  it("defaults capability_mode to agent", () => {
    const result = PhaseSchema.safeParse(minimalPhase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capability_mode).toBe("agent");
    }
  });

  it("defaults gate to auto", () => {
    const result = PhaseSchema.safeParse(minimalPhase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gate).toBe("auto");
    }
  });

  it("defaults inputs to empty array", () => {
    const result = PhaseSchema.safeParse(minimalPhase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inputs).toEqual([]);
    }
  });

  it("defaults outputs to empty array", () => {
    const result = PhaseSchema.safeParse(minimalPhase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputs).toEqual([]);
    }
  });

  it("rejects phase id with uppercase", () => {
    const invalid = { ...minimalPhase, id: "MyPhase" };
    expect(PhaseSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects phase id with spaces", () => {
    const invalid = { ...minimalPhase, id: "my phase" };
    expect(PhaseSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects guidance without {lang} placeholder", () => {
    const invalid = { ...minimalPhase, guidance: "guidance/phase.en.md" };
    expect(PhaseSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts guidance with {lang} placeholder", () => {
    const valid = { ...minimalPhase, guidance: "guidance/phase.{lang}.md" };
    expect(PhaseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts phase with capability and capability_mode", () => {
    const valid = { ...minimalPhase, capability: "web_search", capability_mode: "server" as const };
    expect(PhaseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts phase with gate user_approval", () => {
    const valid = { ...minimalPhase, gate: "user_approval" as const };
    expect(PhaseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts complex phase with fan_out, inputs, outputs, hooks, on_review_fail, skip_when", () => {
    const complex = {
      id: "crawl_phase",
      department: "dev",
      guidance: "guidance/crawl_phase.{lang}.md",
      capability: "web_search",
      capability_mode: "agent" as const,
      gate: "auto" as const,
      skip_when: "depth == 'quick'",
      fan_out: { count_from: "task.meta.crawler_count" },
      inputs: [{ name: "strategy", from: "planning_phase" }],
      outputs: [{ name: "findings", type: "markdown" as const, path: "output/findings.md" }],
      hooks: { pre_run: "scripts/pre.sh", post_run: "scripts/post.sh" },
      on_review_fail: { rerun: "crawl_phase", max_passes: 3, flag_output: "flag.json" },
    };
    expect(PhaseSchema.safeParse(complex).success).toBe(true);
  });

  it("accepts a phase with node_type and node_config", () => {
    const phase = {
      id: "planning",
      department: "planning",
      guidance: "guidance/planning.{lang}.md",
      node_type: "planning_meeting",
      node_config: { max_rounds: 4, require_approval: false },
      inputs: [],
      outputs: [],
    };
    expect(() => PhaseSchema.parse(phase)).not.toThrow();
    const parsed = PhaseSchema.parse(phase);
    expect(parsed.node_type).toBe("planning_meeting");
    expect(parsed.node_config).toEqual({ max_rounds: 4, require_approval: false });
  });

  it("accepts a phase without node_type (existing packs still work)", () => {
    const phase = {
      id: "dev",
      department: "development",
      guidance: "guidance/dev.{lang}.md",
      inputs: [],
      outputs: [],
    };
    expect(() => PhaseSchema.parse(phase)).not.toThrow();
    const parsed = PhaseSchema.parse(phase);
    expect(parsed.node_type).toBeUndefined();
    expect(parsed.node_config).toBeUndefined();
  });
});

describe("PackInputFieldSchema", () => {
  it("accepts valid string field", () => {
    const valid = { key: "topic", type: "string", label: { en: "Topic" } };
    expect(PackInputFieldSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts field with default and enum", () => {
    const valid = {
      key: "depth",
      type: "string",
      label: { en: "Depth", ko: "깊이" },
      default: "standard",
      enum: ["quick", "standard", "deep"],
    };
    expect(PackInputFieldSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts number and boolean types", () => {
    expect(PackInputFieldSchema.safeParse({ key: "count", type: "number", label: { en: "Count" } }).success).toBe(true);
    expect(PackInputFieldSchema.safeParse({ key: "enabled", type: "boolean", label: { en: "Enabled" } }).success).toBe(
      true,
    );
  });

  it("rejects invalid type", () => {
    const invalid = { key: "x", type: "array", label: { en: "X" } };
    expect(PackInputFieldSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("CostProfileSchema", () => {
  it("accepts empty cost profile with defaults", () => {
    const result = CostProfileSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_rounds).toBe(5);
      expect(result.data.default_reasoning).toBe("medium");
    }
  });

  it("accepts full cost profile", () => {
    const valid = {
      max_rounds: 10,
      max_input_tokens: 100000,
      max_output_tokens: 8192,
      default_reasoning: "high" as const,
    };
    expect(CostProfileSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid reasoning value", () => {
    const invalid = { default_reasoning: "ultra" };
    expect(CostProfileSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("QaRulesSchema", () => {
  it("defaults require_test_evidence to false and max_auto_fix_passes to 2", () => {
    const result = QaRulesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.require_test_evidence).toBe(false);
      expect(result.data.max_auto_fix_passes).toBe(2);
    }
  });
});

describe("StaffMemberSchema", () => {
  it("accepts minimal staff member", () => {
    const valid = { name: "Scout", role: "agent", department: "research" };
    expect(StaffMemberSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts full staff member", () => {
    const valid = {
      name: "Sage",
      role: "team_leader",
      department: "planning",
      name_ko: "세이지",
      name_ja: "セージ",
      name_zh: "智者",
      avatar_emoji: "🧠",
      sprite_number: 3,
      personality: "Thoughtful and methodical",
    };
    expect(StaffMemberSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid role", () => {
    const invalid = { name: "Scout", role: "manager", department: "research" };
    expect(StaffMemberSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("StaffSchema", () => {
  it("accepts staff with name_pool only", () => {
    const valid = {
      name_pool: [{ name: "Scout", role: "agent", department: "dev" }],
    };
    expect(StaffSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts staff with room_theme", () => {
    const valid = {
      name_pool: [{ name: "Scout", role: "agent", department: "dev" }],
      room_theme: { floor1: "#aaa", floor2: "#bbb", wall: "#ccc", accent: "#ddd" },
    };
    expect(StaffSchema.safeParse(valid).success).toBe(true);
  });

  // A-001 (#88): default_workspace is used as a path segment by
  // execution-run.ts when auto-creating a workspace directory. A
  // pack containing `default_workspace: "../../etc/evil"` would
  // cause arbitrary directory creation outside the application root.
  // The schema MUST reject any value that contains traversal segments,
  // is absolute, expands to home, or contains anything outside the
  // safe path-segment character class.
  describe("default_workspace traversal protection (A-001)", () => {
    const namePool = [{ name: "Scout", role: "agent", department: "dev" }];

    const malicious: Array<[string, string]> = [
      ["dot-dot traversal", "../../etc/evil"],
      ["embedded dot-dot", "workspaces/../../etc"],
      ["leading slash (absolute)", "/etc/evil"],
      ["leading tilde", "~/Code/evil"],
      ["leading tilde-slash", "~/evil"],
      ["null byte", "workspaces/foo bar"],
      ["whitespace", "workspaces/foo bar"],
      ["backslash", "workspaces\\foo"],
      ["dollar variable", "workspaces/$HOME/x"],
      ["only dot-dot", ".."],
      ["only dot", "."],
      ["empty string", ""],
    ];

    it.each(malicious)("rejects %s", (_label, ws) => {
      expect(StaffSchema.safeParse({ name_pool: namePool, default_workspace: ws }).success).toBe(false);
    });

    it("accepts a simple subdirectory", () => {
      expect(StaffSchema.safeParse({ name_pool: namePool, default_workspace: "workspaces/web-research" }).success).toBe(
        true,
      );
    });

    it("accepts a single-segment subdirectory", () => {
      expect(StaffSchema.safeParse({ name_pool: namePool, default_workspace: "workspaces" }).success).toBe(true);
    });

    it("accepts hyphens, underscores, and digits in segments", () => {
      expect(StaffSchema.safeParse({ name_pool: namePool, default_workspace: "ws_v2/my-pack-3" }).success).toBe(true);
    });
  });
});

describe("PackDefinitionSchema — valid packs", () => {
  it("parses minimal valid pack", () => {
    const result = PackDefinitionSchema.safeParse(minimalPack);
    expect(result.success).toBe(true);
  });

  it("parses complex pack with fan-out, capabilities, gates, hooks, on_review_fail, skip_when", () => {
    const complexPack = {
      pack: {
        key: "web_research_report",
        name: { en: "Web Research Report", ko: "웹 리서치 보고서" },
        version: "2.0.0",
        schema_version: 1,
        description: { en: "Fan-out research pipeline", ko: "팬아웃 리서치 파이프라인" },
        icon: "🔬",
      },
      input: {
        required: [{ key: "topic", type: "string", label: { en: "Topic" } }],
        optional: [
          {
            key: "depth",
            type: "string",
            label: { en: "Depth" },
            default: "standard",
            enum: ["quick", "standard", "deep"],
          },
        ],
      },
      phases: [
        {
          id: "planning",
          department: "planning",
          guidance: "guidance/planning.{lang}.md",
          outputs: [{ name: "strategy", type: "json", path: "research_output/search_strategy.json" }],
        },
        {
          id: "crawl",
          department: "dev",
          guidance: "guidance/crawl.{lang}.md",
          capability: "web_search",
          capability_mode: "agent",
          fan_out: { count_from: "task.meta.crawler_count" },
          inputs: [{ name: "strategy", from: "planning" }],
          outputs: [{ name: "findings", type: "markdown", path: "research_output/findings/crawler_N.md" }],
          skip_when: "depth == 'none'",
        },
        {
          id: "synthesis",
          department: "planning",
          guidance: "guidance/synthesis.{lang}.md",
          gate: "user_approval",
          inputs: [{ name: "findings", from: "crawl" }],
          outputs: [{ name: "draft", type: "markdown", path: "research_output/draft_report.md" }],
          hooks: { pre_run: "scripts/validate_findings.sh" },
          on_review_fail: { rerun: "synthesis", flag_output: "review_flag.json" },
        },
      ],
      cost_profile: {
        max_rounds: 5,
        default_reasoning: "high",
      },
      qa_rules: {
        require_test_evidence: false,
        max_auto_fix_passes: 2,
      },
      staff: {
        name_pool: [
          { name: "Sage", role: "team_leader", department: "planning", sprite_number: 1 },
          { name: "Scout", role: "agent", department: "dev", sprite_number: 2 },
        ],
        room_theme: { floor1: "#1a1a2e", floor2: "#16213e", wall: "#0f3460", accent: "#e94560" },
      },
    };
    expect(PackDefinitionSchema.safeParse(complexPack).success).toBe(true);
  });
});

describe("PackDefinitionSchema — invalid packs", () => {
  it("fails when pack.key is missing", () => {
    const invalid = {
      ...minimalPack,
      pack: { ...minimalPack.pack, key: undefined },
    };
    expect(PackDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("fails when pack.key contains uppercase", () => {
    const invalid = {
      ...minimalPack,
      pack: { ...minimalPack.pack, key: "MyPack" },
    };
    expect(PackDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("fails when phases array is empty", () => {
    const invalid = { ...minimalPack, phases: [] };
    expect(PackDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("fails when phase id contains uppercase", () => {
    const invalid = {
      ...minimalPack,
      phases: [{ ...minimalPhase, id: "MyPhase" }],
    };
    expect(PackDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("fails when schema_version is not 1", () => {
    const invalid = {
      ...minimalPack,
      pack: { ...minimalPack.pack, schema_version: 2 },
    };
    expect(PackDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("fails when pack.name is missing", () => {
    const { name: _name, ...packWithoutName } = minimalPack.pack;
    const invalid = { ...minimalPack, pack: packWithoutName };
    expect(PackDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("fails when phases is missing entirely", () => {
    const { phases: _phases, ...withoutPhases } = minimalPack;
    expect(PackDefinitionSchema.safeParse(withoutPhases).success).toBe(false);
  });
});
