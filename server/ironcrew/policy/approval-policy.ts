/**
 * IronCrew — approval engine.
 *
 * The rule that matters: a high-risk action is not "recommended" by an agent
 * and then carried out. It is technically blocked until an owner decision
 * exists. `assertActionPermitted()` throws, so a caller cannot proceed by
 * ignoring a boolean.
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { newId } from "../domain/ids.ts";
import { appendAuditEvent } from "../domain/audit.ts";

/**
 * Action classes that always require an owner decision, per the company
 * policy. Kept as data so config can extend it, but these entries are the
 * non-negotiable floor and are never removed at runtime.
 */
export const ALWAYS_APPROVAL_REQUIRED = [
  "bank_transfer",
  "tax_filing",
  "contract_execution",
  "legally_binding_statement",
  "external_customer_commitment",
  "pricing_or_discount_override",
  "production_deployment",
  "tier0_change",
  "irreversible_data_change",
  "secret_disclosure",
  "permission_change",
  "agent_lifecycle_change",
  "sandbox_elevation",
] as const;

export type ApprovalType = (typeof ALWAYS_APPROVAL_REQUIRED)[number] | string;

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const approvalRequestSchema = z.object({
  approvalType: z.string().min(1),
  requestedBy: z.string().min(1),
  summary: z.string().min(1),
  riskLevel: z.enum(RISK_LEVELS).default("high"),
  impact: z.string().default(""),
  rollbackPlan: z.string().default(""),
  proposedAction: z.string().default(""),
  evidence: z.array(z.string()).default([]),
  expiresAt: z.number().int().positive().nullable().default(null),
});

export type ApprovalRequestInput = z.input<typeof approvalRequestSchema>;

export interface ApprovalRow {
  id: string;
  company_id: string;
  task_id: string | null;
  run_id: string | null;
  requested_by: string;
  approval_type: string;
  summary: string;
  risk_level: RiskLevel;
  impact: string;
  rollback_plan: string;
  proposed_action: string;
  evidence_json: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: number | null;
  expires_at: number | null;
  correlation_id: string;
  created_at: number;
}

export function requiresApproval(approvalType: string): boolean {
  return (ALWAYS_APPROVAL_REQUIRED as readonly string[]).includes(approvalType);
}

export class ApprovalRequiredError extends Error {
  readonly approvalId: string | null;
  readonly approvalType: string;
  constructor(approvalType: string, approvalId: string | null, detail: string) {
    super(`Action "${approvalType}" is blocked pending owner approval: ${detail}`);
    this.name = "ApprovalRequiredError";
    this.approvalId = approvalId;
    this.approvalType = approvalType;
  }
}

export class ApprovalEngine {
  constructor(private readonly db: DatabaseSync) {}

  request(
    companyId: string,
    input: ApprovalRequestInput,
    opts: { taskId?: string | null; runId?: string | null; correlationId?: string } = {},
  ): ApprovalRow {
    const parsed = approvalRequestSchema.parse(input);
    const id = newId("apr");

    this.db
      .prepare(
        `INSERT INTO crew_approvals
           (id, company_id, task_id, run_id, requested_by, approval_type, summary,
            risk_level, impact, rollback_plan, proposed_action, evidence_json,
            status, expires_at, correlation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(
        id,
        companyId,
        opts.taskId ?? null,
        opts.runId ?? null,
        parsed.requestedBy,
        parsed.approvalType,
        parsed.summary,
        parsed.riskLevel,
        parsed.impact,
        parsed.rollbackPlan,
        parsed.proposedAction,
        JSON.stringify(parsed.evidence),
        parsed.expiresAt,
        opts.correlationId ?? "",
      );

    appendAuditEvent(this.db, {
      companyId,
      actorType: "agent",
      actorId: parsed.requestedBy,
      action: "approval.requested",
      entityType: "approval",
      entityId: id,
      taskId: opts.taskId ?? null,
      runId: opts.runId ?? null,
      approvalId: id,
      correlationId: opts.correlationId ?? "",
      details: { approvalType: parsed.approvalType, riskLevel: parsed.riskLevel, summary: parsed.summary },
    });

    return this.get(id)!;
  }

  get(id: string): ApprovalRow | null {
    return (this.db.prepare("SELECT * FROM crew_approvals WHERE id = ?").get(id) as ApprovalRow | undefined) ?? null;
  }

  listPending(companyId: string, now = Date.now()): ApprovalRow[] {
    this.expireOverdue(companyId, now);
    return this.db
      .prepare("SELECT * FROM crew_approvals WHERE company_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(companyId) as unknown as ApprovalRow[];
  }

  /**
   * Record an owner decision. Guarded on status='pending' so a decision cannot
   * be overwritten and a race between two UI clicks resolves to one winner.
   */
  decide(approvalId: string, decision: "approved" | "rejected", decidedBy: string, reason = ""): ApprovalRow | null {
    const existing = this.get(approvalId);
    if (!existing) return null;

    const res = this.db
      .prepare(
        `UPDATE crew_approvals
            SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, decidedBy, reason, Date.now(), approvalId);

    if (res.changes !== 1) return null;

    appendAuditEvent(this.db, {
      companyId: existing.company_id,
      actorType: "owner",
      actorId: decidedBy,
      action: `approval.${decision}`,
      entityType: "approval",
      entityId: approvalId,
      taskId: existing.task_id,
      runId: existing.run_id,
      approvalId,
      outcome: decision === "approved" ? "ok" : "denied",
      correlationId: existing.correlation_id,
      details: { approvalType: existing.approval_type, reason },
    });

    return this.get(approvalId);
  }

  /** Mark overdue pending approvals as expired. */
  expireOverdue(companyId: string, now = Date.now()): number {
    const res = this.db
      .prepare(
        `UPDATE crew_approvals SET status = 'expired'
          WHERE company_id = ? AND status = 'pending'
            AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(companyId, now);
    return Number(res.changes);
  }

  /**
   * True only when an approval for this exact action exists, is approved and
   * has not expired.
   */
  isApproved(companyId: string, approvalType: string, taskId: string | null, now = Date.now()): boolean {
    const row = this.db
      .prepare(
        `SELECT * FROM crew_approvals
          WHERE company_id = ? AND approval_type = ? AND status = 'approved'
            AND (task_id IS ? OR task_id = ?)
          ORDER BY decided_at DESC LIMIT 1`,
      )
      .get(companyId, approvalType, taskId, taskId) as ApprovalRow | undefined;
    if (!row) return false;
    if (row.expires_at !== null && row.expires_at <= now) return false;
    return true;
  }

  /**
   * The enforcement point. Throws unless the action is either low-risk or
   * covered by a live approval.
   */
  assertActionPermitted(companyId: string, approvalType: string, taskId: string | null, now = Date.now()): void {
    if (!requiresApproval(approvalType)) return;
    if (this.isApproved(companyId, approvalType, taskId, now)) return;

    const pending = this.db
      .prepare(
        `SELECT id FROM crew_approvals
          WHERE company_id = ? AND approval_type = ? AND status = 'pending'
            AND (task_id IS ? OR task_id = ?)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(companyId, approvalType, taskId, taskId) as { id: string } | undefined;

    appendAuditEvent(this.db, {
      companyId,
      actorType: "system",
      actorId: "approval-engine",
      action: "approval.blocked",
      entityType: "approval",
      entityId: pending?.id ?? "",
      taskId,
      outcome: "denied",
      details: { approvalType },
    });

    throw new ApprovalRequiredError(
      approvalType,
      pending?.id ?? null,
      pending ? `approval ${pending.id} is still pending` : "no approval has been requested",
    );
  }
}
