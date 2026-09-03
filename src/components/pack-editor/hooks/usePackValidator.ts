import { useMemo } from "react";
import type { PhaseDefinition, ValidationError } from "../types";

function parseRef(from: string): { phaseId: string; outputName: string } | null {
  if (from.startsWith("input.")) return null;
  const parts = from.split(".");
  if (parts.length < 2) return null;
  return { phaseId: parts[0], outputName: parts[1] };
}

export function validatePack(phases: PhaseDefinition[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const phaseMap = new Map<string, PhaseDefinition>();

  // Check duplicate IDs
  for (const phase of phases) {
    if (!phase.id || phase.id.trim() === "") {
      errors.push({ type: "empty_phase_id", phaseId: phase.id || "(empty)", message: "Phase has no ID" });
      continue;
    }
    if (phaseMap.has(phase.id)) {
      errors.push({ type: "duplicate_id", phaseId: phase.id, message: `Duplicate phase ID: "${phase.id}"` });
    }
    phaseMap.set(phase.id, phase);
  }

  // Check broken input references + build adjacency
  const adjacency = new Map<string, Set<string>>();
  for (const phase of phases) {
    for (const input of phase.inputs) {
      const ref = parseRef(input.from);
      if (!ref) continue;

      const sourcePhase = phaseMap.get(ref.phaseId);
      if (!sourcePhase) {
        errors.push({
          type: "broken_ref",
          phaseId: phase.id,
          inputName: input.name,
          message: `Input "${input.name}" references non-existent phase "${ref.phaseId}"`,
        });
        continue;
      }

      if (!sourcePhase.outputs.some((o) => o.name === ref.outputName)) {
        errors.push({
          type: "broken_ref",
          phaseId: phase.id,
          inputName: input.name,
          message: `Input "${input.name}" references non-existent output "${ref.phaseId}.${ref.outputName}"`,
        });
        continue;
      }

      if (!adjacency.has(ref.phaseId)) adjacency.set(ref.phaseId, new Set());
      adjacency.get(ref.phaseId)!.add(phase.id);
    }
  }

  // Cycle detection (DFS three-color)
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const phase of phases) color.set(phase.id, WHITE);

  function dfs(nodeId: string): boolean {
    color.set(nodeId, GRAY);
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      const c = color.get(neighbor);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(nodeId, BLACK);
    return false;
  }

  for (const phase of phases) {
    if (color.get(phase.id) === WHITE && dfs(phase.id)) {
      errors.push({ type: "cycle", phaseId: phase.id, message: `Phase "${phase.id}" is part of a cycle` });
    }
  }

  // Orphan detection
  const hasIncomingEdge = new Set<string>();
  const hasOutgoingEdge = new Set<string>();
  for (const phase of phases) {
    for (const input of phase.inputs) {
      const ref = parseRef(input.from);
      if (ref && phaseMap.has(ref.phaseId)) {
        hasIncomingEdge.add(phase.id);
        hasOutgoingEdge.add(ref.phaseId);
      }
    }
  }

  const roots = phases.filter((p) => !hasIncomingEdge.has(p.id));
  if (roots.length > 1) {
    for (const root of roots) {
      if (!hasOutgoingEdge.has(root.id) && phases.length > 1) {
        errors.push({
          type: "orphan",
          phaseId: root.id,
          message: `Phase "${root.id}" is disconnected from the workflow`,
        });
      }
    }
  }

  return errors;
}

export function usePackValidator(phases: PhaseDefinition[]) {
  const errors = useMemo(() => validatePack(phases), [phases]);

  const errorsByPhase = useMemo(() => {
    const map = new Map<string, ValidationError[]>();
    for (const error of errors) {
      if (!map.has(error.phaseId)) map.set(error.phaseId, []);
      map.get(error.phaseId)!.push(error);
    }
    return map;
  }, [errors]);

  return { errors, errorsByPhase, hasErrors: errors.length > 0 };
}
