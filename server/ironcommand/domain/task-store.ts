/**
 * Iron Command OS — task repository.
 *
 * The important part of this file is claiming. Upstream OctoOffice claimed a
 * task with an unguarded `UPDATE tasks SET status='in_progress' WHERE id = ?`
 * and relied on in-process Sets for mutual exclusion, which stops working the
 * moment there is a second worker or a restart.
 *
 * Here, claiming is a compare-and-set: the UPDATE carries the observed
 * `status_version` in its WHERE clause and we check `changes === 1`. SQLite
 * serialises writers, so exactly one caller can win. The loser sees
 * `changes === 0` and simply moves on — no exception, no retry storm.
 *
 * Locks are released by naming the run that owns them
 * (`WHERE execution_run_id = ?`), so a late reaper can never clear a lock that
 * a fresh owner has since taken.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows } from "./sql.ts";
import { assertTransition, isTaskStatus, type TaskStatus } from "./task-state.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

/** How long a claim stays valid without a heartbeat. */
export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

export class TaskDependencyError extends Error {}

export interface TaskRow {
  id: string;
  company_id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: TaskStatus;
  status_version: number;
  status_reason: string;
  priority: string;
  risk_level: string;
  sensitive: number;
  assigned_agent_id: string | null;
  created_by: string;
  execution_run_id: string | null;
  execution_locked_at: number | null;
  lock_expires_at: number | null;
  result_summary: string | null;
  review_notes: string | null;
  correlation_id: string;
  deadline_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface CreateTaskInput {
  companyId: string;
  title: string;
  description?: string;
  projectId?: string | null;
  parentTaskId?: string | null;
  acceptanceCriteria?: string[];
  priority?: "low" | "normal" | "high" | "urgent";
  riskLevel?: "low" | "medium" | "high" | "critical";
  sensitive?: boolean;
  status?: TaskStatus;
  assignedAgentId?: string | null;
  createdBy?: string;
  correlationId?: string;
  deadlineAt?: number | null;
}

export class TaskStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateTaskInput): TaskRow {
    const id = newId("task");
    const status: TaskStatus = input.status ?? "inbox";
    if (!isTaskStatus(status)) throw new Error(`Unknown task status: ${status}`);

