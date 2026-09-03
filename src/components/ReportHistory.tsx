import { useEffect, useMemo, useState } from "react";
import type { Agent, Department } from "../types";
import type { TaskReportSummary, TaskReportDetail } from "../api";
import type { UiLanguage } from "../i18n";
import { pickLang } from "../i18n";
import { getTaskReports, getTaskReportDetail } from "../api";
import AgentAvatar from "./AgentAvatar";
import TaskReportPopup from "./TaskReportPopup";

interface ReportHistoryProps {
  agents: Agent[];
  departments: Department[];
  uiLanguage: UiLanguage;
  onClose: () => void;
}

const PAGE_SIZE = 5;
const GROUP_ITEMS_PER_PAGE = 3;

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function projectNameFromSummary(report: TaskReportSummary): string {
  if (report.project_name && report.project_name.trim()) return report.project_name.trim();
  if (!report.project_path) return "General";
  const trimmed = report.project_path.replace(/[\\/]+$/, "");
  const seg = trimmed.split(/[\\/]/).pop();
  return seg || "General";
}

export default function ReportHistory({ agents, departments, uiLanguage, onClose }: ReportHistoryProps) {
  const t = (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => pickLang(uiLanguage, text);
  const [reports, setReports] = useState<TaskReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<TaskReportDetail | null>(null);
  const [page, setPage] = useState(0);
  const [groupPages, setGroupPages] = useState<Record<string, number>>({});

  const totalPages = Math.max(1, Math.ceil(reports.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, reports.length);
  const pageReports = reports.slice(pageStart, pageEnd);

  const groupedPageReports = useMemo(() => {
    const groups = new Map<string, TaskReportSummary[]>();
    for (const report of pageReports) {
      const key = projectNameFromSummary(report);
      const bucket = groups.get(key) ?? [];
      bucket.push(report);
      groups.set(key, bucket);
    }
    return [...groups.entries()];
  }, [pageReports]);

  useEffect(() => {
    setPage(0);
    setGroupPages({});
  }, [reports]);

  // Reset group sub-pages when page changes
  useEffect(() => {
    setGroupPages({});
  }, [page]);

  useEffect(() => {
    getTaskReports()
      .then((r) => setReports(r))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleGroupPageChange = (groupKey: string, nextPage: number, groupTotalPages: number) => {
    const bounded = Math.min(Math.max(nextPage, 0), Math.max(groupTotalPages - 1, 0));
    setGroupPages((prev) => ({ ...prev, [groupKey]: bounded }));
  };

  const handleOpenDetail = async (taskId: string) => {
    try {
      const d = await getTaskReportDetail(taskId);
      setDetail(d);
    } catch (e) {
      console.error("Failed to load report detail:", e);
    }
  };

  // Show TaskReportPopup when detail view is open
  if (detail) {
    return (
      <TaskReportPopup
        report={detail}
        agents={agents}
        departments={departments}
        uiLanguage={uiLanguage}
        onClose={() => setDetail(null)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-4 w-full max-w-2xl border border-emerald-500/30 shadow-[var(--shadow-modal)]"
        style={{ background: "var(--th-bg-secondary)", borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--th-border)" }}
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">&#x1F4CA;</span>
            <h2 className="text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
              {t({
                ko: "작업 보고서 이력",
                en: "Report History",
                ja: "レポート履歴",
                zh: "Report History",
                de: "Berichtsverlauf",
              })}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:text-white"
            style={{ color: "var(--th-text-secondary)" }}
          >
            &#x2715;
          </button>
        </div>

        {/* Content */}
        <div className="max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                {t({ ko: "불러오는 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
              </div>
            </div>
          ) : reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <span className="mb-2 text-3xl opacity-40">&#x1F4ED;</span>
              <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "완료된 보고서가 없습니다",
                  en: "No completed reports",
                  ja: "完了レポートなし",
                  zh: "No completed reports",
                  de: "Keine abgeschlossenen Berichte",
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-4 px-4 py-3">
              {groupedPageReports.map(([projectName, rows]) => {
                const groupTotal = Math.max(1, Math.ceil(rows.length / GROUP_ITEMS_PER_PAGE));
                const groupCurrent = Math.min(Math.max(groupPages[projectName] ?? 0, 0), groupTotal - 1);
                const gStart = groupCurrent * GROUP_ITEMS_PER_PAGE;
                const gEnd = Math.min(gStart + GROUP_ITEMS_PER_PAGE, rows.length);
                const visibleRows = rows.slice(gStart, gEnd);

                return (
                  <div
                    key={projectName}
                    className="overflow-hidden rounded-xl border"
                    style={{ borderColor: "var(--th-border)" }}
                  >
                    <div
                      className="flex items-center justify-between px-4 py-2"
                      style={{ background: "var(--th-card-bg)" }}
                    >
                      <p className="truncate text-xs font-semibold uppercase tracking-wider text-emerald-300">
                        {projectName}
                      </p>
                      <span className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                        {rows.length}
                      </span>
                    </div>
                    <div className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                      {visibleRows.map((r) => {
                        const agent = agents.find((a) => a.id === r.assigned_agent_id);
                        const agentName = uiLanguage === "ko" ? r.agent_name_ko || r.agent_name : r.agent_name;
                        const deptName = uiLanguage === "ko" ? r.dept_name_ko || r.dept_name : r.dept_name;
                        return (
                          <button
                            key={r.id}
                            onClick={() => handleOpenDetail(r.id)}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left transition"
                          >
                            <AgentAvatar agent={agent} agents={agents} size={34} rounded="xl" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                                {r.title}
                              </p>
                              <div
                                className="mt-0.5 flex items-center gap-2 text-xs"
                                style={{ color: "var(--th-text-muted)" }}
                              >
                                <span
                                  className="rounded px-1.5 py-0.5"
                                  style={{ background: "var(--th-bg-surface-hover)" }}
                                >
                                  {deptName}
                                </span>
                                <span>{agentName}</span>
                                <span style={{ color: "var(--th-text-muted)" }}>&middot;</span>
                                <span>{fmtDate(r.completed_at)}</span>
                              </div>
                            </div>
                            <span className="flex-shrink-0 text-xs text-emerald-400">&#x2713;</span>
                          </button>
                        );
                      })}
                    </div>
                    {groupTotal > 1 && (
                      <div
                        className="flex items-center justify-between border-t px-3 py-2"
                        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
                      >
                        <span className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                          {gStart + 1}-{gEnd} / {rows.length}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleGroupPageChange(projectName, groupCurrent - 1, groupTotal)}
                            disabled={groupCurrent <= 0}
                            className="rounded border px-2 py-0.5 text-[11px] transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                          >
                            {t({ ko: "이전", en: "Prev", ja: "前へ", zh: "Prev", de: "Zurück" })}
                          </button>
                          <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                            {groupCurrent + 1} / {groupTotal}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleGroupPageChange(projectName, groupCurrent + 1, groupTotal)}
                            disabled={groupCurrent >= groupTotal - 1}
                            className="rounded border px-2 py-0.5 text-[11px] transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                          >
                            {t({ ko: "다음", en: "Next", ja: "次へ", zh: "Next", de: "Weiter" })}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-3" style={{ borderColor: "var(--th-border)" }}>
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: `총 ${reports.length}건`,
                en: `${reports.length} reports`,
                ja: `全${reports.length}件`,
                zh: `${reports.length} reports`,
                de: `${reports.length} Berichte`,
              })}
            </span>
            <div className="flex items-center gap-3">
              {totalPages > 1 && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPage(currentPage - 1)}
                    disabled={currentPage <= 0}
                    className="rounded border px-2 py-0.5 text-[11px] transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                  >
                    {t({ ko: "이전", en: "Prev", ja: "前へ", zh: "Prev", de: "Zurück" })}
                  </button>
                  <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                    {currentPage + 1} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage(currentPage + 1)}
                    disabled={currentPage >= totalPages - 1}
                    className="rounded border px-2 py-0.5 text-[11px] transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                  >
                    {t({ ko: "다음", en: "Next", ja: "次へ", zh: "Next", de: "Weiter" })}
                  </button>
                </div>
              )}
              <button
                onClick={onClose}
                className="rounded-lg px-4 py-1.5 text-sm font-medium transition"
                style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
              >
                {t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
