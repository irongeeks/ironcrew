import { useState, useCallback, useEffect } from "react";
import type { UiLanguage } from "../i18n";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

type DeptTheme = { floor1: number; floor2: number; wall: number; accent: number };

export interface OfficeRoomManagerProps {
  departments: Array<{ id: string; name: string }>;
  customThemes: Record<string, DeptTheme>;
  onThemeChange: (themes: Record<string, DeptTheme>) => void;
  onActiveDeptChange?: (deptId: string | null) => void;
  onClose: () => void;
  language: UiLanguage;
}

/* ================================================================== */
/*  Constants                                                           */
/* ================================================================== */

const DEFAULT_THEMES: Record<string, DeptTheme> = {
  research: { floor1: 0xd0ecec, floor2: 0xc5e5e5, wall: 0x6b9e9e, accent: 0x06b6d4 },
  planning: { floor1: 0xf0e1c5, floor2: 0xeddaba, wall: 0xae9871, accent: 0xd4a85a },
  dev: { floor1: 0xd8e8f5, floor2: 0xcce1f2, wall: 0x6c96b7, accent: 0x5a9fd4 },
  testing: { floor1: 0xd0f0e0, floor2: 0xc5ebd5, wall: 0x71ae8b, accent: 0x10b981 },
  review: { floor1: 0xf0cbcb, floor2: 0xedc0c0, wall: 0xae7979, accent: 0xd46a6a },
  design: { floor1: 0xe8def2, floor2: 0xe1d4ee, wall: 0x9378ad, accent: 0x9a6fc4 },
  ceoOffice: { floor1: 0xe5d9b9, floor2: 0xdfd0a8, wall: 0x998243, accent: 0xa77d0c },
  breakRoom: { floor1: 0xf7e2b7, floor2: 0xf6dead, wall: 0xa99c83, accent: 0xf0c878 },
};

const DEFAULT_TONE = 50;

