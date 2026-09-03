import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireAuth } from "../../../security/auth.ts";
import type { ComfyUiWorkflowRow } from "../../workflow/comfyui/types.ts";
import { submitWorkflow, pollJobCompletion } from "../../workflow/comfyui/comfyui-connector.ts";

interface ComfyUiWorkflowRouteBaseDeps {
  app: Express;
  db: DatabaseSync;
  nowMs(): number;
  normalizeTextField?(value: unknown): string | null;
}

export function registerComfyUiWorkflowRoutes(ctx: ComfyUiWorkflowRouteBaseDeps): void {
  const { app, db, nowMs } = ctx;
  const normalizeTextField =
    ctx.normalizeTextField ?? ((value: unknown) => (typeof value === "string" ? value.trim() : ""));

  app.use("/api/ops/comfyui-workflows", requireAuth);

  // ---- LIST ----
  app.get("/api/ops/comfyui-workflows", (_req, res) => {
    const workflows = db
      .prepare(`SELECT * FROM comfyui_workflows ORDER BY workflow_type ASC, name ASC, created_at ASC`)
      .all() as ComfyUiWorkflowRow[];
    res.json({ workflows });
  });

  // ---- CREATE ----
  app.post("/api/ops/comfyui-workflows", (req, res) => {
    const body = req.body ?? {};
    const name = normalizeTextField(body.name);
    const workflowType = normalizeTextField(body.workflow_type);
    const workflowJsonRaw = body.workflow_json;
    const parameterMappingsRaw = body.parameter_mappings;
    const defaultServerId = normalizeTextField(body.default_server_id) || null;

    if (!name) return res.status(400).json({ error: "name is required" });
    if (!workflowType || !["text2img", "img2video", "text2speech", "custom"].includes(workflowType)) {
      return res.status(400).json({ error: "workflow_type must be text2img, img2video, text2speech, or custom" });
    }

    let workflowJson: string;
    try {
      workflowJson = typeof workflowJsonRaw === "string" ? workflowJsonRaw : JSON.stringify(workflowJsonRaw);
      JSON.parse(workflowJson);
    } catch {
      return res.status(400).json({ error: "workflow_json must be valid JSON" });
    }

    let parameterMappingsJson: string;
    try {
      const mappings =
        typeof parameterMappingsRaw === "string" ? JSON.parse(parameterMappingsRaw) : parameterMappingsRaw;
      if (!Array.isArray(mappings)) {
        return res.status(400).json({ error: "parameter_mappings must be an array" });
      }
      parameterMappingsJson = JSON.stringify(mappings);
    } catch {
      return res.status(400).json({ error: "parameter_mappings must be valid JSON array" });
    }

    const id = randomUUID();
    const now = nowMs();

    db.prepare(
      `INSERT INTO comfyui_workflows (id, name, workflow_type, workflow_json, parameter_mappings_json, default_server_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, name, workflowType, workflowJson, parameterMappingsJson, defaultServerId, now, now);

    const workflow = db.prepare("SELECT * FROM comfyui_workflows WHERE id = ?").get(id);
    res.status(201).json({ workflow });
  });

  // ---- UPDATE ----
  app.put("/api/ops/comfyui-workflows/:id", (req, res) => {
    const { id } = req.params;
    const existing = db.prepare("SELECT id FROM comfyui_workflows WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "not found" });

    const body = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.name !== undefined) {
      sets.push("name = ?");
      params.push(normalizeTextField(body.name));
    }
    if (body.workflow_type !== undefined) {
      const wt = normalizeTextField(body.workflow_type);
      if (!wt || !["text2img", "img2video", "text2speech", "custom"].includes(wt)) {
        return res.status(400).json({ error: "workflow_type must be text2img, img2video, text2speech, or custom" });
      }
      sets.push("workflow_type = ?");
      params.push(wt);
    }
    if (body.workflow_json !== undefined) {
      try {
        const json = typeof body.workflow_json === "string" ? body.workflow_json : JSON.stringify(body.workflow_json);
        JSON.parse(json);
        sets.push("workflow_json = ?");
        params.push(json);
      } catch {
        return res.status(400).json({ error: "workflow_json must be valid JSON" });
      }
    }
    if (body.parameter_mappings !== undefined) {
      try {
        const mappings =
          typeof body.parameter_mappings === "string" ? JSON.parse(body.parameter_mappings) : body.parameter_mappings;
        if (!Array.isArray(mappings)) {
          return res.status(400).json({ error: "parameter_mappings must be an array" });
        }
        sets.push("parameter_mappings_json = ?");
        params.push(JSON.stringify(mappings));
      } catch {
        return res.status(400).json({ error: "parameter_mappings must be valid JSON array" });
      }
    }
    if (body.default_server_id !== undefined) {
      sets.push("default_server_id = ?");
      params.push(normalizeTextField(body.default_server_id) || null);
    }
    if (body.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(body.enabled ? 1 : 0);
    }

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    sets.push("updated_at = ?");
    params.push(nowMs());
    params.push(id);

    db.prepare(`UPDATE comfyui_workflows SET ${sets.join(", ")} WHERE id = ?`).run(
      ...(params as Array<string | number | null>),
    );
    const workflow = db.prepare("SELECT * FROM comfyui_workflows WHERE id = ?").get(id);
    res.json({ workflow });
  });

  // ---- DELETE ----
  app.delete("/api/ops/comfyui-workflows/:id", (req, res) => {
    const { id } = req.params;
    const existing = db.prepare("SELECT id FROM comfyui_workflows WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "not found" });

    db.prepare("DELETE FROM comfyui_workflows WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  // ---- TEST ----
  app.post("/api/ops/comfyui-workflows/:id/test", async (req, res) => {
    const { id } = req.params;
    const workflow = db.prepare("SELECT * FROM comfyui_workflows WHERE id = ?").get(id) as
      | ComfyUiWorkflowRow
      | undefined;
    if (!workflow) return res.status(404).json({ error: "not found" });

    const serverId = normalizeTextField(req.body?.server_id) || workflow.default_server_id;
    if (!serverId) {
      return res.status(400).json({ error: "No server specified. Set default_server_id or pass server_id." });
    }

    const server = db.prepare("SELECT * FROM servers WHERE id = ?").get(serverId) as
      | { url?: string; auth_config?: string }
      | undefined;
    if (!server?.url) {
      return res.status(404).json({ error: "Server not found or has no URL" });
    }

    let authHeaders: Record<string, string> = {};
    if (server.auth_config) {
      try {
        const parsed = JSON.parse(server.auth_config) as Record<string, unknown>;
        const mode = String(parsed.mode ?? "")
          .trim()
          .toLowerCase();
        if (mode === "bearer" && typeof parsed.token === "string" && parsed.token.trim()) {
          authHeaders = { authorization: `Bearer ${parsed.token.trim()}` };
        } else if (mode === "header" && typeof parsed.header === "string" && typeof parsed.value === "string") {
          authHeaders = { [parsed.header.trim()]: parsed.value.trim() };
        } else if (mode === "api_key" && typeof parsed.key === "string") {
          authHeaders = { [String(parsed.header ?? "x-api-key").trim()]: parsed.key.trim() };
        }
      } catch {
        // ignore malformed auth config
      }
    }

    try {
      const workflowJson = JSON.parse(workflow.workflow_json) as Record<string, unknown>;
      const { promptId } = await submitWorkflow(server.url, authHeaders, workflowJson);
      const result = await pollJobCompletion(server.url, authHeaders, promptId, 60_000, 2_000);
      res.json({ ok: result.status === "success", result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ ok: false, error: message });
    }
  });
}
