/**
 * Iron Command OS — sandbox grant store.
 *
 * A grant is what makes `elevated` CLI permission mode reachable
 * (server/ironcommand/policy/runtime-permissions.ts). This module is the
 * only place a grant is created, and it enforces the rule that matters:
 * **a grant can only be minted from an owner-decided, still-live
 * "sandbox_elevation" approval.** There is no other path to elevation —
 * not a config flag, not an agent request on its own, not a default.
 *
 * Every mint and every revoke is audited, because elevating a CLI's
 * capability is exactly the kind of action docs/THREAT_MODEL.md T-01
 * exists to constrain.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { appendAuditEvent } from "./audit.ts";
import { clampGrantExpiry, sandboxGrantSchema, type SandboxGrant } from "../policy/runtime-permissions.ts";
import type { ApprovalRow } from "../policy/approval-policy.ts";

export interface SandboxGrantRow {
  id: string;
  company_id: string;
  approval_id: string;
  approved_by: string;
  reason: string;
  providers_json: string;
  task_id: string | null;
  workspace_path: string | null;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

function toDomain(row: SandboxGrantRow): SandboxGrant {
  return sandboxGrantSchema.parse({
    grantId: row.id,
    companyId: row.company_id,
    approvedBy: row.approved_by,
    approvalId: row.approval_id,
    reason: row.reason,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    providers: JSON.parse(row.providers_json) as string[],
    taskId: row.task_id ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
  });
}

export class SandboxGrantMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxGrantMintError";
  }
}

export class SandboxGrantStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Mint a grant from an approved "sandbox_elevation" approval.
   *
   * Refuses — loudly, not by silently degrading — unless the approval:
   *   - exists,
   *   - belongs to the same company,
   *   - has type "sandbox_elevation" (an approval for a different action,
   *     e.g. a bank transfer, can never authorise CLI elevation),
   *   - is currently "approved" (not pending, rejected, expired, cancelled).
   *
   * The grant's expiry is clamped to MAX_SANDBOX_GRANT_MS regardless of what
   * is requested — `resolvePermissionMode()` re-clamps too, but failing loud
   * here means an operator sees the real ceiling immediately rather than a
   * silently shortened grant discovered later.
   */
  mintFromApproval(input: {
    approval: ApprovalRow;
    providers: string[];
    requestedDurationMs: number;
    taskId?: string | null;
    workspacePath?: string | null;
    now?: number;
  }): SandboxGrantRow {
    const { approval } = input;
    const now = input.now ?? Date.now();

    if (approval.approval_type !== "sandbox_elevation") {
      throw new SandboxGrantMintError(
        `Approval ${approval.id} is type "${approval.approval_type}", not "sandbox_elevation"; ` +
          `it cannot authorise CLI permission elevation.`,
      );
    }
    if (approval.status !== "approved") {
      throw new SandboxGrantMintError(
        `Approval ${approval.id} is "${approval.status}", not "approved"; no grant can be minted from it.`,
      );
    }
    if (input.providers.length === 0) {
      throw new SandboxGrantMintError("A grant must cover at least one runtime provider.");
    }

    const id = newId("grant");
    const issuedAt = now;
    const expiresAt = clampGrantExpiry(issuedAt, issuedAt + input.requestedDurationMs);

    this.db
      .prepare(
        `INSERT INTO ic_sandbox_grants
           (id, company_id, approval_id, approved_by, reason, providers_json,
            task_id, workspace_path, issued_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        approval.company_id,
        approval.id,
        approval.decided_by ?? "owner",
        approval.summary,
        JSON.stringify(input.providers),
        input.taskId ?? null,
        input.workspacePath ?? null,
        issuedAt,
        expiresAt,
      );

    appendAuditEvent(this.db, {
      companyId: approval.company_id,
      actorType: "owner",
      actorId: approval.decided_by ?? "owner",
      action: "sandbox_grant.minted",
      entityType: "sandbox_grant",
      entityId: id,
      approvalId: approval.id,
      taskId: input.taskId ?? null,
      details: { providers: input.providers, issuedAt, expiresAt },
    });

    return this.get(id)!;
  }

  get(id: string): SandboxGrantRow | null {
    return (
      (this.db.prepare("SELECT * FROM ic_sandbox_grants WHERE id = ?").get(id) as SandboxGrantRow | undefined) ?? null
    );
  }

  /**
   * The most relevant live grant covering (companyId, provider) and,
   * when given, scoped to exactly this task or with no task scope at all.
   * "Live" means unrevoked and not yet past its own expiry — the caller
   * still re-validates through resolvePermissionMode(), this is a narrowing
   * query, not the authority.
   */
  findLive(input: { companyId: string; provider: string; taskId?: string | null; now?: number }): SandboxGrant | null {
    const now = input.now ?? Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM ic_sandbox_grants
          WHERE company_id = ?
            AND revoked_at IS NULL
            AND expires_at > ?
            AND (task_id IS NULL OR task_id = ?)
          ORDER BY issued_at DESC`,
      )
      .all(input.companyId, now, input.taskId ?? null) as unknown as SandboxGrantRow[];

    for (const row of rows) {
      const providers: string[] = JSON.parse(row.providers_json);
      if (providers.map((p) => p.toLowerCase()).includes(input.provider.toLowerCase())) {
        return toDomain(row);
      }
    }
    return null;
  }

  /** Revoke a grant early. Idempotent — revoking an already-revoked grant is a no-op. */
  revoke(id: string, actorId: string, reason = ""): SandboxGrantRow | null {
    const row = this.get(id);
    if (!row) return null;
    if (row.revoked_at !== null) return row;

    this.db.prepare("UPDATE ic_sandbox_grants SET revoked_at = ? WHERE id = ?").run(Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: row.company_id,
      actorType: "owner",
      actorId,
      action: "sandbox_grant.revoked",
      entityType: "sandbox_grant",
      entityId: id,
      approvalId: row.approval_id,
      taskId: row.task_id,
      details: { reason },
    });

    return this.get(id);
  }

  listActive(companyId: string, now = Date.now()): SandboxGrantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ic_sandbox_grants
          WHERE company_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY issued_at DESC`,
      )
      .all(companyId, now) as unknown as SandboxGrantRow[];
  }
}
