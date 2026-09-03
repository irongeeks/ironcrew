import { useEffect, useState } from "react";
import type {
  GitHubPull,
  ProjectDecisionEventItem,
  ProjectGitStatus,
  ProjectReportHistoryItem,
  ProjectTaskHistoryItem,
} from "../../api";
import { getGitHubPulls, getProjectBranches, getProjectGitStatus } from "../../api";
import type { Project } from "../../types";
import type { GroupedProjectTaskCard, ProjectI18nTranslate } from "./types";
import { fmtTime } from "./utils";
import ProjectContextEditor from "./ProjectContextEditor";
import ProjectFileBrowser from "./ProjectFileBrowser";

interface ProjectInsightsPanelProps {
  t: ProjectI18nTranslate;
  selectedProject: Project | null;
  loadingDetail: boolean;
  isCreating: boolean;
  groupedTaskCards: GroupedProjectTaskCard[];
  sortedReports: ProjectReportHistoryItem[];
  sortedDecisionEvents: ProjectDecisionEventItem[];
  getDecisionEventLabel: (eventType: ProjectDecisionEventItem["event_type"]) => string;
  handleOpenTaskDetail: (taskId: string) => Promise<void>;
}

export default function ProjectInsightsPanel({
  t,
  selectedProject,
  loadingDetail,
  isCreating,
  groupedTaskCards,
  sortedReports,
  sortedDecisionEvents,
  getDecisionEventLabel,
  handleOpenTaskDetail,
}: ProjectInsightsPanelProps) {
  const [pulls, setPulls] = useState<GitHubPull[]>([]);
  const [loadingPulls, setLoadingPulls] = useState(false);
  const [gitStatus, setGitStatus] = useState<ProjectGitStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [showAllBranches, setShowAllBranches] = useState(false);

  const projectId = selectedProject?.id ?? null;
  const githubRepo = selectedProject?.github_repo ?? null;

  useEffect(() => {
    if (!projectId) {
      setPulls([]);
      setGitStatus(null);
      setBranches([]);
      setCurrentBranch(null);
      return;
    }

    getProjectGitStatus(projectId)
      .then((s) => setGitStatus(s))
      .catch(() => setGitStatus(null));

    getProjectBranches(projectId)
      .then((b) => {
        setBranches(b.branches);
        setCurrentBranch(b.current_branch);
      })
      .catch(() => {
        setBranches([]);
        setCurrentBranch(null);
      });

    if (githubRepo) {
      const [owner, repo] = githubRepo.split("/");
      if (owner && repo) {
        setLoadingPulls(true);
        getGitHubPulls(owner, repo)
          .then((r) => setPulls(r.pulls))
          .catch(() => setPulls([]))
          .finally(() => setLoadingPulls(false));
      }
    } else {
      setPulls([]);
    }
  }, [projectId, githubRepo]);

  return (
    <div className="min-w-0 space-y-4">
      <div
        className="min-w-0 rounded-xl border p-4"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {t({
              ko: "프로젝트 정보",
              en: "Project Info",
              ja: "プロジェクト情報",
              zh: "Project Info",
              de: "Projektinfo",
            })}
          </h4>
          {selectedProject?.github_repo && (
            <a
              href={`https://github.com/${selectedProject.github_repo}`}
              target="_blank"
              rel="noopener noreferrer"
              title={selectedProject.github_repo}
              className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition hover:border-blue-500 hover:text-[var(--th-text-primary)]"
              style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-secondary)" }}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              {selectedProject.github_repo}
            </a>
          )}
        </div>
        {loadingDetail ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "불러오는 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
          </p>
        ) : isCreating ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "신규 프로젝트를 입력 중입니다",
              en: "Creating a new project",
              ja: "新規プロジェクトを入力中です",
              zh: "Creating a new project",
              de: "Neues Projekt wird erstellt",
            })}
          </p>
        ) : !selectedProject ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "프로젝트를 선택하세요",
              en: "Select a project",
              ja: "プロジェクトを選択",
              zh: "Select a project",
              de: "Projekt auswählen",
            })}
          </p>
        ) : (
          <div className="mt-2 space-y-2 text-xs">
            <p className="text-[var(--th-text-primary)]">
              <span style={{ color: "var(--th-text-muted)" }}>ID:</span> {selectedProject.id}
            </p>
            <p className="break-all text-[var(--th-text-primary)]">
              <span style={{ color: "var(--th-text-muted)" }}>Path:</span> {selectedProject.project_path}
            </p>
            <p className="break-all text-[var(--th-text-primary)]">
              <span style={{ color: "var(--th-text-muted)" }}>Goal:</span> {selectedProject.core_goal}
            </p>
          </div>
        )}
      </div>

      {/* Project Context Editor */}
      {selectedProject && !isCreating && (
        <ProjectContextEditor
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          projectPath={selectedProject.project_path}
        />
      )}

      {/* Project File Browser */}
      {selectedProject && !isCreating && (
        <ProjectFileBrowser projectId={selectedProject.id} projectPath={selectedProject.project_path} />
      )}

      {selectedProject && (gitStatus || branches.length > 0) && (
        <div
          className="min-w-0 rounded-xl border p-4"
          style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
        >
          <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {t({ ko: "Git 상태", en: "Git Status", ja: "Git 状態", zh: "Git Status", de: "Git-Status" })}
          </h4>
          <div className="mt-2 space-y-2 text-xs">
            {gitStatus?.current_branch && (
              <p className="text-[var(--th-text-primary)]">
                <span style={{ color: "var(--th-text-muted)" }}>
                  {t({ ko: "현재 브랜치", en: "Branch", ja: "ブランチ", zh: "Branch", de: "Branch" })}:
                </span>{" "}
                <span className="font-mono">{gitStatus.current_branch}</span>
                {gitStatus.dirty && (
                  <span className="ml-2 rounded bg-amber-600/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                    {gitStatus.changed_files}{" "}
                    {t({ ko: "변경", en: "changed", ja: "変更", zh: "changed", de: "geändert" })}
                    {gitStatus.untracked_files > 0 &&
                      `, ${gitStatus.untracked_files} ${t({ ko: "미추적", en: "untracked", ja: "未追跡", zh: "untracked", de: "nicht verfolgt" })}`}
                  </span>
                )}
              </p>
            )}
            {branches.length > 0 && (
              <div>
                <p style={{ color: "var(--th-text-muted)" }}>
                  {t({ ko: "브랜치", en: "Branches", ja: "ブランチ一覧", zh: "Branches", de: "Branches" })} (
                  {branches.length})
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(showAllBranches ? branches : branches.slice(0, 6)).map((b) => (
                    <span
                      key={b}
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        b === currentBranch ? "bg-blue-600/20 text-blue-300" : ""
                      }`}
                      style={
                        b !== currentBranch
                          ? { background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }
                          : undefined
                      }
                    >
                      {b.replace(/^remotes\/origin\//, "")}
                    </span>
                  ))}
                  {!showAllBranches && branches.length > 6 && (
                    <button
                      type="button"
                      onClick={() => setShowAllBranches(true)}
                      className="rounded px-1.5 py-0.5 text-[10px] text-blue-400 hover:text-blue-300"
                    >
                      +{branches.length - 6} {t({ ko: "더보기", en: "more", ja: "もっと", zh: "more", de: "mehr" })}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {selectedProject?.github_repo && (
        <div
          className="min-w-0 rounded-xl border p-4"
          style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
        >
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
              {t({ ko: "오픈 PR", en: "Open PRs", ja: "オープン PR", zh: "Open PRs", de: "Offene PRs" })}
              {!loadingPulls && pulls.length > 0 && (
                <span className="ml-1.5 rounded-full bg-blue-600/20 px-1.5 py-0.5 text-[10px] text-blue-300">
                  {pulls.length}
                </span>
              )}
            </h4>
            <a
              href={`https://github.com/${selectedProject.github_repo}/pulls`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] hover:text-[var(--th-text-primary)]"
              style={{ color: "var(--th-text-secondary)" }}
            >
              {t({
                ko: "GitHub에서 보기",
                en: "View on GitHub",
                ja: "GitHubで表示",
                zh: "View on GitHub",
                de: "Auf GitHub ansehen",
              })}
            </a>
          </div>
          {loadingPulls ? (
            <p className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({ ko: "불러오는 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
            </p>
          ) : pulls.length === 0 ? (
            <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "오픈 PR이 없습니다",
                en: "No open pull requests",
                ja: "オープン PR はありません",
                zh: "No open pull requests",
                de: "Keine offenen Pull Requests",
              })}
            </p>
          ) : (
            <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1">
              {pulls.map((pr) => (
                <a
                  key={pr.number}
                  href={pr.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-lg border px-3 py-2 transition hover:border-blue-500/70"
                  style={{ background: "var(--th-bg-secondary)", borderColor: "var(--th-border)" }}
                >
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                      #{pr.number}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" style={{ color: "var(--th-text-primary)" }}>
                        {pr.draft && (
                          <span
                            className="mr-1 rounded px-1 py-0.5 text-[10px]"
                            style={{ background: "var(--bg-glow)", color: "var(--th-text-secondary)" }}
                          >
                            Draft
                          </span>
                        )}
                        {pr.title}
                      </p>
                      <p className="mt-0.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                        {pr.user} · {fmtTime(new Date(pr.updated_at).getTime())}
                      </p>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        className="min-w-0 rounded-xl border p-4"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({ ko: "작업 이력", en: "Task History", ja: "作業履歴", zh: "Task History", de: "Aufgabenverlauf" })}
        </h4>
        {!selectedProject ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            -
          </p>
        ) : groupedTaskCards.length === 0 ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "연결된 작업이 없습니다",
              en: "No mapped tasks",
              ja: "紐づくタスクなし",
              zh: "No mapped tasks",
              de: "Keine zugeordneten Aufgaben",
            })}
          </p>
        ) : (
          <div className="mt-2 max-h-56 overflow-x-hidden overflow-y-auto space-y-2 pr-1">
            {groupedTaskCards.map((group) => (
              <button
                key={group.root.id}
                type="button"
                onClick={() => void handleOpenTaskDetail(group.root.id)}
                className="w-full min-w-0 overflow-hidden rounded-lg border px-3 py-2 text-left transition hover:border-blue-500/70 hover:bg-[var(--th-bg-secondary)]"
                style={{ background: "var(--th-bg-secondary)", borderColor: "var(--th-border)" }}
              >
                <p
                  className="whitespace-pre-wrap break-all text-xs font-semibold"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {group.root.title}
                </p>
                <p className="mt-1 break-all text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {group.root.status} · {group.root.task_type} · {fmtTime(group.root.created_at)}
                </p>
                <p className="mt-1 break-all text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  {t({ ko: "담당", en: "Owner", ja: "担当", zh: "Owner", de: "Verantwortlich" })}:{" "}
                  {group.root.assigned_agent_name_ko || group.root.assigned_agent_name || "-"}
                </p>
                <p className="mt-1 text-[11px] text-blue-300">
                  {t({ ko: "하위 작업", en: "Sub tasks", ja: "サブタスク", zh: "Sub tasks", de: "Unteraufgaben" })}:{" "}
                  {group.children.length}
                </p>
                {group.children.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {group.children.slice(0, 3).map((child: ProjectTaskHistoryItem) => (
                      <p
                        key={child.id}
                        className="whitespace-pre-wrap break-all text-[11px]"
                        style={{ color: "var(--th-text-muted)" }}
                      >
                        - {child.title}
                      </p>
                    ))}
                    {group.children.length > 3 && (
                      <p className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                        +{group.children.length - 3}
                      </p>
                    )}
                  </div>
                )}
                <p className="mt-2 text-right text-[11px] text-emerald-300">
                  {t({
                    ko: "카드 클릭으로 상세 보기",
                    en: "Click card for details",
                    ja: "クリックで詳細表示",
                    zh: "Click card for details",
                    de: "Karte anklicken für Details",
                  })}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className="min-w-0 rounded-xl border p-4"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({
            ko: "보고서 이력(프로젝트 매핑)",
            en: "Mapped Reports",
            ja: "紐づくレポート",
            zh: "Mapped Reports",
            de: "Zugeordnete Berichte",
          })}
        </h4>
        {!selectedProject ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            -
          </p>
        ) : sortedReports.length === 0 ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "연결된 보고서가 없습니다",
              en: "No mapped reports",
              ja: "紐づくレポートなし",
              zh: "No mapped reports",
              de: "Keine zugeordneten Berichte",
            })}
          </p>
        ) : (
          <div className="mt-2 max-h-56 overflow-x-hidden overflow-y-auto space-y-2 pr-1">
            {sortedReports.map((row) => (
              <div
                key={row.id}
                className="flex min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2"
                style={{ background: "var(--th-bg-secondary)", borderColor: "var(--th-border)" }}
              >
                <div className="min-w-0">
                  <p
                    className="whitespace-pre-wrap break-all text-xs font-medium"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {row.title}
                  </p>
                  <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                    {fmtTime(row.completed_at || row.created_at)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleOpenTaskDetail(row.id)}
                  className="shrink-0 rounded-md bg-emerald-700 px-2 py-1 text-[11px] text-white hover:bg-emerald-600"
                >
                  {t({ ko: "열람", en: "Open", ja: "表示", zh: "Open", de: "Öffnen" })}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className="min-w-0 rounded-xl border p-4"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({
            ko: "대표 선택사항",
            en: "Representative Decisions",
            ja: "代表選択事項",
            zh: "Representative Decisions",
            de: "Wesentliche Entscheidungen",
          })}
        </h4>
        {!selectedProject ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            -
          </p>
        ) : sortedDecisionEvents.length === 0 ? (
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "기록된 대표 의사결정이 없습니다",
              en: "No representative decision records",
              ja: "代表意思決定の記録はありません",
              zh: "No representative decision records",
              de: "Keine wesentlichen Entscheidungen erfasst",
            })}
          </p>
        ) : (
          <div className="mt-2 max-h-56 overflow-x-hidden overflow-y-auto space-y-2 pr-1">
            {sortedDecisionEvents.map((event) => {
              let selectedLabels: string[] = [];
              if (event.selected_options_json) {
                try {
                  const parsed = JSON.parse(event.selected_options_json) as Array<{ label?: unknown }>;
                  selectedLabels = Array.isArray(parsed)
                    ? parsed
                        .map((row) => (typeof row?.label === "string" ? row.label.trim() : ""))
                        .filter((label) => label.length > 0)
                    : [];
                } catch {
                  selectedLabels = [];
                }
              }

              return (
                <div
                  key={`${event.id}-${event.created_at}`}
                  className="rounded-lg border px-3 py-2"
                  style={{ background: "var(--th-bg-secondary)", borderColor: "var(--th-border)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
                      {getDecisionEventLabel(event.event_type)}
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                      {fmtTime(event.created_at)}
                    </p>
                  </div>
                  <p
                    className="mt-1 whitespace-pre-wrap break-all text-[11px]"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    {event.summary}
                  </p>
                  {selectedLabels.length > 0 && (
                    <p className="mt-1 whitespace-pre-wrap break-all text-[11px] text-blue-300">
                      {t({
                        ko: "선택 내용",
                        en: "Selected Items",
                        ja: "選択内容",
                        zh: "Selected Items",
                        de: "Ausgewählte Punkte",
                      })}
                      : {selectedLabels.join(" / ")}
                    </p>
                  )}
                  {event.note && event.note.trim().length > 0 && (
                    <p className="mt-1 whitespace-pre-wrap break-all text-[11px] text-emerald-300">
                      {t({
                        ko: "추가 요청사항",
                        en: "Additional Request",
                        ja: "追加要請事項",
                        zh: "Additional Request",
                        de: "Zusätzliche Anfrage",
                      })}
                      : {event.note}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
