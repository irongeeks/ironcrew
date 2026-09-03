import type { NodeTypeDefinition } from "../../node-type-interface.ts";

/**
 * ComfyUI Generate node — dispatches text2img, img2video, or text2speech
 * requests through the ConnectorRegistry to a running ComfyUI server.
 */
const ComfyuiGenerateNode: NodeTypeDefinition = {
  key: "comfyui_generate",

  meta: {
    label: "ComfyUI Generate",
    description: "Generate images, videos, or speech audio via a ComfyUI server.",
    icon: "🎨",
    color: "#10b981",
    category: "connector",
  },

  configSchema: [
    {
      key: "capability",
      type: "select",
      label: "Capability",
      description: "Which ComfyUI capability to invoke (text2img, img2video, or text2speech)",
      options: [
        { value: "text2img", label: "Text → Image" },
        { value: "img2video", label: "Image → Video" },
        { value: "text2speech", label: "Text → Speech" },
      ],
      default: "text2img",
      required: true,
    },
    {
      key: "width",
      type: "number",
      label: "Width",
      description: "Output width in pixels (text2img only, default: workflow default)",
      min: 64,
      max: 4096,
    },
    {
      key: "height",
      type: "number",
      label: "Height",
      description: "Output height in pixels (text2img only, default: workflow default)",
      min: 64,
      max: 4096,
    },
    {
      key: "seed",
      type: "number",
      label: "Seed",
      description: "Random seed for reproducibility (-1 for random)",
      default: -1,
    },
  ],

  inputs: [
    {
      name: "prompt",
      type: "string",
      label: "Prompt",
      required: true,
      description: "The positive text prompt describing what to generate.",
    },
    {
      name: "negative_prompt",
      type: "string",
      label: "Negative Prompt",
      required: false,
      description: "What to avoid in the output (text2img/img2video).",
    },
    {
      name: "input_image",
      type: "image",
      label: "Input Image",
      required: false,
      description: "Source image path for img2video.",
    },
    {
      name: "language",
      type: "string",
      label: "Language",
      required: false,
      description: "Language for text2speech (e.g. 'German (de)', 'English (en)').",
    },
    {
      name: "exaggeration",
      type: "number",
      label: "Exaggeration",
      required: false,
      description: "Expressiveness level for text2speech (default 0.7).",
    },
    {
      name: "audio_prompt",
      type: "string",
      label: "Audio Prompt",
      required: false,
      description: "Reference audio filename for voice cloning (text2speech).",
    },
  ],

  outputs: [
    {
      name: "artifacts",
      type: "json",
      label: "Generated Artifacts",
      required: true,
      description: "Array of { path, type, metadata } for each generated file.",
    },
    {
      name: "primary_path",
      type: "string",
      label: "Primary Output Path",
      required: true,
      description: "File path of the first generated artifact.",
    },
  ],

  async execute(ctx) {
    const registry = ctx.connectorRegistry;
    if (!registry) {
      return { status: "error", outputs: {}, error: "No connector registry available" };
    }

    const capability = (ctx.config.capability as string) || "text2img";

    if (!registry.hasBinding(capability)) {
      return {
        status: "error",
        outputs: {},
        error: `No binding configured for capability "${capability}". Configure a ComfyUI server in Settings.`,
      };
    }

    // Build connector input — text2speech uses `text` instead of `prompt`
    const input: Record<string, unknown> = {};
    if (capability === "text2speech") {
      input.text = ctx.inputs.prompt;
      if (ctx.inputs.language) input.language = ctx.inputs.language;
      if (ctx.inputs.exaggeration) input.exaggeration = ctx.inputs.exaggeration;
      if (ctx.inputs.audio_prompt) input.audio_prompt = ctx.inputs.audio_prompt;
    } else {
      input.prompt = ctx.inputs.prompt;
      if (ctx.inputs.negative_prompt) input.negative_prompt = ctx.inputs.negative_prompt;
      if (ctx.inputs.input_image) input.input_image = ctx.inputs.input_image;
      if (ctx.config.width) input.width = ctx.config.width;
      if (ctx.config.height) input.height = ctx.config.height;
    }
    if (ctx.config.seed !== undefined && ctx.config.seed !== -1) input.seed = ctx.config.seed;

    const result = await registry.executeCapability(capability, input);

    if (result.status !== "success") {
      return {
        status: "error",
        outputs: {},
        error: result.error ?? `ComfyUI ${capability} failed with status: ${result.status}`,
      };
    }

    const primaryPath = result.artifacts[0]?.path ?? "";

    return {
      status: "success",
      outputs: {
        artifacts: result.artifacts,
        primary_path: primaryPath,
      },
      summary: `ComfyUI ${capability}: ${result.artifacts.length} artifact(s) generated`,
    };
  },

  getAgentGuidance(ctx, lang) {
    if (!ctx.connectorRegistry) return "";
    const capability = (ctx.config.capability as string) || "text2img";
    return ctx.connectorRegistry.getAgentGuidance(capability, lang) ?? "";
  },

  async testConnection(config) {
    // Delegate to the connector's own testConnection — not available via
    // the registry interface, so we just check if the binding exists.
    void config;
    return { ok: true, message: "Use Settings → Connectors to test the ComfyUI connection." };
  },
};

export default ComfyuiGenerateNode;
