import type { Department } from "../../types";
import type { TaskReportTeamSection } from "../../api";
import type { UiLanguage } from "../../i18n";
import { pickLang } from "../../i18n";
import ReportDocumentList from "./ReportDocumentList";
import { fmtTime, statusClass } from "./utils";

interface TeamReportTabProps {
  team: TaskReportTeamSection;
  departmentById: Map<string, Department>;
  uiLanguage: UiLanguage;
  expandedDocs: Record<string, boolean>;
  documentPages: Record<string, number>;
  onToggleDoc: (docId: string) => void;
  onSetPage: (scopeKey: string, page: number) => void;
}

export default function TeamReportTab({
  team,
  departmentById,
  uiLanguage,
  expandedDocs,
  documentPages,
  onToggleDoc,
  onSetPage,
}: TeamReportTabProps) {
  const t = (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => pickLang(uiLanguage, text);

  const teamDeptFromMap = team.department_id ? departmentById.get(team.department_id) : undefined;
  const teamName =
    uiLanguage === "ko"
      ? teamDeptFromMap?.name_ko || team.department_name_ko || team.department_name
      : teamDeptFromMap?.name || team.department_name || team.department_name_ko;
  const teamAgent = uiLanguage === "ko" ? team.agent_name_ko || team.agent_name : team.agent_name;
  const logs = team.logs ?? [];
  const keyLogs = logs.filter((lg) => lg.kind === "system" || lg.message.includes("Status")).slice(-20);

  return (
    <div className="space-y-3">
      <div
        className="rounded-lg border p-3"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {team.title}
          </p>
          <span className={`rounded px-2 py-0.5 text-[11px] ${statusClass(team.status)}`}>{team.status}</span>
        </div>
        <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {teamName} · {teamAgent || "-"}
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
          {t({ ko: "완료", en: "Completed", ja: "完了", zh: "Completed", de: "Abgeschlossen" })}:{" "}
          {fmtTime(team.completed_at)}
        </p>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
          {team.summary || "-"}
        </p>
      </div>

      {team.linked_subtasks.length > 0 && (
        <div
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <p className="mb-2 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "연결된 서브태스크",
              en: "Linked Subtasks",
              ja: "関連サブタスク",
              zh: "Linked Subtasks",
              de: "Verknüpfte Unteraufgaben",
            })}
          </p>
          <div className="space-y-1.5">
            {team.linked_subtasks.map((st) => (
              <div
                key={st.id}
                className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px]"
                style={{ background: "var(--th-card-bg)" }}
              >
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--th-text-secondary)" }}>
                  {st.title}
                </span>
                <span className={`rounded px-1.5 py-0.5 ${statusClass(st.status)}`}>{st.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--th-text-muted)" }}>
          {t({ ko: "팀 문서", en: "Team Documents", ja: "チーム文書", zh: "Team Documents", de: "Teamdokumente" })}
        </p>
        <ReportDocumentList
          documents={team.documents ?? []}
          scopeKey={`team:${team.id}`}
          uiLanguage={uiLanguage}
          expandedDocs={expandedDocs}
          documentPages={documentPages}
          onToggleDoc={onToggleDoc}
          onSetPage={onSetPage}
        />
      </div>

      {keyLogs.length > 0 && (
        <div
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <p className="mb-2 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "진행 로그",
              en: "Progress Logs",
              ja: "進行ログ",
              zh: "Progress Logs",
              de: "Fortschrittsprotokolle",
            })}
          </p>
          <div className="space-y-1">
            {keyLogs.map((lg, idx) => (
              <div
                key={`${lg.created_at}-${idx}`}
                className="text-[11px]"
                style={{ color: "var(--th-text-secondary)" }}
              >
                <span className="mr-2" style={{ color: "var(--th-text-muted)" }}>
                  {fmtTime(lg.created_at)}
                </span>
                {lg.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
