import AgentAvatar from "../../AgentAvatar";
import type { Agent, WorkflowPackKey } from "../../../types";
import type { ChannelSettingsTabProps } from "../types";
import { CHANNEL_META, isWorkflowPackKey } from "./constants";
import { type ChatRow, defaultWorkflowPackLabel } from "./state";

type ChatSessionListProps = {
  t: ChannelSettingsTabProps["t"];
  chatRows: ChatRow[];
  agentById: Map<string, Agent>;
  spriteMap: Map<string, number>;
  workflowPackNameByKey: Map<WorkflowPackKey, string>;
  onAdd: () => void;
  onEdit: (row: ChatRow) => void;
  onDelete: (row: ChatRow) => void;
};

export default function ChatSessionList({
  t,
  chatRows,
  agentById,
  spriteMap,
  workflowPackNameByKey,
  onAdd,
  onEdit,
  onDelete,
}: ChatSessionListProps) {
  return (
    <div
      className="rounded-lg border p-3 space-y-3"
      style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {t({ en: "Chat Sessions", de: "Chat-Sitzungen" })}
        </div>
        <button
          onClick={onAdd}
          className="text-xs px-3 py-1 rounded-md bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/40"
        >
          + {t({ en: "Add Chat", de: "Chat hinzufügen" })}
        </button>
      </div>

      {chatRows.length === 0 ? (
        <div className="text-xs py-2" style={{ color: "var(--th-text-muted)" }}>
          {t({
            en: "No chats yet. Use 'Add Chat' to register messenger/token/channel.",
            de: "Keine Chats vorhanden. Verwenden Sie 'Chat hinzufügen', um Messenger/Token/Kanal zu registrieren.",
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {chatRows.map((row) => {
            const meta = CHANNEL_META[row.channel];
            const assignedAgent = row.session.agentId ? agentById.get(row.session.agentId) : undefined;
            const assignedAgentName = assignedAgent
              ? assignedAgent.name_ko || assignedAgent.name
              : row.session.agentId || "";
            const workflowPackKey = isWorkflowPackKey(row.session.workflowPackKey)
              ? row.session.workflowPackKey
              : "development";
            const workflowPackLabel =
              workflowPackNameByKey.get(workflowPackKey) ?? defaultWorkflowPackLabel(t, workflowPackKey);
            const tokenReady = row.token.trim().length > 0;
            return (
              <div
                key={row.key}
                className="rounded-md border px-3 py-2"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-100">{row.session.name}</span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded uppercase"
                        style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
                      >
                        {meta.label}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${meta.transportReady ? "bg-emerald-600/20 text-emerald-300" : "bg-amber-600/20 text-amber-300"}`}
                      >
                        {meta.transportReady
                          ? t({ en: "Native", de: "Direkt" })
                          : t({ en: "Compat", de: "Kompatibel" })}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/20 text-indigo-300">
                        {workflowPackLabel}
                      </span>
                      {!tokenReady && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-600/20 text-red-300">
                          {t({ en: "No token", de: "Kein Token" })}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] font-mono break-all" style={{ color: "var(--th-text-secondary)" }}>
                      {row.session.targetId}
                    </div>
                    <div
                      className="mt-1 text-[11px] flex items-center gap-1.5"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      {assignedAgentName ? (
                        <>
                          <span>{t({ en: "Agent", de: "Agent" })}:</span>
                          {assignedAgent && (
                            <AgentAvatar agent={assignedAgent} spriteMap={spriteMap} size={14} rounded="xl" />
                          )}
                          <span className="truncate">{assignedAgentName}</span>
                        </>
                      ) : (
                        <span>{t({ en: "No agent assigned", de: "Kein Agent zugewiesen" })}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onEdit(row)}
                      className="px-2 py-1 rounded text-[11px] border"
                      style={{
                        background: "var(--th-bg-surface-hover)",
                        borderColor: "var(--th-border-strong)",
                        color: "var(--th-text-heading)",
                      }}
                    >
                      {t({ en: "Edit", de: "Bearbeiten" })}
                    </button>
                    <button
                      onClick={() => onDelete(row)}
                      className="px-2 py-1 rounded text-[11px] bg-red-600/20 border border-red-500/30 text-red-300 hover:bg-red-600/30"
                    >
                      {t({ en: "Delete", de: "Löschen" })}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
        {t({
          en: "Messages starting with $ become company directives; normal messages go 1:1 to the selected agent.",
          de: "Nachrichten mit $ werden zu Unternehmensdirektiven; normale Nachrichten gehen 1:1 an den gewählten Agent.",
        })}
      </div>
    </div>
  );
}
