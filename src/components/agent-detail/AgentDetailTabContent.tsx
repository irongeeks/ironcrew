import { localeName, type UiLanguage } from "../../i18n";
import type { Agent, Department, SubAgent, SubTask, Task } from "../../types";
import { getSubAgentSpriteNum, SUBTASK_STATUS_ICON, taskStatusLabel, taskTypeLabel, type TFunction } from "./constants";

interface AgentDetailTabContentProps {
  tab: "info" | "tasks" | "alba";
  t: TFunction;
  language: UiLanguage;
  agent: Agent;
  departments: Department[];
  agentTasks: Task[];
  agentSubAgents: SubAgent[];
  subtasksByTask: Record<string, SubTask[]>;
  expandedTaskId: string | null;
  setExpandedTaskId: (taskId: string | null) => void;
  onChat: (agent: Agent) => void;
  onAssignTask: (agentId: string) => void;
  onOpenTerminal?: (taskId: string) => void;
}

export default function AgentDetailTabContent({
  tab,
  t,
  language,
  agent,
  departments,
  agentTasks,
  agentSubAgents,
  subtasksByTask,
  expandedTaskId,
  setExpandedTaskId,
  onChat,
  onAssignTask,
  onOpenTerminal,
}: AgentDetailTabContentProps) {
  if (tab === "info") {
    return (
      <div className="space-y-3">
        <div className="rounded-lg p-3" style={{ background: "var(--th-bg-surface-hover)" }}>
          <div className="text-xs mb-1" style={{ color: "var(--th-text-muted)" }}>
            {t({ ko: "성격", en: "Personality", ja: "性格", zh: "Personality", de: "Persönlichkeit" })}
          </div>
          <div className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {agent.personality ??
              t({ ko: "설정 없음", en: "Not set", ja: "未設定", zh: "Not set", de: "Nicht gesetzt" })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <div className="rounded-lg p-3 text-center" style={{ background: "var(--th-bg-surface-hover)" }}>
            <div className="text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
              {agentSubAgents.filter((subAgent) => subAgent.status === "working").length}
            </div>
            <div className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
              {t({ ko: "알바생", en: "Sub-agents", ja: "サブエージェント", zh: "Sub-agents", de: "Unteragenten" })}
            </div>
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={() => onChat(agent)}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{
              background: "var(--bg-glow)",
              border: "1px solid var(--border-strong)",
              color: "var(--th-text-primary)",
            }}
          >
            💬 {t({ ko: "대화하기", en: "Chat", ja: "チャット", zh: "Chat", de: "Chat" })}
          </button>
          <button
            onClick={() => onAssignTask(agent.id)}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{
              background: "var(--accent-subtle)",
              border: "1px solid var(--accent-dim)",
              color: "var(--accent)",
            }}
          >
            📋{" "}
            {t({ ko: "업무 배정", en: "Assign Task", ja: "タスク割り当て", zh: "Assign Task", de: "Aufgabe zuweisen" })}
          </button>
        </div>
        {agent.status === "working" && agent.current_task_id && onOpenTerminal && (
          <button
            onClick={() => onOpenTerminal(agent.current_task_id!)}
            className="w-full mt-2 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
            style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-primary)" }}
          >
            &#128421;{" "}
            {t({
              ko: "터미널 보기",
              en: "View Terminal",
              ja: "ターミナル表示",
              zh: "View Terminal",
              de: "Terminal anzeigen",
            })}
          </button>
        )}
      </div>
    );
  }

  if (tab === "tasks") {
    return (
      <div className="space-y-2">
        {agentTasks.length === 0 ? (
          <div className="text-center py-8 text-sm" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "배정된 업무가 없습니다",
              en: "No assigned tasks",
              ja: "割り当てられたタスクはありません",
              zh: "No assigned tasks",
              de: "Keine zugewiesenen Aufgaben",
            })}
          </div>
        ) : (
          agentTasks.map((taskItem) => {
            const taskSubtasks = subtasksByTask[taskItem.id] ?? [];
            const isExpanded = expandedTaskId === taskItem.id;
            const subTotal = taskItem.subtask_total ?? taskSubtasks.length;
            const subDone = taskItem.subtask_done ?? taskSubtasks.filter((subtask) => subtask.status === "done").length;
            return (
              <div key={taskItem.id} className="rounded-lg p-3" style={{ background: "var(--th-bg-surface-hover)" }}>
                <button
                  onClick={() => setExpandedTaskId(isExpanded ? null : taskItem.id)}
                  className="flex items-start gap-3 w-full text-left"
                >
                  <div
                    className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                      taskItem.status === "done"
                        ? "bg-green-500"
                        : taskItem.status === "in_progress"
                          ? "bg-blue-500"
                          : ""
                    }`}
                    style={
                      taskItem.status !== "done" && taskItem.status !== "in_progress"
                        ? { background: "rgba(113,113,122,0.8)" }
                        : undefined
                    }
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" style={{ color: "var(--th-text-heading)" }}>
                      {taskItem.title}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: "var(--th-text-muted)" }}>
                      {taskStatusLabel(taskItem.status, t)} · {taskTypeLabel(taskItem.task_type, t)}
                    </div>
                    {subTotal > 0 && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <div
                          className="flex-1 h-1 rounded-full overflow-hidden"
                          style={{ background: "var(--th-border-strong)" }}
                        >
                          <div
                            className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all"
                            style={{ width: `${Math.round((subDone / subTotal) * 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] whitespace-nowrap" style={{ color: "var(--th-text-secondary)" }}>
                          {subDone}/{subTotal}
                        </span>
                      </div>
                    )}
                  </div>
                </button>
                {isExpanded && taskSubtasks.length > 0 && (
                  <div className="mt-2 ml-5 space-y-1 border-l pl-2" style={{ borderColor: "var(--th-border-strong)" }}>
                    {taskSubtasks.map((subtask) => {
                      const targetDepartment = subtask.target_department_id
                        ? departments.find((department) => department.id === subtask.target_department_id)
                        : null;
                      return (
                        <div key={subtask.id} className="flex items-center gap-1.5 text-xs">
                          <span>{SUBTASK_STATUS_ICON[subtask.status] || "\u23F3"}</span>
                          <span
                            className={`flex-1 truncate`}
                            style={{
                              color: subtask.status === "done" ? "var(--th-text-muted)" : "var(--th-text-secondary)",
                              textDecoration: subtask.status === "done" ? "line-through" : undefined,
                            }}
                          >
                            {subtask.title}
                          </span>
                          {targetDepartment && (
                            <span
                              className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
                              style={{ backgroundColor: targetDepartment.color + "30", color: targetDepartment.color }}
                            >
                              {targetDepartment.icon} {localeName(language, targetDepartment)}
                            </span>
                          )}
                          {subtask.delegated_task_id && subtask.status !== "done" && (
                            <span
                              className="text-blue-400 shrink-0"
                              title={t({
                                ko: "위임됨",
                                en: "Delegated",
                                ja: "委任済み",
                                zh: "Delegated",
                                de: "Delegiert",
                              })}
                            >
                              🔗
                            </span>
                          )}
                          {subtask.status === "blocked" && subtask.blocked_reason && (
                            <span
                              className="text-red-400 text-[10px] truncate max-w-[80px]"
                              title={subtask.blocked_reason}
                            >
                              {subtask.blocked_reason}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {agentSubAgents.length === 0 ? (
        <div className="text-center py-8 text-sm" style={{ color: "var(--th-text-muted)" }}>
          <div className="text-3xl mb-2">🧑‍💼</div>
          {t({
            ko: "현재 알바생이 없습니다",
            en: "No sub-agents currently",
            ja: "現在サブエージェントはいません",
            zh: "No sub-agents currently",
            de: "Derzeit keine Unteragenten",
          })}
          <div className="text-xs mt-1" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "병렬 처리 시 자동으로 알바생이 소환됩니다",
              en: "Sub-agents are spawned automatically during parallel work.",
              ja: "並列処理時にサブエージェントが自動で生成されます。",
              zh: "Sub-agents are spawned automatically during parallel work.",
              de: "Unteragenten werden bei paralleler Arbeit automatisch gestartet.",
            })}
          </div>
        </div>
      ) : (
        agentSubAgents.map((subAgent) => (
          <div
            key={subAgent.id}
            className={`rounded-lg p-3 flex items-center gap-3 ${subAgent.status === "working" ? "animate-alba-spawn" : ""}`}
            style={{ background: "var(--th-bg-surface-hover)" }}
          >
            <div className="w-8 h-8 rounded-full bg-amber-500/20 overflow-hidden flex items-center justify-center">
              <img
                src={`/sprites/${getSubAgentSpriteNum(subAgent.id)}-D-1.png`}
                alt={t({ ko: "알바생", en: "Sub-agent", ja: "サブエージェント", zh: "Sub-agent", de: "Unteragent" })}
                className="w-full h-full object-cover"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate flex items-center gap-1.5" style={{ color: "var(--th-text-heading)" }}>
                <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400">
                  {t({ ko: "알바", en: "Sub", ja: "サブ", zh: "Sub", de: "Sub" })}
                </span>
                {subAgent.task}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--th-text-muted)" }}>
                {subAgent.status === "working"
                  ? `🔨 ${t({ ko: "작업중...", en: "Working...", ja: "作業中...", zh: "Working...", de: "Aktiv..." })}`
                  : `✅ ${t({ ko: "완료", en: "Done", ja: "完了", zh: "Done", de: "Erledigt" })}`}
              </div>
            </div>
            {subAgent.status === "working" && (
              <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            )}
          </div>
        ))
      )}
    </div>
  );
}
