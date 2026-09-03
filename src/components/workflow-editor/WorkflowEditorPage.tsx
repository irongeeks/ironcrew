import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { fetchPackDefinition, savePackDefinition, invalidateEditorCaches } from "../../api/workflow-packs";
import { usePackEditorState } from "../pack-editor/hooks/usePackEditorState";
import { usePackSerializer } from "../pack-editor/hooks/usePackSerializer";
import { usePackValidator } from "../pack-editor/hooks/usePackValidator";
import { useExecutionSync } from "../pack-editor/hooks/useExecutionSync";
import { PropertyPanel } from "../pack-editor/PropertyPanel";
import { PreviewPanel } from "../pack-editor/PreviewPanel";
import { NodePalette } from "../pack-editor/NodePalette";
import { PackMetaPanel } from "../pack-editor/PackMetaPanel";
import { CreatePackDialog } from "../pack-editor/CreatePackDialog";
import type { PackDefinitionResponse } from "../pack-editor/types";
import type { SubTask } from "../../types";
import { WorkflowToolbar } from "./WorkflowToolbar";
import { WorkflowPackSelector } from "./WorkflowPackSelector";
import { SubsystemErrorBoundary } from "../SubsystemErrorBoundary";

const GraphCanvas = lazy(() => import("../pack-editor/GraphCanvas").then((m) => ({ default: m.GraphCanvas })));

type Mode = "view" | "edit";

interface WorkflowEditorPageProps {
  subtasks: SubTask[];
  activePackKey?: string;
}

