import type { ComponentProps, FormEventHandler } from "react";
import type { Agent, Department, TaskType, WorkflowPackKey } from "../../../types";
import { TASK_TYPE_OPTIONS, taskTypeLabel, type FormFeedback, type TFunction } from "../constants";
import CreateTaskModalOverlays from "./Overlays";
import type { CreateTaskModalOverlaysProps } from "./overlay-types";
import { AssigneeSection, PrioritySection, ProjectSection } from "./Sections";
import PipelineSection from "./PipelineSection";
import PackInputsSection from "./PackInputsSection";
import PhaseSelectionSection from "./PhaseSelectionSection";

/** Workflow packs that don't need a project — they use a fixed output directory. */
const PROJECT_FREE_PACKS: ReadonlySet<string> = new Set(["video_preprod"]);

interface CreateTaskModalViewProps {
  t: TFunction;
  locale: string;
  createNewProjectMode: boolean;
  draftsCount: number;
  title: string;
  description: string;
  departmentId: string;
  taskType: TaskType;
  workflowPackKey: WorkflowPackKey | "";
  priority: number;
  assignAgentId: string;
  submitBusy: boolean;
  formFeedback: FormFeedback | null;
  departments: Department[];
  filteredAgents: Agent[];
  projectSectionProps: ComponentProps<typeof ProjectSection>;
  overlaysProps: CreateTaskModalOverlaysProps;
  onOpenDraftModal: () => void;
  onRequestClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onDepartmentChange: (value: string) => void;
  onTaskTypeChange: (value: TaskType) => void;
  onPriorityChange: (value: number) => void;
  onAssignAgentChange: (value: string) => void;
  pipelineSteps: string[];
  enableAutoRetry: boolean;
  maxRetries: number;
  onPipelineStepsChange: (steps: string[]) => void;
  onEnableAutoRetryChange: (enabled: boolean) => void;
  onMaxRetriesChange: (max: number) => void;
  packInputValues: Record<string, string>;
  onPackInputChange: (key: string, value: string) => void;
  onRequiredPackKeysChange?: (keys: string[]) => void;
  skippedPhases: string[];
  onSkippedPhasesChange: (skipped: string[]) => void;
  agentRouting: "single" | "department";
  onAgentRoutingChange: (routing: "single" | "department") => void;
}

