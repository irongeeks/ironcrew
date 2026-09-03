import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "bootstrap" });

export type MessageIngressAuditOutcome =
  | "accepted"
  | "duplicate"
  | "idempotency_conflict"
  | "storage_busy"
  | "validation_error";

export type AuditRequestLike = {
  get(name: string): string | undefined;
  ip?: string;
  socket?: { remoteAddress?: string };
};

export type MessageIngressAuditInput = {
  endpoint: "/api/messages" | "/api/announcements" | "/api/directives" | "/api/inbox";
  req: AuditRequestLike;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
  outcome: MessageIngressAuditOutcome;
  statusCode: number;
  messageId?: string | null;
  detail?: string | null;
};

export type TaskCreationAuditInput = {
  taskId: string;
  taskTitle: string;
  taskStatus?: string | null;
  departmentId?: string | null;
  assignedAgentId?: string | null;
  sourceTaskId?: string | null;
  taskType?: string | null;
  projectPath?: string | null;
  trigger: string;
  triggerDetail?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  req?: AuditRequestLike | null;
  body?: Record<string, unknown> | null;
};

type MessageIngressAuditEntry = {
  id: string;
  created_at: number;
  endpoint: string;
  method: "POST";
  status_code: number;
  outcome: MessageIngressAuditOutcome;
  idempotency_key: string | null;
  request_id: string | null;
  message_id: string | null;
  payload_hash: string;
  request_ip: string | null;
  user_agent: string | null;
  detail: string | null;
  prev_hash: string;
  chain_hash: string;
};

type DbLike = Pick<DatabaseSync, "prepare">;

type WithSqliteBusyRetry = <T>(operation: string, fn: () => T) => Promise<T>;

type SecurityAuditDeps = {
  db: DbLike;
  logsDir: string;
  nowMs: () => number;
  withSqliteBusyRetry: WithSqliteBusyRetry;
};

class SecurityAuditLogWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityAuditLogWriteError";
  }
}

function canonicalizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeAuditValue(item));
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalizeAuditValue(src[key]);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && value.length > 8_000) {
    return `${value.slice(0, 8_000)}...[truncated:${value.length}]`;
  }
  return value;
}

function stableAuditJson(value: unknown): string {
  try {
    return JSON.stringify(canonicalizeAuditValue(value));
  } catch {
    return JSON.stringify(String(value));
  }
}

