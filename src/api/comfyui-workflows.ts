const BASE = "/api/ops/comfyui-workflows";

export interface ComfyUiWorkflow {
  id: string;
  name: string;
  workflow_type: "text2img" | "img2video" | "custom";
  workflow_json: string;
  parameter_mappings_json: string;
  default_server_id: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export async function listComfyUiWorkflows(): Promise<ComfyUiWorkflow[]> {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`Failed to list ComfyUI workflows: ${res.status}`);
  const data = (await res.json()) as { workflows: ComfyUiWorkflow[] };
  return data.workflows;
}

export async function createComfyUiWorkflow(input: {
  name: string;
  workflow_type: string;
  workflow_json: string;
  parameter_mappings: unknown[];
  default_server_id?: string;
}): Promise<ComfyUiWorkflow> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Failed to create: ${res.status}`);
  }
  const data = (await res.json()) as { workflow: ComfyUiWorkflow };
  return data.workflow;
}

export async function updateComfyUiWorkflow(
  id: string,
  input: Partial<{
    name: string;
    workflow_type: string;
    workflow_json: string;
    parameter_mappings: unknown[];
    default_server_id: string | null;
    enabled: boolean;
  }>,
): Promise<ComfyUiWorkflow> {
  const res = await fetch(`${BASE}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Failed to update: ${res.status}`);
  }
  const data = (await res.json()) as { workflow: ComfyUiWorkflow };
  return data.workflow;
}

export async function deleteComfyUiWorkflow(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function testComfyUiWorkflow(
  id: string,
  serverId?: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const res = await fetch(`${BASE}/${id}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server_id: serverId }),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; error?: string };
}
