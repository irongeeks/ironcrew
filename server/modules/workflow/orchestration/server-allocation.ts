import { randomUUID } from "node:crypto";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => any;
    all: (...args: unknown[]) => any[];
    run: (...args: unknown[]) => { changes?: number };
  };
};

export const SERVER_TYPES = ["comfyui", "llm_api", "database", "file_storage", "ssh_remote"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];
export type ServerStatus = "online" | "offline" | "busy" | "idle";

type RequestResult =
  | { state: "skipped" }
  | { state: "allocated"; allocation_id: string; server_id: string; requested_server_type: ServerType }
  | { state: "queued"; allocation_id: string; queue_position: number; requested_server_type: ServerType };

export function listServerTypePresets(): Array<{
  type: ServerType;
  label: string;
  description: string;
  examples: string[];
}> {
  return [
    {
      type: "comfyui",
      label: "ComfyUI",
      description: "Image/video generation node server",
      examples: ["http://127.0.0.1:8188", "https://comfy.internal/api"],
    },
    {
      type: "llm_api",
      label: "LLM API",
      description: "OpenAI, Anthropic, or local LLM gateway",
      examples: ["https://api.openai.com/v1", "https://api.anthropic.com", "http://localhost:11434/v1"],
    },
    {
      type: "database",
      label: "Database",
      description: "Operational or analytics database endpoint",
      examples: ["postgres://db.internal:5432/app", "mysql://db.internal:3306/app"],
    },
    {
      type: "file_storage",
      label: "File Storage",
      description: "Blob/object storage gateway",
      examples: ["https://s3.amazonaws.com/bucket", "https://minio.internal"],
    },
    {
      type: "ssh_remote",
      label: "SSH Remote",
      description: "General-purpose remote server (SSH/Tailscale)",
      examples: ["100.101.102.103", "myserver.tailnet"],
    },
  ];
}

export function normalizeServerType(raw: unknown): ServerType | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase() as ServerType;
  return SERVER_TYPES.includes(trimmed) ? trimmed : null;
}

export function inferRequestedServerType(input: {
  explicitType?: unknown;
  provider?: unknown;
  workflowMetaJson?: unknown;
  taskType?: unknown;
}): ServerType | null {
  const explicit = normalizeServerType(input.explicitType);
  if (explicit) return explicit;

  const taskType = typeof input.taskType === "string" ? input.taskType.trim().toLowerCase() : "";
  if (taskType.includes("mockup") || taskType.includes("design") || taskType.includes("image")) return "comfyui";

  const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "";
  // Only the "api" provider (backend-driven LLM calls) needs a managed llm_api server.
  // CLI providers (claude, codex, gemini, opencode, copilot, antigravity) handle their
  // own API authentication and don't require a centrally allocated llm_api server.
  if (provider === "api") {
    return "llm_api";
  }

  if (typeof input.workflowMetaJson === "string" && input.workflowMetaJson.trim()) {
    try {
      const parsed = JSON.parse(input.workflowMetaJson) as Record<string, unknown>;
      const fromMeta = normalizeServerType(parsed.server_type ?? parsed.serverType);
      if (fromMeta) return fromMeta;
    } catch {
      // ignore malformed JSON
    }
  }
  return null;
}

function loadAllowedServerIds(db: DbLike, agentId: string | null): string[] | null {
  if (!agentId) return null;
  const rows = db
    .prepare("SELECT server_id FROM agent_server_access WHERE agent_id = ? ORDER BY server_id ASC")
    .all(agentId) as Array<{ server_id?: string | null }>;
  const ids = rows.map((row) => String(row.server_id ?? "").trim()).filter((id) => id.length > 0);
  return ids.length > 0 ? ids : null;
}

function findAvailableServer(
  db: DbLike,
  serverType: ServerType,
  agentId: string | null,
): {
  id: string;
  max_concurrent_jobs: number;
  current_jobs: number;
  status: ServerStatus;
} | null {
  const allowedServerIds = loadAllowedServerIds(db, agentId);
  const hasAllowList = Array.isArray(allowedServerIds) && allowedServerIds.length > 0;
  const allowClause = hasAllowList ? `AND id IN (${allowedServerIds.map(() => "?").join(", ")})` : "";
  const query = `
      SELECT id, max_concurrent_jobs, current_jobs, status
      FROM servers
      WHERE enabled = 1
        AND type = ?
        AND status != 'offline'
        AND current_jobs < max_concurrent_jobs
        ${allowClause}
      ORDER BY current_jobs ASC, updated_at ASC, created_at ASC
      LIMIT 1
    `;
  const args: unknown[] = [serverType, ...(allowedServerIds ?? [])];
  const row = db.prepare(query).get(...args) as
    | {
        id: string;
        max_concurrent_jobs: number;
        current_jobs: number;
        status: ServerStatus;
      }
    | undefined;
  return row ?? null;
}

