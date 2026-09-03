import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireAuth } from "../../../security/auth.ts";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";
import {
  inferRequestedServerType,
  listServerTypePresets,
  normalizeServerType,
  processQueuedServerAllocations,
  releaseServerAccess,
  requestServerAccess,
  runServerHealthChecks,
} from "../../workflow/orchestration/server-allocation.ts";

interface ServerManagementRouteBaseDeps {
  app: Express;
  db: DatabaseSync;
  nowMs(): number;
  broadcast(type: string, payload: unknown): void;
  normalizeTextField?(value: unknown): string | null;
}

export function registerServerManagementRoutes(ctx: ServerManagementRouteBaseDeps): void {
  const { app, db, nowMs, broadcast } = ctx;
  const normalizeTextField =
    ctx.normalizeTextField ?? ((value: unknown) => (typeof value === "string" ? value.trim() : ""));
  app.use("/api/ops/servers", requireAuth);

  const listServersStmt = db.prepare(
    `
      SELECT
        s.*,
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
      ORDER BY s.type ASC, s.name ASC, s.created_at ASC
    `,
  );

  app.get("/api/ops/servers/presets", (_req, res) => {
    res.json({ presets: listServerTypePresets() });
  });

  app.get("/api/ops/servers", (_req, res) => {
    const servers = listServersStmt.all();
    res.json({ servers });
  });

  app.get("/api/ops/servers/allocations", (req, res) => {
    const status = (normalizeTextField(req.query.status) ?? "").toLowerCase();
    const validStatus = status && ["queued", "active", "released"].includes(status) ? status : "";
    const sql = `
      SELECT
        sa.*,
        s.name AS server_name,
        s.type AS server_type,
        a.name AS agent_name,
        a.name_ko AS agent_name_ko,
        t.title AS task_title
      FROM server_allocations sa
      LEFT JOIN servers s ON s.id = sa.server_id
      LEFT JOIN agents a ON a.id = sa.agent_id
      LEFT JOIN tasks t ON t.id = sa.task_id
      ${validStatus ? "WHERE sa.status = ?" : ""}
      ORDER BY
        CASE sa.status WHEN 'active' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
        sa.requested_at ASC
    `;
    const allocations = validStatus ? db.prepare(sql).all(validStatus) : db.prepare(sql).all();
    res.json({ allocations });
  });

  app.get("/api/ops/servers/:id", (req, res) => {
    const id = normalizeTextField(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "invalid_id" });

    const server = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!server) return res.status(404).json({ ok: false, error: "server_not_found" });

    const allocations = db
      .prepare(
        `
        SELECT sa.*, a.name AS agent_name, a.name_ko AS agent_name_ko, t.title AS task_title
        FROM server_allocations sa
        LEFT JOIN agents a ON a.id = sa.agent_id
        LEFT JOIN tasks t ON t.id = sa.task_id
        WHERE sa.server_id = ? OR (sa.server_id IS NULL AND sa.status = 'queued' AND sa.requested_server_type = ?)
        ORDER BY
          CASE sa.status WHEN 'active' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
          sa.requested_at ASC
      `,
      )
      .all(id, (server as { type?: string }).type ?? "");
    return res.json({ server, allocations });
  });

  app.post("/api/ops/servers", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = normalizeTextField(body.name);
    const type = normalizeServerType(body.type);
    if (!name || !type) return res.status(400).json({ ok: false, error: "invalid_payload" });

    const endpointUrl = normalizeTextField(body.endpoint_url) || null;
    if (endpointUrl && isBlockedSsrfTarget(endpointUrl, { allowLocal: true })) {
      return res
        .status(400)
        .json({ ok: false, error: "blocked_ssrf_target", detail: "URL targets a blocked address range" });
    }
    const departmentId = normalizeTextField(body.department_id) || "dev";
    const maxConcurrentRaw = Number(body.max_concurrent_jobs);
    const maxConcurrentJobs = Number.isFinite(maxConcurrentRaw) ? Math.max(1, Math.floor(maxConcurrentRaw)) : 1;
    const enabled = body.enabled === false || body.enabled === 0 || body.enabled === "0" ? 0 : 1;
    const authConfigJson =
      body.auth_config_json == null
        ? null
        : typeof body.auth_config_json === "string"
          ? body.auth_config_json
          : JSON.stringify(body.auth_config_json);
    const metadataJson =
      body.metadata_json == null
        ? null
        : typeof body.metadata_json === "string"
          ? body.metadata_json
          : JSON.stringify(body.metadata_json);
    const sshConfigJson =
      body.ssh_config_json == null
        ? null
        : typeof body.ssh_config_json === "string"
          ? body.ssh_config_json
          : JSON.stringify(body.ssh_config_json);

    // Validate: ssh_remote type requires ssh_config_json
    if (type === "ssh_remote" && !sshConfigJson) {
      return res
        .status(400)
        .json({ error: "ssh_config_required", message: "ssh_remote servers require SSH configuration" });
    }

    const id = randomUUID();
    const t = nowMs();

    db.prepare(
      `
      INSERT INTO servers (
        id, name, type, endpoint_url, auth_config_json, ssh_config_json, max_concurrent_jobs, current_jobs,
        status, enabled, department_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      name,
      type,
      endpointUrl,
      authConfigJson,
      sshConfigJson,
      maxConcurrentJobs,
      enabled ? "idle" : "offline",
      enabled,
      departmentId || null,
      metadataJson,
      t,
      t,
    );

    const server = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    broadcast("server_update", { action: "created", server });
    res.status(201).json({ ok: true, server });
  });

  app.patch("/api/ops/servers/:id", (req, res) => {
    const id = normalizeTextField(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "invalid_id" });
    const existing = db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as
      | { current_jobs?: number; max_concurrent_jobs?: number; status?: string }
      | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: "server_not_found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const setParts: string[] = [];
    const values: any[] = [];

    if (body.name != null) {
      setParts.push("name = ?");
      values.push(normalizeTextField(body.name) || "Unnamed Server");
    }
    if (body.type != null) {
      const type = normalizeServerType(body.type);
      if (!type) return res.status(400).json({ ok: false, error: "invalid_server_type" });
      setParts.push("type = ?");
      values.push(type);
    }
    if (body.endpoint_url != null) {
      if (typeof body.endpoint_url === "string") {
        const candidateUrl = normalizeTextField(body.endpoint_url) || "";
        if (candidateUrl && isBlockedSsrfTarget(candidateUrl, { allowLocal: true })) {
          return res
            .status(400)
            .json({ ok: false, error: "blocked_ssrf_target", detail: "URL targets a blocked address range" });
        }
      }
      setParts.push("endpoint_url = ?");
      values.push(normalizeTextField(body.endpoint_url) || null);
    }
    if (body.auth_config_json != null) {
      setParts.push("auth_config_json = ?");
      values.push(
        typeof body.auth_config_json === "string" ? body.auth_config_json : JSON.stringify(body.auth_config_json),
      );
    }
    if (body.ssh_config_json !== undefined) {
      if (body.ssh_config_json === null) {
        setParts.push("ssh_config_json = ?");
        values.push(null);
      } else {
        setParts.push("ssh_config_json = ?");
        values.push(
          typeof body.ssh_config_json === "string" ? body.ssh_config_json : JSON.stringify(body.ssh_config_json),
        );
      }
    }
    if (body.max_concurrent_jobs != null) {
      const maxRaw = Number(body.max_concurrent_jobs);
      const max = Number.isFinite(maxRaw)
        ? Math.max(1, Math.floor(maxRaw))
        : Math.max(1, Number(existing.max_concurrent_jobs ?? 1));
      setParts.push("max_concurrent_jobs = ?");
      values.push(max);
      const currentJobs = Math.max(0, Number(existing.current_jobs ?? 0));
      const nextStatus = currentJobs >= max ? "busy" : "idle";
      setParts.push("status = ?");
      values.push(nextStatus);
    }
    if (body.enabled != null) {
      const enabled = body.enabled === false || body.enabled === 0 || body.enabled === "0" ? 0 : 1;
      setParts.push("enabled = ?");
      values.push(enabled);
      setParts.push("status = ?");
      values.push(enabled ? "idle" : "offline");
    }
    if (body.department_id != null) {
      setParts.push("department_id = ?");
      values.push(normalizeTextField(body.department_id) || null);
    }
    if (body.metadata_json != null) {
      setParts.push("metadata_json = ?");
      values.push(typeof body.metadata_json === "string" ? body.metadata_json : JSON.stringify(body.metadata_json));
    }
    if (body.status != null) {
      const status = String(body.status).trim().toLowerCase();
      if (!["online", "offline", "busy", "idle"].includes(status)) {
        return res.status(400).json({ ok: false, error: "invalid_status" });
      }
      setParts.push("status = ?");
      values.push(status);
    }

    setParts.push("updated_at = ?");
    values.push(nowMs());
    values.push(id);
    if (setParts.length <= 1) return res.status(400).json({ ok: false, error: "empty_patch" });

    db.prepare(`UPDATE servers SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    const updated = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    broadcast("server_update", { action: "updated", server: updated });
    res.json({ ok: true, server: updated });
  });

  app.delete("/api/ops/servers/:id", (req, res) => {
    const id = normalizeTextField(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "invalid_id" });

    const existing = db.prepare("SELECT id FROM servers WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "server_not_found" });
    db.prepare("DELETE FROM servers WHERE id = ?").run(id);
    broadcast("server_update", { action: "deleted", server_id: id });
    res.json({ ok: true });
  });

  app.post("/api/ops/servers/health-check", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { server_ids?: string[] };
      const serverIds = Array.isArray(body.server_ids) ? body.server_ids : undefined;
      const results = await runServerHealthChecks(db as any, nowMs(), { serverIds });
      const servers = listServersStmt.all();
      broadcast("server_update", { action: "health_checked", servers });
      res.json({ ok: true, results, servers });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/ops/servers/:id/health-check", async (req, res) => {
    try {
      const id = normalizeTextField(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: "invalid_id" });
      const results = await runServerHealthChecks(db as any, nowMs(), { serverIds: [id] });
      const server = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
      broadcast("server_update", { action: "health_checked_single", server });
      res.json({ ok: true, result: results[0] ?? null, server });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/ops/servers/allocations/request", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = normalizeTextField(body.task_id);
    const agentId = normalizeTextField(body.agent_id) || null;
    if (!taskId) return res.status(400).json({ ok: false, error: "task_id_required" });

    const requestedServerType = inferRequestedServerType({
      explicitType: body.requested_server_type,
      provider: body.provider,
      workflowMetaJson: body.workflow_meta_json,
      taskType: body.task_type,
    });
    const result = requestServerAccess(db as any, {
      nowMs: nowMs(),
      taskId,
      agentId,
      requestedServerType,
      queueReason: normalizeTextField(body.queue_reason) || null,
    });
    const servers = listServersStmt.all();
    broadcast("server_update", { action: "allocation_requested", result, servers });
    res.json({ ok: true, result });
  });

  app.post("/api/ops/servers/allocations/release", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = normalizeTextField(body.task_id);
    const agentId = normalizeTextField(body.agent_id) || null;
    if (!taskId) return res.status(400).json({ ok: false, error: "task_id_required" });

    const result = releaseServerAccess(db as any, {
      nowMs: nowMs(),
      taskId,
      agentId,
      reason: normalizeTextField(body.reason) || "manual_release",
    });
    const servers = listServersStmt.all();
    broadcast("server_update", { action: "allocation_released", result, servers });
    res.json({ ok: true, ...result });
  });

  app.post("/api/ops/servers/allocations/process-queue", (_req, res) => {
    const activated = processQueuedServerAllocations(db as any, nowMs());
    const servers = listServersStmt.all();
    broadcast("server_update", { action: "queue_processed", activated, servers });
    res.json({ ok: true, activated, servers });
  });
}
