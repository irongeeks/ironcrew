import fs from "node:fs";
import path from "node:path";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";
import type { ComfyUiJobResult } from "./types.ts";

/**
 * HTTP helpers for the ComfyUI connector.
 *
 * Lives in the connectors/ layer (per CLAUDE.md, connectors/ is a self-contained
 * lower platform layer that modules/workflow/ depends on — never the other way
 * around). The legacy module at server/modules/workflow/comfyui/comfyui-connector.ts
 * now re-exports from this file for backwards compatibility.
 */

/**
 * Submit a workflow to ComfyUI's /prompt endpoint.
 */
export async function submitWorkflow(
  serverUrl: string,
  authHeaders: Record<string, string>,
  workflowJson: Record<string, unknown>,
  paramOverrides?: Record<string, { nodeId: string; inputKey: string; value: unknown }>,
): Promise<{ promptId: string }> {
  if (isBlockedSsrfTarget(serverUrl, { allowLocal: true })) {
    throw new Error("ComfyUI server URL targets a blocked address range (SSRF protection)");
  }

  const finalWorkflow = paramOverrides ? injectParameters(workflowJson, paramOverrides) : workflowJson;

  const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ prompt: finalWorkflow }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ComfyUI /prompt failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { prompt_id?: string };
  if (!data.prompt_id) {
    throw new Error("ComfyUI /prompt response missing prompt_id");
  }

  return { promptId: data.prompt_id };
}

/**
 * Poll ComfyUI /history/{promptId} until the job completes, errors, or times out.
 */
export async function pollJobCompletion(
  serverUrl: string,
  authHeaders: Record<string, string>,
  promptId: string,
  timeoutMs = 300_000,
  pollIntervalMs = 3_000,
): Promise<ComfyUiJobResult> {
  if (isBlockedSsrfTarget(serverUrl, { allowLocal: true })) {
    throw new Error("ComfyUI server URL targets a blocked address range (SSRF protection)");
  }

  const baseUrl = serverUrl.replace(/\/+$/, "");
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const res = await fetch(`${baseUrl}/history/${promptId}`, {
      headers: authHeaders,
    });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const entry = data[promptId] as
        | {
            status?: { status_str?: string; completed?: boolean };
            outputs?: Record<
              string,
              {
                images?: Array<{ filename: string; subfolder: string; type: string }>;
                audio?: Array<{ filename: string; subfolder: string; type: string }>;
                gifs?: Array<{ filename: string; subfolder: string; type: string }>;
              }
            >;
          }
        | undefined;

      if (entry) {
        const statusStr = entry.status?.status_str ?? "";
        const completed = entry.status?.completed ?? false;

        if (statusStr === "error" || (statusStr && !completed && statusStr !== "running")) {
          return {
            status: "error",
            outputs: [],
            executionTimeMs: Date.now() - startTime,
            error: `ComfyUI job failed with status: ${statusStr}`,
          };
        }

        if (completed || statusStr === "success") {
          const outputs: Array<{ filename: string; subfolder: string; type: string }> = [];
          if (entry.outputs) {
            for (const nodeOutput of Object.values(entry.outputs)) {
              // ComfyUI outputs can be under "images", "audio", or "gifs" depending on node type
              const outputArrays = [nodeOutput.images, nodeOutput.audio, nodeOutput.gifs].filter(Boolean);
              for (const arr of outputArrays) {
                if (arr) {
                  for (const item of arr) {
                    outputs.push({
                      filename: item.filename,
                      subfolder: item.subfolder ?? "",
                      type: item.type ?? "output",
                    });
                  }
                }
              }
            }
          }
          return {
            status: "success",
            outputs,
            executionTimeMs: Date.now() - startTime,
          };
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    status: "timeout",
    outputs: [],
    executionTimeMs: Date.now() - startTime,
    error: `ComfyUI job timed out after ${timeoutMs}ms`,
  };
}

/**
 * Download a ComfyUI output file to local disk.
 */
export async function downloadOutput(
  serverUrl: string,
  authHeaders: Record<string, string>,
  filename: string,
  subfolder: string,
  outputDir: string,
  fileType: string = "output",
): Promise<string> {
  if (isBlockedSsrfTarget(serverUrl, { allowLocal: true })) {
    throw new Error("ComfyUI server URL targets a blocked address range (SSRF protection)");
  }

  const baseUrl = serverUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ filename, subfolder, type: fileType });
  const res = await fetch(`${baseUrl}/view?${params.toString()}`, {
    headers: authHeaders,
  });

  if (!res.ok) {
    throw new Error(`ComfyUI /view failed (${res.status}) for ${filename}`);
  }

  const safeName = path.basename(filename);
  if (!safeName || safeName === "." || safeName === "..") {
    throw new Error(`Invalid filename from ComfyUI: ${filename}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const localPath = path.join(outputDir, safeName);
  const resolved = path.resolve(localPath);
  if (!resolved.startsWith(path.resolve(outputDir) + path.sep) && resolved !== path.resolve(outputDir)) {
    throw new Error(`Path traversal detected: ${filename}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  return localPath;
}

/**
 * Deep-clone a workflow JSON and inject parameter overrides into specific node inputs.
 */
export function injectParameters(
  workflowJson: Record<string, unknown>,
  paramMap: Record<string, { nodeId: string; inputKey: string; value: unknown }>,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(workflowJson)) as Record<string, unknown>;

  for (const [, mapping] of Object.entries(paramMap)) {
    const node = cloned[mapping.nodeId] as { inputs?: Record<string, unknown> } | undefined;
    if (node?.inputs) {
      node.inputs[mapping.inputKey] = mapping.value;
    }
  }

  return cloned;
}
