import { describe, it, expect } from "vitest";
import { serializePackDefinition } from "../hooks/usePackSerializer";
import type { PackEditorState } from "../hooks/usePackEditorState";

const BASE_STATE: PackEditorState = {
  packKey: "test_pack",
  source: "community",
  packMeta: {
    key: "test_pack",
    name: { en: "Test" },
    version: "1.0.0",
    schema_version: 1,
    description: { en: "" },
  },
  input: { required: [], optional: [] },
  phases: [],
  selectedNodeId: null,
  dirty: false,
};

describe("serializePackDefinition — node_type / node_config persistence", () => {
  it("includes node_type in the serialized phase when set", () => {
    const state: PackEditorState = {
      ...BASE_STATE,
      phases: [
        {
          id: "meeting_phase",
          department: "planning",
          guidance: "guidance/meeting_phase.{lang}.md",
          node_type: "planning_meeting",
          inputs: [],
          outputs: [],
        },
      ],
    };

    const def = serializePackDefinition(state);
    const phases = def.phases as Array<Record<string, unknown>>;
    expect(phases[0].node_type).toBe("planning_meeting");
  });

  it("includes non-empty node_config in the serialized phase", () => {
    const state: PackEditorState = {
      ...BASE_STATE,
      phases: [
        {
          id: "generate_phase",
          department: "dev",
          guidance: "guidance/generate_phase.{lang}.md",
          node_type: "comfyui_generate",
          node_config: { workflow_id: "wf_001", batch_size: 2 },
          inputs: [],
          outputs: [],
        },
      ],
    };

    const def = serializePackDefinition(state);
    const phases = def.phases as Array<Record<string, unknown>>;
    expect(phases[0].node_type).toBe("comfyui_generate");
    expect(phases[0].node_config).toEqual({ workflow_id: "wf_001", batch_size: 2 });
  });

  it("omits node_type when undefined", () => {
    const state: PackEditorState = {
      ...BASE_STATE,
      phases: [
        {
          id: "plain_phase",
          department: "dev",
          guidance: "guidance/plain_phase.{lang}.md",
          inputs: [],
          outputs: [],
        },
      ],
    };

    const def = serializePackDefinition(state);
    const phases = def.phases as Array<Record<string, unknown>>;
    expect(Object.hasOwn(phases[0], "node_type")).toBe(false);
  });

  it("omits node_config when it is an empty object", () => {
    const state: PackEditorState = {
      ...BASE_STATE,
      phases: [
        {
          id: "phase_with_empty_config",
          department: "dev",
          guidance: "guidance/phase_with_empty_config.{lang}.md",
          node_type: "planning_meeting",
          node_config: {},
          inputs: [],
          outputs: [],
        },
      ],
    };

    const def = serializePackDefinition(state);
    const phases = def.phases as Array<Record<string, unknown>>;
    // node_type is still present; only empty node_config is dropped
    expect(phases[0].node_type).toBe("planning_meeting");
    expect(Object.hasOwn(phases[0], "node_config")).toBe(false);
  });

  it("node_type and node_config survive a multi-phase pack alongside plain phases", () => {
    const state: PackEditorState = {
      ...BASE_STATE,
      phases: [
        {
          id: "plan",
          department: "planning",
          guidance: "guidance/plan.{lang}.md",
          inputs: [],
          outputs: [{ name: "strategy", type: "json", path: "out/strategy.json" }],
        },
        {
          id: "generate",
          department: "dev",
          guidance: "guidance/generate.{lang}.md",
          node_type: "comfyui_generate",
          node_config: { workflow_id: "wf_abc" },
          inputs: [{ name: "strategy", from: "plan.strategy" }],
          outputs: [{ name: "image", type: "image", path: "out/image.png" }],
        },
      ],
    };

    const def = serializePackDefinition(state);
    const phases = def.phases as Array<Record<string, unknown>>;
    expect(Object.hasOwn(phases[0], "node_type")).toBe(false);
    expect(phases[1].node_type).toBe("comfyui_generate");
    expect(phases[1].node_config).toEqual({ workflow_id: "wf_abc" });
  });
});
