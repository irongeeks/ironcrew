import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPackDefinition } from "../../../api/workflow-packs";
import type { PackDefinitionResponse, PhaseDefinition } from "../../pack-editor/types";

interface PhaseSelectionSectionProps {
  packKey: string;
  locale: string;
  skippedPhases: string[];
  onSkippedPhasesChange: (skipped: string[]) => void;
}

function phaseLabel(phase: PhaseDefinition): string {
  return phase.id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build downstream map: phase → set of phases that depend on it (directly or transitively). */
function buildDownstreamMap(phases: PhaseDefinition[]): Map<string, Set<string>> {
  // Direct: child depends on parent via inputs[].from = "<parent>.<output>"
  const children = new Map<string, Set<string>>();
  for (const phase of phases) {
    for (const input of phase.inputs) {
      const parentId = input.from.split(".")[0];
      if (!children.has(parentId)) children.set(parentId, new Set());
      children.get(parentId)!.add(phase.id);
    }
  }
  // Transitive closure via BFS
  const downstream = new Map<string, Set<string>>();
  for (const phase of phases) {
    const reachable = new Set<string>();
    const queue = [phase.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of children.get(cur) ?? []) {
        if (!reachable.has(child)) {
          reachable.add(child);
          queue.push(child);
        }
      }
    }
    downstream.set(phase.id, reachable);
  }
  return downstream;
}

/** Build upstream map: phase → set of phases it depends on (directly or transitively). */
function buildUpstreamMap(phases: PhaseDefinition[]): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const phase of phases) {
    const deps = new Set<string>();
    for (const input of phase.inputs) {
      deps.add(input.from.split(".")[0]);
    }
    parents.set(phase.id, deps);
  }
  // Transitive closure
  const upstream = new Map<string, Set<string>>();
  for (const phase of phases) {
    const reachable = new Set<string>();
    const queue = [phase.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const parent of parents.get(cur) ?? []) {
        if (!reachable.has(parent)) {
          reachable.add(parent);
          queue.push(parent);
        }
      }
    }
    upstream.set(phase.id, reachable);
  }
  return upstream;
}

export default function PhaseSelectionSection({
  packKey,
  locale,
  skippedPhases,
  onSkippedPhasesChange,
}: PhaseSelectionSectionProps) {
  const [phases, setPhases] = useState<PhaseDefinition[]>([]);
  const onSkippedRef = useRef(onSkippedPhasesChange);
  useEffect(() => {
    onSkippedRef.current = onSkippedPhasesChange;
  });

  useEffect(() => {
    if (!packKey) {
      setPhases([]);
      return;
    }
    let stale = false;
    fetchPackDefinition(packKey)
      .then((def) => {
        if (stale) return;
        const data = def as unknown as PackDefinitionResponse;
        const p = data.definition?.phases ?? [];
        setPhases(p);
        onSkippedRef.current([]);
      })
      .catch(() => {
        if (!stale) setPhases([]);
      });
    return () => {
      stale = true;
    };
  }, [packKey]);

  const downstreamMap = useMemo(() => buildDownstreamMap(phases), [phases]);
  const upstreamMap = useMemo(() => buildUpstreamMap(phases), [phases]);

  // Only show when pack has 2+ phases
  if (phases.length < 2) return null;

  const skippedSet = new Set(skippedPhases);
  const activeCount = phases.length - skippedSet.size;

  function togglePhase(phaseId: string) {
    if (skippedSet.has(phaseId)) {
      // Re-enable: also re-enable all upstream dependencies
      const toEnable = new Set([phaseId]);
      for (const up of upstreamMap.get(phaseId) ?? []) {
        toEnable.add(up);
      }
      onSkippedPhasesChange(skippedPhases.filter((id) => !toEnable.has(id)));
    } else {
      // Skip: also skip all downstream dependents
      if (activeCount <= 1) return;
      const toSkip = new Set([phaseId]);
      for (const down of downstreamMap.get(phaseId) ?? []) {
        toSkip.add(down);
      }
      // Ensure at least one phase remains active
      const newSkipped = new Set([...skippedPhases, ...toSkip]);
      if (newSkipped.size >= phases.length) return;
      onSkippedPhasesChange([...newSkipped]);
    }
  }

  const sectionLabel =
    locale === "ko"
      ? "단계 선택"
      : locale === "ja"
        ? "フェーズ選択"
        : locale === "zh"
          ? "阶段选择"
          : locale === "de"
            ? "Phasen-Auswahl"
            : "Phases";

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
        {sectionLabel}
      </label>
      <div className="space-y-1">
        {phases.map((phase) => {
          const isSkipped = skippedSet.has(phase.id);
          const isLastActive = !isSkipped && activeCount <= 1;
          return (
            <label
              key={phase.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-black/5 dark:hover:bg-white/5"
              style={{ opacity: isSkipped ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={!isSkipped}
                disabled={isLastActive}
                onChange={() => togglePhase(phase.id)}
                className="h-3.5 w-3.5 rounded accent-blue-500"
              />
              <span
                className="text-sm"
                style={{
                  color: "var(--th-text-primary)",
                  textDecoration: isSkipped ? "line-through" : undefined,
                }}
              >
                {phaseLabel(phase)}
              </span>
              <span className="ml-auto text-[10px]" style={{ color: "var(--th-text-muted, var(--th-text-secondary))" }}>
                {phase.department}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
