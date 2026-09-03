import type { NodeTypeDefinition } from "../../node-type-interface.ts";

/**
 * Echo node — passes every input through as an output unchanged.
 * Used as a minimal example and for testing the node-type pipeline.
 */
const EchoNode: NodeTypeDefinition = {
  key: "echo",

  meta: {
    label: "Echo",
    description: "Passes all inputs through to outputs unchanged. Useful for testing and debugging workflows.",
    icon: "🔁",
    color: "#6b7280",
    category: "control",
    docsUrl: "docs/node-types/echo.md",
  },

  configSchema: [
    {
      key: "label",
      type: "string",
      label: "Log Label",
      description: "Optional label that appears in the task log when this node runs (e.g. 'Step 1 complete')",
      default: "",
      required: false,
    },
  ],

  inputs: [
    {
      name: "data",
      type: "json",
      label: "Input Data",
      required: false,
      description: "Any data to pass through. If not connected, outputs an empty object.",
    },
  ],

  outputs: [
    {
      name: "data",
      type: "json",
      label: "Output Data",
      required: true,
      description: "The same data that was received on the input port.",
    },
  ],

  async execute(ctx) {
    const label = (ctx.config.label as string) || "echo";
    return {
      status: "success",
      outputs: { data: ctx.inputs.data ?? {} },
      summary: label,
    };
  },
};

export default EchoNode;
