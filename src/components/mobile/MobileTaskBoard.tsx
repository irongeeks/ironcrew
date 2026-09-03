import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { Agent, Department, SubTask, Task, TaskStatus, WorkflowPackKey } from "../../types";
import CreateTaskModal from "../taskboard/CreateTaskModal";
import { COLUMNS, taskStatusLabel, priorityIcon } from "../taskboard/constants";
import { approvePhase } from "../../api/workflow-skills-subtasks";

interface MobileTaskBoardProps {
  activePackKey?: WorkflowPackKey;
  tasks: Task[];
  agents: Agent[];
  departments: Department[];
  subtasks: SubTask[];
  onCreateTask: (input: {
    title: string;
    description?: string;
    department_id?: string;
    task_type?: string;
    priority?: number;
    project_id?: string;
    project_path?: string;
    assigned_agent_id?: string;
    workflow_pack_key?: WorkflowPackKey;
  }) => void;
  onUpdateTask: (id: string, data: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onAssignTask: (taskId: string, agentId: string) => void;
  onRunTask: (id: string) => void;
  onStopTask: (id: string) => void;
  onPauseTask?: (id: string) => void;
  onResumeTask?: (id: string) => void;
  onOpenTerminal?: (taskId: string) => void;
  onOpenMeetingMinutes?: (taskId: string) => void;
  onMergeTask?: (id: string) => void;
  onDiscardTask?: (id: string) => void;
}

export function MobileTaskBoard({
  tasks,
  agents,
  departments,
  subtasks,
  onCreateTask,
  onAssignTask,
  onOpenTerminal,
  activePackKey,
}: MobileTaskBoardProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TaskStatus>("inbox");
  const [showCreate, setShowCreate] = useState(false);
  const [approvingPhase, setApprovingPhase] = useState<string | null>(null);

  const subtasksByTask = useMemo(() => {
    const map = new Map<string, SubTask[]>();
    for (const s of subtasks) {
      const list = map.get(s.task_id) ?? [];
      list.push(s);
      map.set(s.task_id, list);
    }
    return map;
  }, [subtasks]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const visibleTasks = useMemo(() => tasks.filter((task) => task.hidden !== 1), [tasks]);

  const countByStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const col of COLUMNS) counts[col.status] = 0;
    for (const task of visibleTasks) {
      if (counts[task.status] !== undefined) counts[task.status]++;
    }
    return counts;
  }, [visibleTasks]);

  const filteredTasks = useMemo(
    () =>
      visibleTasks
        .filter((task) => task.status === activeTab)
        .sort((a, b) => b.priority - a.priority || b.created_at - a.created_at),
    [visibleTasks, activeTab],
  );

  const handleCreateClick = () => {
    setShowCreate(true);
  };

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--bg-base)" }}>
      {/* Header with + New button */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h1
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 10,
            color: "var(--text-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {t({ ko: "업무 보드", en: "Task Board", ja: "タスクボード", zh: "Task Board", de: "Aufgaben-Board" })}
        </h1>
        <button
          onClick={handleCreateClick}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow active:scale-95"
        >
          + {t({ ko: "새 작업", en: "New Task", ja: "新規タスク", zh: "New Task", de: "Neue Aufgabe" })}
        </button>
      </div>

      {/* Status tabs - wrapping grid so all pills are visible without scrolling */}
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        {COLUMNS.map((col) => {
          const isActive = activeTab === col.status;
          const count = countByStatus[col.status] ?? 0;
          return (
            <button
              key={col.status}
              onClick={() => setActiveTab(col.status)}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition-colors"
              style={{
                background: isActive ? `${col.color}22` : "var(--th-card-bg)",
                color: isActive ? col.color : "var(--th-text-secondary)",
                border: isActive ? `1px solid ${col.color}66` : "1px solid transparent",
              }}
            >
              <span>{taskStatusLabel(col.status, t)}</span>
              <span
                className="rounded-full px-1 py-0.5 text-[10px] font-bold"
                style={{
                  background: isActive ? `${col.color}33` : "var(--th-card-bg)",
                  color: isActive ? col.color : "var(--th-text-muted)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {filteredTasks.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-2 py-16 text-center"
            style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}
          >
            <span
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 14,
                color: "var(--text-primary)",
                letterSpacing: "0.04em",
              }}
            >
              {t({
                ko: "아직 작업이 없습니다",
                en: "No tasks yet",
                ja: "タスクがありません",
                zh: "暂无任务",
                de: "Noch keine Aufgaben",
              })}
            </span>
            <span style={{ fontSize: 12, maxWidth: 260, lineHeight: 1.5 }}>
              {t({
                ko: "첫 작업을 만들어 AI 에이전트 팀에 위임하세요.",
                en: "Create your first task and delegate it to your AI agent team.",
                ja: "最初のタスクを作成してAIエージェントチームに委任しましょう。",
                zh: "创建您的第一个任务,并将其委托给 AI 代理团队。",
                de: "Erstelle deine erste Aufgabe und übergib sie an dein KI-Agenten-Team.",
              })}
            </span>
            <button
              onClick={handleCreateClick}
              className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow active:scale-95"
              style={{ minHeight: 44 }}
            >
              + {t({ ko: "새 작업", en: "New Task", ja: "新規タスク", zh: "New Task", de: "Neue Aufgabe" })}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredTasks.map((task) => {
              const agent = task.assigned_agent_id ? agentMap.get(task.assigned_agent_id) : undefined;
              return (
                <div
                  key={task.id}
                  onClick={() => onOpenTerminal?.(task.id)}
                  role="button"
                  tabIndex={0}
                  className="w-full rounded-xl p-3 text-left transition-colors active:scale-[0.98]"
                  style={{
                    background: "var(--th-card-bg)",
                    border: "1px solid var(--th-border)",
                    cursor: "pointer",
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className="line-clamp-2 text-sm font-medium"
                      style={{ color: "var(--th-text-primary)", fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {task.title}
                    </span>
                    <span className="flex-shrink-0 text-xs">{priorityIcon(task.priority)}</span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    {agent && (
                      <span
                        className="truncate rounded-md px-1.5 py-0.5 text-[10px]"
                        style={{
                          background: "var(--bg-surface)",
                          color: "var(--th-text-secondary)",
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {agent.name}
                      </span>
                    )}
                    {task.task_type && task.task_type !== "general" && (
                      <span
                        className="truncate rounded-md px-1.5 py-0.5 text-[10px]"
                        style={{
                          background: "var(--bg-surface)",
                          color: "var(--th-text-muted)",
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {task.task_type}
                      </span>
                    )}
                    {task.subtask_total != null && task.subtask_total > 0 && (
                      <span
                        className="ml-auto text-[10px]"
                        style={{ color: "var(--th-text-muted)", fontFamily: "'JetBrains Mono', monospace" }}
                      >
                        {task.subtask_done ?? 0}/{task.subtask_total}
                      </span>
                    )}
                  </div>

                  {/* Phase approval buttons */}
                  {(() => {
                    const taskSubs = subtasksByTask.get(task.id) ?? [];
                    const awaitingPhases = taskSubs
                      .filter((s) => s.status === "awaiting_approval" && /^\[pipeline:/.test(s.title))
                      .map((s) => {
                        const match = s.title.match(/^\[pipeline:([^\]]+)\]/);
                        return match ? { subtask: s, phaseId: match[1] } : null;
                      })
                      .filter(Boolean) as Array<{ subtask: SubTask; phaseId: string }>;

                    if (awaitingPhases.length === 0) return null;

                    return (
                      <div className="mt-2 flex flex-col gap-1.5">
                        {awaitingPhases.map(({ phaseId }) => (
                          <button
                            key={phaseId}
                            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white transition active:scale-[0.97] disabled:opacity-50"
                            style={{ minHeight: 44 }}
                            disabled={approvingPhase === phaseId}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setApprovingPhase(phaseId);
                              try {
                                await approvePhase(task.id, phaseId);
                              } catch (err) {
                                console.error("Phase approval failed:", err);
                              } finally {
                                setApprovingPhase(null);
                              }
                            }}
                          >
                            {approvingPhase === phaseId
                              ? t({
                                  ko: "승인 중...",
                                  en: "Approving...",
                                  ja: "承認中...",
                                  zh: "审批中...",
                                  de: "Genehmige...",
                                })
                              : t({
                                  ko: `✅ ${phaseId} 승인`,
                                  en: `✅ Approve ${phaseId}`,
                                  ja: `✅ ${phaseId} を承認`,
                                  zh: `✅ 批准 ${phaseId}`,
                                  de: `✅ ${phaseId} genehmigen`,
                                })}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateTaskModal
          agents={agents}
          departments={departments}
          activePackKey={activePackKey}
          onClose={() => setShowCreate(false)}
          onCreate={(input) => {
            onCreateTask(input);
            setShowCreate(false);
          }}
          onAssign={onAssignTask}
        />
      )}
    </div>
  );
}

export default MobileTaskBoard;
