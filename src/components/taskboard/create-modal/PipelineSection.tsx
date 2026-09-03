import { useCallback, useRef, useState } from "react";
import type { Department } from "../../../types";
import type { TFunction } from "../constants";

// ── Pipeline Presets ────────────────────────────────────────────────

interface PipelinePreset {
  key: string;
  label: { ko: string; en: string; ja: string; zh: string; de: string };
  steps: string[];
}

const PIPELINE_PRESETS: PipelinePreset[] = [
  { key: "direct", label: { ko: "직접", en: "Direct", ja: "ダイレクト", zh: "Direct", de: "Direkt" }, steps: [] },
  {
    key: "with_planning",
    label: { ko: "기획 포함", en: "With Planning", ja: "計画付き", zh: "With Planning", de: "Mit Planung" },
    steps: ["planning", "dev"],
  },
  {
    key: "with_qa",
    label: { ko: "QA 포함", en: "With QA", ja: "QA付き", zh: "With QA", de: "Mit QA" },
    steps: ["dev", "qa"],
  },
  {
    key: "full",
    label: { ko: "전체", en: "Full Pipeline", ja: "フル", zh: "Full Pipeline", de: "Vollständige Pipeline" },
    steps: ["planning", "dev", "qa"],
  },
  {
    key: "full_design",
    label: {
      ko: "전체+디자인",
      en: "Full + Design",
      ja: "フル+デザイン",
      zh: "Full + Design",
      de: "Vollständig + Design",
    },
    steps: ["planning", "design", "dev", "qa"],
  },
];

// ── Props ───────────────────────────────────────────────────────────

interface PipelineSectionProps {
  t: TFunction;
  departments: Department[];
  pipelineSteps: string[];
  enableAutoRetry: boolean;
  maxRetries: number;
  onPipelineStepsChange: (steps: string[]) => void;
  onEnableAutoRetryChange: (enabled: boolean) => void;
  onMaxRetriesChange: (max: number) => void;
}

// ── Component ───────────────────────────────────────────────────────

