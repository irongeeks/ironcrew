import type { DbLike } from "../../../types/db-like.ts";

export type VideoRenderPendingSubtask = {
  id: string;
  status: string;
  delegated_task_id: string | null;
};

type ReconcileVideoRenderDelegationDeps = {
  db: DbLike;
  nowMs: () => number;
  broadcast: (event: string, payload: unknown) => void;
};

export function reconcileVideoRenderDelegationState(
  deps: ReconcileVideoRenderDelegationDeps,
  pendingRender: VideoRenderPendingSubtask[],
): {
  staleResetCount: number;
  recoveredDoneCount: number;
} {
  const { db, nowMs, broadcast } = deps;

  const delegatedIds = [
    ...new Set(pendingRender.map((sub) => String(sub.delegated_task_id ?? "").trim()).filter((id) => id.length > 0)),
  ];
  const delegatedStatusById = new Map<string, string>();
  if (delegatedIds.length > 0) {
    const placeholders = delegatedIds.map(() => "?").join(", ");
    const delegatedRows = db
      .prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`)
      .all(...delegatedIds) as Array<{ id: string; status: string }>;
    for (const row of delegatedRows) {
      delegatedStatusById.set(row.id, String(row.status ?? ""));
    }
  }

  let staleResetCount = 0;
  let recoveredDoneCount = 0;
  const doneAt = nowMs();
  for (const sub of pendingRender) {
    const delegatedTaskId = String(sub.delegated_task_id ?? "").trim();
    if (!delegatedTaskId) continue;
    const delegatedStatus = delegatedStatusById.get(delegatedTaskId);
    if (!delegatedStatus || delegatedStatus === "cancelled" || delegatedStatus === "inbox") {
      db.prepare(
        `
          UPDATE subtasks
          SET delegated_task_id = NULL,
              status = CASE WHEN status = 'blocked' THEN 'pending' ELSE status END,
              blocked_reason = CASE WHEN status = 'blocked' THEN NULL ELSE blocked_reason END
          WHERE id = ?
        `,
      ).run(sub.id);
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
      staleResetCount += 1;
      continue;
    }
    if (delegatedStatus === "review" || delegatedStatus === "done") {
      db.prepare("UPDATE subtasks SET status = 'done', completed_at = ?, blocked_reason = NULL WHERE id = ?").run(
        doneAt,
        sub.id,
      );
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
      recoveredDoneCount += 1;
    }
  }

  return { staleResetCount, recoveredDoneCount };
}
