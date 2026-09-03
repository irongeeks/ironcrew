/**
 * @deprecated The canonical ComfyUI HTTP helpers now live in
 * `server/connectors/built-in/comfyui/http.ts` (the connectors/ layer).
 * This module is kept as a thin re-export for backwards compatibility and
 * will be removed in a follow-up cleanup PR. New code should import directly
 * from the connectors/ path.
 *
 * Layering rule (CLAUDE.md): connectors/ is the lower platform layer.
 * modules/workflow/ depends on connectors/, never the other way around.
 */

export {
  submitWorkflow,
  pollJobCompletion,
  downloadOutput,
  injectParameters,
} from "../../../connectors/built-in/comfyui/http.ts";