export default function PipelineSection({
  t,
  departments,
  pipelineSteps,
  enableAutoRetry,
  maxRetries,
  onPipelineStepsChange,
  onEnableAutoRetryChange,
  onMaxRetriesChange,
}: PipelineSectionProps) {
  const [addDropdownOpen, setAddDropdownOpen] = useState(false);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const deptMap = new Map(departments.map((d) => [d.id, d]));
  const usedDepts = new Set(pipelineSteps);
  const availableDepts = departments.filter((d) => !usedDepts.has(d.id));

  // Find matching preset
  const activePreset = PIPELINE_PRESETS.find(
    (p) => p.steps.length === pipelineSteps.length && p.steps.every((s, i) => s === pipelineSteps[i]),
  );

  const handlePresetClick = useCallback(
    (preset: PipelinePreset) => {
      onPipelineStepsChange([...preset.steps]);
    },
    [onPipelineStepsChange],
  );

  const handleRemoveStep = useCallback(
    (index: number) => {
      onPipelineStepsChange(pipelineSteps.filter((_, i) => i !== index));
    },
    [pipelineSteps, onPipelineStepsChange],
  );

  const handleAddDept = useCallback(
    (deptId: string) => {
      onPipelineStepsChange([...pipelineSteps, deptId]);
      setAddDropdownOpen(false);
    },
    [pipelineSteps, onPipelineStepsChange],
  );

  const handleDragStart = useCallback((index: number) => {
    dragItem.current = index;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    dragOverItem.current = index;
  }, []);

  const handleDrop = useCallback(() => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    const from = dragItem.current;
    const to = dragOverItem.current;
    if (from === to) return;
    const newSteps = [...pipelineSteps];
    const [moved] = newSteps.splice(from, 1);
    newSteps.splice(to, 0, moved!);
    onPipelineStepsChange(newSteps);
    dragItem.current = null;
    dragOverItem.current = null;
  }, [pipelineSteps, onPipelineStepsChange]);

  return (
    <details
      className="group rounded-lg border"
      style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
    >
      <summary
        className="cursor-pointer select-none px-3 py-2 text-sm font-medium"
        style={{ color: "var(--th-text-secondary)" }}
      >
        {t({
          ko: "파이프라인 & 옵션",
          en: "Pipeline & Options",
          ja: "パイプライン＆オプション",
          zh: "Pipeline & Options",
          de: "Pipeline & Optionen",
        })}
        {pipelineSteps.length > 0 && (
          <span className="ml-2 text-xs opacity-60">
            ({pipelineSteps.map((s) => deptMap.get(s)?.icon ?? s).join(" → ")})
          </span>
        )}
      </summary>

      <div className="space-y-3 border-t px-3 pb-3 pt-3" style={{ borderColor: "var(--th-border)" }}>
        {/* Preset chips */}
        <div>
          <label className="mb-1.5 block text-xs font-medium" style={{ color: "var(--th-text-muted)" }}>
            {t({ ko: "프리셋", en: "Preset", ja: "プリセット", zh: "Preset", de: "Voreinstellung" })}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {PIPELINE_PRESETS.map((preset) => {
              const isActive = activePreset?.key === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => handlePresetClick(preset)}
                  className={`rounded-md border px-2.5 py-1 text-xs transition ${
                    isActive ? "border-blue-500 bg-blue-600 text-white" : "hover:border-blue-500/50"
                  }`}
                  style={isActive ? undefined : { borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                >
                  {t(preset.label)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Pipeline steps (drag-and-drop) */}
        {pipelineSteps.length > 0 && (
          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "파이프라인 순서",
                en: "Pipeline Order",
                ja: "パイプライン順序",
                zh: "Pipeline Order",
                de: "Pipeline-Reihenfolge",
              })}
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {pipelineSteps.map((deptId, index) => {
                const dept = deptMap.get(deptId);
                return (
                  <div
                    key={`${deptId}-${index}`}
                    draggable
                    onDragStart={() => handleDragStart(index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDrop={handleDrop}
                    className="flex cursor-grab items-center gap-1 rounded-md border px-2 py-1 text-xs active:cursor-grabbing"
                    style={{
                      borderColor: "var(--th-border)",
                      color: "var(--th-text-primary)",
                      background: "var(--th-card-bg)",
                    }}
                  >
                    <span className="opacity-40">⋮⋮</span>
                    <span>{dept?.icon ?? "?"}</span>
                    <span>{dept?.name ?? deptId}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveStep(index)}
                      className="ml-0.5 opacity-40 transition hover:text-red-400 hover:opacity-100"
                    >
                      ×
                    </button>
                    {index < pipelineSteps.length - 1 && <span className="ml-1 select-none opacity-30">→</span>}
                  </div>
                );
              })}

              {/* Add department button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setAddDropdownOpen(!addDropdownOpen)}
                  disabled={availableDepts.length === 0}
                  className="rounded-md border px-2 py-1 text-xs transition hover:border-blue-500/50 disabled:opacity-30"
                  style={{ borderColor: "var(--th-border)", color: "var(--th-text-muted)" }}
                >
                  +
                </button>
                {addDropdownOpen && availableDepts.length > 0 && (
                  <div
                    className="absolute left-0 top-full z-10 mt-1 min-w-32 rounded-lg border py-1 shadow-lg"
                    style={{ background: "var(--th-bg-secondary)", borderColor: "var(--th-border)" }}
                  >
                    {availableDepts.map((dept) => (
                      <button
                        key={dept.id}
                        type="button"
                        onClick={() => handleAddDept(dept.id)}
                        className="block w-full px-3 py-1.5 text-left text-xs transition hover:bg-blue-600/20"
                        style={{ color: "var(--th-text-primary)" }}
                      >
                        {dept.icon} {dept.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Auto-retry */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
            <input
              type="checkbox"
              checked={enableAutoRetry}
              onChange={(e) => onEnableAutoRetryChange(e.target.checked)}
              className="accent-blue-500"
            />
            {t({
              ko: "실패 시 자동 재시도",
              en: "Auto-retry on failure",
              ja: "失敗時に自動リトライ",
              zh: "Auto-retry on failure",
              de: "Automatisch bei Fehler wiederholen",
            })}
          </label>
          {enableAutoRetry && (
            <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--th-text-muted)" }}>
              Max:
              <select
                value={maxRetries}
                onChange={(e) => onMaxRetriesChange(Number(e.target.value))}
                className="rounded border px-1.5 py-0.5 text-xs"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
    </details>
  );
}
