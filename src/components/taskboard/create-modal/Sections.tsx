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
        {t({ ko: "우선순위", en: "Priority", ja: "優先度", zh: "Priority", de: "Priorität" })}: {priorityIcon(priority)}{" "}
        {priorityLabel(priority, t)} ({priority}/5)
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
        {t({ ko: "담당 에이전트", en: "Assignee", ja: "担当エージェント", zh: "Assignee", de: "Zugewiesener Agent" })}
      </label>
      <AgentSelect
        agents={agents}
        departments={departments}
        value={assignAgentId}
        onChange={(value) => onAssignAgentChange(value)}
        placeholder={t({
          ko: "-- 미배정 --",
          en: "-- Unassigned --",
          ja: "-- 未割り当て --",
          zh: "-- Unassigned --",
          de: "-- Nicht zugewiesen --",
        })}
        size="md"
      />
      {departmentId && agents.length === 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({
            ko: "해당 부서에 에이전트가 없습니다.",
            en: "No agents are available in this department.",
            ja: "この部署にはエージェントがいません。",
            zh: "No agents are available in this department.",
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
        {t({ ko: "프로젝트명", en: "Project Name", ja: "プロジェクト名", zh: "Project Name", de: "Projektname" })}
      </label>
      <div className="relative" ref={projectPickerRef}>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={projectQuery}
            onChange={(event) => onProjectQueryChange(event.target.value)}
            onFocus={onProjectInputFocus}
            onKeyDown={onProjectInputKeyDown}
            placeholder={t({
              ko: "프로젝트 이름 또는 경로 입력",
              en: "Type project name or path",
              ja: "プロジェクト名またはパスを入力",
              zh: "Type project name or path",
              de: "Projektname oder Pfad eingeben",
            })}
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
            title={t({
              ko: "프로젝트 목록 토글",
              en: "Toggle project list",
              ja: "プロジェクト一覧の切替",
              zh: "Toggle project list",
              de: "Projektliste umschalten",
            })}
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
              {t({
                ko: "-- 프로젝트 미지정 --",
                en: "-- No project --",
                ja: "-- プロジェクトなし --",
                zh: "-- No project --",
                de: "-- Kein Projekt --",
              })}
            </button>
            {projectsLoading ? (
              <div className="px-3 py-2 text-sm" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  ko: "프로젝트 불러오는 중...",
                  en: "Loading projects...",
                  ja: "プロジェクトを読み込み中...",
                  zh: "Loading projects...",
                  de: "Projekte werden geladen...",
                })}
              </div>
            ) : filteredProjects.length === 0 ? (
              <div
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                style={{ color: "var(--th-text-secondary)" }}
              >
                <p className="pr-2">
                  {t({
                    ko: "신규 프로젝트로 생성할까요?",
                    en: "Create as a new project?",
                    ja: "新規プロジェクトとして作成しますか？",
                    zh: "Create as a new project?",
                    de: "Als neues Projekt erstellen?",
                  })}
                </p>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onEnableCreateNewProject();
                  }}
                  className="ml-auto shrink-0 rounded-md border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
                >
                  {t({ ko: "예", en: "Yes", ja: "はい", zh: "Yes", de: "Ja" })}
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
            {t({
              ko: "신규 프로젝트 경로",
              en: "New project path",
              ja: "新規プロジェクトパス",
              zh: "New project path",
              de: "Neuer Projektpfad",
            })}
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
              {t({
                ko: "앱 내 폴더 탐색",
                en: "In-App Folder Browser",
                ja: "アプリ内フォルダ閲覧",
                zh: "In-App Folder Browser",
                de: "Ordner-Browser",
              })}
            </button>
            <button
              type="button"
              disabled={pathApiUnsupported}
              onClick={onTogglePathSuggestions}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
            >
              {pathSuggestionsOpen
                ? t({
                    ko: "자동 경로찾기 닫기",
                    en: "Close Auto Finder",
                    ja: "自動候補を閉じる",
                    zh: "Close Auto Finder",
                    de: "Auto-Finder schließen",
                  })
                : t({
                    ko: "자동 경로찾기",
                    en: "Auto Path Finder",
                    ja: "自動パス検索",
                    zh: "Auto Path Finder",
                    de: "Auto-Pfadsuche",
                  })}
            </button>
            <button
              type="button"
              disabled={nativePathPicking}
              onClick={onPickNativePath}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
            >
              {nativePathPicking
                ? t({
                    ko: "수동 경로찾기 여는 중...",
                    en: "Opening Manual Picker...",
                    ja: "手動パス選択を開いています...",
                    zh: "Opening Manual Picker...",
                    de: "Manuelle Auswahl wird geöffnet...",
                  })
                : nativePickerUnsupported
                  ? t({
                      ko: "수동 경로찾기(사용불가)",
                      en: "Manual Path Finder (Unavailable)",
                      ja: "手動パス選択（利用不可）",
                      zh: "Manual Path Finder (Unavailable)",
                      de: "Manuelle Pfadsuche (Nicht verfügbar)",
                    })
                  : t({
                      ko: "수동 경로찾기",
                      en: "Manual Path Finder",
                      ja: "手動パス選択",
                      zh: "Manual Path Finder",
                      de: "Manuelle Pfadsuche",
                    })}
            </button>
          </div>
          {pathSuggestionsOpen && (
            <div
              className="max-h-40 overflow-y-auto rounded-lg border"
              style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
            >
              {pathSuggestionsLoading ? (
                <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  {t({
                    ko: "경로 후보를 불러오는 중...",
                    en: "Loading path suggestions...",
                    ja: "パス候補を読み込み中...",
                    zh: "Loading path suggestions...",
                    de: "Pfadvorschläge werden geladen...",
                  })}
                </p>
              ) : pathSuggestions.length === 0 ? (
                <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  {t({
                    ko: "추천 경로가 없습니다. 직접 입력해주세요.",
                    en: "No suggested path. Enter one manually.",
                    ja: "候補パスがありません。手入力してください。",
                    zh: "No suggested path. Enter one manually.",
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
                ko: "해당 경로가 아직 존재하지 않습니다. 생성 확인 후 진행됩니다.",
                en: "This path does not exist yet. Creation confirmation will be requested.",
                ja: "このパスはまだ存在しません。作成確認後に続行されます。",
                zh: "This path does not exist yet. Creation confirmation will be requested.",
                de: "Dieser Pfad existiert noch nicht. Die Erstellung wird bestätigt.",
              })}
            </p>
          )}
          <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "설명 항목 내용이 신규 프로젝트의 핵심 목표(core_goal)로 저장됩니다.",
              en: "Description will be saved as the new project core goal.",
              ja: "説明欄の内容が新規プロジェクトのコア目標として保存されます。",
              zh: "Description will be saved as the new project core goal.",
              de: "Die Beschreibung wird als Kernziel des neuen Projekts gespeichert.",
            })}
          </p>
        </div>
      )}

      {!projectsLoading && projects.length === 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({
            ko: "등록된 프로젝트가 없습니다. 프로젝트 관리에서 먼저 생성해주세요.",
            en: "No registered project. Create one first in Project Manager.",
            ja: "登録済みプロジェクトがありません。先にプロジェクト管理で作成してください。",
            zh: "No registered project. Create one first in Project Manager.",
            de: "Kein registriertes Projekt. Erstellen Sie zunächst eines in der Projektverwaltung.",
          })}
        </p>
      )}
    </div>
  );
}