    this.db
      .prepare(
        `INSERT INTO ic_tasks
           (id, company_id, project_id, parent_task_id, title, description,
            acceptance_criteria, status, status_version, priority, risk_level,
            sensitive, assigned_agent_id, created_by, correlation_id, deadline_at)
         VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.projectId ?? null,
        input.parentTaskId ?? null,
        input.title,
        input.description ?? "",
        JSON.stringify(input.acceptanceCriteria ?? []),
        status,
        input.priority ?? "normal",
        input.riskLevel ?? "low",
        input.sensitive ? 1 : 0,
        input.assignedAgentId ?? null,
        input.createdBy ?? "system",
        input.correlationId ?? "",
        input.deadlineAt ?? null,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: (input.createdBy === "owner" ? "owner" : "system") as ActorType,
      actorId: input.createdBy ?? "system",
      action: "task.created",
      entityType: "task",
      entityId: id,
      taskId: id,
      correlationId: input.correlationId ?? "",
      details: { title: input.title, status, priority: input.priority ?? "normal" },
    });

    return this.get(id)!;
  }

  get(id: string): TaskRow | null {
    return (this.db.prepare("SELECT * FROM ic_tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null;
  }

  list(companyId: string, opts: { status?: TaskStatus; projectId?: string; limit?: number } = {}): TaskRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
    params.push(limit);
    return allRows<TaskRow>(
      this.db.prepare(`SELECT * FROM ic_tasks WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`),
      ...params,
    );
  }

  /**
   * Move a task to a new status.
   *
   * Guarded on `status_version` so a concurrent transition loses rather than
   * silently overwriting. Returns null when the CAS failed (someone else moved
   * the task first); throws only when the transition itself is illegal.
   */
  transition(
    taskId: string,
    to: TaskStatus,
    opts: {
      expectedVersion?: number;
      reason?: string;
      actorType?: ActorType;
      actorId?: string;
      assignedAgentId?: string | null;
      resultSummary?: string | null;
      reviewNotes?: string | null;
      correlationId?: string;
    } = {},
  ): TaskRow | null {
    const task = this.get(taskId);
    if (!task) return null;

    assertTransition(task.status, to);

    const expectedVersion = opts.expectedVersion ?? task.status_version;
    const now = Date.now();
    const completedAt = to === "done" ? now : null;

    const result = this.db
      .prepare(
        `UPDATE ic_tasks
            SET status = ?,
                status_version = status_version + 1,
                status_reason = ?,
                assigned_agent_id = COALESCE(?, assigned_agent_id),
                result_summary = COALESCE(?, result_summary),
                review_notes = COALESCE(?, review_notes),
                completed_at = COALESCE(?, completed_at),
                updated_at = ?
          WHERE id = ? AND status_version = ?`,
      )
      .run(
        to,
        opts.reason ?? "",
        opts.assignedAgentId ?? null,
        opts.resultSummary ?? null,
        opts.reviewNotes ?? null,
        completedAt,
        now,
        taskId,
        expectedVersion,
      );

    if (result.changes !== 1) return null;

    appendAuditEvent(this.db, {
      companyId: task.company_id,
      actorType: opts.actorType ?? "system",
      actorId: opts.actorId ?? "system",
      action: "task.transitioned",
      entityType: "task",
      entityId: taskId,
      taskId,
      correlationId: opts.correlationId ?? task.correlation_id,
      details: { from: task.status, to, reason: opts.reason ?? "" },
    });

    return this.get(taskId);
  }

  /**
   * Atomically claim a task for execution.
   *
   * Succeeds only if the task is still in `fromStatus`, still at the observed
   * status_version, and either unlocked or holding an expired lock. Everything
   * is expressed in the WHERE clause so the decision is made by the database,
   * not by a read-then-write race in application code.
   *
   * Returns the claimed task, or null if another worker won.
   */
  claim(input: {
    taskId: string;
    runId: string;
    agentId: string;
    expectedVersion: number;
    fromStatus?: TaskStatus;
    lockTtlMs?: number;
    now?: number;
    actorId?: string;
    correlationId?: string;
  }): TaskRow | null {
    const now = input.now ?? Date.now();
    const ttl = input.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    const from: TaskStatus = input.fromStatus ?? "ready";

    assertTransition(from, "assigned");

    const result = this.db
      .prepare(
        `UPDATE ic_tasks
            SET status = 'assigned',
                status_version = status_version + 1,
                assigned_agent_id = ?,
                execution_run_id = ?,
                execution_locked_at = ?,
                lock_expires_at = ?,
                updated_at = ?
          WHERE id = ?
            AND status = ?
            AND status_version = ?
            AND (execution_run_id IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)`,
      )
      .run(input.agentId, input.runId, now, now + ttl, now, input.taskId, from, input.expectedVersion, now);

    if (result.changes !== 1) return null;

    const task = this.get(input.taskId)!;
    appendAuditEvent(this.db, {
      companyId: task.company_id,
      actorType: "system",
      actorId: input.actorId ?? "scheduler",
      action: "task.claimed",
      entityType: "task",
      entityId: input.taskId,
      taskId: input.taskId,
      runId: input.runId,
      correlationId: input.correlationId ?? task.correlation_id,
      details: { agentId: input.agentId, lockExpiresAt: now + ttl },
    });
    return task;
  }

  /** Extend the lock for a run that is still alive. Idempotent. */
  renewLock(taskId: string, runId: string, opts: { lockTtlMs?: number; now?: number } = {}): boolean {
    const now = opts.now ?? Date.now();
    const ttl = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    const res = this.db
      .prepare(
        `UPDATE ic_tasks SET lock_expires_at = ?, updated_at = ?
          WHERE id = ? AND execution_run_id = ?`,
      )
      .run(now + ttl, now, taskId, runId);
    return res.changes === 1;
  }

  /**
   * Release a lock. Only the owning run may release it — this is what stops a
   * late reaper from clearing a lock a new owner has already taken.
   */
  releaseLock(taskId: string, runId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE ic_tasks
            SET execution_run_id = NULL, execution_locked_at = NULL, lock_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND execution_run_id = ?`,
      )
      .run(Date.now(), taskId, runId);
    return res.changes === 1;
  }

  /**
   * Find tasks whose lock has expired while still in an active state — the
   * signature of a worker that died mid-run.
   */
  findOrphaned(companyId: string, now = Date.now()): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ic_tasks
          WHERE company_id = ?
            AND status IN ('assigned','running')
            AND lock_expires_at IS NOT NULL
            AND lock_expires_at <= ?`,
      )
      .all(companyId, now) as unknown as TaskRow[];
  }

  /**
   * Recover an orphaned task back to `ready` so it can be picked up again.
   * Guarded on the run id we observed holding the lock, so a task that has
   * since been re-claimed is left alone.
   */
  recoverOrphaned(taskId: string, observedRunId: string, reason = "orphaned run recovered"): TaskRow | null {
    const task = this.get(taskId);
    if (!task) return null;

    const res = this.db
      .prepare(
        `UPDATE ic_tasks
            SET status = 'ready',
                status_version = status_version + 1,
                status_reason = ?,
                execution_run_id = NULL,
                execution_locked_at = NULL,
                lock_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND execution_run_id = ? AND status IN ('assigned','running')`,
      )
      .run(reason, Date.now(), taskId, observedRunId);

    if (res.changes !== 1) return null;

    appendAuditEvent(this.db, {
      companyId: task.company_id,
      actorType: "system",
      actorId: "recovery",
      action: "task.recovered",
      entityType: "task",
      entityId: taskId,
      taskId,
      runId: observedRunId,
      details: { reason, previousStatus: task.status },
    });
    return this.get(taskId);
  }

  // --- dependencies -------------------------------------------------------

  addDependency(
    companyId: string,
    taskId: string,
    dependsOnId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): void {
    if (taskId === dependsOnId) throw new TaskDependencyError("A task cannot depend on itself.");
    if (this.wouldCreateCycle(taskId, dependsOnId)) {
      throw new TaskDependencyError(`Adding dependency ${taskId} -> ${dependsOnId} would create a cycle.`);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ic_task_dependencies (id, company_id, task_id, depends_on_id)
         VALUES (?,?,?,?)`,
      )
      .run(newId("dep"), companyId, taskId, dependsOnId);

    appendAuditEvent(this.db, {
      companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "task.dependency_added",
      entityType: "task",
      entityId: taskId,
      taskId,
      details: { dependsOnId },
    });
  }

  /** Idempotent: removing an edge that isn't there is a no-op, not an error. */
  removeDependency(
    companyId: string,
    taskId: string,
    dependsOnId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): boolean {
    const res = this.db
      .prepare("DELETE FROM ic_task_dependencies WHERE company_id = ? AND task_id = ? AND depends_on_id = ?")
      .run(companyId, taskId, dependsOnId);
    if (res.changes === 0) return false;

    appendAuditEvent(this.db, {
      companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "task.dependency_removed",
      entityType: "task",
      entityId: taskId,
      taskId,
      details: { dependsOnId },
    });
    return true;
  }

  /** Walk the existing edges to see whether the new edge closes a loop. */
  private wouldCreateCycle(taskId: string, dependsOnId: string): boolean {
    const seen = new Set<string>();
    const stack = [dependsOnId];
    while (stack.length) {
      const current = stack.pop()!;
      if (current === taskId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const rows = this.db
        .prepare("SELECT depends_on_id FROM ic_task_dependencies WHERE task_id = ?")
        .all(current) as unknown as Array<{ depends_on_id: string }>;
      for (const row of rows) stack.push(row.depends_on_id);
    }
    return false;
  }

  blockers(taskId: string): TaskRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM ic_tasks t
           JOIN ic_task_dependencies d ON d.depends_on_id = t.id
          WHERE d.task_id = ?`,
      )
      .all(taskId) as unknown as TaskRow[];
  }

  /** The mirror of blockers(): tasks that depend on this one, i.e. this task blocks them. */
  blocking(taskId: string): TaskRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM ic_tasks t
           JOIN ic_task_dependencies d ON d.task_id = t.id
          WHERE d.depends_on_id = ?`,
      )
      .all(taskId) as unknown as TaskRow[];
  }

  /** A task is ready when every blocker is done. */
  isDependencyReady(taskId: string): boolean {
    return this.blockers(taskId).every((b) => b.status === "done");
  }

  /**
   * Tasks eligible for execution right now: status `ready`, unlocked (or
   * expired lock), and with all blockers done.
   */
  findClaimable(companyId: string, now = Date.now(), limit = 50): TaskRow[] {
    const candidates = this.db
      .prepare(
        `SELECT * FROM ic_tasks
          WHERE company_id = ?
            AND status = 'ready'
            AND (execution_run_id IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
          ORDER BY
            CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            created_at ASC
          LIMIT ?`,
      )
      .all(companyId, now, limit) as unknown as TaskRow[];
    return candidates.filter((t) => this.isDependencyReady(t.id));
  }
}
