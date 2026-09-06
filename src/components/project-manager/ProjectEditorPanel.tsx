import type { Dispatch, SetStateAction } from "react";
import { isApiRequestError, pickProjectPathNative, type ProjectDetailResponse } from "../../api";
import type { Agent, AssignmentMode, Department, Project } from "../../types";
import type {
  FormFeedback,
  ManualAssignmentWarning,
  MissingPathPrompt,
  ProjectI18nTranslate,
  ProjectManualSelectionStats,
} from "./types";
import ManualAssignmentSelector from "./ManualAssignmentSelector";

interface ProjectEditorPanelProps {
  t: ProjectI18nTranslate;
  language: string;
  isCreating: boolean;
  editingProjectId: string | null;
  selectedProject: Project | null;
  detail: ProjectDetailResponse | null;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  projectPath: string;
  setProjectPath: Dispatch<SetStateAction<string>>;
  coreGoal: string;
  setCoreGoal: Dispatch<SetStateAction<string>>;
  saving: boolean;
  canSave: boolean;
  pathToolsVisible: boolean;
  pathSuggestionsOpen: boolean;
  setPathSuggestionsOpen: Dispatch<SetStateAction<boolean>>;
  pathSuggestionsLoading: boolean;
  pathSuggestions: string[];
  missingPathPrompt: MissingPathPrompt | null;
  setMissingPathPrompt: Dispatch<SetStateAction<MissingPathPrompt | null>>;
  pathApiUnsupported: boolean;
  setPathApiUnsupported: Dispatch<SetStateAction<boolean>>;
  nativePathPicking: boolean;
  setNativePathPicking: Dispatch<SetStateAction<boolean>>;
  nativePickerUnsupported: boolean;
  setNativePickerUnsupported: Dispatch<SetStateAction<boolean>>;
  setManualPathPickerOpen: Dispatch<SetStateAction<boolean>>;
  loadManualPathEntries: (targetPath?: string) => Promise<void>;
  unsupportedPathApiMessage: string;
  resolvePathHelperErrorMessage: (
    err: unknown,
    fallback: { ko?: string; en: string; ja?: string; zh?: string; de?: string },
  ) => string;
  formFeedback: FormFeedback | null;
  setFormFeedback: Dispatch<SetStateAction<FormFeedback | null>>;
  assignmentMode: AssignmentMode;
  setAssignmentMode: Dispatch<SetStateAction<AssignmentMode>>;
  setManualAssignmentWarning: Dispatch<SetStateAction<ManualAssignmentWarning | null>>;
  manualSelectionStats: ProjectManualSelectionStats;
  selectedAgentIds: Set<string>;
  setSelectedAgentIds: Dispatch<SetStateAction<Set<string>>>;
  agentFilterDept: string;
  setAgentFilterDept: Dispatch<SetStateAction<string>>;
  agents: Agent[];
  departments: Department[];
  spriteMap: Map<string, number>;
  onSave: () => void;
  onCancelEdit: () => void;
  onStartEditSelected: () => void;
  onDelete: () => void;
}

