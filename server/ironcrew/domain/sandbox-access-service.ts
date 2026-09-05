import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ApprovalEngine, type ApprovalRow } from "../policy/approval-policy.ts";
import { ApprovalReviewStore } from "./approval-review-store.ts";
import { SandboxGrantStore, type SandboxGrantRow } from "./sandbox-grant-store.ts";
import { TaskStore } from "./task-store.ts";
import { ProjectStore } from "./project-store.ts";
import { RESOLVED_AGENT_SELECT } from "./agent-resolution.ts";
import {
  sandboxAccessRequestSchema,
  sandboxActionSchema,
  readSandboxAction,
  type SandboxAction,
} from "../policy/sandbox-access.ts";
import { sandboxGrantSchema, type SandboxGrant } from "../policy/runtime-permissions.ts";
import { appendAuditEvent } from "./audit.ts";

export class SandboxAccessError extends Error {}
export interface SandboxRunScope {
  companyId: string;
  taskId: string;
  agentId: string;
  projectId: string | null;
  provider: string;
  workspacePath: string;
  runId: string;
}

export class SandboxAccessService {
  private readonly approvals: ApprovalEngine;
  private readonly reviews: ApprovalReviewStore;
  readonly grants: SandboxGrantStore;
  constructor(private readonly db: DatabaseSync) {
    this.approvals = new ApprovalEngine(db);
    this.reviews = new ApprovalReviewStore(db);
    this.grants = new SandboxGrantStore(db);
  }
  request(companyId: string, input: unknown, actorId: string): ApprovalRow {
    if (!this.db.prepare("SELECT id FROM crew_users WHERE id=? AND role='owner' AND status='active'").get(actorId))
      throw new SandboxAccessError("Für Sandbox-Ausnahmen ist ein angemeldetes aktives Owner-Konto erforderlich.");
    const parsed = sandboxAccessRequestSchema.parse(input);
    const task = new TaskStore(this.db).get(parsed.taskId);
    if (!task || task.company_id !== companyId || !task.assigned_agent_id || !task.project_id)
      throw new SandboxAccessError("Sandbox-Zugriff benötigt eine zugewiesene Aufgabe mit Projekt.");
    const assigned = this.db
      .prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id=? AND a.company_id=?`)
      .get(task.assigned_agent_id, companyId) as { runtime_provider: string } | undefined;
    if (assigned?.runtime_provider !== parsed.provider)
      throw new SandboxAccessError(
        "Die gewählte Runtime muss der Runtime des zugewiesenen Agenten entsprechen. Bitte dessen Profil zuerst anpassen.",
      );
    const project = new ProjectStore(this.db).get(task.project_id);
    if (
      !project ||
      project.company_id !== companyId ||
      !project.workspace_path ||
      !path.isAbsolute(project.workspace_path)
    )
      throw new SandboxAccessError("Ein absoluter Projekt-Workspace muss zuerst konfiguriert werden.");
    const action = sandboxActionSchema.parse({
      ...parsed,
      companyId,
      projectId: project.id,
      agentId: task.assigned_agent_id,
      workspacePath: path.normalize(project.workspace_path),
      kind: "sandbox_elevation",
      version: 1,
      maxRuns: 1,
    });
    const serialized = JSON.stringify(action);
    const pending = this.approvals.listPending(companyId).find((a) => a.proposed_action === serialized);
    if (pending) return pending;
    if (!["ready", "review"].includes(task.status))
      throw new SandboxAccessError("Die Aufgabe muss bereit oder im Review sein; offene Freigaben zuerst abschließen.");
    this.db.exec("SAVEPOINT sandbox_request");
    try {
      const approval = this.approvals.request(
        companyId,
        {
          approvalType: "sandbox_elevation",
          requestedBy: actorId,
          summary: `Sandbox-Ausnahme: ${task.title} · ${action.provider} · ${Math.round(action.durationMs / 60000)} Minuten · 1 Run`,
          riskLevel: "critical",
          impact: `CLI-Sicherheitsabfragen werden umgangen. Workspace: ${action.workspacePath}. Grund: ${action.reason}`,
          rollbackPlan:
            "Widerruf oder Ablauf beendet den erhöhten Run; bereits erfolgte Dateiänderungen müssen separat geprüft werden.",
          proposedAction: serialized,
          expiresAt: Date.now() + action.durationMs,
        },
        { taskId: task.id, correlationId: task.correlation_id },
      );
      const parked = new TaskStore(this.db).transition(task.id, "approval_required", {
        expectedVersion: task.status_version,
        actorType: "owner",
        actorId,
        reason: "Sandbox-Ausnahme wartet auf konkrete Owner-Freigabe",
        correlationId: task.correlation_id,
      });
      if (!parked) throw new SandboxAccessError("Die Aufgabe wurde gleichzeitig geändert. Bitte neu laden.");
      this.db.exec("RELEASE sandbox_request");
      return approval;
    } catch (error) {
      this.db.exec("ROLLBACK TO sandbox_request");
      this.db.exec("RELEASE sandbox_request");
      throw error;
    }
  }
  private approvedAction(companyId: string, approval: ApprovalRow | null, now: number): SandboxAction | null {
    if (
      !approval ||
      approval.company_id !== companyId ||
      approval.approval_type !== "sandbox_elevation" ||
      approval.status !== "approved" ||
      !approval.decided_by ||
      (approval.expires_at !== null && approval.expires_at <= now)
    )
      return null;
    const action = readSandboxAction(approval.proposed_action);
    if (!action || action.companyId !== companyId || action.taskId !== approval.task_id) return null;
    const tally = this.reviews.tally(approval.id);
    if (!tally.satisfied || tally.blocked) return null;
    const ownerVote = this.db
      .prepare(
        "SELECT r.id FROM crew_approval_reviews r JOIN crew_users u ON u.id=r.reviewer_id WHERE r.approval_id=? AND r.verdict='approved' AND u.role='owner' AND u.status='active' LIMIT 1",
      )
      .get(approval.id);
    if (!ownerVote) return null;
    const assigned = this.db
      .prepare(`${RESOLVED_AGENT_SELECT} WHERE a.id=? AND a.company_id=?`)
      .get(action.agentId, companyId) as { runtime_provider: string } | undefined;
    if (assigned?.runtime_provider !== action.provider) return null;
    const task = new TaskStore(this.db).get(action.taskId);
    const project = new ProjectStore(this.db).get(action.projectId);
    if (
      !task ||
      task.company_id !== companyId ||
      task.assigned_agent_id !== action.agentId ||
      task.project_id !== action.projectId ||
      !project ||
      project.company_id !== companyId ||
      !project.workspace_path ||
      path.normalize(project.workspace_path) !== action.workspacePath
    )
      return null;
    return action;
  }
  /** Called after the existing owner/quorum decision; also safe after restart. */
  settleApproval(companyId: string, approvalId: string): SandboxGrantRow | null {
    this.db.exec("SAVEPOINT sandbox_mint");
    try {
      const approval = this.approvals.get(approvalId);
      const action = this.approvedAction(companyId, approval, Date.now());
      if (!action || !approval) {
        this.db.exec("RELEASE sandbox_mint");
        return null;
      }
      const existing = this.db
        .prepare("SELECT * FROM crew_sandbox_grants WHERE company_id=? AND approval_id=? ORDER BY issued_at LIMIT 1")
        .get(companyId, approvalId) as SandboxGrantRow | undefined;
      const result =
        existing ??
        this.grants.mintFromApproval({
          approval,
          providers: [action.provider],
          taskId: action.taskId,
          workspacePath: action.workspacePath,
          requestedDurationMs: Math.min(action.durationMs, (approval.expires_at ?? Infinity) - Date.now()),
        });
      // Never remint an expired, revoked or consumed approval.
      this.db.exec("RELEASE sandbox_mint");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO sandbox_mint");
      this.db.exec("RELEASE sandbox_mint");
      throw error;
    }
  }
  /** All validation and consumption occurs synchronously in one SQLite write transaction. */
  consumeForRun(scope: SandboxRunScope): SandboxGrant | null {
    this.db.exec("SAVEPOINT sandbox_consume");
    try {
      let now = Date.now();
      const run = this.db
        .prepare(
          "SELECT id FROM crew_runs WHERE id=? AND company_id=? AND task_id=? AND agent_id=? AND runtime_type=? AND status IN ('queued','running')",
        )
        .get(scope.runId, scope.companyId, scope.taskId, scope.agentId, scope.provider);
      if (!run) {
        this.db.exec("RELEASE sandbox_consume");
        return null;
      }
      const approvals = this.db
        .prepare(
          "SELECT id FROM crew_approvals WHERE company_id=? AND task_id=? AND approval_type='sandbox_elevation' AND status='approved' ORDER BY created_at DESC",
        )
        .all(scope.companyId, scope.taskId) as Array<{ id: string }>;
      let result: SandboxGrant | null = null;
      for (const item of approvals) {
        const approval = this.approvals.get(item.id);
        const action = this.approvedAction(scope.companyId, approval, now);
        if (
          !action ||
          action.agentId !== scope.agentId ||
          action.projectId !== scope.projectId ||
          action.provider !== scope.provider ||
          action.workspacePath !== path.normalize(scope.workspacePath)
        )
          continue;
        const row = this.settleApproval(scope.companyId, item.id);
        now = Date.now(); // A lazily minted grant may be newer than the initial lookup.
        if (
          !row ||
          row.revoked_at !== null ||
          row.expires_at <= now ||
          row.issued_at > now ||
          (row.consumed_run_id !== null && row.consumed_run_id !== scope.runId)
        )
          continue;
        if (
          row.task_id !== action.taskId ||
          row.workspace_path !== action.workspacePath ||
          JSON.stringify(JSON.parse(row.providers_json)) !== JSON.stringify([action.provider])
        )
          continue;
        const used = this.db
          .prepare(
            "UPDATE crew_sandbox_grants SET consumed_run_id=?, consumed_at=? WHERE id=? AND consumed_run_id IS NULL AND revoked_at IS NULL AND expires_at>?",
          )
          .run(scope.runId, now, row.id, now);
        if (used.changes)
          appendAuditEvent(this.db, {
            companyId: scope.companyId,
            actorType: "system",
            actorId: "sandbox-access",
            action: "sandbox_grant.consumed",
            entityType: "sandbox_grant",
            entityId: row.id,
            taskId: scope.taskId,
            runId: scope.runId,
            approvalId: row.approval_id,
            details: { provider: scope.provider, workspacePath: action.workspacePath, expiresAt: row.expires_at },
          });
        else if (row.consumed_run_id !== scope.runId) continue;
        result = sandboxGrantSchema.parse({
          grantId: row.id,
          companyId: scope.companyId,
          approvedBy: row.approved_by,
          approvalId: row.approval_id,
          reason: row.reason,
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
          providers: [action.provider],
          taskId: scope.taskId,
          workspacePath: action.workspacePath,
        });
        break;
      }
      this.db.exec("RELEASE sandbox_consume");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO sandbox_consume");
      this.db.exec("RELEASE sandbox_consume");
      throw error;
    }
  }
  list(companyId: string) {
    const grants = this.db
      .prepare("SELECT * FROM crew_sandbox_grants WHERE company_id=? ORDER BY issued_at DESC LIMIT 100")
      .all(companyId) as unknown as SandboxGrantRow[];
    const requests = this.approvals
      .listPending(companyId)
      .filter((a) => a.approval_type === "sandbox_elevation" && readSandboxAction(a.proposed_action));
    return { grants, requests };
  }
  revoke(companyId: string, grantId: string, actorId: string, reason: string): SandboxGrantRow | null {
    const grant = this.grants.get(grantId);
    if (!grant || grant.company_id !== companyId) return null;
    return this.grants.revoke(grantId, actorId, reason);
  }
}
