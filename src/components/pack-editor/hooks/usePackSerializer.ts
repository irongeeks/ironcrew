import { useMemo } from "react";
import type { PackEditorState } from "./usePackEditorState";

/**
 * Convert editor state to a PackDefinition object suitable for API submission.
 * This is the "serialize" half of the roundtrip (deserialize is in pack-deserializer.ts).
 */
export function serializePackDefinition(state: PackEditorState): Record<string, unknown> {
  const def: Record<string, unknown> = {
    pack: state.packMeta,
    input: state.input,
    phases: state.phases.map((p) => {
      const phase: Record<string, unknown> = {
        id: p.id,
        department: p.department,
        guidance: p.guidance,
      };
      if (p.node_type) phase.node_type = p.node_type;
      if (p.node_config && Object.keys(p.node_config).length > 0) phase.node_config = p.node_config;
      if (p.capability) phase.capability = p.capability;
      if (p.capability_mode && p.capability_mode !== "hybrid") phase.capability_mode = p.capability_mode;
      if (p.gate && p.gate !== "auto") phase.gate = p.gate;
      if (p.skip_when) phase.skip_when = p.skip_when;
      if (p.on_review_fail) phase.on_review_fail = p.on_review_fail;
      if (p.fan_out) phase.fan_out = p.fan_out;
      if (p.inputs.length > 0) phase.inputs = p.inputs;
      if (p.outputs.length > 0) phase.outputs = p.outputs;
      if (p.hooks) phase.hooks = p.hooks;
      return phase;
    }),
  };

  if (state.costProfile) def.cost_profile = state.costProfile;
  if (state.qaRules) def.qa_rules = state.qaRules;
  if (state.staff) def.staff = state.staff;
  if (state.ui) def.ui = state.ui;

  return def;
}

/**
 * Hook that derives a serializable PackDefinition from editor state.
 * Memoized — only recomputes when state changes.
 */
export function usePackSerializer(state: PackEditorState): Record<string, unknown> {
  return useMemo(() => serializePackDefinition(state), [state]);
}
