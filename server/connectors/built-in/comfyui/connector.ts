import { submitWorkflow, pollJobCompletion, downloadOutput } from "./http.ts";
import type { Connector, ConnectorExecuteResult } from "../../connector-interface.ts";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";

const SUPPORTED_CAPABILITIES = ["text2img", "img2video", "text2speech"] as const;
type SupportedCapability = (typeof SUPPORTED_CAPABILITIES)[number];

function isSupportedCapability(cap: string): cap is SupportedCapability {
  return (SUPPORTED_CAPABILITIES as readonly string[]).includes(cap);
}

export const comfyuiConnector: Connector = {
  name: "comfyui",

  capabilities: [
    {
      name: "text2img",
      description: "Generate image from text prompt using a ComfyUI workflow",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Positive text prompt describing the desired image" },
          negative_prompt: { type: "string", description: "Negative text prompt (what to avoid)" },
          width: { type: "number", description: "Output image width in pixels" },
          height: { type: "number", description: "Output image height in pixels" },
          steps: { type: "number", description: "Number of diffusion steps" },
          cfg_scale: { type: "number", description: "Classifier-free guidance scale" },
          seed: { type: "number", description: "Random seed for reproducibility (-1 for random)" },
        },
        required: ["prompt"],
      },
      outputSchema: {
        type: "object",
        properties: {
          artifacts: {
            type: "array",
            items: { type: "object", properties: { path: { type: "string" }, type: { type: "string" } } },
          },
        },
      },
    },
    {
      name: "img2video",
      description: "Animate a source image into a short video clip using a ComfyUI workflow",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Text prompt guiding the animation" },
          input_image: { type: "string", description: "Local path or URL of the source image" },
          negative_prompt: { type: "string", description: "Negative text prompt" },
          frames: { type: "number", description: "Number of frames to generate" },
          fps: { type: "number", description: "Frames per second for the output video" },
          motion_bucket_id: { type: "number", description: "Controls the amount of motion" },
          seed: { type: "number", description: "Random seed for reproducibility (-1 for random)" },
        },
        required: ["prompt"],
      },
      outputSchema: {
        type: "object",
        properties: {
          artifacts: {
            type: "array",
            items: { type: "object", properties: { path: { type: "string" }, type: { type: "string" } } },
          },
        },
      },
    },
    {
      name: "text2speech",
      description: "Generate speech audio from text using a ComfyUI Chatterbox TTS workflow",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to synthesize into speech" },
          language: { type: "string", description: "Language for TTS (e.g. 'German (de)', 'English (en)')" },
          exaggeration: { type: "number", description: "Expressiveness level (default 0.7)" },
          cfg_weight: { type: "number", description: "CFG weight for generation (default 0.3)" },
          temperature: { type: "number", description: "Sampling temperature (default 0.8)" },
          seed: { type: "number", description: "Random seed for reproducibility (-1 for random)" },
          audio_prompt: { type: "string", description: "Reference audio filename for voice cloning" },
        },
        required: ["text"],
      },
      outputSchema: {
        type: "object",
        properties: {
          artifacts: {
            type: "array",
            items: { type: "object", properties: { path: { type: "string" }, type: { type: "string" } } },
          },
        },
      },
    },
  ],

  async execute(
    capability: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<ConnectorExecuteResult> {
    if (!isSupportedCapability(capability)) {
      throw new Error(`Unsupported capability: "${capability}". Supported: ${SUPPORTED_CAPABILITIES.join(", ")}`);
    }

    const serverUrl = typeof config.serverUrl === "string" ? config.serverUrl : "";
    if (!serverUrl) {
      return { status: "error", artifacts: [], error: "No ComfyUI server URL configured" };
    }
    if (isBlockedSsrfTarget(serverUrl, { allowLocal: true })) {
      return { status: "error", artifacts: [], error: "URL targets a blocked address range (SSRF protection)" };
    }

    const authHeaders = (config.authHeaders as Record<string, string> | undefined) ?? {};
    const workflowJson = (config.workflowJson as Record<string, unknown> | undefined) ?? {};
    const outputDir = typeof config.outputDir === "string" ? config.outputDir : "./comfyui_output";
    const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 300_000;
    const pollIntervalMs = typeof config.pollIntervalMs === "number" ? config.pollIntervalMs : 3_000;

    // Build parameter overrides from input fields
    const paramOverrides = buildParamOverrides(capability, input, config);

    const startTime = Date.now();

    try {
      const { promptId } = await submitWorkflow(serverUrl, authHeaders, workflowJson, paramOverrides);

      const jobResult = await pollJobCompletion(serverUrl, authHeaders, promptId, timeoutMs, pollIntervalMs);

      if (jobResult.status !== "success") {
        return {
          status: jobResult.status,
          artifacts: [],
          costInfo: { durationMs: jobResult.executionTimeMs },
          error: jobResult.error,
        };
      }

      // Download each output file
      const artifacts: ConnectorExecuteResult["artifacts"] = [];
      for (const output of jobResult.outputs) {
        const localPath = await downloadOutput(
          serverUrl,
          authHeaders,
          output.filename,
          output.subfolder,
          outputDir,
          output.type,
        );
        artifacts.push({
          path: localPath,
          type: capability === "img2video" ? "video" : capability === "text2speech" ? "audio" : "image",
          metadata: {
            filename: output.filename,
            subfolder: output.subfolder,
            comfyType: output.type,
          },
        });
      }

      return {
        status: "success",
        artifacts,
        costInfo: { durationMs: Date.now() - startTime },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        artifacts: [],
        costInfo: { durationMs: Date.now() - startTime },
        error: message,
      };
    }
  },

  getAgentGuidance(capability: string, config: Record<string, unknown>, _lang: string): string {
    const serverUrl = typeof config.serverUrl === "string" ? config.serverUrl : "(not configured)";
    const workflowName = typeof config.workflowName === "string" ? config.workflowName : "(default workflow)";

    if (capability === "text2img") {
      return [
        `ComfyUI text-to-image generation is available at: ${serverUrl}`,
        `Active workflow: ${workflowName}`,
        "To generate an image, provide a detailed positive prompt and optionally a negative prompt.",
        "Key parameters: prompt (required), negative_prompt, width, height, steps (default 20), cfg_scale (default 7), seed (-1 for random).",
        "The connector will submit the workflow, wait for completion, and return the local file path of the generated image.",
        "Use descriptive prompts for best results. Include style keywords (e.g., 'photorealistic', 'oil painting') for specific aesthetics.",
      ].join("\n");
    }

    if (capability === "img2video") {
      return [
        `ComfyUI image-to-video animation is available at: ${serverUrl}`,
        `Active workflow: ${workflowName}`,
        "To animate an image, provide the local path to the source image and a guiding text prompt.",
        "Key parameters: input_image (required), prompt (required), frames (default 16), fps (default 8), motion_bucket_id (controls motion amount).",
        "The connector will submit the workflow, wait for completion, and return the local file path of the generated video clip.",
        "Keep motion_bucket_id between 50-150 for moderate animation; higher values produce more motion.",
      ].join("\n");
    }

    if (capability === "text2speech") {
      return [
        `ComfyUI text-to-speech generation is available at: ${serverUrl}`,
        `Active workflow: ${workflowName}`,
        "To generate speech audio, provide the text to synthesize.",
        "Key parameters: text (required), language (e.g. 'German (de)', 'English (en)'), exaggeration (default 0.7), cfg_weight (default 0.3), temperature (default 0.8), seed (-1 for random).",
        "Optional: audio_prompt — filename of a reference audio in ComfyUI's input folder for voice cloning.",
        "The connector will submit the workflow, wait for completion, and return the local file path of the generated audio.",
      ].join("\n");
    }

    return `ComfyUI connector at ${serverUrl}. Capability: ${capability}. Refer to the workflow configuration for parameter details.`;
  },

  async testConnection(config: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const serverUrl = typeof config.serverUrl === "string" ? config.serverUrl : "";

    if (!serverUrl) {
      return { ok: false, message: "No ComfyUI server URL configured" };
    }

    if (isBlockedSsrfTarget(serverUrl, { allowLocal: true })) {
      return { ok: false, message: "URL targets a blocked address range (SSRF protection)" };
    }

    const authHeaders = (config.authHeaders as Record<string, string> | undefined) ?? {};
    const baseUrl = serverUrl.replace(/\/+$/, "");

    try {
      const res = await fetch(`${baseUrl}/system_stats`, {
        method: "GET",
        headers: { ...authHeaders },
      });

      if (!res.ok) {
        return {
          ok: false,
          message: `ComfyUI server responded with ${res.status} ${res.statusText}`,
        };
      }

      return { ok: true, message: `ComfyUI server at ${baseUrl} is reachable` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  },
};

/**
 * Build parameter overrides from input fields, using parameterMappings from config when available.
 * Falls back to no-op overrides when no mapping is configured.
 */
function buildParamOverrides(
  capability: string,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Record<string, { nodeId: string; inputKey: string; value: unknown }> | undefined {
  // If the config provides explicit parameter mappings, use them
  const mappings = config.parameterMappings as
    | Array<{ paramKey: string; nodeId: string; inputKey: string }>
    | undefined;

  if (!mappings || mappings.length === 0) {
    // No mappings configured — return undefined so the workflow runs as-is
    // This is valid: the user may have baked parameters into the workflow JSON already
    void capability; // satisfy linter
    void input;
    return undefined;
  }

  const overrides: Record<string, { nodeId: string; inputKey: string; value: unknown }> = {};
  for (const mapping of mappings) {
    if (mapping.paramKey in input) {
      overrides[mapping.paramKey] = {
        nodeId: mapping.nodeId,
        inputKey: mapping.inputKey,
        value: input[mapping.paramKey],
      };
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
