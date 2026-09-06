import type { KeyboardEvent, RefObject } from "react";
import type { Agent, Department, Project } from "../../../types";
import AgentSelect from "../../AgentSelect";
import { priorityIcon, priorityLabel, type MissingPathPrompt, type TFunction } from "../constants";

interface PrioritySectionProps {
  priority: number;
  t: TFunction;
  onPriorityChange: (priority: number) => void;
}

export function PrioritySection({ priority, t, onPriorityChange }: PrioritySectionProps) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
        {t({ en: "Priority", de: "Priorität" })}: {priorityIcon(priority)} {priorityLabel(priority, t)} ({priority}/5)
      </label>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => onPriorityChange(star)}
            className={`flex-1 rounded-lg py-2 text-lg transition ${
              star <= priority ? "bg-amber-600 text-white shadow-md" : ""
            }`}
            style={star <= priority ? undefined : { background: "var(--th-card-bg)", color: "var(--th-text-muted)" }}
          >
            ★
          </button>
        ))}
      </div>
    </div>
  );
}

interface AssigneeSectionProps {
  agents: Agent[];
  departments: Department[];
  departmentId: string;
  assignAgentId: string;
  t: TFunction;
  onAssignAgentChange: (agentId: string) => void;
}

export function AssigneeSection({
  agents,
  departments,
  departmentId,
  assignAgentId,
  t,
  onAssignAgentChange,
}: AssigneeSectionProps) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
        {t({ en: "Assignee", de: "Zugewiesener Agent" })}
      </label>
      <AgentSelect
        agents={agents}
        departments={departments}
        value={assignAgentId}
        onChange={(value) => onAssignAgentChange(value)}
        placeholder={t({ en: "-- Unassigned --", de: "-- Nicht zugewiesen --" })}
        size="md"
      />
      {departmentId && agents.length === 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({
            en: "No agents are available in this department.",
            de: "In dieser Abteilung sind keine Agents verfügbar.",
          })}
        </p>
      )}
    </div>
  );
}

interface ProjectSectionProps {
  t: TFunction;
  projectPickerRef: RefObject<HTMLDivElement | null>;
  projectQuery: string;
  projectDropdownOpen: boolean;
  projectActiveIndex: number;
  projectsLoading: boolean;
  filteredProjects: Project[];
  selectedProject: Project | null;
  projects: Project[];
  createNewProjectMode: boolean;
  newProjectPath: string;
  pathApiUnsupported: boolean;
  pathSuggestionsOpen: boolean;
  pathSuggestionsLoading: boolean;
  pathSuggestions: string[];
  missingPathPrompt: MissingPathPrompt | null;
  nativePathPicking: boolean;
  nativePickerUnsupported: boolean;
  onProjectQueryChange: (value: string) => void;
  onProjectInputFocus: () => void;
  onProjectInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onToggleProjectDropdown: () => void;
  onSelectProject: (project: Project | null) => void;
  onProjectHover: (projectId: string) => void;
  onEnableCreateNewProject: () => void;
  onNewProjectPathChange: (value: string) => void;
  onOpenManualPathBrowser: () => void;
  onTogglePathSuggestions: () => void;
  onPickNativePath: () => void;
  onSelectPathSuggestion: (path: string) => void;
}