export default function CreateTaskModalView({
  t,
  locale,
  createNewProjectMode,
  draftsCount,
  title,
  description,
  departmentId,
  taskType,
  workflowPackKey,
  priority,
  assignAgentId,
  submitBusy,
  formFeedback,
  departments,
  filteredAgents,
  projectSectionProps,
  overlaysProps,
  onOpenDraftModal,
  onRequestClose,
  onSubmit,
  onTitleChange,
  onDescriptionChange,
  onDepartmentChange,
  onTaskTypeChange,
  onPriorityChange,
  onAssignAgentChange,
  pipelineSteps,
  enableAutoRetry,
  maxRetries,
  onPipelineStepsChange,
  onEnableAutoRetryChange,
  onMaxRetriesChange,
  packInputValues,
  onPackInputChange,
  onRequiredPackKeysChange,
  skippedPhases,
  onSkippedPhasesChange,
  agentRouting,
  onAgentRoutingChange,
}: CreateTaskModalViewProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
        }
      }}
    >
      <div
        className={`my-3 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden border shadow-2xl transition-[max-width] duration-300 ease-out sm:my-0 sm:max-h-[90dvh] lg:max-w-2xl ${
          createNewProjectMode ? "lg:max-w-5xl" : ""
        }`}
        style={{
          background: "var(--th-bg-secondary)",
          borderColor: "var(--th-border)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-5"
          style={{ borderColor: "var(--th-border)" }}
        >
          <h2 className="text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
            {t({ en: "Create New Task", de: "Neue Aufgabe erstellen" })}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenDraftModal}
              className="rounded-lg border px-2.5 py-1.5 text-xs transition"
              style={{ borderColor: "var(--th-border)", color: "var(--th-text-primary)" }}
              title={t({ en: "Open temporary drafts", de: "Temporäre Entwürfe öffnen" })}
            >
              {`[${t({ en: "Temp", de: "Temporär" })}(${draftsCount})]`}
            </button>
            <button
              onClick={onRequestClose}
              className="rounded-lg p-1.5 transition hover:text-white"
              style={{ color: "var(--th-text-secondary)" }}
              title={t({ en: "Close", de: "Schließen" })}
            >
              ✕
            </button>
          </div>
        </div>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div
            className={`min-h-0 flex-1 overflow-y-auto px-6 py-4 ${createNewProjectMode ? "lg:grid lg:grid-cols-2 lg:gap-5" : ""}`}
          >
            <div className="min-w-0 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ en: "Title", de: "Titel" })} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(event) => onTitleChange(event.target.value)}
                  placeholder={t({ en: "Enter a task title", de: "Aufgabentitel eingeben" })}
                  required
                  className="w-full rounded-lg border px-3 py-2 text-sm placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  style={{
                    background: "var(--th-input-bg)",
                    borderColor: "var(--th-input-border)",
                    color: "var(--th-text-primary)",
                  }}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ en: "Description", de: "Beschreibung" })}
                </label>
                <textarea
                  value={description}
                  onChange={(event) => onDescriptionChange(event.target.value)}
                  placeholder={t({ en: "Enter a detailed description", de: "Detaillierte Beschreibung eingeben" })}
                  rows={3}
                  className="w-full resize-none rounded-lg border px-3 py-2 text-sm placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  style={{
                    background: "var(--th-input-bg)",
                    borderColor: "var(--th-input-border)",
                    color: "var(--th-text-primary)",
                  }}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ en: "Department", de: "Abteilung" })}
                  </label>
                  <select
                    value={departmentId}
                    onChange={(event) => onDepartmentChange(event.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    style={{
                      background: "var(--th-input-bg)",
                      borderColor: "var(--th-input-border)",
                      color: "var(--th-text-primary)",
                    }}
                  >
                    <option value="">{t({ en: "-- All --", de: "-- Alle --" })}</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.icon} {department.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ en: "Task Type", de: "Aufgabentyp" })}
                  </label>
                  <select
                    value={taskType}
                    onChange={(event) => onTaskTypeChange(event.target.value as TaskType)}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    style={{
                      background: "var(--th-input-bg)",
                      borderColor: "var(--th-input-border)",
                      color: "var(--th-text-primary)",
                    }}
                  >
                    {TASK_TYPE_OPTIONS.map((typeOption) => (
                      <option key={typeOption.value} value={typeOption.value}>
                        {taskTypeLabel(typeOption.value, t)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!PROJECT_FREE_PACKS.has(workflowPackKey) && <ProjectSection {...projectSectionProps} />}

              <div className={createNewProjectMode ? "lg:hidden" : ""}>
                <PrioritySection priority={priority} t={t} onPriorityChange={onPriorityChange} />
              </div>
              <div className={createNewProjectMode ? "lg:hidden" : ""}>
                <AssigneeSection
                  agents={filteredAgents}
                  departments={departments}
                  departmentId={departmentId}
                  assignAgentId={assignAgentId}
                  t={t}
                  onAssignAgentChange={onAssignAgentChange}
                />
              </div>

              {!workflowPackKey && (
                <PipelineSection
                  t={t}
                  departments={departments}
                  pipelineSteps={pipelineSteps}
                  enableAutoRetry={enableAutoRetry}
                  maxRetries={maxRetries}
                  onPipelineStepsChange={onPipelineStepsChange}
                  onEnableAutoRetryChange={onEnableAutoRetryChange}
                  onMaxRetriesChange={onMaxRetriesChange}
                />
              )}

              {workflowPackKey && (
                <PackInputsSection
                  packKey={workflowPackKey}
                  locale={locale}
                  values={packInputValues}
                  onChange={onPackInputChange}
                  onRequiredKeysChange={onRequiredPackKeysChange}
                />
              )}

              {workflowPackKey && (
                <PhaseSelectionSection
                  packKey={workflowPackKey}
                  locale={locale}
                  skippedPhases={skippedPhases}
                  onSkippedPhasesChange={onSkippedPhasesChange}
                />
              )}

              {workflowPackKey && (
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ en: "Agent Routing", de: "Agent-Routing" })}
                  </label>
                  <button
                    type="button"
                    onClick={() => onAgentRoutingChange(agentRouting === "department" ? "single" : "department")}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      agentRouting === "department" ? "bg-green-600" : "bg-gray-500"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        agentRouting === "department" ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                  <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {agentRouting === "department"
                      ? t({ en: "Team Routing", de: "Team-Routing" })
                      : t({ en: "Single Agent", de: "Einzelner Agent" })}
                  </span>
                </div>
              )}
            </div>

            {createNewProjectMode && (
              <aside className="hidden min-w-0 lg:block lg:transition-all lg:duration-300 lg:ease-out">
                <div
                  className="space-y-4 rounded-xl border p-4 shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
                  style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
                >
                  <PrioritySection priority={priority} t={t} onPriorityChange={onPriorityChange} />
                  <AssigneeSection
                    agents={filteredAgents}
                    departments={departments}
                    departmentId={departmentId}
                    assignAgentId={assignAgentId}
                    t={t}
                    onAssignAgentChange={onAssignAgentChange}
                  />
                </div>
              </aside>
            )}
          </div>

          {formFeedback && (
            <div className="px-6 pb-3">
              <div
                className={`rounded-lg border px-3 py-2 text-xs ${
                  formFeedback.tone === "error"
                    ? "border-rose-500/60 bg-rose-500/10 text-rose-200"
                    : "border-cyan-500/50 bg-cyan-500/10 text-cyan-100"
                }`}
              >
                {formFeedback.message}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 border-t px-6 py-4" style={{ borderColor: "var(--th-border)" }}>
            <button
              type="button"
              onClick={onRequestClose}
              className="rounded-lg border px-4 py-2 text-sm transition"
              style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            >
              {t({ en: "Cancel", de: "Abbrechen" })}
            </button>
            <button
              type="submit"
              disabled={!title.trim() || submitBusy}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitBusy
                ? t({ en: "Creating...", de: "Wird erstellt..." })
                : t({ en: "Create Task", de: "Aufgabe erstellen" })}
            </button>
          </div>
        </form>
      </div>

      <CreateTaskModalOverlays {...overlaysProps} />
    </div>
  );
}
