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
  const nodeInputOptions = buildNodeInputOptions(parsedNodes);

  return (
    <div
      className="space-y-3 rounded-lg border p-4"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <h4 className="text-sm font-medium text-slate-200">
        {editingId
          ? t({
              ko: "워크플로우 편집",
              en: "Edit Workflow",
              ja: "ワークフロー編集",
              zh: "Edit Workflow",
              de: "Workflow bearbeiten",
            })
          : t({
              ko: "새 워크플로우",
              en: "New Workflow",
              ja: "新規ワークフロー",
              zh: "New Workflow",
              de: "Neuer Workflow",
            })}
      </h4>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "이름", en: "Name", ja: "名前", zh: "Name", de: "Name" })}
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
            {t({ ko: "타입", en: "Type", ja: "タイプ", zh: "Type", de: "Typ" })}
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
            <option value="text2img">Text → Image</option>
            <option value="img2video">Image → Video</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>

      {/* ── Workflow JSON upload zone ── */}
      <div>
        <span className="mb-1 block text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {t({
            ko: "Workflow JSON (파일 업로드 또는 드래그 & 드롭)",
            en: "Workflow JSON (upload or drag & drop)",
            ja: "Workflow JSON (ファイルアップロードまたはドラッグ&ドロップ)",
            zh: "Workflow JSON (upload or drag & drop)",
            de: "Workflow JSON (hochladen oder Drag & Drop)",
          })}
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
                })}
              </span>
              <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "다시 클릭하여 교체",
                  en: "Click to replace",
                  ja: "クリックして差し替え",
                  zh: "Click to replace",
                  de: "Zum Ersetzen klicken",
                })}
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  ko: "ComfyUI API JSON 파일을 드래그하거나 클릭하세요",
                  en: "Drop ComfyUI API JSON file here or click to browse",
                  ja: "ComfyUI API JSONファイルをドラッグまたはクリック",
                  zh: "Drop ComfyUI API JSON file here or click to browse",
                  de: "ComfyUI API JSON-Datei hierher ziehen oder klicken zum Durchsuchen",
                })}
              </p>
              <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "ComfyUI에서 'Save (API Format)'으로 내보낸 JSON",
                  en: "Export from ComfyUI via 'Save (API Format)'",
                  ja: "ComfyUIから「Save (API Format)」でエクスポート",
                  zh: "Export from ComfyUI via 'Save (API Format)'",
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
              ? t({
                  ko: "JSON 숨기기",
                  en: "Hide raw JSON",
                  ja: "JSONを非表示",
                  zh: "Hide raw JSON",
                  de: "Roh-JSON ausblenden",
                })
              : t({
                  ko: "JSON 보기",
                  en: "Show raw JSON",
                  ja: "JSONを表示",
                  zh: "Show raw JSON",
                  de: "Roh-JSON anzeigen",
                })}
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
              ko: "파라미터 매핑 — 각 역할에 노드 입력을 할당하세요",
              en: "Parameter Mapping — assign node inputs to each role",
              ja: "パラメータマッピング — 各役割にノード入力を割り当て",
              zh: "Parameter Mapping — assign node inputs to each role",
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
          {t({
            ko: "기본 서버 ID (선택)",
            en: "Default Server ID (optional)",
            ja: "デフォルトサーバー ID (任意)",
            zh: "Default Server ID (optional)",
            de: "Standard-Server-ID (optional)",
          })}
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
          placeholder="Server UUID from Servers settings"
        />
      </label>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !form.name || !form.workflow_json}
          className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
        >
          {saving ? "..." : t({ ko: "저장", en: "Save", ja: "保存", zh: "Save", de: "Speichern" })}
        </button>
        <button
          onClick={resetForm}
          className="rounded border px-3 py-1.5 text-xs"
          style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
        >
          {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
        </button>
      </div>
    </div>
  );
}
