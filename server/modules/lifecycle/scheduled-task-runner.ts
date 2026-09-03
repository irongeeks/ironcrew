/**
 * Scheduled Task Runner — periodically checks for due cron schedules and
 * creates tasks in the inbox queue.
 *
 * Runs every 60 seconds. Missed runs (server was off) are skipped with a
 * warning log. Each schedule's next_run_at is pre-computed after every fire.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import { CronExpressionParser } from "cron-parser";
import { SESSION_AUTH_TOKEN } from "../../config/runtime.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "scheduled-task-runner" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduledTaskRunnerDeps = {
  db: DatabaseSync;
  app: Express;
  broadcast: (type: string, payload: unknown) => void;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  nowMs: () => number;
};

type ScheduledTaskRow = {
  id: string;
  title: string;
  description: string;
  cron_expression: string;
  timezone: string;
  workflow_pack_key: string | null;
  project_path: string | null;
  department_id: string | null;
  priority: number;
  next_run_at: number;
  last_run_at: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the next occurrence from a cron expression, returning epoch ms. */
function computeNextRunAt(cronExpression: string, timezone: string, after: Date): number {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: after,
    tz: timezone,
  });
  return interval.next().toDate().getTime();
}

/** Max tasks to create per tick (burst protection). */
const MAX_PER_TICK = 5;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createScheduledTaskRunner(deps: ScheduledTaskRunnerDeps) {
  const { db, app, broadcast, nowMs } = deps;
  let running = false;

  /** Find all enabled schedules that are due. */
  function findDueSchedules(now: number): ScheduledTaskRow[] {
    return db
      .prepare(
        `SELECT id, title, description, cron_expression, timezone,
                workflow_pack_key, project_path, department_id, priority,
                next_run_at, last_run_at
         FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
      )
      .all(now, MAX_PER_TICK + 5) as ScheduledTaskRow[];
  }

  /** Create a task via internal HTTP POST. */
  async function createTask(schedule: ScheduledTaskRow): Promise<string | null> {
    const port = (app?.get?.("port") as number) || 8790;
    try {
      const body: Record<string, unknown> = {
        title: schedule.title,
        description: schedule.description || undefined,
        department_id: schedule.department_id || undefined,
        priority: schedule.priority,
        trigger: "scheduled",
        trigger_detail: schedule.id,
      };
      if (schedule.workflow_pack_key) body.workflow_pack_key = schedule.workflow_pack_key;
      if (schedule.project_path) body.project_path = schedule.project_path;

      const resp = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        log.error(
          { scheduleId: schedule.id, status: resp.status, errText: errText.slice(0, 200) },
          "task creation failed",
        );
        return null;
      }

      const data = (await resp.json()) as { id?: string };
      return data.id ?? null;
    } catch (err) {
      log.error({ err, scheduleId: schedule.id }, "task creation fetch failed");
      return null;
    }
  }

  /** Advance a schedule's next_run_at and set last_run_at. */
  function advanceSchedule(scheduleId: string, cronExpression: string, timezone: string, now: number): void {
    const nextRunAt = computeNextRunAt(cronExpression, timezone, new Date(now));
    db.prepare("UPDATE scheduled_tasks SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?").run(
      nextRunAt,
      now,
      now,
      scheduleId,
    );
  }

  /** Main tick — called every 60 seconds. */
  async function tick(): Promise<void> {
    if (running) return;
    running = true;

    try {
      const now = nowMs();
      const dueSchedules = findDueSchedules(now);
      if (dueSchedules.length === 0) return;

      let created = 0;
      for (const schedule of dueSchedules) {
        if (created >= MAX_PER_TICK) break;

        // Check if this is a missed run (more than 2 tick intervals old = 120s)
        const missedThreshold = now - 120_000;
        if (schedule.next_run_at < missedThreshold && schedule.last_run_at !== null) {
          // Missed run — skip and advance
          log.warn(
            { scheduleId: schedule.id, title: schedule.title, dueAt: new Date(schedule.next_run_at).toISOString() },
            `Missed scheduled run for "${schedule.title}" (was due at ${new Date(schedule.next_run_at).toISOString()}), skipping to next occurrence`,
          );
          advanceSchedule(schedule.id, schedule.cron_expression, schedule.timezone, now);
          continue;
        }

        const taskId = await createTask(schedule);
        if (taskId) {
          created++;
          broadcast("autonomous_action", {
            action: "scheduled_task_fired",
            scheduled_task_id: schedule.id,
            scheduled_task_title: schedule.title,
            task_id: taskId,
            task_title: schedule.title,
            reason: `Schedule "${schedule.title}" fired — Task created`,
            timestamp: now,
          });
          advanceSchedule(schedule.id, schedule.cron_expression, schedule.timezone, now);
        } else {
          // Task creation failed — do NOT advance next_run_at so the next tick retries
          log.warn({ scheduleId: schedule.id, title: schedule.title }, "task creation failed, will retry next tick");
        }
      }
    } catch (err) {
      log.error({ err }, "scheduled task runner tick failed");
    } finally {
      running = false;
    }
  }

  return { tick };
}
