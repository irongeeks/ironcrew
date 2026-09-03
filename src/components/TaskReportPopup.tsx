import { useMemo, useState, useEffect, useCallback } from "react";
import type { Agent, Department } from "../types";
import type { TaskReportDetail } from "../api";
import { archiveTaskReport, getTaskReportDetail } from "../api";
import type { UiLanguage } from "../i18n";
import { pickLang } from "../i18n";
import AgentAvatar from "./AgentAvatar";
import PlanningSummaryTab from "./task-report/PlanningSummaryTab";
import TeamReportTab from "./task-report/TeamReportTab";
import { elapsed, fmtTime, projectNameFromPath } from "./task-report/utils";

interface TaskReportPopupProps {
  report: TaskReportDetail;
  agents: Agent[];
  departments: Department[];
  uiLanguage: UiLanguage;
  onClose: () => void;
}

export default function TaskReportPopup({ report, agents, departments, uiLanguage, onClose }: TaskReportPopupProps) {
  const t = (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => pickLang(uiLanguage, text);

  const [currentReport, setCurrentReport] = useState<TaskReportDetail>(report);
  const [refreshingArchive, setRefreshingArchive] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("planning");
  const [expandedDocs, setExpandedDocs] = useState<Record<string, boolean>>({});
  const [documentPages, setDocumentPages] = useState<Record<string, number>>({});

  useEffect(() => {
    setCurrentReport(report);
  }, [report]);

  const rootTaskId = currentReport.project?.root_task_id || currentReport.task.id;
  const teamReports = useMemo(() => currentReport.team_reports ?? [], [currentReport.team_reports]);
  const projectName = currentReport.project?.project_name || projectNameFromPath(currentReport.task.project_path);
  const projectPath = currentReport.project?.project_path || currentReport.task.project_path;
  const planningSummary = currentReport.planning_summary;

  const refreshArchive = async () => {
    if (!rootTaskId || refreshingArchive) return;
    setRefreshingArchive(true);
    try {
      await archiveTaskReport(rootTaskId);
      const refreshed = await getTaskReportDetail(rootTaskId);
      setCurrentReport(refreshed);
    } catch (err) {
      console.error("Failed to refresh planning archive:", err);
    } finally {
      setRefreshingArchive(false);
    }
  };

  useEffect(() => {
    setActiveTab("planning");
    setExpandedDocs({});
    setDocumentPages({});
  }, [currentReport.task.id, currentReport.requested_task_id, teamReports.length]);

  const taskAgent = agents.find((a) => a.id === currentReport.task.assigned_agent_id);
  const departmentById = useMemo(() => {
    const map = new Map<string, Department>();
    for (const department of departments) {
      map.set(department.id, department);
    }
    return map;
  }, [departments]);
  const taskDeptFromMap = currentReport.task.department_id
    ? departmentById.get(currentReport.task.department_id)
    : undefined;
  const taskAgentName =
    uiLanguage === "ko"
      ? currentReport.task.agent_name_ko || currentReport.task.agent_name
      : currentReport.task.agent_name;
  const taskDeptName =
    uiLanguage === "ko"
      ? taskDeptFromMap?.name_ko || currentReport.task.dept_name_ko || currentReport.task.dept_name
      : taskDeptFromMap?.name || currentReport.task.dept_name || currentReport.task.dept_name_ko;

  const selectedTeam = useMemo(() => {
    if (activeTab === "planning") return null;
    return teamReports.find((team) => team.id === activeTab || team.task_id === activeTab) ?? null;
  }, [activeTab, teamReports]);

  const planningDocs = planningSummary?.documents ?? [];

  const toggleDoc = useCallback((docId: string) => {
    setExpandedDocs((prev) => {
      const current = prev[docId] !== false;
      return { ...prev, [docId]: !current };
    });
  }, []);

  const setPage = useCallback((scopeKey: string, page: number) => {
    setDocumentPages((prev) => ({ ...prev, [scopeKey]: page }));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-4 w-full max-w-4xl border border-emerald-500/30 shadow-2xl shadow-emerald-500/10"
        style={{ background: "var(--th-bg-secondary)", borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--th-border)" }}
        >
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xl">&#x1F4CB;</span>
              <h2 className="truncate text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
                {t({
                  ko: "작업 완료 보고서",
                  en: "Task Completion Report",
                  ja: "タスク完了レポート",
                  zh: "Task Completion Report",
                  de: "Aufgaben-Abschlussbericht",
                })}
              </h2>
              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">{projectName}</span>
            </div>
            <p className="truncate text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {projectPath || "-"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:text-white"
            style={{ color: "var(--th-text-secondary)" }}
          >
            &#x2715;
          </button>
        </div>

        {/* Task info bar */}
        <div className="border-b px-6 py-3" style={{ borderColor: "var(--th-border)" }}>
          <div className="flex items-start gap-3">
            <AgentAvatar agent={taskAgent} agents={agents} size={40} rounded="xl" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                {currentReport.task.title}
              </p>
              <div
                className="mt-1 flex flex-wrap items-center gap-2 text-xs"
                style={{ color: "var(--th-text-secondary)" }}
              >
                <span className="rounded px-1.5 py-0.5" style={{ background: "var(--th-bg-surface-hover)" }}>
                  {taskDeptName}
                </span>
                <span>
                  {taskAgentName} ({currentReport.task.agent_role})
                </span>
                <span>
                  {t({ ko: "완료", en: "Completed", ja: "완了", zh: "Completed", de: "Abgeschlossen" })}:{" "}
                  {fmtTime(currentReport.task.completed_at)}
                </span>
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-400">
                  {elapsed(currentReport.task.created_at, currentReport.task.completed_at)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="border-b px-6 py-2.5" style={{ borderColor: "var(--th-border)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveTab("planning")}
              className={`rounded-lg px-3 py-1.5 text-xs ${
                activeTab === "planning" ? "bg-emerald-600 text-white" : "text-slate-300 hover:opacity-80"
              }`}
            >
              {t({
                ko: "기획팀장 취합본",
                en: "Planning Summary",
                ja: "企画サマリー",
                zh: "Planning Summary",
                de: "Planungszusammenfassung",
              })}
            </button>
            {teamReports.map((team) => {
              const label =
                uiLanguage === "ko"
                  ? team.department_name_ko || team.department_name || team.department_id || "팀"
                  : team.department_name || team.department_id || "Team";
              return (
                <button
                  key={team.id}
                  onClick={() => setActiveTab(team.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs ${
                    activeTab === team.id ? "bg-blue-600 text-white" : "text-slate-300 hover:opacity-80"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab content */}
        <div className="max-h-[68vh] overflow-y-auto px-6 py-4">
          {activeTab === "planning" ? (
            <PlanningSummaryTab
              content={planningSummary?.content}
              generatedAt={planningSummary?.generated_at}
              documents={planningDocs}
              uiLanguage={uiLanguage}
              refreshingArchive={refreshingArchive}
              onRefreshArchive={refreshArchive}
              expandedDocs={expandedDocs}
              documentPages={documentPages}
              onToggleDoc={toggleDoc}
              onSetPage={setPage}
            />
          ) : selectedTeam ? (
            <TeamReportTab
              team={selectedTeam}
              departmentById={departmentById}
              uiLanguage={uiLanguage}
              expandedDocs={expandedDocs}
              documentPages={documentPages}
              onToggleDoc={toggleDoc}
              onSetPage={setPage}
            />
          ) : (
            <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "표시할 보고서가 없습니다",
                en: "No report to display",
                ja: "表示するレポートがありません",
                zh: "No report to display",
                de: "Kein Bericht anzuzeigen",
              })}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-3" style={{ borderColor: "var(--th-border)" }}>
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: `팀 보고서 ${teamReports.length}개`,
                en: `${teamReports.length} team reports`,
                ja: `チームレポート ${teamReports.length}件`,
                zh: `${teamReports.length} team reports`,
                de: `${teamReports.length} Teamberichte`,
              })}
            </span>
            <button
              onClick={onClose}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500"
            >
              {t({ ko: "확인", en: "OK", ja: "OK", zh: "OK", de: "OK" })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
