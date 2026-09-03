import type { ValidationError } from "../pack-editor/types";

type Mode = "view" | "edit";

interface WorkflowToolbarProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  isDirty: boolean;
  onSave: () => void;
  onPreview: () => void;
  errors: ValidationError[];
  monitorEnabled: boolean;
  onMonitorToggle: () => void;
}

export function WorkflowToolbar({
  mode,
  onModeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isDirty,
  onSave,
  onPreview,
  errors,
  monitorEnabled,
  onMonitorToggle,
}: WorkflowToolbarProps) {
  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-1.5"
      style={{ borderColor: "var(--border)", background: "var(--bg-surface)" }}
    >
      {/* Mode toggle */}
      <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-strong)" }}>
        {(["view", "edit"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            className="px-3 py-1 text-[10px] font-medium capitalize"
            style={{
              background: mode === m ? "var(--accent-dim)" : "var(--bg-surface-solid)",
              color: mode === m ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            {m === "view" ? "View" : "Edit"}
          </button>
        ))}
      </div>

      {/* View mode: monitor toggle */}
      {mode === "view" && (
        <button
          onClick={onMonitorToggle}
          className="rounded-lg border px-2 py-1 text-[10px] font-medium"
          style={{
            borderColor: monitorEnabled ? "var(--accent)" : "var(--border-strong)",
            background: monitorEnabled ? "var(--accent-dim)" : "var(--bg-surface-solid)",
            color: monitorEnabled ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          Live Monitor
        </button>
      )}

      {/* Edit mode: undo/redo + save */}
      {mode === "edit" && (
        <>
          <div className="flex gap-0.5">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className="rounded px-2 py-1 text-xs disabled:opacity-30"
              style={{ color: "var(--text-secondary)" }}
              title="Undo (Ctrl+Z)"
            >
              ↶
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className="rounded px-2 py-1 text-xs disabled:opacity-30"
              style={{ color: "var(--text-secondary)" }}
              title="Redo (Ctrl+Shift+Z)"
            >
              ↷
            </button>
          </div>

          <button
            onClick={onPreview}
            className="rounded-lg border px-2 py-1 text-[10px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-surface-solid)",
              color: "var(--text-muted)",
            }}
          >
            JSON
          </button>

          <button
            onClick={onSave}
            disabled={!isDirty}
            className="rounded-lg border px-3 py-1 text-[10px] font-medium disabled:opacity-30"
            style={{
              borderColor: isDirty ? "var(--accent)" : "var(--border-strong)",
              background: isDirty ? "var(--accent-dim)" : "var(--bg-surface-solid)",
              color: isDirty ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            Save
          </button>
        </>
      )}

      {/* Validation status */}
      {mode === "edit" && errors.length > 0 && (
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-[9px] font-medium"
          style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}
          title={errors.map((e) => e.message).join("\n")}
        >
          {errors.length} issue{errors.length > 1 ? "s" : ""}
        </span>
      )}

      {mode === "edit" && errors.length === 0 && (
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-[9px] font-medium"
          style={{ background: "rgba(52,211,153,0.15)", color: "var(--accent)" }}
        >
          Valid
        </span>
      )}
    </div>
  );
}
