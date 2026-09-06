import LocalizedText, { useUiCopy } from "../../LocalizedText";
import type { RefObject } from "react";
import type { TFunction } from "../types";
import type { FormState } from "./constants";
import { ROLE_OPTIONS } from "./constants";
import type { ParsedNode, RoleAssignment } from "./workflowNodeParser";
import { buildNodeInputOptions } from "./workflowNodeParser";

export interface WorkflowFormProps {
  t: TFunction;
  editingId: string | null;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  saving: boolean;
  parsedNodes: ParsedNode[];
  roleAssignments: RoleAssignment[];
  showRawJson: boolean;
  setShowRawJson: React.Dispatch<React.SetStateAction<boolean>>;
  dragOver: boolean;
  setDragOver: React.Dispatch<React.SetStateAction<boolean>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileDrop: (e: React.DragEvent) => void;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleRoleChange: (roleKey: string, value: string) => void;
  handleSave: () => void;
  resetForm: () => void;
}

export function WorkflowForm({
  t,
  editingId,
  form,
  setForm,
  saving,
  parsedNodes,
  roleAssignments,
  showRawJson,
  setShowRawJson,
  dragOver,
  setDragOver,
  fileInputRef,
  handleFileDrop,
  handleFileSelect,
  handleRoleChange,
  handleSave,
  resetForm,
}: WorkflowFormProps) {
  const translateUiCopy = useUiCopy();
  const nodeInputOptions = buildNodeInputOptions(parsedNodes);

  return (
    <div
      className="space-y-3 rounded-lg border p-4"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <h4 className="text-sm font-medium text-slate-200">
        {editingId
          ? t({ en: "Edit Workflow", de: "Workflow bearbeiten" })
          : t({ en: "New Workflow", de: "Neuer Workflow" })}
      </h4>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Name", de: "Name" })}
          </span>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full rounded border px-2 py-1.5 text-xs"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
            placeholder="e.g. Shortfilm T2I"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Type", de: "Typ" })}
          </span>
          <select
            value={form.workflow_type}
            onChange={(e) => setForm((f) => ({ ...f, workflow_type: e.target.value as FormState["workflow_type"] }))}
            className="w-full rounded border px-2 py-1.5 text-xs"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            <option value="text2img">
              <LocalizedText en="Text → Image" de="Text → Bild" />
            </option>
            <option value="img2video">
              <LocalizedText en="Image → Video" de="Bild → Video" />
            </option>
            <option value="custom">
              <LocalizedText en="Custom" de="Benutzerdefiniert" />
            </option>
          </select>
        </label>
      </div>

      {/* ── Workflow JSON upload zone ── */}
      <div>
        <span className="mb-1 block text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {t({ en: "Workflow JSON (upload or drag & drop)", de: "Workflow JSON (hochladen oder Drag & Drop)" })}
        </span>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleFileDrop}
          onClick={() => fileInputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed px-4 py-6 transition-colors"
          style={{
            borderColor: dragOver ? "var(--th-accent, #3b82f6)" : "var(--th-border)",
            background: dragOver ? "rgba(59,130,246,0.08)" : "var(--th-input-bg)",
          }}
        >
          <input ref={fileInputRef} type="file" accept=".json" onChange={handleFileSelect} className="hidden" />
          {form.workflow_json ? (
            <div className="text-center">
              <span className="text-xs text-green-400">
                {t({
                  ko: `워크플로우 로드됨 (${parsedNodes.length}개 노드)`,
                  en: `Workflow loaded (${parsedNodes.length} nodes with inputs)`,
                  ja: `ワークフローロード済み (${parsedNodes.length}ノード)`,
                  zh: `Workflow loaded (${parsedNodes.length} nodes)`,
                  de: `Workflow geladen (${parsedNodes.length} Knoten mit Eingaben)`,
                })}
              </span>
              <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                {t({ en: "Click to replace", de: "Zum Ersetzen klicken" })}
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  en: "Drop ComfyUI API JSON file here or click to browse",
                  de: "ComfyUI API JSON-Datei hierher ziehen oder klicken zum Durchsuchen",
                })}
              </p>
              <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  en: "Export from ComfyUI via 'Save (API Format)'",
                  de: "Export aus ComfyUI über 'Save (API Format)'",
                })}
              </p>
            </div>
          )}
        </div>

        {form.workflow_json && (
          <button
            onClick={() => setShowRawJson((v) => !v)}
            className="mt-1 text-[10px] underline"
            style={{ color: "var(--th-text-muted)" }}
          >
            {showRawJson
              ? t({ en: "Hide raw JSON", de: "Roh-JSON ausblenden" })
              : t({ en: "Show raw JSON", de: "Roh-JSON anzeigen" })}
          </button>
        )}
        {showRawJson && (
          <textarea
            readOnly
            value={form.workflow_json}
            className="mt-1 h-32 w-full rounded border px-2 py-1.5 font-mono text-[10px]"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-muted)",
            }}
          />
        )}
      </div>

      {/* ── Parameter mapping via node picker ── */}
      {parsedNodes.length > 0 && (
        <div>
          <span className="mb-2 block text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "Parameter Mapping — assign node inputs to each role",
              de: "Parameterzuordnung — Nodeneingaben für jede Rolle zuweisen",
            })}
          </span>
          <div className="space-y-2">
            {ROLE_OPTIONS.map((role) => {
              const current = roleAssignments.find((a) => a.paramKey === role.key);
              const currentValue = current ? `${current.nodeId}::${current.inputKey}` : "";
              return (
                <div key={role.key} className="flex items-center gap-2">
                  <span
                    className="w-32 shrink-0 rounded px-2 py-1 text-[11px] font-medium"
                    style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
                  >
                    {role.label}
                  </span>
                  <select
                    value={currentValue}
                    onChange={(e) => handleRoleChange(role.key, e.target.value)}
                    className="flex-1 rounded border px-2 py-1 text-xs"
                    style={{
                      background: "var(--th-input-bg)",
                      borderColor: "var(--th-input-border)",
                      color: "var(--th-text-primary)",
                    }}
                  >
                    {nodeInputOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          {/* Show detected nodes summary */}
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px]" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: `발견된 노드 (${parsedNodes.length}개)`,
                en: `Detected nodes (${parsedNodes.length})`,
                ja: `検出されたノード (${parsedNodes.length})`,
                zh: `Detected nodes (${parsedNodes.length})`,
                de: `Erkannte Nodes (${parsedNodes.length})`,
              })}
            </summary>
            <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
              {parsedNodes.map((node) => (
                <div
                  key={node.nodeId}
                  className="flex items-center gap-2 text-[10px]"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  <code className="shrink-0 rounded px-1" style={{ background: "var(--th-bg-surface-hover)" }}>
                    {node.nodeId}
                  </code>
                  <span>{node.title}</span>
                  <span style={{ color: "var(--th-text-muted)" }}>({node.classType})</span>
                  <span>
                    [{[...node.stringInputs.map((i) => i.key), ...node.numericInputs.map((i) => i.key)].join(", ")}]
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-xs text-slate-400">
          {t({ en: "Default Server ID (optional)", de: "Standard-Server-ID (optional)" })}
        </span>
        <input
          value={form.default_server_id}
          onChange={(e) => setForm((f) => ({ ...f, default_server_id: e.target.value }))}
          className="w-full rounded border px-2 py-1.5 text-xs"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
          placeholder={translateUiCopy("Server UUID from Servers settings", "Server-UUID aus den Servereinstellungen")}
        />
      </label>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !form.name || !form.workflow_json}
          className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
        >
          {saving ? "..." : t({ en: "Save", de: "Speichern" })}
        </button>
        <button
          onClick={resetForm}
          className="rounded border px-3 py-1.5 text-xs"
          style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
        >
          {t({ en: "Cancel", de: "Abbrechen" })}
        </button>
      </div>
    </div>
  );
}
