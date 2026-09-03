import { useCallback, useMemo, useState } from "react";
import { bulkHideTasks } from "../api";
import { useMobile } from "../hooks/useMobile";
import { useI18n } from "../i18n";
import type { Agent, Department, SubTask, Task, WorkflowPackKey } from "../types";
import MobileTaskBoard from "./mobile/MobileTaskBoard";
import ProjectManagerModal from "./ProjectManagerModal";
import BulkHideModal from "./taskboard/BulkHideModal";
import CreateTaskModal from "./taskboard/CreateTaskModal";
import FilterBar from "./taskboard/FilterBar";
import TaskCard from "./taskboard/TaskCard";
import { COLUMNS, isHideableStatus, taskStatusLabel, type HideableStatus } from "./taskboard/constants";

interface TaskBoardProps {
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

export function TaskBoard(props: TaskBoardProps) {
  const {
    activePackKey,
    tasks,
    agents,
    departments,
    subtasks,
    onCreateTask,
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
  } = props;

  const { isMobile } = useMobile();
  const { t } = useI18n();

  const [showCreate, setShowCreate] = useState(false);
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showBulkHideModal, setShowBulkHideModal] = useState(false);
  const [filterDept, setFilterDept] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterType, setFilterType] = useState("");
  const [search, setSearch] = useState("");
  const [showAllTasks, setShowAllTasks] = useState(false);

  const hiddenTaskIds = useMemo(
    () => new Set(tasks.filter((task) => task.hidden === 1).map((task) => task.id)),
    [tasks],
  );

  const hideTask = useCallback(
    (taskId: string) => {
      onUpdateTask(taskId, { hidden: 1 });
    },
    [onUpdateTask],
  );

  const unhideTask = useCallback(
    (taskId: string) => {
      onUpdateTask(taskId, { hidden: 0 });
    },
    [onUpdateTask],
  );

  const hideByStatuses = useCallback((statuses: HideableStatus[]) => {
    if (statuses.length === 0) return;
    bulkHideTasks(statuses, 1);
  }, []);

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (filterDept && task.department_id !== filterDept) return false;
      if (filterAgent && task.assigned_agent_id !== filterAgent) return false;
      if (filterType && task.task_type !== filterType) return false;
      if (search && !task.title.toLowerCase().includes(search.toLowerCase())) return false;
      const isHidden = hiddenTaskIds.has(task.id);
      if (!showAllTasks && isHidden) return false;
      return true;
    });
  }, [tasks, filterDept, filterAgent, filterType, search, hiddenTaskIds, showAllTasks]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    for (const column of COLUMNS) {
      grouped[column.status] = filteredTasks
        .filter((task) => task.status === column.status)
        .sort((a, b) => b.priority - a.priority || b.created_at - a.created_at);
    }
    return grouped;
  }, [filteredTasks]);

  const subtasksByTask = useMemo(() => {
    const grouped: Record<string, SubTask[]> = {};
    for (const subtask of subtasks) {
      if (!grouped[subtask.task_id]) grouped[subtask.task_id] = [];
      grouped[subtask.task_id].push(subtask);
    }
    return grouped;
  }, [subtasks]);

  const activeFilterCount = [filterDept, filterAgent, filterType, search].filter(Boolean).length;
  const hiddenTaskCount = useMemo(() => {
    let count = 0;
    for (const task of tasks) {
      if (isHideableStatus(task.status) && hiddenTaskIds.has(task.id)) count++;
    }
    return count;
  }, [tasks, hiddenTaskIds]);

  if (isMobile) return <MobileTaskBoard {...props} />;

  return (
    <div className="taskboard-shell flex h-full flex-col gap-4 p-3 sm:p-4" style={{ background: "var(--bg-base)" }}>
      <div className="flex flex-wrap items-center gap-3">
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
        <span
          className="rounded-full px-2.5 py-0.5 text-xs"
          style={{ background: "var(--th-card-bg)", color: "var(--th-text-secondary)" }}
        >
          {t({ ko: "총", en: "Total", ja: "合計", zh: "Total", de: "Gesamt" })} {filteredTasks.length}
          {t({ ko: "개", en: "", ja: "件", zh: "", de: "" })}
          {activeFilterCount > 0 &&
            ` (${t({ ko: "필터", en: "filters", ja: "フィルター", zh: "filters", de: "Filter" })} ${activeFilterCount}${t(
              {
                ko: "개 적용",
                en: " applied",
                ja: "件適用",
                zh: " applied",
                de: " angewendet",
              },
            )})`}
        </span>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {activeFilterCount > 0 && (
            <button
              onClick={() => {
                setFilterDept("");
                setFilterAgent("");
                setFilterType("");
                setSearch("");
              }}
              className="min-h-10 rounded-lg border px-3 py-2 text-xs transition hover:text-white"
              style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            >
              {t({
                ko: "필터 초기화",
                en: "Reset Filters",
                ja: "フィルターをリセット",
                zh: "Reset Filters",
                de: "Filter zurücksetzen",
              })}
            </button>
          )}
          <button
            onClick={() => setShowAllTasks((prev) => !prev)}
            className={`min-h-10 rounded-lg border px-3 py-2 text-xs transition ${
              showAllTasks ? "border-cyan-600 bg-cyan-900/40 text-cyan-100 hover:bg-cyan-900/60" : "hover:text-white"
            }`}
            title={
              showAllTasks
                ? t({
                    ko: "진행중 보기로 전환 (숨김 제외)",
                    en: "Switch to active view (exclude hidden)",
                    ja: "進行中表示へ切替（非表示を除外）",
                    zh: "Switch to active view (exclude hidden)",
                    de: "Zur aktiven Ansicht wechseln (ausgeblendete ausschließen)",
                  })
                : t({
                    ko: "모두보기로 전환 (숨김 포함)",
                    en: "Switch to all view (include hidden)",
                    ja: "全体表示へ切替（非表示を含む）",
                    zh: "Switch to all view (include hidden)",
                    de: "Zur Gesamtansicht wechseln (ausgeblendete einschließen)",
                  })
            }
          >
            <span
              className={showAllTasks ? "" : "text-emerald-200"}
              style={showAllTasks ? { color: "var(--th-text-secondary)" } : undefined}
            >
              {t({ ko: "진행중", en: "Active", ja: "進行中", zh: "Active", de: "Aktiv" })}
            </span>
            <span className="mx-1" style={{ color: "var(--th-text-muted)" }}>
              /
            </span>
            <span
              className={showAllTasks ? "text-cyan-100" : ""}
              style={!showAllTasks ? { color: "var(--th-text-muted)" } : undefined}
            >
              {t({ ko: "모두보기", en: "All", ja: "すべて", zh: "All", de: "Alle" })}
            </span>
            <span
              className="ml-1 rounded-full px-1.5 py-0.5 text-[10px]"
              style={{ background: "var(--th-card-bg)", color: "var(--th-text-secondary)" }}
            >
              {hiddenTaskCount}
            </span>
          </button>
          <button
            onClick={() => setShowBulkHideModal(true)}
            className="min-h-10 rounded-lg border px-3 py-2 text-xs transition hover:text-white"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            title={t({
              ko: "완료/보류/취소 상태 업무 숨기기",
              en: "Hide done/pending/cancelled tasks",
              ja: "完了/保留/キャンセル状態を非表示",
              zh: "Hide done/pending/cancelled tasks",
              de: "Erledigte/Ausstehende/Abgebrochene Aufgaben ausblenden",
            })}
          >
            🙈 {t({ ko: "숨김", en: "Hide", ja: "非表示", zh: "Hide", de: "Ausblenden" })}
          </button>
          <button
            onClick={() => setShowProjectManager(true)}
            className="taskboard-project-manage-btn min-h-10 rounded-lg border px-3 py-2 text-xs font-semibold transition"
          >
            🗂{" "}
            {t({
              ko: "프로젝트 관리",
              en: "Project Manager",
              ja: "プロジェクト管理",
              zh: "Project Manager",
              de: "Projektverwaltung",
            })}
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="min-h-10 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-blue-500 active:scale-95"
          >
            + {t({ ko: "새 업무", en: "New Task", ja: "新規タスク", zh: "New Task", de: "Neue Aufgabe" })}
          </button>
        </div>
      </div>

      <FilterBar
        agents={agents}
        departments={departments}
        filterDept={filterDept}
        filterAgent={filterAgent}
        filterType={filterType}
        search={search}
        onFilterDept={setFilterDept}
        onFilterAgent={setFilterAgent}
        onFilterType={setFilterType}
        onSearch={setSearch}
      />

      {tasks.length === 0 ? (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl p-8 text-center"
          style={{ background: "var(--bg-surface)", border: "1px dashed var(--border)" }}
        >
          <div
            className="text-lg font-semibold"
            style={{ color: "var(--text-primary)", fontFamily: "'Press Start 2P', monospace" }}
          >
            {t({
              ko: "아직 업무가 없습니다",
              en: "No tasks yet",
              ja: "タスクがまだありません",
              zh: "No tasks yet",
              de: "Noch keine Aufgaben",
            })}
          </div>
          <div
            className="max-w-md text-sm"
            style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}
          >
            {t({
              ko: "첫 번째 업무를 만들어 AI 에이전트 팀에게 작업을 위임하세요.",
              en: "Create your first task and delegate it to your AI agent team.",
              ja: "最初のタスクを作成し、AIエージェントチームに委任しましょう。",
              zh: "Create your first task and delegate it to your AI agent team.",
              de: "Erstelle deine erste Aufgabe und delegiere sie an dein KI-Agenten-Team.",
            })}
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="min-h-10 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-blue-500 active:scale-95"
          >
            + {t({ ko: "새 업무", en: "New Task", ja: "新規タスク", zh: "New Task", de: "Neue Aufgabe" })}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden pb-2 snap-x snap-proximity [scrollbar-width:thin]">
          {COLUMNS.map((column) => {
            const columnTasks = tasksByStatus[column.status] ?? [];
            return (
              <div
                key={column.status}
                className="taskboard-column flex w-[46vw] min-w-[160px] max-w-[260px] snap-start flex-shrink-0 flex-col rounded-xl sm:w-48 lg:w-56"
                style={{
                  background: "var(--bg-surface)",
                  border: `1px solid ${column.color}22`,
                }}
              >
                <div
                  className="flex items-center justify-between px-2.5 py-2"
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: `${column.color}08`,
                  }}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: column.color }} />
                    <span
                      className="truncate text-[8px] font-semibold uppercase tracking-wide"
                      style={{ color: column.color, fontFamily: "'Press Start 2P', monospace" }}
                    >
                      {taskStatusLabel(column.status, t)}
                    </span>
                  </div>
                  <span
                    className="ml-1 flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color: column.color,
                      background: `${column.color}22`,
                      border: `1px solid ${column.color}44`,
                      minWidth: 20,
                      textAlign: "center",
                    }}
                  >
                    {columnTasks.length}
                  </span>
                </div>

                <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                  {columnTasks.length === 0 ? (
                    <div
                      className="flex min-h-16 items-center justify-center py-6"
                      style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}
                    >
                      {t({ ko: "비어 있음", en: "empty", ja: "空", zh: "empty", de: "leer" })}
                    </div>
                  ) : (
                    columnTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        agents={agents}
                        departments={departments}
                        taskSubtasks={subtasksByTask[task.id] ?? []}
                        isHiddenTask={hiddenTaskIds.has(task.id)}
                        onUpdateTask={onUpdateTask}
                        onDeleteTask={onDeleteTask}
                        onAssignTask={onAssignTask}
                        onRunTask={onRunTask}
                        onStopTask={onStopTask}
                        onPauseTask={onPauseTask}
                        onResumeTask={onResumeTask}
                        onOpenTerminal={onOpenTerminal}
                        onOpenMeetingMinutes={onOpenMeetingMinutes}
                        onMergeTask={onMergeTask}
                        onDiscardTask={onDiscardTask}
                        onHideTask={hideTask}
                        onUnhideTask={unhideTask}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          activePackKey={activePackKey}
          agents={agents}
          departments={departments}
          onClose={() => setShowCreate(false)}
          onCreate={onCreateTask}
          onAssign={onAssignTask}
        />
      )}

      {showProjectManager && (
        <ProjectManagerModal agents={agents} departments={departments} onClose={() => setShowProjectManager(false)} />
      )}

      {showBulkHideModal && (
        <BulkHideModal
          tasks={tasks}
          hiddenTaskIds={hiddenTaskIds}
          onClose={() => setShowBulkHideModal(false)}
          onApply={(statuses) => {
            hideByStatuses(statuses);
            setShowBulkHideModal(false);
          }}
        />
      )}
    </div>
  );
}

export default TaskBoard;