function reconcileServerStatus(currentJobs: number, maxConcurrentJobs: number, online = true): ServerStatus {
  if (!online) return "offline";
  if (currentJobs >= Math.max(1, maxConcurrentJobs)) return "busy";
  return "idle";
}

export function requestServerAccess(
  db: DbLike,
  input: {
    nowMs: number;
    taskId: string;
    agentId: string | null;
    requestedServerType: ServerType | null;
    queueReason?: string | null;
  },
): RequestResult {
  if (!input.requestedServerType) return { state: "skipped" };

  const existing = db
    .prepare(
      `
      SELECT id, status, server_id, requested_server_type
      FROM server_allocations
      WHERE task_id = ?
        AND requested_server_type = ?
        AND status IN ('queued','active')
      ORDER BY requested_at DESC
      LIMIT 1
    `,
    )
    .get(input.taskId, input.requestedServerType) as
    | {
        id: string;
        status: "queued" | "active";
        server_id: string | null;
        requested_server_type: ServerType;
      }
    | undefined;
  if (existing) {
    if (existing.status === "active" && existing.server_id) {
      return {
        state: "allocated",
        allocation_id: existing.id,
        server_id: existing.server_id,
        requested_server_type: existing.requested_server_type,
      };
    }
    const queuePos = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM server_allocations WHERE requested_server_type = ? AND status = 'queued' AND requested_at <= (SELECT requested_at FROM server_allocations WHERE id = ?)",
      )
      .get(input.requestedServerType, existing.id) as { cnt?: number } | undefined;
    return {
      state: "queued",
      allocation_id: existing.id,
      queue_position: Number(queuePos?.cnt ?? 1),
      requested_server_type: existing.requested_server_type,
    };
  }

  const available = findAvailableServer(db, input.requestedServerType, input.agentId);
  const allocationId = randomUUID();
  if (available) {
    const nextJobs = Math.max(0, Number(available.current_jobs ?? 0)) + 1;
    const nextStatus = reconcileServerStatus(nextJobs, Number(available.max_concurrent_jobs ?? 1), true);
    db.prepare(
      `
      INSERT INTO server_allocations (
        id, server_id, task_id, agent_id, requested_server_type, status, requested_at, started_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `,
    ).run(allocationId, available.id, input.taskId, input.agentId, input.requestedServerType, input.nowMs, input.nowMs);
    db.prepare("UPDATE servers SET current_jobs = ?, status = ?, updated_at = ? WHERE id = ?").run(
      nextJobs,
      nextStatus,
      input.nowMs,
      available.id,
    );
    return {
      state: "allocated",
      allocation_id: allocationId,
      server_id: available.id,
      requested_server_type: input.requestedServerType,
    };
  }

  db.prepare(
    `
    INSERT INTO server_allocations (
      id, server_id, task_id, agent_id, requested_server_type, status, queue_reason, requested_at
    ) VALUES (?, NULL, ?, ?, ?, 'queued', ?, ?)
  `,
  ).run(allocationId, input.taskId, input.agentId, input.requestedServerType, input.queueReason ?? null, input.nowMs);
  const queueSize = db
    .prepare("SELECT COUNT(*) AS cnt FROM server_allocations WHERE requested_server_type = ? AND status = 'queued'")
    .get(input.requestedServerType) as { cnt?: number } | undefined;
  return {
    state: "queued",
    allocation_id: allocationId,
    queue_position: Math.max(1, Number(queueSize?.cnt ?? 1)),
    requested_server_type: input.requestedServerType,
  };
}

export function releaseServerAccess(
  db: DbLike,
  input: {
    nowMs: number;
    taskId: string;
    agentId?: string | null;
    reason?: string;
  },
): { released_allocations: number; touched_server_ids: string[] } {
  const rows = db
    .prepare(
      `
      SELECT id, server_id, status
      FROM server_allocations
      WHERE task_id = ?
        AND status IN ('queued','active')
        ${input.agentId ? "AND agent_id = ?" : ""}
      ORDER BY requested_at ASC
    `,
    )
    .all(...(input.agentId ? [input.taskId, input.agentId] : [input.taskId])) as Array<{
    id: string;
    server_id: string | null;
    status: "queued" | "active";
  }>;
  if (rows.length === 0) return { released_allocations: 0, touched_server_ids: [] };

  const touchedServerIds: string[] = [];
  for (const row of rows) {
    db.prepare(
      "UPDATE server_allocations SET status = 'released', released_reason = ?, released_at = ? WHERE id = ?",
    ).run(input.reason ?? "task_finished", input.nowMs, row.id);
    if (row.status !== "active" || !row.server_id) continue;

    const server = db
      .prepare("SELECT id, current_jobs, max_concurrent_jobs, status FROM servers WHERE id = ?")
      .get(row.server_id) as
      | { id: string; current_jobs: number; max_concurrent_jobs: number; status: ServerStatus }
      | undefined;
    if (!server) continue;
    const nextJobs = Math.max(0, Number(server.current_jobs ?? 0) - 1);
    const nextStatus =
      server.status === "offline"
        ? "offline"
        : reconcileServerStatus(nextJobs, Number(server.max_concurrent_jobs ?? 1), true);
    db.prepare("UPDATE servers SET current_jobs = ?, status = ?, updated_at = ? WHERE id = ?").run(
      nextJobs,
      nextStatus,
      input.nowMs,
      row.server_id,
    );
    touchedServerIds.push(row.server_id);
  }

  return { released_allocations: rows.length, touched_server_ids: Array.from(new Set(touchedServerIds)) };
}

