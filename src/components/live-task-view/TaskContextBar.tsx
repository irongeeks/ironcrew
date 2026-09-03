import type { Task, SubTask } from "../../types";

interface TaskContextBarProps {
  task: Task | null;
  subtasks: SubTask[];
}

export default function TaskContextBar({ task, subtasks }: TaskContextBarProps) {
  if (!task) return null;

  const taskSubtasks = subtasks.filter((s) => s.task_id === task.id);
  const doneCount = taskSubtasks.filter((s) => s.status === "done").length;
  const totalCount = task.subtask_total ?? taskSubtasks.length;
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;

  let phaseLabel: string | null = null;
  if (task.workflow_meta_json) {
    try {
      const meta = JSON.parse(task.workflow_meta_json);
      phaseLabel = meta.current_phase_label ?? meta.current_phase ?? null;
    } catch {
      // ignore parse errors
    }
  }

  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--bg-elevated)",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 11,
          color: "var(--text-primary)",
          marginBottom: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {task.title}
      </div>
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 9,
          color: "var(--text-muted)",
          display: "flex",
          gap: 8,
        }}
      >
        {phaseLabel && <span>{phaseLabel}</span>}
        {totalCount > 0 && (
          <span>
            Subtask {doneCount}/{totalCount}
          </span>
        )}
      </div>
      {totalCount > 0 && (
        <div
          style={{
            marginTop: 6,
            height: 3,
            background: "var(--bg-surface)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              background: "linear-gradient(90deg, var(--accent), #10b981)",
              borderRadius: 2,
              transition: "width 0.3s ease",
            }}
          />
        </div>
      )}
    </div>
  );
}
