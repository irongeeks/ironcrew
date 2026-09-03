/**
 * Autonomous Scheduler — periodically assigns idle agents to waiting tasks.
 *
 * Reads `autonomousMode` and `autonomousMaxConcurrent` from the settings table
 * on every tick so operators can toggle the feature at runtime without restart.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import type { ChildProcess } from "node:child_process";
import {
  selectAutoAssignableAgentForTask,
  type AutoAssignSelectionResult,
} from "../routes/core/tasks/execution-run-auto-assign.ts";
import { SESSION_AUTH_TOKEN } from "../../config/runtime.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutonomousSchedulerDeps = {
  db: DatabaseSync;
  app: Express;
  activeProcesses: Map<string, ChildProcess>;
  broadcast: (type: string, payload: unknown) => void;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  nowMs: () => number;
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  priority: number;
  assigned_agent_id: string | null;
  department_id: string | null;
  workflow_pack_key: string | null;
  project_id: string | null;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Setting helpers
// ---------------------------------------------------------------------------

export function readAutonomousModeEnabled(db: Pick<DatabaseSync, "prepare">): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'autonomousMode' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  return normalizeBool(row?.value) === true;
}

function readMaxConcurrent(db: Pick<DatabaseSync, "prepare">): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'autonomousMaxConcurrent' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  const parsed = Number(row?.value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 2;
}

function normalizeBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Scheduler core
// ---------------------------------------------------------------------------

/** Cooldown period after a task fails before the scheduler will retry it. */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
/** Maximum consecutive failures before a task is permanently skipped by the scheduler. */
const MAX_SCHEDULER_FAILURES = 3;

export function createAutonomousScheduler(deps: AutonomousSchedulerDeps) {
  const { db, app, activeProcesses, broadcast, notifyCeo, appendTaskLog, nowMs } = deps;

  /** Track recent failures: taskId → { count, lastFailedAt } */
  const failureTracker = new Map<string, { count: number; lastFailedAt: number }>();

  /** Check if a task should be skipped due to recent failures. */
  function isInFailureCooldown(taskId: string): boolean {
    const entry = failureTracker.get(taskId);
    if (!entry) return false;
    if (entry.count >= MAX_SCHEDULER_FAILURES) return true; // permanently skipped
    return nowMs() - entry.lastFailedAt < FAILURE_COOLDOWN_MS;
  }

  /** How many tasks are actively running right now? */
  function countRunningTasks(): number {
    const dbCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'in_progress'").get() as { cnt: number }
    ).cnt;
    // Cross-check with active process handles to avoid counting orphans
    return Math.min(dbCount, activeProcesses.size || dbCount);
  }

  /** Fetch tasks eligible for autonomous scheduling, sorted by priority then age.
   *  Excludes tasks that have failed recently (within FAILURE_COOLDOWN_MS). */
  function findSchedulableTasks(limit: number): TaskRow[] {
    const cooldownThreshold = nowMs() - FAILURE_COOLDOWN_MS;
    return db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, t.assigned_agent_id, t.department_id, t.workflow_pack_key, t.project_id, t.created_at
         FROM tasks t
         WHERE t.status IN ('inbox', 'planned')
           AND t.hidden = 0
           AND NOT EXISTS (
             SELECT 1 FROM task_logs tl
             WHERE tl.task_id = t.id
               AND tl.message LIKE 'RUN failed%'
               AND tl.created_at > ?
           )
           AND (
             SELECT COUNT(*) FROM task_logs tl2
             WHERE tl2.task_id = t.id
               AND tl2.message LIKE 'RUN failed%'
           ) < ?
           AND NOT EXISTS (
             SELECT 1 FROM subtasks s
             WHERE s.task_id = t.id
               AND s.title LIKE '[pipeline:%'
               AND s.status = 'awaiting_approval'
           )
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT ?`,
      )
      .all(cooldownThreshold, MAX_SCHEDULER_FAILURES, limit) as TaskRow[];
  }

  /** Trigger task execution via internal HTTP POST (same pattern as triggerTaskReRun). */
  function triggerRun(taskId: string, reason: string): void {
    try {
      const port = (app?.get?.("port") as number) || 8790;
      fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SESSION_AUTH_TOKEN}` },
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        appendTaskLog(taskId, "error", `Autonomous scheduler trigger failed (${reason}): ${msg}`);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTaskLog(taskId, "error", `Autonomous scheduler trigger exception (${reason}): ${msg}`);
    }
  }

  /**
   * Main scheduler tick — called periodically and also on-demand after task completion.
   * Safe to call concurrently (worst case: two fetches to /run, second one will get a
   * "task already in_progress" guard from the existing route).
   */
  function schedulerTick(): void {
    if (!readAutonomousModeEnabled(db)) return;

    const maxConcurrent = readMaxConcurrent(db);
    const running = countRunningTasks();
    if (running >= maxConcurrent) {
      broadcast("autonomous_action", {
        action: "scheduler_skip",
        reason: `${running}/${maxConcurrent} slots occupied`,
        timestamp: nowMs(),
      });
      return;
    }

    const slots = maxConcurrent - running;
    // Fetch more than needed to account for filtered-out tasks
    const tasks = findSchedulableTasks(slots + 10).filter((t) => !isInFailureCooldown(t.id));
    if (tasks.length === 0) return;

    for (const task of tasks.slice(0, slots)) {
      // Try to find an available agent
      let selection: AutoAssignSelectionResult | null = null;
      if (!task.assigned_agent_id) {
        selection = selectAutoAssignableAgentForTask(db as any, task);
        if (!selection) {
          broadcast("autonomous_action", {
            action: "scheduler_skip",
            task_id: task.id,
            task_title: task.title,
            reason: "No idle agent available",
            timestamp: nowMs(),
          });
          continue;
        }
      }

      const agentName = selection?.agent?.name ?? "(pre-assigned)";
      const agentId = selection?.agent?.id ?? task.assigned_agent_id;

      broadcast("autonomous_action", {
        action: "task_scheduled",
        task_id: task.id,
        task_title: task.title,
        agent_id: agentId,
        agent_name: agentName,
        reason: `Autonomous scheduler: assigning "${task.title}" to ${agentName}`,
        timestamp: nowMs(),
      });

      notifyCeo(`[Autonomous] Scheduling task "${task.title}" → ${agentName}`, task.id, "status_update");

      triggerRun(task.id, "autonomous_scheduler");
    }
  }

  return { schedulerTick, readAutonomousModeEnabled: () => readAutonomousModeEnabled(db) };
}
