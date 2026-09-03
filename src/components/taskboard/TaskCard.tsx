import { useEffect, useState } from "react";
import type { Agent, Department, SubTask, Task, TaskStatus } from "../../types";
import { useI18n } from "../../i18n";
import AgentAvatar from "../AgentAvatar";
import AgentSelect from "../AgentSelect";
import DiffModal from "./DiffModal";
import {
  getTaskTypeBadge,
  isHideableStatus,
  priorityIcon,
  priorityLabel,
  STATUS_OPTIONS,
  taskStatusLabel,
  timeAgo,
} from "./constants";
import { approvePhase, resetPhase, resetPipelineFrom } from "../../api/workflow-skills-subtasks";

interface TaskCardProps {
  task: Task;
  agents: Agent[];
  departments: Department[];
  taskSubtasks: SubTask[];
  isHiddenTask?: boolean;
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
  onHideTask?: (id: string) => void;
  onUnhideTask?: (id: string) => void;
}

const SUBTASK_STATUS_ICON: Record<string, string> = {
  pending: "\u23F3",
  in_progress: "\uD83D\uDD28",
  done: "\u2705",
  blocked: "\uD83D\uDEAB",
  awaiting_approval: "\u23F8\uFE0F",
  skipped: "\u23ED\uFE0F",
};

