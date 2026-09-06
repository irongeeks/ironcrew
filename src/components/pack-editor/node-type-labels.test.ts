import { describe, expect, it } from "vitest";
import type { NodeTypeInfoResponse } from "../../api/workflow-packs";
import { localizeNodeType } from "./node-type-labels";

const node: NodeTypeInfoResponse = {
  key: "comfyui_generate",
  meta: {
    label: "ComfyUI Generate",
    description: "Generate images, videos, or speech audio via a ComfyUI server.",
    icon: "",
    color: "",
    category: "connector",
  },
  configSchema: [
    {
      key: "capability",
      type: "select",
      label: "Capability",
      description: "",
      default: "text2img",
      options: [{ value: "text2img", label: "Text → Image" }],
    },
  ],
  inputs: [],
  outputs: [],
};

describe("built-in node labels", () => {
  it("translates labels while keeping keys, defaults, option values and source metadata intact", () => {
    const translated = localizeNodeType(node, "de");
    expect(translated.meta.label).toBe("ComfyUI-Generierung");
    expect(translated.key).toBe(node.key);
    expect(translated.configSchema[0]).toMatchObject({
      key: "capability",
      default: "text2img",
      options: [{ value: "text2img", label: "Text → Bild" }],
    });
    expect(node.meta.label).toBe("ComfyUI Generate");
    expect(localizeNodeType(node, "en")).toBe(node);
  });
  it("preserves custom node metadata", () => {
    const custom = { ...node, meta: { ...node.meta, category: "custom" as const } };
    expect(localizeNodeType(custom, "de")).toBe(custom);
    const unknown = { ...node, key: "my_node" };
    expect(localizeNodeType(unknown, "de")).toBe(unknown);
  });
});