export default function ProjectEditorPanel({
  t,
  language,
  isCreating,
  editingProjectId,
  selectedProject,
  detail,
  name,
  setName,
  projectPath,
  setProjectPath,
  coreGoal,
  setCoreGoal,
  saving,
  canSave,
  pathToolsVisible,
  pathSuggestionsOpen,
  setPathSuggestionsOpen,
  pathSuggestionsLoading,
  pathSuggestions,
  missingPathPrompt,
  setMissingPathPrompt,
  pathApiUnsupported,
  setPathApiUnsupported,
  nativePathPicking,
  setNativePathPicking,
  nativePickerUnsupported,
  setNativePickerUnsupported,
  setManualPathPickerOpen,
  loadManualPathEntries,
  unsupportedPathApiMessage,
  resolvePathHelperErrorMessage,
  formFeedback,
  setFormFeedback,
  assignmentMode,
  setAssignmentMode,
  setManualAssignmentWarning,
  manualSelectionStats,
  selectedAgentIds,
  setSelectedAgentIds,
  agentFilterDept,
  setAgentFilterDept,
  agents,
  departments,
  spriteMap,
  onSave,
  onCancelEdit,
  onStartEditSelected,
  onDelete,
}: ProjectEditorPanelProps) {
  return (
    <div
      className="min-w-0 space-y-3 rounded-xl border p-4"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <label className="block text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {t({ en: "Project Name", de: "Projektname" })}
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setFormFeedback(null);
          }}
          disabled={!isCreating && !editingProjectId}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />
      </label>
      <label className="block text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {t({ en: "Project Path", de: "Projektpfad" })}
        <input
          type="text"
          value={projectPath}
          onChange={(e) => {
            setProjectPath(e.target.value);
            setMissingPathPrompt(null);
            setFormFeedback(null);
          }}
          disabled={!isCreating && !editingProjectId}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />
      </label>
      {pathToolsVisible && (
        <div className="space-y-2">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={pathApiUnsupported}
              onClick={() => {
                setFormFeedback(null);
                setManualPathPickerOpen(true);
                void loadManualPathEntries(projectPath.trim() || undefined);
              }}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold text-[var(--th-text-primary)] transition hover:bg-[var(--th-bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)" }}
            >
              {t({ en: "In-App Folder Browser", de: "Ordner-Browser" })}
            </button>
            <button
              type="button"
              disabled={pathApiUnsupported}
              onClick={() => {
                setFormFeedback(null);
                setPathSuggestionsOpen((prev) => !prev);
              }}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold text-[var(--th-text-primary)] transition hover:bg-[var(--th-bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)" }}
            >
              {pathSuggestionsOpen
                ? t({ en: "Close Auto Finder", de: "Automatische Suche schließen" })
                : t({ en: "Auto Path Finder", de: "Automatische Pfadsuche" })}
            </button>
            <button
              type="button"
              disabled={nativePathPicking}
              onClick={async () => {
                setNativePickerUnsupported(false);
                setNativePathPicking(true);
                try {
                  const picked = await pickProjectPathNative();
                  if (picked.cancelled || !picked.path) return;
                  setProjectPath(picked.path);
                  setMissingPathPrompt(null);
                  setPathSuggestionsOpen(false);
                  setFormFeedback(null);
                } catch (err) {
                  console.error("Failed to open native path picker:", err);
                  if (isApiRequestError(err) && err.status === 404) {
                    setPathApiUnsupported(true);
                    setFormFeedback({ tone: "info", message: unsupportedPathApiMessage });
                  } else {
                    const message = resolvePathHelperErrorMessage(err, {
                      en: "Failed to open OS folder picker.",
                      de: "Die Ordnerauswahl des Betriebssystems konnte nicht geöffnet werden.",
                    });
                    if (
                      isApiRequestError(err) &&
                      (err.code === "native_picker_unavailable" || err.code === "native_picker_failed")
                    ) {
                      setNativePickerUnsupported(true);
                      setManualPathPickerOpen(true);
                      await loadManualPathEntries(projectPath.trim() || undefined);
                      setFormFeedback({ tone: "info", message });
                    } else {
                      setFormFeedback({ tone: "error", message });
                    }
                  }
                } finally {
                  setNativePathPicking(false);
                }
              }}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold text-[var(--th-text-primary)] transition hover:bg-[var(--th-bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)" }}
            >
              {nativePathPicking
                ? t({ en: "Opening Manual Picker...", de: "Manuellen Pfad-Browser öffnen..." })
                : nativePickerUnsupported
                  ? t({ en: "Manual Path Finder (Unavailable)", de: "Manueller Pfad-Browser (nicht verfügbar)" })
                  : t({ en: "Manual Path Finder", de: "Manueller Pfad-Browser" })}
            </button>
          </div>
          {pathSuggestionsOpen && (
            <div
              className="max-h-40 overflow-y-auto rounded-lg border"
              style={{ borderColor: "var(--th-border)", background: "var(--th-bg-surface-hover)" }}
            >
              {pathSuggestionsLoading ? (
                <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ en: "Loading path suggestions...", de: "Pfadvorschläge werden geladen..." })}
                </p>
              ) : pathSuggestions.length === 0 ? (
                <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  {t({
                    en: "No suggested path. Enter one manually.",
                    de: "Kein Pfadvorschlag. Bitte manuell eingeben.",
                  })}
                </p>
              ) : (
                pathSuggestions.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    onClick={() => {
                      setProjectPath(candidate);
                      setMissingPathPrompt(null);
                      setPathSuggestionsOpen(false);
                      setFormFeedback(null);
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-[var(--th-text-primary)] transition hover:opacity-80"
                  >
                    {candidate}
                  </button>
                ))
              )}
            </div>
          )}
          {missingPathPrompt && (
            <p className="text-xs text-amber-300">
              {t({
                en: "This path does not exist yet. Save will ask whether to create it.",
                de: "Dieser Pfad existiert noch nicht. Beim Speichern wird gefragt, ob er erstellt werden soll.",
              })}
            </p>
          )}
        </div>
      )}
      {formFeedback && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            formFeedback.tone === "error"
              ? "border-rose-500/60 bg-rose-500/10 text-rose-800 dark:text-rose-200"
              : "border-cyan-500/50 bg-cyan-500/10 text-cyan-800 dark:text-cyan-100"
          }`}
        >
          {formFeedback.message}
        </div>
      )}
      <label className="block text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {t({ en: "Project Description", de: "Projektbeschreibung" })}
        <textarea
          rows={3}
          value={coreGoal}
          onChange={(e) => {
            setCoreGoal(e.target.value);
            setFormFeedback(null);
          }}
          disabled={!isCreating && !editingProjectId}
          placeholder={t({
            en: "Brief project description (detailed context managed in CLAUDE.md editor)",
            de: "Kurze Projektbeschreibung (Details im CLAUDE.md Editor)",
          })}
          className="mt-1 w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />
      </label>

      <ManualAssignmentSelector
        t={t}
        language={language}
        isCreating={isCreating}
        editingProjectId={editingProjectId}
        assignmentMode={assignmentMode}
        setAssignmentMode={setAssignmentMode}
        setManualAssignmentWarning={setManualAssignmentWarning}
        manualSelectionStats={manualSelectionStats}
        selectedAgentIds={selectedAgentIds}
        setSelectedAgentIds={setSelectedAgentIds}
        agentFilterDept={agentFilterDept}
        setAgentFilterDept={setAgentFilterDept}
        departments={departments}
        agents={agents}
        spriteMap={spriteMap}
        detail={detail}
        selectedProject={selectedProject}
      />

      <div className="flex flex-wrap gap-2 pt-1">
        {(isCreating || !!editingProjectId) && (
          <button
            type="button"
            onClick={() => {
              onSave();
            }}
            disabled={!canSave || saving}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {editingProjectId ? t({ en: "Save", de: "Speichern" }) : t({ en: "Create", de: "Erstellen" })}
          </button>
        )}
        {(isCreating || !!editingProjectId) && (
          <button
            type="button"
            onClick={onCancelEdit}
            className="rounded-lg border px-3 py-1.5 text-xs"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
          >
            {t({ en: "Cancel", de: "Abbrechen" })}
          </button>
        )}
        <button
          type="button"
          onClick={onStartEditSelected}
          disabled={!selectedProject || isCreating || !!editingProjectId}
          className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {t({ en: "Edit Selected", de: "Auswahl bearbeiten" })}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!selectedProject}
          className="rounded-lg border border-red-700/70 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40"
        >
          {t({ en: "Delete", de: "Löschen" })}
        </button>
      </div>
    </div>
  );
}