export default function TaskCard({
  task,
  agents,
  departments,
  taskSubtasks,
  isHiddenTask,
  onUpdateTask,
  onDeleteTask,
  onAssignTask,
  onRunTask,
  onStopTask,
  onPauseTask,
  onResumeTask,
  onOpenTerminal,
  onOpenMeetingMinutes,
  onMergeTask,
  onDiscardTask,
  onHideTask,
  onUnhideTask,
}: TaskCardProps) {
  void onMergeTask;
  void onDiscardTask;
  const { t, locale: localeTag, language: locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showSubtasks, setShowSubtasks] = useState(false);
  const [autoExpandedForApproval, setAutoExpandedForApproval] = useState(false);
  const [agentWarning, setAgentWarning] = useState(false);
  const [approvingPhase, setApprovingPhase] = useState<string | null>(null);

  const assignedAgent = task.assigned_agent ?? agents.find((agent) => agent.id === task.assigned_agent_id);
  const fallbackAssignedName =
    (locale === "ko" ? task.agent_name_ko || task.agent_name : task.agent_name || task.agent_name_ko) ||
    task.assigned_agent_id;
  const assignedDisplayName = assignedAgent ? (locale === "ko" ? assignedAgent.name_ko : assignedAgent.name) : null;
  const assignedLabel = assignedDisplayName || fallbackAssignedName || null;
  const department = departments.find((d) => d.id === task.department_id);
  const typeBadge = getTaskTypeBadge(task.task_type, t);

  const hasPhaseAwaitingApproval = taskSubtasks.some(
    (s) => s.status === "awaiting_approval" && /^\[pipeline:/.test(s.title),
  );
  const canRun = (task.status === "planned" || task.status === "inbox") && !hasPhaseAwaitingApproval;

  // Auto-expand subtasks when a phase is awaiting approval
  useEffect(() => {
    if (hasPhaseAwaitingApproval && !showSubtasks && !autoExpandedForApproval) {
      setShowSubtasks(true);
      setAutoExpandedForApproval(true);
    }
    if (!hasPhaseAwaitingApproval && autoExpandedForApproval) {
      setAutoExpandedForApproval(false);
    }
  }, [hasPhaseAwaitingApproval, showSubtasks, autoExpandedForApproval]);
  const canStop = task.status === "in_progress";
  const canPause = task.status === "in_progress" && !!onPauseTask;
  const canResume = (task.status === "pending" || task.status === "cancelled") && !!onResumeTask;
  const canDelete = task.status !== "in_progress";
  const canHideTask = isHideableStatus(task.status);

  return (
    <div
      className={`group rounded-lg border p-3 transition ${
        isHiddenTask ? "border-cyan-700/80 hover:border-cyan-600" : ""
      }`}
      style={{
        background: "var(--bg-surface)",
        borderColor: isHiddenTask ? undefined : "var(--border)",
        transition: "background 0.15s, border-color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "var(--bg-surface-hover)";
        (e.currentTarget as HTMLDivElement).style.borderColor = isHiddenTask ? "" : "var(--border-strong)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "var(--bg-surface)";
        (e.currentTarget as HTMLDivElement).style.borderColor = isHiddenTask ? "" : "var(--border)";
      }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left font-semibold leading-snug"
          style={{ color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
        >
          {task.title}
        </button>
        <span
          className="flex-shrink-0 text-base"
          title={`${t({ ko: "우선순위", en: "Priority", ja: "優先度", zh: "Priority", de: "Priorität" })}: ${priorityLabel(task.priority, t)}`}
        >
          {priorityIcon(task.priority)}
        </span>
      </div>

      {task.description && (
        <p
          className={`mb-2 text-xs leading-relaxed ${expanded ? "" : "line-clamp-2"}`}
          style={{ color: "var(--th-text-secondary)" }}
        >
          {task.description}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge.color}`}>{typeBadge.label}</span>
        {isHiddenTask && (
          <span className="rounded-full bg-cyan-900/60 px-2 py-0.5 text-xs text-cyan-200">
            🙈 {t({ ko: "숨김", en: "Hidden", ja: "非表示", zh: "Hidden", de: "Ausgeblendet" })}
          </span>
        )}
        {department && (
          <span
            className="rounded-full px-2 py-0.5 text-xs"
            style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
          >
            {department.icon} {locale === "ko" ? department.name_ko : department.name}
          </span>
        )}
      </div>

      <div className="mb-3">
        <select
          value={task.status}
          onChange={(event) => onUpdateTask(task.id, { status: event.target.value as TaskStatus })}
          className="min-h-10 w-full rounded-lg border px-2 py-1.5 text-xs outline-none transition focus:border-blue-500"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        >
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {taskStatusLabel(status as TaskStatus, t)}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {assignedAgent && assignedLabel ? (
            <>
              <AgentAvatar agent={assignedAgent} agents={agents} size={20} />
              <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {assignedLabel}
              </span>
            </>
          ) : assignedLabel ? (
            <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {assignedLabel}
            </span>
          ) : (
            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({ ko: "미배정", en: "Unassigned", ja: "未割り当て", zh: "Unassigned", de: "Nicht zugewiesen" })}
            </span>
          )}
        </div>
        <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
          {timeAgo(task.created_at, localeTag)}
        </span>
      </div>

      <div
        className={`mb-3 rounded-lg transition-all ${agentWarning ? "ring-2 ring-red-500 animate-[shake_0.4s_ease-in-out]" : ""}`}
      >
        <AgentSelect
          agents={agents}
          departments={departments}
          value={task.assigned_agent_id ?? ""}
          placeholder={
            assignedAgent || !assignedLabel
              ? undefined
              : t({
                  ko: `배정됨(숨김): ${assignedLabel}`,
                  en: `Assigned (hidden): ${assignedLabel}`,
                  ja: `割り当て済み(非表示): ${assignedLabel}`,
                  zh: `Assigned (hidden): ${assignedLabel}`,
                  de: `Zugewiesen (ausgeblendet): ${assignedLabel}`,
                })
          }
          onChange={(agentId) => {
            setAgentWarning(false);
            if (agentId) {
              onAssignTask(task.id, agentId);
            } else {
              onUpdateTask(task.id, { assigned_agent_id: null });
            }
          }}
        />
        {agentWarning && (
          <p className="mt-1 text-xs font-medium text-red-400 animate-[shake_0.4s_ease-in-out]">
            {t({
              ko: "담당자를 배정해주세요!",
              en: "Please assign an agent!",
              ja: "担当者を割り当ててください！",
              zh: "Please assign an agent!",
              de: "Bitte weisen Sie einen Agent zu!",
            })}
          </p>
        )}
      </div>

      {(task.subtask_total ?? 0) > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setShowSubtasks((v) => !v)}
            className="mb-1.5 flex w-full items-center gap-2 text-left"
          >
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--th-card-border)" }}>
              <div
                className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all"
                style={{ width: `${Math.round(((task.subtask_done ?? 0) / (task.subtask_total ?? 1)) * 100)}%` }}
              />
            </div>
            <span className="text-xs whitespace-nowrap" style={{ color: "var(--th-text-secondary)" }}>
              {task.subtask_done ?? 0}/{task.subtask_total ?? 0}
            </span>
            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {showSubtasks ? "▲" : "▼"}
            </span>
          </button>
          {showSubtasks && taskSubtasks.length > 0 && (
            <div className="space-y-1.5">
              {taskSubtasks.map((subtask) => {
                const targetDepartment = subtask.target_department_id
                  ? departments.find((departmentItem) => departmentItem.id === subtask.target_department_id)
                  : null;
                const isAwaitingApproval = subtask.status === "awaiting_approval";
                // Extract phase ID from title like [pipeline:phase_id] or [pipeline:phase_id:N]
                const phaseMatch = subtask.title.match(/^\[pipeline:([^\]]+)\]/);
                const rawPhaseId = phaseMatch ? phaseMatch[1] : null;
                // For approval/reset, use the raw ID (including fan-out index for single reset)
                const phaseId = rawPhaseId;
                // For reset-from, strip fan-out index to target the logical phase
                const basePhaseId = rawPhaseId?.includes(":") ? rawPhaseId.split(":")[0] : rawPhaseId;
                const canReset =
                  phaseId && (subtask.status === "done" || subtask.status === "in_progress" || isAwaitingApproval);

                return (
                  <div
                    key={subtask.id}
                    className="rounded-lg border p-2"
                    style={{
                      borderColor: isAwaitingApproval
                        ? "rgba(245, 158, 11, 0.4)"
                        : subtask.status === "in_progress"
                          ? "var(--th-accent, rgba(96, 165, 250, 0.3))"
                          : "var(--th-border)",
                      background: isAwaitingApproval
                        ? "rgba(245, 158, 11, 0.08)"
                        : subtask.status === "in_progress"
                          ? "rgba(96, 165, 250, 0.06)"
                          : "rgba(255, 255, 255, 0.02)",
                    }}
                  >
                    {/* Status + Title row */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{SUBTASK_STATUS_ICON[subtask.status] || "\u23F3"}</span>
                      <span
                        className={`flex-1 text-xs font-medium ${subtask.status === "done" || subtask.status === "skipped" ? "line-through" : ""}`}
                        style={{
                          color:
                            subtask.status === "done" || subtask.status === "skipped"
                              ? "var(--th-text-muted)"
                              : isAwaitingApproval
                                ? "#f59e0b"
                                : subtask.status === "in_progress"
                                  ? "var(--th-text-primary)"
                                  : "var(--th-text-secondary)",
                        }}
                      >
                        {subtask.title}
                      </span>
                    </div>

                    {/* Badges row */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
                      {isAwaitingApproval && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 bg-amber-500/20">
                          {t({
                            ko: "승인 대기",
                            en: "Awaiting Approval",
                            ja: "承認待ち",
                            zh: "待批准",
                            de: "Genehmigung ausstehend",
                          })}
                        </span>
                      )}
                      {targetDepartment && !isAwaitingApproval && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ backgroundColor: targetDepartment.color + "30", color: targetDepartment.color }}
                        >
                          {targetDepartment.icon} {targetDepartment.name_ko}
                        </span>
                      )}
                      {subtask.delegated_task_id && subtask.status !== "done" && !isAwaitingApproval && (
                        <span
                          className="text-blue-400"
                          title={t({ ko: "위임됨", en: "Delegated", ja: "委任済み", zh: "Delegated", de: "Delegiert" })}
                        >
                          🔗
                        </span>
                      )}
                      {subtask.status === "blocked" && subtask.blocked_reason && (
                        <span
                          className="text-red-400 text-[10px] truncate max-w-[120px]"
                          title={subtask.blocked_reason}
                        >
                          {subtask.blocked_reason}
                        </span>
                      )}
                    </div>

                    {/* Action buttons */}
                    {(isAwaitingApproval || canReset) && phaseId && (
                      <div className="mt-2 flex gap-1.5 pl-6">
                        {isAwaitingApproval && (
                          <button
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-green-600 px-2 py-1.5 text-xs font-semibold text-white transition hover:bg-green-500 disabled:opacity-60"
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
                                  ko: "✅ 승인 & 계속",
                                  en: "✅ Approve & Continue",
                                  ja: "✅ 承認して続行",
                                  zh: "✅ 批准并继续",
                                  de: "✅ Genehmigen & Weiter",
                                })}
                          </button>
                        )}
                        {canReset && (
                          <>
                            <button
                              className="rounded-md px-2 py-1.5 text-[10px] font-medium transition hover:bg-orange-600/30"
                              style={{ color: "var(--th-text-muted)" }}
                              title={t({
                                ko: "이 단계만 재실행",
                                en: "Reset this phase only",
                                ja: "このフェーズのみリセット",
                                zh: "仅重置此阶段",
                                de: "Nur diese Phase zurücksetzen",
                              })}
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await resetPhase(task.id, phaseId);
                                } catch (err) {
                                  console.error("Phase reset failed:", err);
                                }
                              }}
                            >
                              {t({ ko: "↩ 재실행", en: "↩ Redo", ja: "↩ やり直し", zh: "↩ 重做", de: "↩ Wiederholen" })}
                            </button>
                            <button
                              className="rounded-md px-2 py-1.5 text-[10px] font-medium text-orange-300/80 transition hover:bg-orange-600/30"
                              title={t({
                                ko: "이 단계 + 이후 단계 모두 초기화",
                                en: "Reset this phase and all following phases",
                                ja: "このフェーズ以降を全てリセット",
                                zh: "重置此阶段及所有后续阶段",
                                de: "Diese und alle folgenden Phasen zurücksetzen",
                              })}
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await resetPipelineFrom(task.id, basePhaseId!);
                                } catch (err) {
                                  console.error("Phase reset failed:", err);
                                }
                              }}
                            >
                              {t({
                                ko: "↩ 이후 전부 재실행",
                                en: "↩ Redo all following",
                                ja: "↩ 以降すべてやり直し",
                                zh: "↩ 重做所有后续",
                                de: "↩ Alle folgenden wiederholen",
                              })}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {canRun && (
          <button
            onClick={() => {
              if (!task.assigned_agent_id) {
                setAgentWarning(true);
                setTimeout(() => setAgentWarning(false), 3000);
                return;
              }
              onRunTask(task.id);
            }}
            title={t({ ko: "작업 실행", en: "Run task", ja: "タスク実行", zh: "Run task", de: "Aufgabe ausführen" })}
            className="flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg bg-green-700 px-2 py-2 text-xs font-medium text-white transition hover:bg-green-600"
          >
            ▶ {t({ ko: "실행", en: "Run", ja: "実行", zh: "Run", de: "Ausführen" })}
          </button>
        )}
        {canPause && (
          <button
            onClick={() => onPauseTask!(task.id)}
            title={t({
              ko: "작업 일시중지",
              en: "Pause task",
              ja: "タスク一時停止",
              zh: "Pause task",
              de: "Aufgabe pausieren",
            })}
            className="flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg bg-orange-700 px-2 py-2 text-xs font-medium text-white transition hover:bg-orange-600"
          >
            ⏸ {t({ ko: "일시중지", en: "Pause", ja: "一時停止", zh: "Pause", de: "Pause" })}
          </button>
        )}
        {canStop && (
          <button
            onClick={() => {
              if (
                confirm(
                  t({
                    ko: `"${task.title}" 작업을 중지할까요?\n\n경고: Stop 처리 시 해당 프로젝트 변경분은 롤백됩니다.`,
                    en: `Stop "${task.title}"?\n\nWarning: stopping will roll back project changes.`,
                    ja: `「${task.title}」を停止しますか？\n\n警告: 停止するとプロジェクトの変更はロールバックされます。`,
                    zh: `Stop "${task.title}"?\n\nWarning: stopping will roll back project changes.`,
                    de: `„${task.title}" stoppen?\n\nWarnung: Das Stoppen setzt Projektänderungen zurück.`,
                  }),
                )
              ) {
                onStopTask(task.id);
              }
            }}
            title={t({
              ko: "작업 중지",
              en: "Cancel task",
              ja: "タスク停止",
              zh: "Cancel task",
              de: "Aufgabe abbrechen",
            })}
            className="flex min-h-10 items-center justify-center gap-1 rounded-lg bg-red-800 px-2 py-2 text-xs font-medium text-white transition hover:bg-red-700"
          >
            ⏹ {t({ ko: "중지", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
          </button>
        )}
        {canResume && (
          <button
            onClick={() => onResumeTask!(task.id)}
            title={t({
              ko: "작업 재개",
              en: "Resume task",
              ja: "タスク再開",
              zh: "Resume task",
              de: "Aufgabe fortsetzen",
            })}
            className="flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg bg-blue-700 px-2 py-2 text-xs font-medium text-white transition hover:bg-blue-600"
          >
            ↩ {t({ ko: "재개", en: "Resume", ja: "再開", zh: "Resume", de: "Fortsetzen" })}
          </button>
        )}
        {(task.status === "in_progress" ||
          task.status === "review" ||
          task.status === "done" ||
          task.status === "pending") &&
          onOpenTerminal && (
            <button
              onClick={() => onOpenTerminal(task.id)}
              title={t({
                ko: "터미널 출력 보기",
                en: "View terminal output",
                ja: "ターミナル出力を見る",
                zh: "View terminal output",
                de: "Terminal-Ausgabe anzeigen",
              })}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-[var(--bg-surface)] px-2.5 py-2 text-xs font-medium text-[var(--text-primary)] transition hover:bg-slate-600 hover:text-white"
            >
              <span className="text-sm">🖥</span>
              {t({ ko: "로그", en: "Log", ja: "ログ", zh: "Log", de: "Log" })}
            </button>
          )}
        {(task.status === "planned" ||
          task.status === "collaborating" ||
          task.status === "in_progress" ||
          task.status === "review" ||
          task.status === "done" ||
          task.status === "pending") &&
          onOpenMeetingMinutes && (
            <button
              onClick={() => onOpenMeetingMinutes(task.id)}
              title={t({
                ko: "회의록 보기",
                en: "View meeting minutes",
                ja: "会議録を見る",
                zh: "View meeting minutes",
                de: "Protokoll anzeigen",
              })}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-cyan-800 px-2.5 py-2 text-xs font-medium text-cyan-100 transition hover:bg-cyan-700 hover:text-white"
            >
              <span className="text-sm">📝</span>
              {t({ ko: "메모", en: "Notes", ja: "メモ", zh: "Notes", de: "Notizen" })}
            </button>
          )}
        {task.status === "review" && (
          <>
            <button
              onClick={() => onRunTask(task.id)}
              title={t({
                ko: "승인하고 다음 단계로",
                en: "Approve & Continue",
                ja: "承認して次へ",
                zh: "Approve & Continue",
                de: "Genehmigen & Weiter",
              })}
              className="flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg bg-green-700 px-2.5 py-2 text-xs font-medium text-white transition hover:bg-green-600"
            >
              {t({ ko: "승인", en: "Approve", ja: "承認", zh: "Approve", de: "Genehmigen" })}
            </button>
            <button
              onClick={() => setShowDiff(true)}
              title={t({
                ko: "변경사항 보기 (Git diff)",
                en: "View changes (Git diff)",
                ja: "変更を見る (Git diff)",
                zh: "View changes (Git diff)",
                de: "Änderungen anzeigen (Git diff)",
              })}
              className="flex min-h-10 items-center justify-center gap-1 rounded-lg bg-purple-800 px-2.5 py-2 text-xs font-medium text-purple-200 transition hover:bg-purple-700"
            >
              {t({ ko: "Diff", en: "Diff", ja: "差分", zh: "Diff", de: "Diff" })}
            </button>
          </>
        )}
        {canHideTask && !isHiddenTask && onHideTask && (
          <button
            onClick={() => onHideTask(task.id)}
            title={t({
              ko: "완료/보류/취소 작업 숨기기",
              en: "Hide done/pending/cancelled task",
              ja: "完了/保留/キャンセルのタスクを非表示",
              zh: "Hide done/pending/cancelled task",
              de: "Erledigte/Ausstehende/Abgebrochene Aufgabe ausblenden",
            })}
            className="flex min-h-10 items-center justify-center gap-1 rounded-lg bg-[var(--bg-surface)] px-2.5 py-2 text-xs text-[var(--text-primary)] transition hover:bg-slate-600"
          >
            🙈 {t({ ko: "숨김", en: "Hide", ja: "非表示", zh: "Hide", de: "Ausblenden" })}
          </button>
        )}
        {canHideTask && !!isHiddenTask && onUnhideTask && (
          <button
            onClick={() => onUnhideTask(task.id)}
            title={t({
              ko: "숨긴 작업 복원",
              en: "Restore hidden task",
              ja: "非表示タスクを復元",
              zh: "Restore hidden task",
              de: "Ausgeblendete Aufgabe wiederherstellen",
            })}
            className="flex min-h-10 items-center justify-center gap-1 rounded-lg bg-blue-800 px-2.5 py-2 text-xs text-blue-200 transition hover:bg-blue-700 hover:text-white"
          >
            👁 {t({ ko: "복원", en: "Restore", ja: "復元", zh: "Restore", de: "Wiederherstellen" })}
          </button>
        )}
        {canDelete && (
          <button
            onClick={() => {
              if (
                confirm(
                  t({
                    ko: `"${task.title}" 업무를 삭제할까요?`,
                    en: `Delete "${task.title}"?`,
                    ja: `「${task.title}」を削除しますか？`,
                    zh: `Delete "${task.title}"?`,
                    de: `„${task.title}" löschen?`,
                  }),
                )
              )
                onDeleteTask(task.id);
            }}
            title={t({
              ko: "작업 삭제",
              en: "Delete task",
              ja: "タスク削除",
              zh: "Delete task",
              de: "Aufgabe löschen",
            })}
            className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-red-800 bg-transparent px-2.5 py-2 text-xs font-medium text-red-400 transition hover:border-red-600 hover:bg-red-900 hover:text-red-200"
          >
            <span className="text-sm">🗑</span>
            {t({ ko: "삭제", en: "Delete", ja: "削除", zh: "删除", de: "Löschen" })}
          </button>
        )}
      </div>

      {showDiff && <DiffModal taskId={task.id} onClose={() => setShowDiff(false)} />}
    </div>
  );
}
