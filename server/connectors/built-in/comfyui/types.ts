/**
 * Type definitions for the ComfyUI connector.
 *
 * Lives in the connectors/ layer (per CLAUDE.md, connectors/ is a self-contained
 * lower platform layer that modules/workflow/ depends on — never the other way
 * around). The legacy module at server/modules/workflow/comfyui/types.ts now
 * re-exports from this file for backwards compatibility.
 */

export type ComfyUiJobResult = {
  status: "success" | "error" | "timeout";
  outputs: Array<{ filename: string; subfolder: string; type: string }>;
  executionTimeMs: number;
  error?: string;
};

export type ComfyUiParameterMapping = {
  paramKey: string;
  nodeId: string;
  inputKey: string;
  description: string;
  defaultValue?: unknown;
};

export type ComfyUiWorkflowConfig = {
  id: string;
  name: string;
  workflowType: "text2img" | "img2video" | "text2speech" | "custom";
  workflowJson: Record<string, unknown>;
  parameterMappings: ComfyUiParameterMapping[];
  defaultServerId?: string;
};

export type ComfyUiWorkflowRow = {
  id: string;
  name: string;
  workflow_type: "text2img" | "img2video" | "text2speech" | "custom";
  workflow_json: string;
  parameter_mappings_json: string;
  default_server_id: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
};