export function ProjectSection({
  t,
  projectPickerRef,
  projectQuery,
  projectDropdownOpen,
  projectActiveIndex,
  projectsLoading,
  filteredProjects,
  selectedProject,
  projects,
  createNewProjectMode,
  newProjectPath,
  pathApiUnsupported,
  pathSuggestionsOpen,
  pathSuggestionsLoading,
  pathSuggestions,
  missingPathPrompt,
  nativePathPicking,
  nativePickerUnsupported,
  onProjectQueryChange,
  onProjectInputFocus,
  onProjectInputKeyDown,
  onToggleProjectDropdown,
  onSelectProject,
  onProjectHover,
  onEnableCreateNewProject,
  onNewProjectPathChange,
  onOpenManualPathBrowser,
  onTogglePathSuggestions,
  onPickNativePath,
  onSelectPathSuggestion,
}: ProjectSectionProps) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
        {t({ en: "Project Name", de: "Projektname" })}
      </label>
      <div className="relative" ref={projectPickerRef}>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={projectQuery}
            onChange={(event) => onProjectQueryChange(event.target.value)}
            onFocus={onProjectInputFocus}
            onKeyDown={onProjectInputKeyDown}
            placeholder={t({ en: "Type project name or path", de: "Projektname oder Pfad eingeben" })}
            className="w-full rounded-lg border px-3 py-2 text-sm placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
          <button
            type="button"
            onClick={onToggleProjectDropdown}
            className="rounded-lg border px-2.5 py-2 text-xs transition hover:text-white"
            style={{
              borderColor: "var(--th-border)",
              background: "var(--th-card-bg)",
              color: "var(--th-text-secondary)",
            }}
            title={t({ en: "Toggle project list", de: "Projektliste umschalten" })}
          >
            {projectDropdownOpen ? "▲" : "▼"}
          </button>
        </div>

        {projectDropdownOpen && (
          <div
            className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border shadow-xl"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
          >
            <button
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onSelectProject(null);
              }}
              className="w-full border-b px-3 py-2 text-left text-sm transition"
              style={{ borderColor: "var(--th-card-bg)", color: "var(--th-text-secondary)" }}
            >
              {t({ en: "-- No project --", de: "-- Kein Projekt --" })}
            </button>
            {projectsLoading ? (
              <div className="px-3 py-2 text-sm" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Loading projects...", de: "Projekte werden geladen..." })}
              </div>
            ) : filteredProjects.length === 0 ? (
              <div
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                style={{ color: "var(--th-text-secondary)" }}
              >
                <p className="pr-2">{t({ en: "Create as a new project?", de: "Als neues Projekt erstellen?" })}</p>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onEnableCreateNewProject();
                  }}
                  className="ml-auto shrink-0 rounded-md border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
                >
                  {t({ en: "Yes", de: "Ja" })}
                </button>
              </div>
            ) : (
              filteredProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelectProject(project);
                  }}
                  onMouseEnter={() => onProjectHover(project.id)}
                  className={`w-full px-3 py-2 text-left transition ${
                    projectActiveIndex >= 0 && filteredProjects[projectActiveIndex]?.id === project.id
                      ? ""
                      : selectedProject?.id === project.id
                        ? ""
                        : ""
                  }`}
                  style={
                    projectActiveIndex >= 0 && filteredProjects[projectActiveIndex]?.id === project.id
                      ? { background: "var(--th-bg-surface-hover)" }
                      : selectedProject?.id === project.id
                        ? { background: "var(--th-card-bg)" }
                        : undefined
                  }
                >
                  <div className="truncate text-sm text-slate-100">{project.name}</div>
                  <div className="truncate text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                    {project.project_path}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {selectedProject && (
        <p className="mt-1 break-all text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {selectedProject.project_path}
        </p>
      )}

      {createNewProjectMode && !selectedProject && (
        <div className="mt-2 space-y-2">
          <label className="block text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "New project path", de: "Neuer Projektpfad" })}
          </label>
          <input
            type="text"
            value={newProjectPath}
            onChange={(event) => onNewProjectPathChange(event.target.value)}
            placeholder="/absolute/path/to/project"
            className="w-full rounded-lg border px-3 py-2 text-sm placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={pathApiUnsupported}
              onClick={onOpenManualPathBrowser}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
            >
              {t({ en: "In-App Folder Browser", de: "Ordner-Browser" })}
            </button>
            <button
              type="button"
              disabled={pathApiUnsupported}
              onClick={onTogglePathSuggestions}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
            >
              {pathSuggestionsOpen
                ? t({ en: "Close Auto Finder", de: "Auto-Finder schließen" })
                : t({ en: "Auto Path Finder", de: "Auto-Pfadsuche" })}
            </button>
            <button
              type="button"
              disabled={nativePathPicking}
              onClick={onPickNativePath}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
            >
              {nativePathPicking
                ? t({ en: "Opening Manual Picker...", de: "Manuelle Auswahl wird geöffnet..." })
                : nativePickerUnsupported
                  ? t({ en: "Manual Path Finder (Unavailable)", de: "Manuelle Pfadsuche (Nicht verfügbar)" })
                  : t({ en: "Manual Path Finder", de: "Manuelle Pfadsuche" })}
            </button>
          </div>
          {pathSuggestionsOpen && (
            <div
              className="max-h-40 overflow-y-auto rounded-lg border"
              style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
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
                    onClick={() => onSelectPathSuggestion(candidate)}
                    className="w-full px-3 py-2 text-left text-xs transition"
                    style={{ color: "var(--th-text-primary)" }}
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
                en: "This path does not exist yet. Creation confirmation will be requested.",
                de: "Dieser Pfad existiert noch nicht. Die Erstellung wird bestätigt.",
              })}
            </p>
          )}
          <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              en: "Description will be saved as the new project core goal.",
              de: "Die Beschreibung wird als Kernziel des neuen Projekts gespeichert.",
            })}
          </p>
        </div>
      )}

      {!projectsLoading && projects.length === 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({
            en: "No registered project. Create one first in Project Manager.",
            de: "Kein registriertes Projekt. Erstellen Sie zunächst eines in der Projektverwaltung.",
          })}
        </p>
      )}
    </div>
  );
}
