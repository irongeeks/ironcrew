import type { Express, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { requireAuth, shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";

type OpsSessionRow = {
  id: string;
  title: string;
  status: string;
  priority: number;
  started_at: number | null;
  updated_at: number;
  assigned_agent_id: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  department_id: string | null;
  department_name: string | null;
  department_icon: string | null;
  subtask_total: number;
  subtask_in_progress: number;
  subtask_done: number;
  active_allocations: number;
};

type OpsNodeRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  enabled: number;
  current_jobs: number;
  max_concurrent_jobs: number;
  endpoint_url: string | null;
  last_health_check_at: number | null;
  last_health_error: string | null;
  active_allocations: number;
  queued_allocations: number;
};

type OpsAlert = {
  id: string;
  level: "critical" | "warning" | "info";
  source: "task" | "subtask" | "node" | "allocation";
  title: string;
  detail: string;
  entity_id: string;
  created_at: number;
};

const SESSION_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  review: 1,
  pending: 2,
  collaborating: 3,
  planned: 4,
  inbox: 5,
  done: 6,
  cancelled: 7,
};

interface OperationsRouteBaseDeps {
  app: Express;
  db: DatabaseSync;
  nowMs(): number;
  broadcast(type: string, payload: unknown): void;
  activeProcesses: Map<string, ChildProcess>;
  killPidTree(pid: number): void;
  stopProgressTimer(taskId: string): void;
  endTaskExecutionSession(taskId: string, reason?: string): void;
  clearTaskWorkflowState(taskId: string): void;
  normalizeTextField?(value: unknown): string | null;
}