function normalizeAuditText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...[truncated:${trimmed.length}]`;
}

function resolveAuditRequestId(
  req: { get(name: string): string | undefined },
  body: Record<string, unknown>,
): string | null {
  const candidates: unknown[] = [
    body.request_id,
    body.requestId,
    req.get("x-request-id"),
    req.get("x-correlation-id"),
    req.get("traceparent"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200);
  }
  return null;
}

function resolveAuditRequestIp(req: AuditRequestLike): string | null {
  const forwarded = req.get("x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  if (typeof req.ip === "string" && req.ip.trim()) {
    return req.ip.trim().slice(0, 128);
  }
  if (typeof req.socket?.remoteAddress === "string" && req.socket.remoteAddress.trim()) {
    return req.socket.remoteAddress.trim().slice(0, 128);
  }
  return null;
}

export function createSecurityAuditTools(deps: SecurityAuditDeps) {
  const { db, logsDir, nowMs, withSqliteBusyRetry } = deps;

  const securityAuditLogPath = path.join(logsDir, "security-audit.ndjson");
  const securityAuditFallbackLogPath = path.join(logsDir, "security-audit-fallback.ndjson");
  const SECURITY_AUDIT_CHAIN_SEED = process.env.SECURITY_AUDIT_CHAIN_SEED?.trim() || "office-zero-security-audit-v1";
  const SECURITY_AUDIT_CHAIN_KEY = process.env.SECURITY_AUDIT_CHAIN_KEY ?? "";

  function computeAuditChainHash(
    prevHash: string,
    entry: Omit<MessageIngressAuditEntry, "prev_hash" | "chain_hash">,
  ): string {
    const hasher = createHash("sha256");
    hasher.update(SECURITY_AUDIT_CHAIN_SEED, "utf8");
    hasher.update("|", "utf8");
    hasher.update(prevHash, "utf8");
    hasher.update("|", "utf8");
    if (SECURITY_AUDIT_CHAIN_KEY) {
      hasher.update(SECURITY_AUDIT_CHAIN_KEY, "utf8");
      hasher.update("|", "utf8");
    }
    hasher.update(stableAuditJson(entry), "utf8");
    return hasher.digest("hex");
  }

  function loadSecurityAuditPrevHash(): string {
    try {
      if (!fs.existsSync(securityAuditLogPath)) return "GENESIS";
      const raw = fs.readFileSync(securityAuditLogPath, "utf8").trim();
      if (!raw) return "GENESIS";
      const lines = raw.split(/\r?\n/);
      for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
        const line = lines[idx]?.trim();
        if (!line) continue;
        const parsed = JSON.parse(line) as { chain_hash?: unknown };
        if (typeof parsed.chain_hash === "string" && parsed.chain_hash.trim()) {
          return parsed.chain_hash.trim();
        }
      }
    } catch (err) {
      log.warn({ err }, "security audit chain bootstrap failed");
    }
    return "GENESIS";
  }

  let securityAuditPrevHash = loadSecurityAuditPrevHash();

  function appendSecurityAuditFallbackLog(payload: unknown): boolean {
    const line = `${stableAuditJson(payload)}\n`;
    try {
      fs.appendFileSync(securityAuditFallbackLogPath, line, { encoding: "utf8", mode: 0o600 });
      return true;
    } catch (fallbackErr) {
      try {
        process.stderr.write(`[OctoOffice] security audit fallback append failed: ${String(fallbackErr)}\n${line}`);
        // Fail closed when neither primary nor fallback file append succeeds.
        return false;
      } catch {
        return false;
      }
    }
  }

  function appendSecurityAuditLog(entry: Omit<MessageIngressAuditEntry, "prev_hash" | "chain_hash">): void {
    const prevHash = securityAuditPrevHash;
    const chainHash = computeAuditChainHash(prevHash, entry);
    const line = JSON.stringify({ ...entry, prev_hash: prevHash, chain_hash: chainHash });
    try {
      fs.appendFileSync(securityAuditLogPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      securityAuditPrevHash = chainHash;
    } catch (err) {
      const fallbackOk = appendSecurityAuditFallbackLog({
        ...entry,
        prev_hash: prevHash,
        chain_hash: chainHash,
        fallback_reason: String(err),
        fallback_created_at: nowMs(),
      });
      const fallbackStatus = fallbackOk ? "fallback_saved" : "fallback_failed";
      throw new SecurityAuditLogWriteError(`security audit append failed (${fallbackStatus}): ${String(err)}`);
    }
  }

  function recordMessageIngressAudit(input: MessageIngressAuditInput): void {
    const payloadHash = createHash("sha256").update(stableAuditJson(input.body), "utf8").digest("hex");
    const entry: Omit<MessageIngressAuditEntry, "prev_hash" | "chain_hash"> = {
      id: randomUUID(),
      created_at: nowMs(),
      endpoint: input.endpoint,
      method: "POST",
      status_code: input.statusCode,
      outcome: input.outcome,
      idempotency_key: input.idempotencyKey,
      request_id: resolveAuditRequestId(input.req, input.body),
      message_id: input.messageId ?? null,
      payload_hash: payloadHash,
      request_ip: resolveAuditRequestIp(input.req),
      user_agent: normalizeAuditText(input.req.get("user-agent"), 200),
      detail: normalizeAuditText(input.detail),
    };
    appendSecurityAuditLog(entry);
  }

  function recordMessageIngressAuditOr503(
    res: { status(code: number): { json(payload: unknown): unknown } },
    input: MessageIngressAuditInput,
  ): boolean {
    try {
      recordMessageIngressAudit(input);
      return true;
    } catch (err) {
      log.error({ err }, "security audit unavailable");
      res.status(503).json({ error: "audit_log_unavailable", retryable: true });
      return false;
    }
  }

  async function rollbackMessageInsertAfterAuditFailure(messageId: string): Promise<void> {
    await withSqliteBusyRetry("messages.audit_rollback", () => {
      db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    });
  }

  async function recordAcceptedIngressAuditOrRollback(
    res: { status(code: number): { json(payload: unknown): unknown } },
    input: Omit<MessageIngressAuditInput, "messageId">,
    messageId: string,
  ): Promise<boolean> {
    if (recordMessageIngressAuditOr503(res, { ...input, messageId })) return true;
    try {
      await rollbackMessageInsertAfterAuditFailure(messageId);
    } catch (rollbackErr) {
      log.error({ err: rollbackErr, messageId }, "rollback after audit failure failed");
    }
    return false;
  }

  function recordTaskCreationAudit(input: TaskCreationAuditInput): void {
    try {
      const body = input.body && typeof input.body === "object" ? input.body : null;
      const payloadForHash: Record<string, unknown> = {
        trigger: input.trigger,
        trigger_detail: input.triggerDetail ?? null,
        actor_type: input.actorType ?? null,
        actor_id: input.actorId ?? null,
        actor_name: input.actorName ?? null,
        body,
      };
      const payloadJson = stableAuditJson(payloadForHash);
      const payloadHash = createHash("sha256").update(payloadJson, "utf8").digest("hex");

      const requestId = input.req ? resolveAuditRequestId(input.req, body ?? {}) : null;
      const requestIp = input.req ? resolveAuditRequestIp(input.req) : null;
      const userAgent = input.req ? normalizeAuditText(input.req.get("user-agent"), 200) : null;

      db.prepare(
        `
      INSERT INTO task_creation_audits (
        id, task_id, task_title, task_status, department_id, assigned_agent_id, source_task_id,
        task_type, project_path, trigger, trigger_detail, actor_type, actor_id, actor_name,
        request_id, request_ip, user_agent, payload_hash, payload_preview, completed, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      ).run(
        randomUUID(),
        input.taskId,
        normalizeAuditText(input.taskTitle, 500),
        normalizeAuditText(input.taskStatus ?? null, 64),
        normalizeAuditText(input.departmentId ?? null, 100),
        normalizeAuditText(input.assignedAgentId ?? null, 100),
        normalizeAuditText(input.sourceTaskId ?? null, 100),
        normalizeAuditText(input.taskType ?? null, 100),
        normalizeAuditText(input.projectPath ?? null, 500),
        normalizeAuditText(input.trigger, 120),
        normalizeAuditText(input.triggerDetail ?? null, 500),
        normalizeAuditText(input.actorType ?? null, 64),
        normalizeAuditText(input.actorId ?? null, 100),
        normalizeAuditText(input.actorName ?? null, 200),
        requestId,
        requestIp,
        userAgent,
        payloadHash,
        normalizeAuditText(payloadJson, 4000),
        0,
        nowMs(),
      );
    } catch (err) {
      log.warn({ err }, "task creation audit failed");
    }
  }

  function setTaskCreationAuditCompletion(taskId: string, completed: boolean): void {
    try {
      db.prepare("UPDATE task_creation_audits SET completed = ? WHERE task_id = ?").run(completed ? 1 : 0, taskId);
    } catch (err) {
      log.warn({ err }, "task creation audit completion update failed");
    }
  }

  return {
    recordMessageIngressAuditOr503,
    recordAcceptedIngressAuditOrRollback,
    recordTaskCreationAudit,
    setTaskCreationAuditCompletion,
  };
}
