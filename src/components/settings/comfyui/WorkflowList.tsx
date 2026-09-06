import LocalizedText from "../../LocalizedText";
import type { ComfyUiWorkflow } from "../../../api/comfyui-workflows";
import type { TFunction } from "../types";

export interface WorkflowListProps {
  t: TFunction;
  workflows: ComfyUiWorkflow[];
  loading: boolean;
  testing: string | null;
  testResult: { id: string; ok: boolean; msg: string } | null;
  onTest: (id: string) => void;
  onEdit: (wf: ComfyUiWorkflow) => void;
  onDelete: (id: string) => void;
}

function typeLabel(wt: string) {
  if (wt === "text2img") return "Text \u2192 Image";
  if (wt === "img2video") return "Image \u2192 Video";
  return "Custom";
}

export function WorkflowList({
  t,
  workflows,
  loading,
  testing,
  testResult,
  onTest,
  onEdit,
  onDelete,
}: WorkflowListProps) {
  if (loading) {
    return (
      <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
        <LocalizedText en="Loading..." de="Wird geladen …" />
      </p>
    );
  }

  if (workflows.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
        {t({ en: "No ComfyUI workflows configured.", de: "Keine ComfyUI-Workflows konfiguriert." })}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {workflows.map((wf) => (
        <div
          key={wf.id}
          className="flex items-center justify-between rounded-lg border px-4 py-3"
          style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-200">{wf.name}</span>
              <span
                className="rounded px-1.5 py-0.5 text-[10px]"
                style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
              >
                {typeLabel(wf.workflow_type)}
              </span>
              {!wf.enabled && (
                <span className="rounded bg-yellow-900/40 px-1.5 py-0.5 text-[10px] text-yellow-400">
                  {t({ en: "Disabled", de: "Deaktiviert" })}
                </span>
              )}
            </div>
            {wf.default_server_id && (
              <p className="mt-0.5 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                Server: {wf.default_server_id.slice(0, 8)}...
              </p>
            )}
            {testResult?.id === wf.id && (
              <p className={`mt-1 text-[10px] ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                {testResult.msg}
              </p>
            )}
          </div>

          <div className="flex gap-1.5">
            <button
              onClick={() => onTest(wf.id)}
              disabled={testing === wf.id}
              className="rounded border px-2 py-1 text-[10px] disabled:opacity-50"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
            >
              {testing === wf.id ? "..." : t({ en: "Test", de: "Testen" })}
            </button>
            <button
              onClick={() => onEdit(wf)}
              className="rounded border px-2 py-1 text-[10px]"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
            >
              {t({ en: "Edit", de: "Bearbeiten" })}
            </button>
            <button
              onClick={() => onDelete(wf.id)}
              className="rounded border border-red-800 px-2 py-1 text-[10px] text-red-400 hover:bg-red-900/40"
            >
              {t({ en: "Delete", de: "Löschen" })}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