export function processQueuedServerAllocations(
  db: DbLike,
  nowMs: number,
): Array<{ allocation_id: string; task_id: string | null; agent_id: string | null; server_id: string }> {
  const queued = db
    .prepare(
      `
      SELECT id, task_id, agent_id, requested_server_type
      FROM server_allocations
      WHERE status = 'queued'
      ORDER BY requested_at ASC
    `,
    )
    .all() as Array<{ id: string; task_id: string | null; agent_id: string | null; requested_server_type: ServerType }>;

  const activated: Array<{
    allocation_id: string;
    task_id: string | null;
    agent_id: string | null;
    server_id: string;
  }> = [];
  for (const row of queued) {
    const available = findAvailableServer(db, row.requested_server_type, row.agent_id);
    if (!available) continue;

    db.prepare("UPDATE server_allocations SET status = 'active', server_id = ?, started_at = ? WHERE id = ?").run(
      available.id,
      nowMs,
      row.id,
    );
    const nextJobs = Math.max(0, Number(available.current_jobs ?? 0)) + 1;
    const nextStatus = reconcileServerStatus(nextJobs, Number(available.max_concurrent_jobs ?? 1), true);
    db.prepare("UPDATE servers SET current_jobs = ?, status = ?, updated_at = ? WHERE id = ?").run(
      nextJobs,
      nextStatus,
      nowMs,
      available.id,
    );
    activated.push({
      allocation_id: row.id,
      task_id: row.task_id,
      agent_id: row.agent_id,
      server_id: available.id,
    });
  }

  return activated;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

const PASSIVE_ENDPOINT_PROTOCOLS = new Set([
  "postgres:",
  "postgresql:",
  "mysql:",
  "mariadb:",
  "mongodb:",
  "redis:",
  "s3:",
  "gs:",
  "file:",
]);

function readAuthHeaders(authConfigJson: string | null): Record<string, string> {
  if (!authConfigJson) return {};
  try {
    const parsed = JSON.parse(authConfigJson) as Record<string, unknown>;
    const mode = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
    if (mode === "bearer") {
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      if (token) return { authorization: `Bearer ${token}` };
      return {};
    }
    if (mode === "header") {
      const header = typeof parsed.header === "string" ? parsed.header.trim() : "";
      const value = typeof parsed.value === "string" ? parsed.value.trim() : "";
      if (header && value) return { [header]: value };
      return {};
    }
    if (mode === "api_key") {
      const key = typeof parsed.key === "string" ? parsed.key.trim() : "";
      const header = typeof parsed.header === "string" ? parsed.header.trim() : "x-api-key";
      if (key) return { [header]: key };
      return {};
    }
  } catch {
    // ignore malformed auth config
  }
  return {};
}

function detectEndpointProtocol(endpointUrl: string): string {
  try {
    return new URL(endpointUrl).protocol.toLowerCase();
  } catch {
    const match = endpointUrl.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    return match ? `${match[1].toLowerCase()}:` : "";
  }
}

function buildHealthProbeCandidates(base: string, serverType: ServerType): string[] {
  if (serverType === "llm_api") {
    const isV1Base = /\/v1$/i.test(base);
    const candidates = isV1Base
      ? [base, `${base}/models`, `${base}/health`]
      : [base, `${base}/health`, `${base}/v1/models`, `${base}/models`];
    return Array.from(new Set(candidates));
  }
  return Array.from(new Set([base, `${base}/health`]));
}

async function checkEndpointHealth(
  endpointUrl: string,
  authConfigJson: string | null,
  serverType: ServerType,
): Promise<{ ok: boolean; error: string | null }> {
  const base = trimSlash(endpointUrl.trim());
  if (!base) return { ok: false, error: "missing_endpoint" };

  const protocol = detectEndpointProtocol(base);
  if (!protocol) return { ok: false, error: "invalid_endpoint" };
  if (protocol !== "http:" && protocol !== "https:") {
    if (PASSIVE_ENDPOINT_PROTOCOLS.has(protocol)) return { ok: true, error: null };
    return { ok: false, error: `unsupported_protocol_${protocol.slice(0, -1)}` };
  }

  if (isBlockedSsrfTarget(base, { allowLocal: true })) {
    return { ok: false, error: "blocked_ssrf_target" };
  }

  const headers = readAuthHeaders(authConfigJson);
  const candidates = buildHealthProbeCandidates(base, serverType);
  let lastError = "request_failed";
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(4_000),
      });
      if (resp.ok) return { ok: true, error: null };
      lastError = `http_${resp.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError };
}

export async function runServerHealthChecks(
  db: DbLike,
  nowMs: number,
  input?: { serverIds?: string[] | null },
): Promise<Array<{ id: string; status: ServerStatus; last_health_error: string | null }>> {
  const ids = Array.isArray(input?.serverIds) ? input!.serverIds.filter((value) => typeof value === "string") : [];
  const rows = ids.length
    ? (db
        .prepare(
          `
          SELECT id, type, endpoint_url, auth_config_json, ssh_config_json, enabled, current_jobs, max_concurrent_jobs
          FROM servers
          WHERE id IN (${ids.map(() => "?").join(",")})
        `,
        )
        .all(...ids) as Array<{
        id: string;
        type: ServerType;
        endpoint_url: string | null;
        auth_config_json: string | null;
        ssh_config_json: string | null;
        enabled: number;
        current_jobs: number;
        max_concurrent_jobs: number;
      }>)
    : (db
        .prepare(
          `
          SELECT id, type, endpoint_url, auth_config_json, ssh_config_json, enabled, current_jobs, max_concurrent_jobs
          FROM servers
        `,
        )
        .all() as Array<{
        id: string;
        type: ServerType;
        endpoint_url: string | null;
        auth_config_json: string | null;
        ssh_config_json: string | null;
        enabled: number;
        current_jobs: number;
        max_concurrent_jobs: number;
      }>);

  const results: Array<{ id: string; status: ServerStatus; last_health_error: string | null }> = [];
  for (const row of rows) {
    if (Number(row.enabled ?? 1) !== 1) {
      db.prepare("UPDATE servers SET status = 'offline', last_health_check_at = ?, updated_at = ? WHERE id = ?").run(
        nowMs,
        nowMs,
        row.id,
      );
      results.push({ id: row.id, status: "offline", last_health_error: "disabled" });
      continue;
    }

    const endpoint = typeof row.endpoint_url === "string" ? row.endpoint_url.trim() : "";
    if (!endpoint) {
      // For SSH-enabled servers, do an SSH connection check
      if (row.ssh_config_json) {
        try {
          const { SshConfigSchema } = await import("../ssh/types.ts");
          const { createSshConnector } = await import("../ssh/ssh-connector.ts");
          const parsed = SshConfigSchema.safeParse(JSON.parse(row.ssh_config_json));
          if (parsed.success) {
            const connector = createSshConnector(parsed.data);
            const ok = await connector.testConnection();
            const status = ok
              ? reconcileServerStatus(Number(row.current_jobs ?? 0), Number(row.max_concurrent_jobs ?? 1), true)
              : ("offline" as const);
            const lastError = ok ? null : "SSH connection failed";
            db.prepare(
              "UPDATE servers SET status = ?, last_health_error = ?, last_health_check_at = ?, updated_at = ? WHERE id = ?",
            ).run(status, lastError, nowMs, nowMs, row.id);
            results.push({ id: row.id, status, last_health_error: lastError });
            continue;
          }
        } catch {
          /* SSH check failed, fall through to default */
        }
      }
      // No endpoint and no SSH — assume healthy
      const status = reconcileServerStatus(Number(row.current_jobs ?? 0), Number(row.max_concurrent_jobs ?? 1), true);
      db.prepare(
        "UPDATE servers SET status = ?, last_health_error = NULL, last_health_check_at = ?, updated_at = ? WHERE id = ?",
      ).run(status, nowMs, nowMs, row.id);
      results.push({ id: row.id, status, last_health_error: null });
      continue;
    }

    const serverType = normalizeServerType(row.type) ?? "llm_api";
    const health = await checkEndpointHealth(endpoint, row.auth_config_json ?? null, serverType);
    const status = health.ok
      ? reconcileServerStatus(Number(row.current_jobs ?? 0), Number(row.max_concurrent_jobs ?? 1), true)
      : ("offline" as const);
    db.prepare(
      "UPDATE servers SET status = ?, last_health_error = ?, last_health_check_at = ?, updated_at = ? WHERE id = ?",
    ).run(status, health.error, nowMs, nowMs, row.id);
    results.push({ id: row.id, status, last_health_error: health.error });
  }

  return results;
}
