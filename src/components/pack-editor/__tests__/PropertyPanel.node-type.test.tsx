import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PropertyPanel } from "../PropertyPanel";
import type { PhaseDefinition } from "../types";

// Mock all three API calls used by PropertyPanel
vi.mock("../../../api/workflow-packs", () => ({
  fetchEditorCapabilities: vi.fn().mockResolvedValue([]),
  fetchEditorDepartments: vi.fn().mockResolvedValue([{ id: "dev", name: "Development" }]),
  fetchNodeTypes: vi.fn().mockResolvedValue([
    {
      key: "comfyui_generate",
      meta: {
        label: "ComfyUI Generate",
        description: "Image generation",
        icon: "🖼",
        color: "#34d399",
        category: "connector",
      },
      configSchema: [
        { key: "workflow_id", type: "string", label: "Workflow ID", description: "", default: "default_wf" },
      ],
      inputs: [{ name: "prompt", type: "markdown", label: "Prompt", required: true }],
      outputs: [{ name: "image", type: "image", label: "Image", required: true }],
    },
    {
      key: "planning_meeting",
      meta: {
        label: "Planning Meeting",
        description: "Cross-agent meeting",
        icon: "📋",
        color: "#a78bfa",
        category: "collaboration",
      },
      configSchema: [],
      inputs: [{ name: "agenda", type: "markdown", label: "Agenda", required: true }],
      outputs: [
        { name: "minutes", type: "markdown", label: "Minutes", required: true },
        { name: "decisions", type: "json", label: "Decisions", required: false },
      ],
    },
  ]),
}));

// GuidanceEditor makes its own fetch; stub it out
vi.mock("../panels/GuidanceEditor", () => ({
  GuidanceEditor: () => null,
}));

const AGENT_PHASE: PhaseDefinition = {
  id: "render_step",
  department: "dev",
  guidance: "guidance/render_step.{lang}.md",
  inputs: [{ name: "old_input", from: "upstream.result" }],
  outputs: [{ name: "old_output", type: "markdown", path: "out/old.md" }],
};

describe("PropertyPanel — node type change replaces ports", () => {
  let onUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onUpdate = vi.fn();
  });

  async function renderAndWaitForNodeTypes(phase: PhaseDefinition) {
    render(<PropertyPanel packKey="test_pack" phase={phase} readOnly={false} onUpdate={onUpdate} onClose={vi.fn()} />);
    // Wait for fetchNodeTypes to resolve and populate the select
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /ComfyUI Generate/i })).toBeDefined();
    });
  }

  it("replaces inputs and outputs when a node type is selected", async () => {
    await renderAndWaitForNodeTypes(AGENT_PHASE);

    // Two selects share the "None (agent-only)" placeholder: Node Type (index 0) and Capability (index 1)
    const [nodeTypeSelect] = screen.getAllByDisplayValue("None (agent-only)");
    fireEvent.change(nodeTypeSelect, { target: { value: "comfyui_generate" } });

    expect(onUpdate).toHaveBeenCalledOnce();
    const [calledPhaseId, updates] = onUpdate.mock.calls[0] as [string, Partial<PhaseDefinition>];

    expect(calledPhaseId).toBe("render_step");
    expect(updates.node_type).toBe("comfyui_generate");
    expect(updates.node_config).toEqual({ workflow_id: "default_wf" });

    // Old ports must be replaced by the node type's ports
    expect(updates.inputs).toEqual([{ name: "prompt", from: "" }]);
    expect(updates.outputs).toEqual([{ name: "image", type: "image", path: "output/render_step/image.md" }]);
  });

  it("derives artifact paths from the current phase id, not a hardcoded string", async () => {
    const differentPhase: PhaseDefinition = {
      ...AGENT_PHASE,
      id: "my_custom_phase",
    };
    await renderAndWaitForNodeTypes(differentPhase);

    const [nodeTypeSelect] = screen.getAllByDisplayValue("None (agent-only)");
    fireEvent.change(nodeTypeSelect, { target: { value: "planning_meeting" } });

    const [, updates] = onUpdate.mock.calls[0] as [string, Partial<PhaseDefinition>];
    expect(updates.outputs).toEqual([
      { name: "minutes", type: "markdown", path: "output/my_custom_phase/minutes.md" },
      { name: "decisions", type: "json", path: "output/my_custom_phase/decisions.json" },
    ]);
  });

  it("preserves existing ports when node type is cleared to None", async () => {
    const phaseWithNodeType: PhaseDefinition = {
      ...AGENT_PHASE,
      node_type: "comfyui_generate",
      node_config: { workflow_id: "wf_001" },
      inputs: [{ name: "prompt", from: "upstream.text" }],
      outputs: [{ name: "image", type: "image", path: "out/image.md" }],
    };
    await renderAndWaitForNodeTypes(phaseWithNodeType);

    const nodeTypeSelect = screen.getByDisplayValue(/ComfyUI Generate/i);
    fireEvent.change(nodeTypeSelect, { target: { value: "" } });

    const [, updates] = onUpdate.mock.calls[0] as [string, Partial<PhaseDefinition>];
    expect(updates.node_type).toBeUndefined();
    expect(updates.node_config).toBeUndefined();
    // inputs/outputs must NOT be present in the update (no replacement for None)
    expect(Object.hasOwn(updates, "inputs")).toBe(false);
    expect(Object.hasOwn(updates, "outputs")).toBe(false);
  });
});
