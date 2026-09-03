import type { Express, Request, Response } from "express";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { decryptSecret, encryptSecret } from "../../../oauth/helpers.ts";
import { shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";
import { isBlockedSsrfTarget, SsrfBlockedError } from "../../../security/ssrf.ts";
import { safeFetch } from "../../../security/safe-fetch.ts";

type ApiProviderPreset = {
  base_url: string;
  models_path: string;
  auth_header: string;
};

type ApiProviderType =
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "openrouter"
  | "together"
  | "groq"
  | "cerebras"
  | "custom";

type ApiProviderRow = {
  id: string;
  name: string;
  type: ApiProviderType;
  base_url: string;
  api_key_enc: string | null;
  enabled: number;
  allow_local: number;
  models_cache: string | null;
  models_cached_at: number | null;
  created_at: number;
  updated_at: number;
};

type ApiProviderPayload = {
  name?: unknown;
  type?: unknown;
  base_url?: unknown;
  api_key?: unknown;
  enabled?: unknown;
  allow_local?: unknown;
};

interface RegisterApiProviderRoutesOptions {
  app: Express;
  db: DatabaseSync;
  nowMs: () => number;
}

const API_PROVIDER_PRESETS: Record<ApiProviderType, ApiProviderPreset> = {
  openai: { base_url: "https://api.openai.com/v1", models_path: "/models", auth_header: "Bearer" },
  anthropic: { base_url: "https://api.anthropic.com/v1", models_path: "/models", auth_header: "x-api-key" },
  google: {
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    models_path: "/models",
    auth_header: "key",
  },
  ollama: { base_url: "http://localhost:11434/v1", models_path: "/models", auth_header: "" },
  openrouter: { base_url: "https://openrouter.ai/api/v1", models_path: "/models", auth_header: "Bearer" },
  together: { base_url: "https://api.together.xyz/v1", models_path: "/models", auth_header: "Bearer" },
  groq: { base_url: "https://api.groq.com/openai/v1", models_path: "/models", auth_header: "Bearer" },
  cerebras: { base_url: "https://api.cerebras.ai/v1", models_path: "/models", auth_header: "Bearer" },
  custom: { base_url: "", models_path: "/models", auth_header: "Bearer" },
};

function isApiProviderType(value: unknown): value is ApiProviderType {
  return typeof value === "string" && value in API_PROVIDER_PRESETS;
}

const ApiProviderPayloadSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    type: z.string().optional(),
    base_url: z.string().url().max(500).optional(),
    api_key: z.string().max(500).optional(),
    enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    allow_local: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  })
  .strict();

function parseBody(req: Request, res: Response): ApiProviderPayload | null {
  const result = ApiProviderPayloadSchema.safeParse(req.body ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
      return path + issue.message;
    });
    res.status(400).json({ ok: false, error: "validation_failed", detail: issues.join("; ") });
    return null;
  }
  return result.data as ApiProviderPayload;
}

function readProvider(db: DatabaseSync, id: string): ApiProviderRow | null {
  const row = db.prepare("SELECT * FROM api_providers WHERE id = ?").get(id) as ApiProviderRow | undefined;
  return row ?? null;
}

