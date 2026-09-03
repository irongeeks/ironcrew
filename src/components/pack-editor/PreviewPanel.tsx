import { useState, useCallback } from "react";
import { savePackDefinition, validatePackDefinition } from "../../api/workflow-packs";
import type { ValidationResult } from "../../api/workflow-packs";

interface PreviewPanelProps {
  packKey: string;
  definition: Record<string, unknown>;
  readOnly: boolean;
  onSaved: () => void;
  onClose: () => void;
}

export function PreviewPanel({ packKey, definition, readOnly, onSaved, onClose }: PreviewPanelProps) {
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const jsonPreview = JSON.stringify(definition, null, 2);

  const handleValidate = useCallback(async () => {
    const result = await validatePackDefinition(definition);
    setValidationResult(result);
  }, [definition]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await savePackDefinition(packKey, definition);
      setSaveSuccess(true);
      onSaved();
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [packKey, definition, onSaved]);

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-lg border"
      style={{ background: "var(--bg-surface-solid)", borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Pack Definition (JSON)
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleValidate()}
            className="rounded border px-2 py-1 text-[10px] font-medium"
            style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
          >
            Validate
          </button>
          {!readOnly && (
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded px-2 py-1 text-[10px] font-medium text-white"
              style={{ background: saving ? "var(--text-muted)" : "var(--accent)" }}
            >
              {saving ? "Saving..." : saveSuccess ? "Saved!" : "Save"}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-xs hover:opacity-80"
            style={{ color: "var(--text-muted)" }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Validation result */}
      {validationResult && (
        <div
          className="px-4 py-2 text-xs"
          style={{
            background: validationResult.valid ? "var(--status-working-bg)" : "rgba(239,68,68,0.1)",
            color: validationResult.valid ? "var(--status-working)" : "#ef4444",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {validationResult.valid ? (
            "✓ Valid — no errors found"
          ) : (
            <div>
              <div className="mb-1 font-medium">Validation Errors:</div>
              {validationResult.errors.map((err, i) => (
                <div key={i} className="ml-2">
                  <span style={{ color: "var(--text-muted)" }}>{err.path}:</span> {err.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Save error */}
      {saveError && (
        <div
          className="px-4 py-2 text-xs"
          style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", borderBottom: "1px solid var(--border)" }}
        >
          Save failed: {saveError}
        </div>
      )}

      {/* YAML/JSON preview */}
      <pre
        className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed"
        style={{ color: "var(--text-secondary)", background: "var(--bg-base)" }}
      >
        {jsonPreview}
      </pre>
    </div>
  );
}
