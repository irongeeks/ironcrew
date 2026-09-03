/**
 * Scheduled Tasks CRUD API
 * Mounted at /api/ops/scheduled-tasks
 */

import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { CronExpressionParser } from "cron-parser";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { requireAuth, shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "scheduled-tasks-api" });

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const cronExpressionSchema = z
  .string()
  .min(1)
  .refine(
    (val) => {
      try {
        CronExpressionParser.parse(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid cron expression" },
  );

const timezoneSchema = z
  .string()
  .default("UTC")
  .refine(
    (val) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: val });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA timezone" },
  );

const ScheduledTaskInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  cron_expression: cronExpressionSchema,
  timezone: timezoneSchema,
  workflow_pack_key: z.string().nullable().default(null),
  project_path: z.string().nullable().default(null),
  department_id: z.string().nullable().default(null),
  priority: z.number().int().min(1).max(10).default(5),
  enabled: z.boolean().default(true),
});

const ScheduledTaskUpdate = ScheduledTaskInput.partial();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeNextRunAt(cronExpression: string, timezone: string): number {
  const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
  return interval.next().toDate().getTime();
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerScheduledTaskRoutes(ctx: RuntimeContext): void {
  const { app, db, nowMs, broadcast } = ctx;
  const BASE = "/api/ops/scheduled-tasks";

  app.use(BASE, requireAuth);

  function requireCsrfGuard(req: Parameters<typeof shouldRequireCsrf>[0], res: any): boolean {
    if (!shouldRequireCsrf(req)) return true;
    if (hasValidCsrfToken(req)) return true;
    res.status(403).json({ error: "csrf_token_invalid" });
    return false;
  }

  // GET / — list all schedules
  app.get(BASE, (_req, res) => {
    const rows = db.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC").all();
    res.json(rows);
  });

  // POST / — create schedule
  app.post(BASE, (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const parsed = ScheduledTaskInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation_failed", details: parsed.error.issues });
    }
    const body = parsed.data;
    const id = randomUUID();
    const now = nowMs();
    const nextRunAt = computeNextRunAt(body.cron_expression, body.timezone);

    db.prepare(
      `INSERT INTO scheduled_tasks
         (id, title, description, cron_expression, timezone, workflow_pack_key,
          project_path, department_id, priority, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      body.title,
      body.description,
      body.cron_expression,
      body.timezone,
      body.workflow_pack_key,
      body.project_path,
      body.department_id,
      body.priority,
      body.enabled ? 1 : 0,
      nextRunAt,
      now,
      now,
    );

    const created = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
    broadcast("scheduled_task_updated", { action: "created", id });
    res.status(201).json(created);
  });

  // GET /:id
  app.get(`${BASE}/:id`, (req, res) => {
    const row = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });

  // PUT /:id
  app.put(`${BASE}/:id`, (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const existing = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "not_found" });

    const parsed = ScheduledTaskUpdate.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation_failed", details: parsed.error.issues });
    }
    const body = parsed.data;
    const now = nowMs();

    const cronChanged = body.cron_expression && body.cron_expression !== existing.cron_expression;
    const tzChanged = body.timezone && body.timezone !== existing.timezone;
    const nextRunAt =
      cronChanged || tzChanged
        ? computeNextRunAt(body.cron_expression ?? existing.cron_expression, body.timezone ?? existing.timezone)
        : existing.next_run_at;

    db.prepare(
      `UPDATE scheduled_tasks SET
         title = ?, description = ?, cron_expression = ?, timezone = ?,
         workflow_pack_key = ?, project_path = ?, department_id = ?,
         priority = ?, enabled = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      body.title ?? existing.title,
      body.description ?? existing.description,
      body.cron_expression ?? existing.cron_expression,
      body.timezone ?? existing.timezone,
      body.workflow_pack_key !== undefined ? body.workflow_pack_key : existing.workflow_pack_key,
      body.project_path !== undefined ? body.project_path : existing.project_path,
      body.department_id !== undefined ? body.department_id : existing.department_id,
      body.priority ?? existing.priority,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      nextRunAt,
      now,
      req.params.id,
    );

    const updated = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(req.params.id);
    broadcast("scheduled_task_updated", { action: "updated", id: req.params.id });
    res.json(updated);
  });

  // DELETE /:id
  app.delete(`${BASE}/:id`, (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const existing = db.prepare("SELECT id FROM scheduled_tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(req.params.id);
    broadcast("scheduled_task_updated", { action: "deleted", id: req.params.id });
    res.json({ ok: true });
  });

  // POST /:id/toggle
  app.post(`${BASE}/:id/toggle`, (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const existing = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "not_found" });

    const now = nowMs();
    const newEnabled = existing.enabled === 1 ? 0 : 1;
    const nextRunAt =
      newEnabled === 1 ? computeNextRunAt(existing.cron_expression, existing.timezone) : existing.next_run_at;

    db.prepare("UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(
      newEnabled,
      nextRunAt,
      now,
      req.params.id,
    );

    const updated = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(req.params.id);
    broadcast("scheduled_task_updated", { action: "toggled", id: req.params.id });
    res.json(updated);
  });

  // POST /:id/trigger — manually trigger now
  app.post(`${BASE}/:id/trigger`, async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const existing = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "not_found" });

    try {
      const port = (app?.get?.("port") as number) || 8790;
      const taskBody: Record<string, unknown> = {
        title: existing.title,
        description: existing.description || undefined,
        department_id: existing.department_id || undefined,
        priority: existing.priority,
        trigger: "scheduled",
        trigger_detail: existing.id,
      };
      if (existing.workflow_pack_key) taskBody.workflow_pack_key = existing.workflow_pack_key;
      if (existing.project_path) taskBody.project_path = existing.project_path;

      const { SESSION_AUTH_TOKEN } = await import("../../../config/runtime.ts");
      const taskResp = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SESSION_AUTH_TOKEN}` },
        body: JSON.stringify(taskBody),
      });

      if (!taskResp.ok) {
        const errText = await taskResp.text().catch(() => "");
        return res.status(500).json({ error: "task_creation_failed", detail: errText.slice(0, 200) });
      }

      const taskData = (await taskResp.json()) as { id?: string };
      broadcast("autonomous_action", {
        action: "scheduled_task_fired",
        scheduled_task_id: existing.id,
        scheduled_task_title: existing.title,
        task_id: taskData.id,
        task_title: existing.title,
        reason: `Schedule "${existing.title}" manually triggered — Task created`,
        timestamp: nowMs(),
      });

      res.json({ ok: true, task_id: taskData.id });
    } catch (err) {
      log.error({ err, scheduleId: req.params.id }, "manual trigger failed");
      res.status(500).json({ error: "trigger_failed" });
    }
  });

  // GET /:id/history
  app.get(`${BASE}/:id/history`, (req, res) => {
    const existing = db.prepare("SELECT id FROM scheduled_tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, t.created_at, t.completed_at
       FROM tasks t
       JOIN task_creation_audits a ON a.task_id = t.id
       WHERE a.trigger = 'scheduled' AND a.trigger_detail = ?
       ORDER BY t.created_at DESC
       LIMIT ?`,
      )
      .all(req.params.id, limit);

    res.json(rows);
  });
}
