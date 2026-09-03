/**
 * @deprecated The canonical ComfyUI types now live in
 * `server/connectors/built-in/comfyui/types.ts` (the connectors/ layer).
 * This module is kept as a thin re-export for backwards compatibility and
 * will be removed in a follow-up cleanup PR. New code should import directly
 * from the connectors/ path.
 */

export type {
  ComfyUiJobResult,
  ComfyUiParameterMapping,
  ComfyUiWorkflowConfig,
  ComfyUiWorkflowRow,
} from "../../../connectors/built-in/comfyui/types.ts";