export function WorkflowEditorPage({ subtasks, activePackKey }: WorkflowEditorPageProps) {
  const [selectedPackKey, setSelectedPackKey] = useState<string | null>(activePackKey ?? null);
  const [mode, setMode] = useState<Mode>("view");
  const [monitorEnabled, setMonitorEnabled] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showPackMeta, setShowPackMeta] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Invalidate editor metadata caches on mount so departments, connectors,
  // and node types are always fresh when the user opens the editor.
  useEffect(() => {
    invalidateEditorCaches();
  }, []);

  const editor = usePackEditorState();
  const serialized = usePackSerializer(editor.state);
  const { errors, errorsByPhase } = usePackValidator(editor.state.phases);

  // TODO: Filter subtasks by selectedPackKey once SubTask carries workflow_pack_key or
  // tasks are passed alongside subtasks. Currently picks the first available task.
  const monitorTaskId = monitorEnabled ? (subtasks.find((s) => s.task_id)?.task_id ?? null) : null;
  const executionState = useExecutionSync(monitorTaskId, subtasks);

  // Load pack definition when selection changes
  useEffect(() => {
    if (!selectedPackKey) return;
    let cancelled = false;

    fetchPackDefinition(selectedPackKey)
      .then((data) => {
        if (cancelled) return;
        editor.loadPack(data as unknown as PackDefinitionResponse);
      })
      .catch(() => {
        // Silently ignore load errors
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPackKey]);

  // Sync when parent changes the active office pack
  useEffect(() => {
    if (activePackKey && activePackKey !== selectedPackKey) {
      setSelectedPackKey(activePackKey);
    }
    // Only react to activePackKey changes from parent, not selectedPackKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePackKey]);

  const handleSave = useCallback(async () => {
    if (!selectedPackKey) return;
    try {
      await savePackDefinition(selectedPackKey, serialized);
      editor.setDirty(false);
    } catch {
      // Save failed silently
    }
  }, [selectedPackKey, serialized, editor]);

  const handlePreviewSaved = useCallback(() => {
    editor.setDirty(false);
  }, [editor]);

  // Keyboard shortcuts
  useEffect(() => {
    if (mode !== "edit") return;

    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        editor.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        editor.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, editor, handleSave]);

  const isEditing = mode === "edit";
  const isReadOnly = isEditing && editor.state.source === "built-in";

  const selectedPhase = editor.state.selectedNodeId
    ? (editor.state.phases.find((p) => p.id === editor.state.selectedNodeId) ?? null)
    : null;

  // Empty state — no pack selected
  if (!selectedPackKey) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4" style={{ color: "var(--text-muted)" }}>
        <span
          className="text-xs font-semibold tracking-wider"
          style={{ fontFamily: "'Press Start 2P', monospace", fontSize: 11 }}
        >
          WORKFLOWS
        </span>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Select a workflow pack to visualize or edit
        </p>
        <WorkflowPackSelector activePackKey={null} onSelect={setSelectedPackKey} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--bg-base)" }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 border-b px-4 py-2"
        style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
      >
        <span
          className="text-xs font-semibold tracking-wider"
          style={{ fontFamily: "'Press Start 2P', monospace", fontSize: 9, color: "var(--text-primary)" }}
        >
          WORKFLOWS
        </span>
        <WorkflowPackSelector activePackKey={selectedPackKey} onSelect={setSelectedPackKey} />

        {isEditing && (
          <button
            onClick={() => setShowPackMeta((v) => !v)}
            className="rounded-lg border px-2 py-1 text-[10px] font-medium"
            style={{
              borderColor: showPackMeta ? "var(--accent)" : "var(--border-strong)",
              background: showPackMeta ? "var(--accent-dim)" : "var(--bg-surface-solid)",
              color: showPackMeta ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            Pack Settings
          </button>
        )}

        {isEditing && (
          <button
            onClick={() => setShowCreateDialog(true)}
            className="rounded-lg border px-2 py-1 text-[10px] font-medium"
            style={{
              borderColor: "var(--status-working)",
              background: "var(--status-working-bg)",
              color: "var(--status-working)",
            }}
          >
            + New Pack
          </button>
        )}
      </div>

      {/* Toolbar */}
      <WorkflowToolbar
        mode={mode}
        onModeChange={setMode}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        onUndo={editor.undo}
        onRedo={editor.redo}
        isDirty={editor.state.dirty && !isReadOnly}
        onSave={() => void handleSave()}
        onPreview={() => setShowPreview((v) => !v)}
        errors={errors}
        monitorEnabled={monitorEnabled}
        onMonitorToggle={() => setMonitorEnabled((v) => !v)}
      />

      {/* Read-only banner for built-in packs */}
      {isEditing && isReadOnly && (
        <div
          className="px-3 py-1 text-center text-[9px]"
          style={{
            background: "rgba(250,204,21,0.1)",
            color: "#facc15",
            borderBottom: "1px solid rgba(250,204,21,0.2)",
          }}
        >
          Built-in pack (read-only). Duplicate to community to edit.
        </div>
      )}

      {/* Main area */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Graph canvas */}
        <div className="relative flex-1">
          <SubsystemErrorBoundary name="Graph Editor" resetKey={selectedPackKey ?? ""}>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
                  Loading graph...
                </div>
              }
            >
              <GraphCanvas
                packKey={selectedPackKey}
                executionState={monitorEnabled ? executionState : undefined}
                validationErrors={mode === "edit" ? errorsByPhase : undefined}
                editorMode={mode === "edit"}
                editorPhases={mode === "edit" ? editor.state.phases : undefined}
                onNodeSelect={editor.selectNode}
                onConnect={(sourcePhaseId, outputName, targetPhaseId, inputName) => {
                  editor.connectPorts(targetPhaseId, inputName, `${sourcePhaseId}.${outputName}`);
                }}
              />
            </Suspense>
          </SubsystemErrorBoundary>

          {/* Node palette overlay (edit mode only) */}
          {mode === "edit" && (
            <div className="absolute left-3 top-3 z-10">
              <NodePalette onAddPhase={editor.addPhase} />
            </div>
          )}
        </div>

        {/* Side panel: PropertyPanel or PackMetaPanel */}
        {mode === "edit" && selectedPhase && !showPackMeta && (
          <PropertyPanel
            packKey={selectedPackKey}
            phase={selectedPhase}
            readOnly={isReadOnly}
            onUpdate={editor.updatePhase}
            onClose={() => editor.selectNode(null)}
          />
        )}

        {mode === "edit" && showPackMeta && (
          <PackMetaPanel
            state={editor.state}
            readOnly={isReadOnly}
            onUpdate={(updates) => {
              if (updates.packMeta || updates.costProfile !== undefined || updates.qaRules !== undefined) {
                editor.updatePackMeta({
                  packMeta: updates.packMeta,
                  costProfile: updates.costProfile,
                  qaRules: updates.qaRules,
                });
              }
              if (updates.input) {
                editor.updateInput(updates.input);
              }
            }}
            onClose={() => setShowPackMeta(false)}
          />
        )}

        {showCreateDialog && (
          <CreatePackDialog
            onClose={() => setShowCreateDialog(false)}
            onCreated={(newKey) => {
              setShowCreateDialog(false);
              invalidateEditorCaches();
              setSelectedPackKey(newKey);
            }}
          />
        )}

        {/* Preview panel overlay */}
        {mode === "edit" && showPreview && (
          <div className="absolute inset-y-0 right-0 z-20 w-[400px]">
            <PreviewPanel
              packKey={selectedPackKey}
              definition={serialized}
              readOnly={editor.state.source === "built-in"}
              onSaved={handlePreviewSaved}
              onClose={() => setShowPreview(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
