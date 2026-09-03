import type { MeetingMinute } from "../../types";
import type { TaskLogEntry } from "./model";

type TrFn = (ko: string, en: string, ja?: string, zh?: string, de?: string) => string;

export interface MeetingMinutesTabProps {
  meetingMinutes: MeetingMinute[];
  taskLogs: TaskLogEntry[];
  locale: string;
  tr: TrFn;
}

function meetingTypeLabel(type: "planned" | "review", tr: TrFn) {
  return type === "planned"
    ? tr("Planned 승인", "Planned Approval", "Planned 承認", "Planned 审批", "Geplante Genehmigung")
    : tr("Review 승인", "Review Approval", "Review 承認", "Review 审批", "Überprüfungsgenehmigung");
}

function meetingStatusLabel(status: MeetingMinute["status"], tr: TrFn) {
  if (status === "completed") return tr("완료", "Completed", "完了", "已完成", "Abgeschlossen");
  if (status === "revision_requested")
    return tr("보완 요청", "Revision Requested", "修正要請", "要求修订", "Überarbeitung angefordert");
  if (status === "failed") return tr("실패", "Failed", "失敗", "失败", "Fehlgeschlagen");
  return tr("진행중", "In Progress", "進行中", "进行中", "In Bearbeitung");
}

export function MeetingMinutesTab({ meetingMinutes, taskLogs, locale, tr }: MeetingMinutesTabProps) {
  return (
    <div className="terminal-panel-body flex-1 overflow-y-auto p-4 space-y-3">
      {meetingMinutes.length === 0 ? (
        taskLogs.length > 0 ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-blue-700/30 bg-blue-900/20 px-3 py-2 text-xs text-blue-300 mb-3">
              {tr(
                "진행 로그 (회의록 없음)",
                "Progress Logs (no meeting minutes available)",
                "進捗ログ（会議録なし）",
                "进度日志（无会议纪要）",
                "Fortschrittsprotokolle (keine Meeting Minutes vorhanden)",
              )}
            </div>
            {taskLogs
              .filter((log) => ["system", "completed", "error", "warn"].includes(log.kind))
              .slice(-30)
              .map((log) => (
                <div
                  key={log.id}
                  className="rounded-md border px-2 py-1.5"
                  style={{ borderColor: "var(--th-border)", background: "var(--th-panel-bg)" }}
                >
                  <div
                    className="mb-0.5 flex items-center gap-2 text-[10px]"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    <span>{new Date(log.created_at).toLocaleTimeString()}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                        log.kind === "error"
                          ? "bg-red-900/40 text-red-300"
                          : log.kind === "warn"
                            ? "bg-amber-900/40 text-amber-300"
                            : log.kind === "completed"
                              ? "bg-green-900/40 text-green-300"
                              : "bg-emerald-900/40 text-emerald-300"
                      }`}
                    >
                      {log.kind}
                    </span>
                  </div>
                  <div
                    className="text-xs leading-relaxed whitespace-pre-wrap break-words"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {log.message}
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center" style={{ color: "var(--th-text-muted)" }}>
            <div className="text-3xl mb-3">📝</div>
            <div className="text-sm">
              {tr(
                "회의록이 아직 없습니다",
                "No meeting minutes yet",
                "会議録はまだありません",
                "暂无会议纪要",
                "Noch keine Protokolle",
              )}
            </div>
          </div>
        )
      ) : (
        meetingMinutes.map((meeting) => (
          <div
            key={meeting.id}
            className="rounded-xl border p-3"
            style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-[10px] text-emerald-200">
                {meetingTypeLabel(meeting.meeting_type, tr)}
              </span>
              <span
                className="rounded px-2 py-0.5 text-[10px]"
                style={{ background: "var(--th-bg-surface)", color: "var(--th-text-primary)" }}
              >
                {tr("라운드", "Round", "ラウンド", "轮次", "Runde")} {meeting.round}
              </span>
              <span
                className="rounded px-2 py-0.5 text-[10px]"
                style={{ background: "var(--th-bg-surface)", color: "var(--th-text-primary)" }}
              >
                {meetingStatusLabel(meeting.status, tr)}
              </span>
              <span className="ml-auto text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                {new Date(meeting.started_at).toLocaleString(locale)}
              </span>
            </div>
            <div className="space-y-1.5">
              {meeting.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-md border px-2 py-1.5"
                  style={{ borderColor: "var(--th-border)", background: "var(--th-panel-bg)" }}
                >
                  <div
                    className="mb-0.5 flex items-center gap-2 text-[10px]"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    <span>#{entry.seq}</span>
                    <span className="text-emerald-300">{entry.speaker_name}</span>
                    {entry.department_name && <span>{entry.department_name}</span>}
                    {entry.role_label && <span>· {entry.role_label}</span>}
                  </div>
                  <div
                    className="text-xs leading-relaxed whitespace-pre-wrap break-words"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {entry.content}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
