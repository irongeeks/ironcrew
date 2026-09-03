import type { Agent, Department } from "../../types";
import { localeName } from "../../i18n";
import AgentAvatar from "../AgentAvatar";
import { ROLE_BADGE, ROLE_LABEL, STATUS_DOT } from "./constants";
import type { Translator } from "./types";

interface AgentCardProps {
  agent: Agent;
  spriteMap: Map<string, number>;
  isKo: boolean;
  locale: string;
  tr: Translator;
  departments: Department[];
  onEdit: () => void;
  onQuickAssignTask: () => void;
  onQuickMessage: () => void;
  onQuickViewDetails: () => void;
  confirmDeleteId: string | null;
  onDeleteClick: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  saving: boolean;
}

export default function AgentCard({
  agent,
  spriteMap,
  isKo,
  locale,
  tr,
  departments,
  onEdit,
  onQuickAssignTask,
  onQuickMessage,
  onQuickViewDetails,
  confirmDeleteId,
  onDeleteClick,
  onDeleteConfirm,
  onDeleteCancel,
  saving,
}: AgentCardProps) {
  const isDeleting = confirmDeleteId === agent.id;
  const dept = departments.find((d) => d.id === agent.department_id);
  const statusLabel = (() => {
    if (agent.status === "working") return tr("작업 중", "Working");
    if (agent.status === "break") return tr("휴식", "Break");
    if (agent.status === "offline") return tr("오프라인", "Offline");
    return tr("대기", "Idle");
  })();
  const providerLabel = (() => {
    if (agent.cli_provider === "claude") return "Claude";
    if (agent.cli_provider === "codex") return "Codex";
    if (agent.cli_provider === "gemini") return "Gemini";
    if (agent.cli_provider === "opencode") return "OpenCode";
    if (agent.cli_provider === "copilot") return "Copilot";
    if (agent.cli_provider === "antigravity") return "Antigravity";
    if (agent.cli_provider === "openclaw") return "OpenClaw";
    return "API";
  })();
  const statusBadgeClass =
    agent.status === "working"
      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
      : agent.status === "break"
        ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
        : agent.status === "offline"
          ? "border-rose-500/30 bg-rose-500/15 text-rose-300"
          : "border-zinc-600/30 bg-zinc-600/10 text-zinc-400";

  return (
    <div
      onClick={onEdit}
      className="group p-4 cursor-pointer transition-all hover:-translate-y-0.5"
      style={{
        background: "var(--th-card-bg)",
        border: "2px solid var(--th-card-border)",
        borderRadius: "10px 14px 10px 12px / 12px 10px 14px 10px",
        boxShadow: "4px 4px 0px var(--shadow-hard-color, rgba(0,0,0,0.4))",
      }}
    >
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <AgentAvatar agent={agent} spriteMap={spriteMap} size={44} rounded="xl" />
          <div
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${STATUS_DOT[agent.status] ?? STATUS_DOT.idle}`}
            style={{ borderColor: "var(--th-card-bg)" }}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="font-pixel text-sm truncate"
              style={{
                color: "var(--th-text-heading)",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.3em",
              }}
            >
              {localeName(locale, agent)}
            </span>
            <span className="text-[10px] shrink-0" style={{ color: "var(--th-text-muted)" }}>
              {(() => {
                const primary = localeName(locale, agent);
                const sub = locale === "en" ? agent.name_ko || "" : agent.name;
                return primary !== sub ? sub : "";
              })()}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md border font-medium ${ROLE_BADGE[agent.role] || ""}`}>
              {isKo ? ROLE_LABEL[agent.role]?.ko : ROLE_LABEL[agent.role]?.en}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md border font-medium ${statusBadgeClass}`}>
              {statusLabel}
            </span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-md border font-semibold uppercase tracking-wide"
              style={{
                borderColor: "var(--th-input-border)",
                background: "var(--th-input-bg)",
                color: "var(--th-text-secondary)",
              }}
            >
              {providerLabel}
            </span>
            {dept && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-md"
                style={{ background: "var(--th-bg-surface)", color: "var(--th-text-muted)" }}
              >
                {dept.icon} {localeName(locale, dept)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        className="flex items-center justify-between mt-3 pt-2.5"
        style={{ borderTop: "1px solid var(--th-card-border)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onQuickAssignTask();
            }}
            className="rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors hover:border-blue-400/50 hover:text-blue-300"
            style={{
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-secondary)",
            }}
          >
            {tr("작업 할당", "Assign Task")}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onQuickMessage();
            }}
            className="rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors hover:border-cyan-400/50 hover:text-cyan-300"
            style={{
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-secondary)",
            }}
          >
            {tr("메시지", "Message")}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onQuickViewDetails();
            }}
            className="rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors hover:border-emerald-400/50 hover:text-emerald-300"
            style={{
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-secondary)",
            }}
          >
            {tr("상세", "Details")}
          </button>
        </div>
        <div
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {isDeleting ? (
            <>
              <button
                onClick={onDeleteConfirm}
                disabled={saving || agent.status === "working"}
                className="px-2 py-0.5 rounded text-[10px] font-medium bg-red-600 hover:bg-red-500 text-white disabled:opacity-40 transition-colors"
              >
                {tr("해고", "Fire")}
              </button>
              <button
                onClick={onDeleteCancel}
                className="px-2 py-0.5 rounded text-[10px] transition-colors"
                style={{ color: "var(--th-text-muted)" }}
              >
                {tr("취소", "No")}
              </button>
            </>
          ) : (
            <button
              onClick={onDeleteClick}
              className="px-1.5 py-0.5 rounded text-xs hover:bg-red-500/15 hover:text-red-400 transition-colors"
              style={{ color: "var(--th-text-muted)" }}
              title={tr("해고", "Fire")}
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