export function registerOperationsRoutes(ctx: OperationsRouteBaseDeps): void {
  const {
    app,
    db,
    nowMs,
    broadcast,
    activeProcesses,
    killPidTree,
    stopProgressTimer,
    endTaskExecutionSession,
    clearTaskWorkflowState,
  } = ctx;

  const normalizeTextField =
    ctx.normalizeTextField ?? ((value: unknown) => (typeof value === "string" ? value.trim() : ""));

  function requireCsrfGuard(req: Parameters<typeof shouldRequireCsrf>[0], res: Response): boolean {
    if (!shouldRequireCsrf(req)) return true;
    if (hasValidCsrfToken(req)) return true;
    res.status(403).json({ ok: false, error: "csrf_token_invalid" });
    return false;
  }

  app.use("/api/operations", requireAuth);

  const sessionsStmt = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.status,
      t.priority,
      t.started_at,
      t.updated_at,
      t.assigned_agent_id,
      a.name AS agent_name,
      a.avatar_emoji AS agent_avatar,
      t.department_id,
      d.name AS department_name,
      d.icon AS department_icon,
      COALESCE(st.total, 0) AS subtask_total,
      COALESCE(st.in_progress, 0) AS subtask_in_progress,
      COALESCE(st.done, 0) AS subtask_done,
      COALESCE(sa.active_allocations, 0) AS active_allocations
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.assigned_agent_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN (
      SELECT
        task_id,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
      FROM subtasks
      GROUP BY task_id
    ) st ON st.task_id = t.id
    LEFT JOIN (
      SELECT task_id, COUNT(*) AS active_allocations
      FROM server_allocations
      WHERE status = 'active'
      GROUP BY task_id
    ) sa ON sa.task_id = t.id
    WHERE t.status NOT IN ('done', 'cancelled')
    ORDER BY t.updated_at DESC
    LIMIT 250
  `);

  const nodesStmt = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.type,
      s.status,
      s.enabled,
      s.current_jobs,
      s.max_concurrent_jobs,
      s.endpoint_url,
      s.last_health_check_at,
      s.last_health_error,
      COALESCE(active_alloc.cnt, 0) AS active_allocations,
      COALESCE(queued_alloc.cnt, 0) AS queued_allocations
    FROM servers s
    LEFT JOIN (
      SELECT server_id, COUNT(*) AS cnt
      FROM server_allocations
      WHERE status = 'active'
      GROUP BY server_id
    ) active_alloc ON active_alloc.server_id = s.id
    LEFT JOIN (
      SELECT server_id, COUNT(*) AS cnt
      FROM server_allocations
      WHERE status = 'queued'
      GROUP BY server_id
    ) queued_alloc ON queued_alloc.server_id = s.id
    ORDER BY s.enabled DESC, s.status ASC, s.type ASC, s.name ASC
  `);

  app.get("/api/operations/sessions", (_req, res) => {
    const sessions = (sessionsStmt.all() as OpsSessionRow[])
      .slice()
      .sort((a, b) => {
        const leftRank = SESSION_STATUS_ORDER[a.status] ?? 999;
        const rightRank = SESSION_STATUS_ORDER[b.status] ?? 999;
        if (leftRank !== rightRank) return leftRank - rightRank;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return b.updated_at - a.updated_at;
      })
      .map((session) => ({
        ...session,
        running: activeProcesses.has(session.id),
      }));

    res.json({ sessions });
  });

  app.get("/api/operations/nodes", (_req, res) => {
    const nodes = nodesStmt.all() as OpsNodeRow[];
    res.json({ nodes });
  });

  app.get("/api/operations/alerts", (_req, res) => {
    const now = nowMs();
    const alerts: OpsAlert[] = [];

    const blockedSubtasks = db
      .prepare(
        `
          SELECT st.id, st.task_id, st.title, COALESCE(st.blocked_reason, '') AS blocked_reason, COALESCE(t.title, '') AS task_title
          FROM subtasks st
          LEFT JOIN tasks t ON t.id = st.task_id
          WHERE st.status = 'blocked'
          ORDER BY st.created_at DESC
          LIMIT 30
        `,
      )
      .all() as Array<{ id: string; task_id: string; title: string; blocked_reason: string; task_title: string }>;

    for (const row of blockedSubtasks) {
      alerts.push({
        id: `blocked:${row.id}`,
        level: "warning",
        source: "subtask",
        title: row.task_title ? `Blocked subtask in ${row.task_title}` : "Blocked subtask",
        detail: row.blocked_reason || row.title,
        entity_id: row.id,
        created_at: now,
      });
    }

    const staleQueuedAllocations = db
      .prepare(
        `
          SELECT id, task_id, requested_server_type, requested_at
          FROM server_allocations
          WHERE status = 'queued'
          ORDER BY requested_at ASC
          LIMIT 30
        `,
      )
      .all() as Array<{ id: string; task_id: string | null; requested_server_type: string; requested_at: number }>;

    for (const row of staleQueuedAllocations) {
      const ageMs = Math.max(0, now - Number(row.requested_at || now));
      if (ageMs < 10 * 60_000) continue;
      alerts.push({
        id: `queue:${row.id}`,
        level: ageMs > 30 * 60_000 ? "critical" : "warning",
        source: "allocation",
        title: "Queued server allocation",
        detail: `${row.requested_server_type} waiting ${Math.round(ageMs / 60_000)}m`,
        entity_id: row.task_id ?? row.id,
        created_at: Number(row.requested_at) || now,
      });
    }

    const unhealthyNodes = db
      .prepare(
        `
          SELECT id, name, enabled, status, COALESCE(last_health_error, '') AS last_health_error, updated_at
          FROM servers
          WHERE enabled = 1 AND (status = 'offline' OR COALESCE(last_health_error, '') <> '')
          ORDER BY updated_at DESC
          LIMIT 20
        `,
      )
      .all() as Array<{
      id: string;
      name: string;
      enabled: number;
      status: string;
      last_health_error: string;
      updated_at: number;
    }>;

    for (const row of unhealthyNodes) {
      alerts.push({
        id: `node:${row.id}`,
        level: row.status === "offline" ? "critical" : "warning",
        source: "node",
        title: `Node ${row.name} degraded`,
        detail: row.last_health_error || `status=${row.status}`,
        entity_id: row.id,
        created_at: row.updated_at || now,
      });
    }

    alerts.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 } as const;
      const left = rank[a.level];
      const right = rank[b.level];
      if (left !== right) return left - right;
      return b.created_at - a.created_at;
    });

    res.json({ alerts: alerts.slice(0, 80) });
  });

  app.post("/api/operations/tasks/:id/kill", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const id = normalizeTextField(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "invalid_id" });

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | { id: string; status: string; assigned_agent_id: string | null }
      | undefined;
    if (!task) return res.status(404).json({ ok: false, error: "task_not_found" });

    const now = nowMs();
    const trackedChild = activeProcesses.get(id) as { pid?: number } | undefined;
    if (trackedChild?.pid && trackedChild.pid > 0) {
      try {
        killPidTree(trackedChild.pid);
      } catch {
        // best effort kill
      }
    }
    activeProcesses.delete(id);

    stopProgressTimer(id);
    clearTaskWorkflowState(id);
    endTaskExecutionSession(id);

    db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      id,
    );

    if (task.assigned_agent_id) {
      db.prepare(
        "UPDATE agents SET status = CASE WHEN current_task_id = ? THEN 'idle' ELSE status END, current_task_id = CASE WHEN current_task_id = ? THEN NULL ELSE current_task_id END WHERE id = ?",
      ).run(id, id, task.assigned_agent_id);
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
      if (agent) broadcast("agent_status", agent);
    }

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    broadcast("task_update", updatedTask);

    res.json({ ok: true, killed: Boolean(trackedChild), task: updatedTask });
  });

  app.post("/api/operations/nodes/:id/drain", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const id = normalizeTextField(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "invalid_id" });

    const node = db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as { id: string } | undefined;
    if (!node) return res.status(404).json({ ok: false, error: "node_not_found" });

    const now = nowMs();
    db.prepare("UPDATE servers SET enabled = 0, status = 'offline', current_jobs = 0, updated_at = ? WHERE id = ?").run(
      now,
      id,
    );

    const released = db
      .prepare(
        "UPDATE server_allocations SET status = 'released', released_reason = 'drained_by_operations', released_at = ? WHERE server_id = ? AND status IN ('active','queued')",
      )
      .run(now, id);

    const updatedNode = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    broadcast("server_update", {
      action: "drained",
      server: updatedNode,
      released_allocations: released.changes,
    });

    res.json({ ok: true, node: updatedNode, released_allocations: released.changes });
  });
}
