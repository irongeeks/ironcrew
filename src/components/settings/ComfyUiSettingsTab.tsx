import type { TFunction } from "./types";
import { useComfyUiWorkflowForm } from "./comfyui/useComfyUiWorkflowForm";
import { WorkflowForm } from "./comfyui/WorkflowForm";
import { WorkflowList } from "./comfyui/WorkflowList";

interface ComfyUiSettingsTabProps {
  t: TFunction;
}

export default function ComfyUiSettingsTab({ t }: ComfyUiSettingsTabProps) {
  const hf = useComfyUiWorkflowForm();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({
            ko: "ComfyUI 워크플로우",
            en: "ComfyUI Workflows",
            ja: "ComfyUI ワークフロー",
            zh: "ComfyUI Workflows",
            de: "ComfyUI Workflows",
          })}
        </h3>
        {!hf.addMode && (
          <button
            onClick={hf.startAdd}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            + {t({ ko: "추가", en: "Add", ja: "追加", zh: "Add", de: "Hinzufügen" })}
          </button>
        )}
      </div>

      <div className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="mb-1 block text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "ComfyUI 서버 URL",
              en: "ComfyUI Server URL",
              ja: "ComfyUI サーバー URL",
              zh: "ComfyUI Server URL",
              de: "ComfyUI Server-URL",
            })}
          </span>
          <input
            value={hf.serverUrl}
            onChange={(e) => hf.setServerUrl(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-xs"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
            placeholder="http://localhost:8188"
          />
        </label>
        <button
          onClick={() => hf.saveServerUrl(hf.serverUrl)}
          className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
        >
          {hf.serverUrlSaved
            ? t({ ko: "저장됨", en: "Saved", ja: "保存済み", zh: "Saved", de: "Gespeichert" })
            : t({ ko: "저장", en: "Save", ja: "保存", zh: "Save", de: "Speichern" })}
        </button>
      </div>

      {hf.error && (
        <div className="rounded bg-red-900/40 px-3 py-2 text-xs text-red-300">
          {hf.error}
          <button onClick={() => hf.setError(null)} className="ml-2 text-red-400 hover:text-red-200">
            ✕
          </button>
        </div>
      )}

      {hf.addMode && (
        <WorkflowForm
          t={t}
          editingId={hf.editingId}
          form={hf.form}
          setForm={hf.setForm}
          saving={hf.saving}
          parsedNodes={hf.parsedNodes}
          roleAssignments={hf.roleAssignments}
          showRawJson={hf.showRawJson}
          setShowRawJson={hf.setShowRawJson}
          dragOver={hf.dragOver}
          setDragOver={hf.setDragOver}
          fileInputRef={hf.fileInputRef}
          handleFileDrop={hf.handleFileDrop}
          handleFileSelect={hf.handleFileSelect}
          handleRoleChange={hf.handleRoleChange}
          handleSave={hf.handleSave}
          resetForm={hf.resetForm}
        />
      )}

      <WorkflowList
        t={t}
        workflows={hf.workflows}
        loading={hf.loading}
        testing={hf.testing}
        testResult={hf.testResult}
        onTest={hf.handleTest}
        onEdit={hf.handleEdit}
        onDelete={(id) => hf.handleDelete(id, t)}
      />
    </div>
  );
}
