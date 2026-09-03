import type { DbLike } from "../../../../types/db-like.ts";

type CrossDeptSubtaskDeps = {
  db: DbLike;
  nowMs: () => number;
  broadcast: (event: string, payload: unknown) => void;
  delegatedTaskToSubtask: Map<string, string>;
};

export function createCrossDeptSubtaskTools(deps: CrossDeptSubtaskDeps) {
  const { db, nowMs, broadcast, delegatedTaskToSubtask } = deps;

  function deriveSubtaskStateFromDelegatedTask(
    taskStatus: string,
    taskCompletedAt: number | null,
  ): { status: "done" | "in_progress" | "blocked"; blockedReason: string | null; completedAt: number | null } {
    if (taskStatus === "done") {
      return { status: "done", blockedReason: null, completedAt: taskCompletedAt ?? nowMs() };
    }
    // Collaboration child tasks can stay in review until parent consolidation meeting.
    // For parent subtask progress gating, treat child-review as checkpoint-complete.
    if (taskStatus === "review") {
      return { status: "done", blockedReason: null, completedAt: taskCompletedAt ?? nowMs() };
    }
    if (
      taskStatus === "in_progress" ||
      taskStatus === "collaborating" ||
      taskStatus === "planned" ||
      taskStatus === "pending"
    ) {
      return { status: "in_progress", blockedReason: null, completedAt: null };
    }
    return { status: "blocked", blockedReason: null, completedAt: null };
  }

  function pickUnlinkedTargetSubtask(parentTaskId: string, targetDeptId: string): { id: string } | undefined {
    const preferred = db
      .prepare(
        `
    SELECT id
    FROM subtasks
    WHERE task_id = ?
      AND target_department_id = ?
      AND status != 'done'
      AND (delegated_task_id IS NULL OR delegated_task_id = '')
      AND (
        title LIKE '[협업]%'
        OR title LIKE '[Collaboration]%'
        OR title LIKE '[協業]%'
        OR title LIKE '[协作]%'
      )
    ORDER BY created_at ASC
    LIMIT 1
  `,
      )
      .get(parentTaskId, targetDeptId) as { id: string } | undefined;
    if (preferred) return preferred;

    return db
      .prepare(
        `
    SELECT id
    FROM subtasks
    WHERE task_id = ?
      AND target_department_id = ?
      AND status != 'done'
      AND (delegated_task_id IS NULL OR delegated_task_id = '')
    ORDER BY created_at ASC
    LIMIT 1
  `,
      )
      .get(parentTaskId, targetDeptId) as { id: string } | undefined;
  }

  function syncSubtaskWithDelegatedTask(
    subtaskId: string,
    delegatedTaskId: string,
    delegatedTaskStatus: string,
    delegatedTaskCompletedAt: number | null,
  ): void {
    const current = db
      .prepare("SELECT delegated_task_id, status, blocked_reason, completed_at FROM subtasks WHERE id = ?")
      .get(subtaskId) as
      | {
          delegated_task_id: string | null;
          status: string;
          blocked_reason: string | null;
          completed_at: number | null;
        }
      | undefined;
    if (!current) return;

    const next = deriveSubtaskStateFromDelegatedTask(delegatedTaskStatus, delegatedTaskCompletedAt);
    const shouldUpdate =
      current.delegated_task_id !== delegatedTaskId ||
      current.status !== next.status ||
      (current.blocked_reason ?? null) !== next.blockedReason ||
      (current.completed_at ?? null) !== next.completedAt;
    if (!shouldUpdate) return;

    db.prepare(
      "UPDATE subtasks SET delegated_task_id = ?, status = ?, blocked_reason = ?, completed_at = ? WHERE id = ?",
    ).run(delegatedTaskId, next.status, next.blockedReason, next.completedAt, subtaskId);
    const updatedSub = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtaskId);
    broadcast("subtask_update", updatedSub);
  }

  function linkCrossDeptTaskToParentSubtask(
    parentTaskId: string,
    targetDeptId: string,
    delegatedTaskId: string,
  ): string | null {
    const sub = pickUnlinkedTargetSubtask(parentTaskId, targetDeptId);
    if (!sub) return null;
    syncSubtaskWithDelegatedTask(sub.id, delegatedTaskId, "planned", null);
    return sub.id;
  }

  function reconcileCrossDeptSubtasks(parentTaskId?: string): void {
    const rows = parentTaskId
      ? db
          .prepare(
            `
      SELECT id, source_task_id, department_id, status, completed_at
      FROM tasks
      WHERE source_task_id = ? AND department_id IS NOT NULL
      ORDER BY created_at ASC
    `,
          )
          .all(parentTaskId)
      : db
          .prepare(
            `
      SELECT id, source_task_id, department_id, status, completed_at
      FROM tasks
      WHERE source_task_id IS NOT NULL AND department_id IS NOT NULL
      ORDER BY created_at ASC
    `,
          )
          .all();

    for (const row of rows as Array<{
      id: string;
      source_task_id: string | null;
      department_id: string | null;
      status: string;
      completed_at: number | null;
    }>) {
      if (!row.source_task_id || !row.department_id) continue;

      const linked = db
        .prepare("SELECT id FROM subtasks WHERE task_id = ? AND delegated_task_id = ? LIMIT 1")
        .get(row.source_task_id, row.id) as { id: string } | undefined;
      const sub = linked ?? pickUnlinkedTargetSubtask(row.source_task_id, row.department_id);
      if (!sub) continue;

      syncSubtaskWithDelegatedTask(sub.id, row.id, row.status, row.completed_at ?? null);
      if (
        row.status === "in_progress" ||
        row.status === "review" ||
        row.status === "planned" ||
        row.status === "collaborating" ||
        row.status === "pending"
      ) {
        delegatedTaskToSubtask.set(row.id, sub.id);
      } else {
        delegatedTaskToSubtask.delete(row.id);
      }
    }
  }

  return {
    deriveSubtaskStateFromDelegatedTask,
    pickUnlinkedTargetSubtask,
    syncSubtaskWithDelegatedTask,
    linkCrossDeptTaskToParentSubtask,
    reconcileCrossDeptSubtasks,
  };
}
