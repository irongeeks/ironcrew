/**
 * IronCrew — append-only, hash-chained audit log.
 *
 * Every write or externally-visible action must land here with an actor, a
 * correlation id and a redacted parameter set (docs/THREAT_MODEL.md T-06).
 *
 * Tamper-evidence: each entry hashes (company, seq, actor, action, entity,
 * outcome, details, timestamp, prev_hash). Editing or deleting a historical row
 * breaks the chain from that point on, which `verifyAuditChain()` detects.
 * This does not make tampering impossible for someone with raw DB access — it
 * makes it detectable, which is the achievable property for a local-first,
 * single-file deployment.
 *
 * There is deliberately no update or delete function in this module.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { redactValue } from "../security/redaction.ts";

export type ActorType = "owner" | "agent" | "system" | "routine";

export interface AuditInput {
  companyId: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  taskId?: string | null;
  runId?: string | null;
  approvalId?: string | null;
  outcome?: "ok" | "denied" | "failed";
  details?: Record<string, unknown>;
  correlationId?: string;
}

export interface AuditEvent extends Required<Omit<AuditInput, "details" | "taskId" | "runId" | "approvalId">> {
  id: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
  approvalId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
  createdAt: number;
}

/** Canonical JSON: keys sorted recursively so hashing is stable. */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      out[key] = walk((node as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function computeEntryHash(fields: {
  companyId: string;
  seq: number;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  outcome: string;
  detailsJson: string;
  createdAt: number;
  prevHash: string;
}): string {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

/**
 * Append an audit entry. Details are deep-redacted before storage, so a leaked
 * database dump cannot become a credential dump.
 */
export function appendAuditEvent(db: DatabaseSync, input: AuditInput): AuditEvent {
  const prev = db
    .prepare("SELECT seq, entry_hash FROM crew_audit_events WHERE company_id = ? ORDER BY seq DESC LIMIT 1")
    .get(input.companyId) as { seq: number; entry_hash: string } | undefined;

  const seq = (prev?.seq ?? 0) + 1;
  const prevHash = prev?.entry_hash ?? "";
  const createdAt = Date.now();
  const details = redactValue(input.details ?? {});
  const detailsJson = canonicalJson(details);

  const entityType = input.entityType ?? "";
  const entityId = input.entityId ?? "";
  const outcome = input.outcome ?? "ok";

  const entryHash = computeEntryHash({
    companyId: input.companyId,
    seq,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType,
    entityId,
    outcome,
    detailsJson,
    createdAt,
    prevHash,
  });

  const id = newId("aud");
  db.prepare(
    `INSERT INTO crew_audit_events
       (id, company_id, seq, actor_type, actor_id, action, entity_type, entity_id,
        task_id, run_id, approval_id, outcome, details_json, correlation_id,
        prev_hash, entry_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.companyId,
    seq,
    input.actorType,
    input.actorId,
    input.action,
    entityType,
    entityId,
    input.taskId ?? null,
    input.runId ?? null,
    input.approvalId ?? null,
    outcome,
    detailsJson,
    input.correlationId ?? "",
    prevHash,
    entryHash,
    createdAt,
  );

  return {
    id,
    companyId: input.companyId,
    seq,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType,
    entityId,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    approvalId: input.approvalId ?? null,
    outcome,
    details,
    correlationId: input.correlationId ?? "",
    prevHash,
    entryHash,
    createdAt,
  };
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** Sequence number of the first broken link, when invalid. */
  brokenAtSeq?: number;
  reason?: string;
}

/** Recompute the whole chain for a company and report the first divergence. */
export function verifyAuditChain(db: DatabaseSync, companyId: string): ChainVerification {
  const rows = db
    .prepare(
      `SELECT seq, actor_type, actor_id, action, entity_type, entity_id, outcome,
              details_json, created_at, prev_hash, entry_hash
         FROM crew_audit_events WHERE company_id = ? ORDER BY seq ASC`,
    )
    .all(companyId) as unknown as Array<{
    seq: number;
    actor_type: string;
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    outcome: string;
    details_json: string;
    created_at: number;
    prev_hash: string;
    entry_hash: string;
  }>;

  let expectedPrev = "";
  let expectedSeq = 1;

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        valid: false,
        checked: expectedSeq - 1,
        brokenAtSeq: row.seq,
        reason: `sequence gap: expected ${expectedSeq}, found ${row.seq}`,
      };
    }
    if (row.prev_hash !== expectedPrev) {
      return {
        valid: false,
        checked: expectedSeq - 1,
        brokenAtSeq: row.seq,
        reason: "prev_hash does not match the preceding entry",
      };
    }
    const recomputed = computeEntryHash({
      companyId,
      seq: row.seq,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      outcome: row.outcome,
      detailsJson: row.details_json,
      createdAt: row.created_at,
      prevHash: row.prev_hash,
    });
    if (recomputed !== row.entry_hash) {
      return {
        valid: false,
        checked: expectedSeq - 1,
        brokenAtSeq: row.seq,
        reason: "entry content does not match its stored hash",
      };
    }
    expectedPrev = row.entry_hash;
    expectedSeq += 1;
  }

  return { valid: true, checked: rows.length };
}

export function listAuditEvents(
  db: DatabaseSync,
  companyId: string,
  opts: { limit?: number; taskId?: string } = {},
): Array<Record<string, unknown>> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  if (opts.taskId) {
    return db
      .prepare("SELECT * FROM crew_audit_events WHERE company_id = ? AND task_id = ? ORDER BY seq DESC LIMIT ?")
      .all(companyId, opts.taskId, limit) as unknown as Array<Record<string, unknown>>;
  }
  return db
    .prepare("SELECT * FROM crew_audit_events WHERE company_id = ? ORDER BY seq DESC LIMIT ?")
    .all(companyId, limit) as unknown as Array<Record<string, unknown>>;
}