const labels = {
  title: { ko: "사무실 관리", en: "Office Manager", ja: "オフィス管理", zh: "Office Manager", de: "Office Manager" },
  accent: { ko: "메인 색상", en: "Main Color", ja: "メインカラー", zh: "Main Color", de: "Main Color" },
  tone: {
    ko: "톤 (밝기)",
    en: "Tone (Brightness)",
    ja: "トーン（明るさ）",
    zh: "Tone (Brightness)",
    de: "Tone (Brightness)",
  },
  reset: { ko: "초기화", en: "Reset", ja: "リセット", zh: "Reset", de: "Reset" },
  resetAll: { ko: "전체 초기화", en: "Reset All", ja: "全てリセット", zh: "Reset All", de: "Reset All" },
  close: { ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Close" },
  presets: { ko: "프리셋", en: "Presets", ja: "プリセット", zh: "Presets", de: "Presets" },
};

/* ================================================================== */
/*  Color helpers                                                       */
/* ================================================================== */

function numToHex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

function hexToNum(h: string): number {
  return parseInt(h.replace("#", ""), 16);
}

function blendColor(from: number, to: number, t: number): number {
  const c = Math.max(0, Math.min(1, t));
  const fr = (from >> 16) & 0xff,
    fg = (from >> 8) & 0xff,
    fb = from & 0xff;
  const tr = (to >> 16) & 0xff,
    tg = (to >> 8) & 0xff,
    tb = to & 0xff;
  return (
    (Math.round(fr + (tr - fr) * c) << 16) | (Math.round(fg + (tg - fg) * c) << 8) | Math.round(fb + (tb - fb) * c)
  );
}

const TONE_PRESET_STEPS = [15, 25, 35, 45, 55, 65, 75, 85] as const;

function generateTonePresets(accent: number): Array<{ tone: number; swatch: number }> {
  return TONE_PRESET_STEPS.map((tone) => ({
    tone,
    swatch: deriveTheme(accent, tone).wall,
  }));
}

function deriveTheme(accent: number, tone: number): DeptTheme {
  const t = tone / 100;
  return {
    accent,
    floor1: blendColor(accent, 0xffffff, 0.85 - t * 0.004 * 100),
    floor2: blendColor(accent, 0xffffff, 0.78 - t * 0.004 * 100),
    wall: blendColor(accent, 0x888888, 0.3 + t * 0.004 * 100),
  };
}

/* Reverse-infer a tone value from an existing theme (best-effort, default 50) */
function inferTone(theme: DeptTheme): number {
  // We try to infer from floor1 blend ratio: floor1 = blend(accent, white, 0.85 - tone*0.4)
  // ratio r = (0.85 - tone*0.4) => tone = (0.85 - r) / 0.4
  const ar = (theme.accent >> 16) & 0xff;
  const af = (theme.floor1 >> 16) & 0xff;
  if (ar === 0xff) return DEFAULT_TONE; // avoid degenerate
  const r = (af - ar) / (0xff - ar);
  const tone = Math.round(((0.85 - r) / 0.4) * 100);
  return Math.max(0, Math.min(100, isNaN(tone) ? DEFAULT_TONE : tone));
}

/* ================================================================== */
/*  Per-department state                                                */
/* ================================================================== */

interface DeptState {
  accent: number;
  tone: number;
}

function initDeptState(deptId: string, customThemes: Record<string, DeptTheme>): DeptState {
  const theme = customThemes[deptId] ?? DEFAULT_THEMES[deptId];
  if (!theme) return { accent: 0x5a9fd4, tone: DEFAULT_TONE };
  return { accent: theme.accent, tone: inferTone(theme) };
}

/* ================================================================== */
/*  Sub-component: DeptCard                                             */
/* ================================================================== */

interface DeptCardProps {
  deptId: string;
  deptName: string;
  state: DeptState;
  language: UiLanguage;
  onActivate: () => void;
  onAccentChange: (accent: number) => void;
  onToneChange: (tone: number) => void;
  onReset: () => void;
}

function DeptCard({
  deptId: _deptId,
  deptName,
  state,
  language,
  onActivate,
  onAccentChange,
  onToneChange,
  onReset,
}: DeptCardProps) {
  const theme = deriveTheme(state.accent, state.tone);
  const presets = generateTonePresets(state.accent);

  return (
    <div
      className="border rounded-lg p-4 space-y-3"
      style={{ background: "var(--th-card-bg)", borderColor: "var(--th-border)" }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {deptName}
        </span>
        <button
          onClick={() => {
            onActivate();
            onReset();
          }}
          className="text-xs px-2 py-0.5 rounded border transition-colors"
          style={{ color: "var(--th-text-secondary)", borderColor: "var(--th-border-strong)" }}
        >
          {labels.reset[language]}
        </button>
      </div>

      {/* Preview swatch */}
      <div className="flex gap-1 h-6 rounded overflow-hidden border" style={{ borderColor: "var(--th-border-strong)" }}>
        <div className="flex-1" style={{ backgroundColor: numToHex(theme.floor1) }} />
        <div className="flex-1" style={{ backgroundColor: numToHex(theme.floor2) }} />
        <div className="flex-1" style={{ backgroundColor: numToHex(theme.wall) }} />
        <div className="w-6 flex-none" style={{ backgroundColor: numToHex(theme.accent) }} />
      </div>

      {/* Preset palette */}
      <div className="space-y-1">
        <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {labels.presets[language]}
        </span>
        <div className="flex gap-1.5 flex-wrap">
          {presets.map((preset) => (
            <button
              key={preset.tone}
              onClick={() => {
                onActivate();
                onToneChange(preset.tone);
              }}
              title={`Tone ${preset.tone}`}
              className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none"
              style={{
                backgroundColor: numToHex(preset.swatch),
                borderColor: Math.abs(state.tone - preset.tone) <= 2 ? "#fff" : "transparent",
              }}
            />
          ))}
        </div>
      </div>

      {/* Accent color picker */}
      <div className="flex items-center gap-3">
        <label className="text-xs w-20 shrink-0" style={{ color: "var(--th-text-secondary)" }}>
          {labels.accent[language]}
        </label>
        <input
          type="color"
          value={numToHex(state.accent)}
          onChange={(e) => {
            onActivate();
            onAccentChange(hexToNum(e.target.value));
          }}
          onInput={(e) => {
            onActivate();
            onAccentChange(hexToNum((e.target as HTMLInputElement).value));
          }}
          className="w-8 h-8 rounded cursor-pointer border bg-transparent p-0"
          style={{ borderColor: "var(--th-border-strong)" }}
        />
        <span className="text-xs font-mono" style={{ color: "var(--th-text-muted)" }}>
          {numToHex(state.accent)}
        </span>
      </div>

      {/* Tone slider */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {labels.tone[language]}
          </label>
          <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            {state.tone}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            Light
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={state.tone}
            onChange={(e) => {
              onActivate();
              onToneChange(Number(e.target.value));
            }}
            onInput={(e) => {
              onActivate();
              onToneChange(Number((e.target as HTMLInputElement).value));
            }}
            className="flex-1 accent-slate-400 h-1.5 cursor-pointer"
          />
          <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            Dark
          </span>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Main component                                                      */
/* ================================================================== */

export default function OfficeRoomManager({
  departments,
  customThemes,
  onThemeChange,
  onActiveDeptChange,
  onClose,
  language,
}: OfficeRoomManagerProps) {
  const [deptStates, setDeptStates] = useState<Record<string, DeptState>>(() => {
    const result: Record<string, DeptState> = {};
    for (const dept of departments) {
      result[dept.id] = initDeptState(dept.id, customThemes);
    }
    return result;
  });

  const buildAndEmit = useCallback(
    (next: Record<string, DeptState>) => {
      const themes: Record<string, DeptTheme> = {};
      for (const [id, s] of Object.entries(next)) {
        themes[id] = deriveTheme(s.accent, s.tone);
      }
      onThemeChange(themes);
    },
    [onThemeChange],
  );

  const updateDept = useCallback(
    (deptId: string, patch: Partial<DeptState>) => {
      setDeptStates((prev) => {
        const next = { ...prev, [deptId]: { ...prev[deptId], ...patch } };
        buildAndEmit(next);
        return next;
      });
    },
    [buildAndEmit],
  );

  const resetDept = useCallback(
    (deptId: string) => {
      const def = DEFAULT_THEMES[deptId];
      if (!def) return;
      const next: DeptState = { accent: def.accent, tone: inferTone(def) };
      setDeptStates((prev) => {
        const updated = { ...prev, [deptId]: next };
        buildAndEmit(updated);
        return updated;
      });
    },
    [buildAndEmit],
  );

  const resetAll = useCallback(() => {
    const next: Record<string, DeptState> = {};
    for (const dept of departments) {
      const def = DEFAULT_THEMES[dept.id];
      next[dept.id] = def ? { accent: def.accent, tone: inferTone(def) } : { accent: 0x5a9fd4, tone: DEFAULT_TONE };
    }
    setDeptStates(next);
    buildAndEmit(next);
  }, [departments, buildAndEmit]);

  const activateDept = useCallback(
    (deptId: string) => {
      onActiveDeptChange?.(deptId);
    },
    [onActiveDeptChange],
  );

  useEffect(() => () => onActiveDeptChange?.(null), [onActiveDeptChange]);

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end"
      style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel */}
      <div
        className="w-full md:max-w-md flex flex-col h-full shadow-2xl border-l"
        style={{ background: "var(--th-bg-secondary)", borderColor: "var(--th-border)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b shrink-0"
          style={{ borderColor: "var(--th-border)" }}
        >
          <h2 className="text-base font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {labels.title[language]}
          </h2>
          <button
            onClick={onClose}
            className="transition-colors w-8 h-8 flex items-center justify-center rounded"
            style={{ color: "var(--th-text-secondary)" }}
            aria-label={labels.close[language]}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>

        {/* Scrollable dept list */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {departments.map((dept) => {
            const state = deptStates[dept.id] ?? { accent: 0x5a9fd4, tone: DEFAULT_TONE };
            return (
              <DeptCard
                key={dept.id}
                deptId={dept.id}
                deptName={dept.name}
                state={state}
                language={language}
                onActivate={() => activateDept(dept.id)}
                onAccentChange={(accent) => updateDept(dept.id, { accent })}
                onToneChange={(tone) => updateDept(dept.id, { tone })}
                onReset={() => resetDept(dept.id)}
              />
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-4 border-t shrink-0 flex gap-2" style={{ borderColor: "var(--th-border)" }}>
          <button
            onClick={resetAll}
            className="flex-1 py-2 rounded-md text-sm font-medium transition-colors"
            style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
          >
            {labels.resetAll[language]}
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-md text-sm font-medium transition-colors"
            style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-heading)" }}
          >
            {labels.close[language]}
          </button>
        </div>
      </div>
    </div>
  );
}