function buildApiProviderHeaders(type: ApiProviderType, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!apiKey) return headers;
  if (type === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (type === "google") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

function normalizeApiBaseUrl(rawUrl: string): string {
  let url = rawUrl.replace(/\/+$/, "");
  url = url.replace(/\/v1\/(chat\/completions|models|messages)$/i, "/v1");
  url = url.replace(/\/v1beta\/models\/.+$/i, "/v1beta");
  return url;
}

function buildModelsUrl(type: ApiProviderType, baseUrl: string, _apiKey: string): string {
  const preset = API_PROVIDER_PRESETS[type] || API_PROVIDER_PRESETS.custom;
  const base = normalizeApiBaseUrl(baseUrl);
  return `${base}${preset.models_path}`;
}

function extractModelIds(type: ApiProviderType, data: unknown): string[] {
  const models: string[] = [];
  const payload = data as {
    data?: Array<{ id?: string }>;
    models?: Array<{ id?: string; name?: string; model?: string }>;
  };

  if (type === "google") {
    if (Array.isArray(payload.models)) {
      for (const m of payload.models) {
        const name = m.name || m.model || "";
        if (name) models.push(name.replace(/^models\//, ""));
      }
    }
  } else if (type === "anthropic") {
    if (Array.isArray(payload.data)) {
      for (const m of payload.data) {
        if (m.id) models.push(m.id);
      }
    }
  } else {
    if (Array.isArray(payload.data)) {
      for (const m of payload.data) {
        if (m.id) models.push(m.id);
      }
    } else if (Array.isArray(payload.models)) {
      for (const m of payload.models) {
        const id = m.id || m.name || m.model || "";
        if (id) models.push(id);
      }
    }
  }
  return models.sort();
}

function parseModelsCache(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function sendNotFound(res: Response): void {
  res.status(404).json({ ok: false, error: "not_found" });
}

export function registerApiProviderRoutes({ app, db, nowMs }: RegisterApiProviderRoutesOptions): void {
  function requireCsrfGuard(req: Parameters<typeof shouldRequireCsrf>[0], res: Response): boolean {
    if (!shouldRequireCsrf(req)) return true;
    if (hasValidCsrfToken(req)) return true;
    res.status(403).json({ ok: false, error: "csrf_token_invalid" });
    return false;
  }

  app.get("/api/api-providers", (_req, res) => {
    const rows = db.prepare("SELECT * FROM api_providers ORDER BY created_at ASC").all() as ApiProviderRow[];
    const providers = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      base_url: row.base_url,
      has_api_key: Boolean(row.api_key_enc),
      enabled: Boolean(row.enabled),
      allow_local: Boolean(row.allow_local),
      models_cache: parseModelsCache(row.models_cache),
      models_cached_at: row.models_cached_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    res.json({ ok: true, providers });
  });

  app.post("/api/api-providers", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const body = parseBody(req, res);
    if (!body) return;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
    const type: ApiProviderType = isApiProviderType(body.type) ? body.type : "openai";
    const apiKey = typeof body.api_key === "string" ? body.api_key : "";

    if (!name || !baseUrl) {
      return res.status(400).json({ ok: false, error: "name and base_url are required" });
    }

    const allowLocal = body.allow_local ? 1 : 0;
    const id = randomUUID();
    const now = nowMs();
    db.prepare(
      "INSERT INTO api_providers (id, name, type, base_url, api_key_enc, allow_local, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, name, type, baseUrl.replace(/\/+$/, ""), apiKey ? encryptSecret(apiKey) : null, allowLocal, now, now);
    res.json({ ok: true, id });
  });

  app.put("/api/api-providers/:id", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const id = String(req.params.id ?? "");
    const body = parseBody(req, res);
    if (!body) return;
    const updates: string[] = ["updated_at = ?"];
    const params: unknown[] = [nowMs()];

    if ("name" in body && typeof body.name === "string" && body.name.trim()) {
      updates.push("name = ?");
      params.push(body.name.trim());
    }
    if ("type" in body && isApiProviderType(body.type)) {
      updates.push("type = ?");
      params.push(body.type);
    }
    if ("base_url" in body && typeof body.base_url === "string" && body.base_url.trim()) {
      updates.push("base_url = ?");
      params.push(body.base_url.trim().replace(/\/+$/, ""));
    }
    if ("api_key" in body) {
      const apiKey = typeof body.api_key === "string" ? body.api_key : "";
      updates.push("api_key_enc = ?");
      params.push(apiKey ? encryptSecret(apiKey) : null);
    }
    if ("enabled" in body) {
      updates.push("enabled = ?");
      params.push(body.enabled ? 1 : 0);
    }
    if ("allow_local" in body) {
      updates.push("allow_local = ?");
      params.push(body.allow_local ? 1 : 0);
    }

    params.push(id);
    const result = db
      .prepare(`UPDATE api_providers SET ${updates.join(", ")} WHERE id = ?`)
      .run(...(params as SQLInputValue[]));

    if (result.changes === 0) return sendNotFound(res);
    res.json({ ok: true });
  });

  app.delete("/api/api-providers/:id", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const id = String(req.params.id ?? "");
    const result = db.prepare("DELETE FROM api_providers WHERE id = ?").run(id);
    if (result.changes === 0) return sendNotFound(res);
    res.json({ ok: true });
  });

  app.post("/api/api-providers/:id/test", async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const id = String(req.params.id ?? "");
    const row = readProvider(db, id);
    if (!row) return sendNotFound(res);

    const apiKey = row.api_key_enc ? decryptSecret(row.api_key_enc) : "";
    const url = buildModelsUrl(row.type, row.base_url, apiKey);

    // SSRF protection: strict by default, but allow local/private targets when the
    // provider has allow_local enabled (e.g. Ollama, LM Studio, local gateways).
    if (isBlockedSsrfTarget(url, { allowLocal: !!row.allow_local })) {
      return res
        .status(400)
        .json({ ok: false, error: "blocked_ssrf_target", detail: "URL targets a blocked address range" });
    }

    const headers = buildApiProviderHeaders(row.type, apiKey);

    try {
      // safeFetch resolves DNS, validates the IP, and pins it into the
      // dispatcher so the actual TCP connect cannot re-resolve under DNS
      // rebinding (A-002 review fix — closes the TOCTOU window).
      const resp = await safeFetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
        allowLocal: !!row.allow_local,
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        return res.json({ ok: false, status: resp.status, error: errBody.slice(0, 500) });
      }

      const data = await resp.json();
      const models = extractModelIds(row.type, data);
      const now = nowMs();
      db.prepare("UPDATE api_providers SET models_cache = ?, models_cached_at = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(models),
        now,
        now,
        id,
      );
      res.json({ ok: true, model_count: models.length, models });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return res
          .status(400)
          .json({ ok: false, error: "blocked_ssrf_target", detail: "URL targets a blocked address range" });
      }
      const message = error instanceof Error ? error.message : String(error);
      res.json({ ok: false, error: message });
    }
  });

  app.get("/api/api-providers/:id/models", async (req, res) => {
    const id = String(req.params.id ?? "");
    const refresh = req.query.refresh === "true";
    const row = readProvider(db, id);
    if (!row) return sendNotFound(res);

    const cachedModels = parseModelsCache(row.models_cache);
    if (!refresh && row.models_cache) {
      return res.json({ ok: true, models: cachedModels, cached: true });
    }

    const apiKey = row.api_key_enc ? decryptSecret(row.api_key_enc) : "";
    const url = buildModelsUrl(row.type, row.base_url, apiKey);

    // SSRF protection: strict by default, but allow local/private targets when the
    // provider has allow_local enabled (e.g. Ollama, LM Studio, local gateways).
    if (isBlockedSsrfTarget(url, { allowLocal: !!row.allow_local })) {
      return res
        .status(400)
        .json({ ok: false, error: "blocked_ssrf_target", detail: "URL targets a blocked address range" });
    }

    const headers = buildApiProviderHeaders(row.type, apiKey);

    try {
      // safeFetch resolves DNS, validates the IP, and pins it into the
      // dispatcher so the actual TCP connect cannot re-resolve under DNS
      // rebinding (A-002 review fix — closes the TOCTOU window).
      const resp = await safeFetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
        allowLocal: !!row.allow_local,
      });
      if (!resp.ok) {
        if (row.models_cache) {
          return res.json({ ok: true, models: cachedModels, cached: true, stale: true });
        }
        return res.status(502).json({ ok: false, error: `upstream returned ${resp.status}` });
      }
      const data = await resp.json();
      const models = extractModelIds(row.type, data);
      const now = nowMs();
      db.prepare("UPDATE api_providers SET models_cache = ?, models_cached_at = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(models),
        now,
        now,
        id,
      );
      res.json({ ok: true, models, cached: false });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return res
          .status(400)
          .json({ ok: false, error: "blocked_ssrf_target", detail: "URL targets a blocked address range" });
      }
      if (row.models_cache) {
        return res.json({ ok: true, models: cachedModels, cached: true, stale: true });
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ ok: false, error: message });
    }
  });

  app.get("/api/api-providers/presets", (_req, res) => {
    res.json({ ok: true, presets: API_PROVIDER_PRESETS });
  });
}
