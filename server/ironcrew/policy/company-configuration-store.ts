/** Original IronCrew operating controls. Each revision is scoped, validated and audited atomically. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ALWAYS_APPROVAL_REQUIRED,
  DEFAULT_COMPANY_CONFIGURATION,
  companyConfigurationSchema,
  saveCompanyConfigurationSchema,
  type CompanyConfiguration,
  type CompanyConfigurationRevision,
  type CompanyConfigurationSnapshot,
} from "../../../src/shared/company-configuration.ts";
import { appendAuditEvent } from "../domain/audit.ts";
import { redact } from "../security/redaction.ts";

export class CompanyConfigurationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "CompanyConfigurationError";
  }
}
interface StoredRevision {
  revision: number;
  configuration_json: string;
  reason: string;
  created_by: string;
  created_at: number;
  correlation_id: string;
  audit_event_id: string;
}
export class CompanyConfigurationStore {
  constructor(private readonly db: DatabaseSync) {}
  private company(companyId: string): void {
    if (!this.db.prepare("SELECT 1 FROM crew_companies WHERE id=?").get(companyId))
      throw new CompanyConfigurationError("company_not_found", "Firma nicht gefunden.", 404);
  }
  private current(companyId: string): StoredRevision | undefined {
    return this.db
      .prepare("SELECT * FROM crew_company_configuration_revisions WHERE company_id=? ORDER BY revision DESC LIMIT 1")
      .get(companyId) as StoredRevision | undefined;
  }
  effective(companyId: string): CompanyConfiguration {
    this.company(companyId);
    const row = this.current(companyId);
    return row
      ? companyConfigurationSchema.parse(JSON.parse(row.configuration_json))
      : structuredClone(DEFAULT_COMPANY_CONFIGURATION);
  }
  private present(row: StoredRevision): CompanyConfigurationRevision {
    return {
      revision: row.revision,
      configuration: companyConfigurationSchema.parse(JSON.parse(row.configuration_json)),
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
      correlationId: row.correlation_id,
      auditEventId: row.audit_event_id,
    };
  }
  canEdit(actorId: string): boolean {
    const user = this.db.prepare("SELECT role,status FROM crew_users WHERE id=?").get(actorId) as
      | { role: string; status: string }
      | undefined;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM crew_users").get() as { n: number };
    return (count.n === 0 && actorId === "ceo") || (user?.role === "owner" && user.status === "active");
  }
  snapshot(companyId: string, actorId = ""): CompanyConfigurationSnapshot {
    this.company(companyId);
    const rows = this.db
      .prepare("SELECT * FROM crew_company_configuration_revisions WHERE company_id=? ORDER BY revision DESC LIMIT 100")
      .all(companyId) as unknown as StoredRevision[];
    const history = rows.map((row) => this.present(row));
    return {
      revision: history[0]?.revision ?? 0,
      configuration: history[0]?.configuration ?? structuredClone(DEFAULT_COMPANY_CONFIGURATION),
      history,
      constraints: { alwaysApprovalRequired: [...ALWAYS_APPROVAL_REQUIRED] },
      toolChoices: this.db
        .prepare("SELECT key,label,risk_class AS riskClass FROM crew_tools WHERE company_id=? ORDER BY label,key")
        .all(companyId) as unknown as CompanyConfigurationSnapshot["toolChoices"],
      canEdit: this.canEdit(actorId),
    };
  }
  save(companyId: string, raw: unknown, actorId: string): CompanyConfigurationSnapshot {
    if (!this.canEdit(actorId))
      throw new CompanyConfigurationError(
        "owner_required",
        "Nur aktive Owner dürfen die Firmenkonfiguration ändern.",
        403,
      );
    this.company(companyId);
    const input = saveCompanyConfigurationSchema.parse(raw);
    if (redact(input.reason).text !== input.reason)
      throw new CompanyConfigurationError("secret_in_reason", "Die Begründung darf keine Zugangsdaten enthalten.", 400);
    this.db.exec("SAVEPOINT company_configuration_change");
    try {
      if ((this.current(companyId)?.revision ?? 0) !== input.baseRevision)
        throw new CompanyConfigurationError(
          "stale_revision",
          "Die Konfiguration wurde inzwischen geändert. Neu laden und erneut prüfen.",
        );
      const knownTools = new Set(
        (this.db.prepare("SELECT key FROM crew_tools WHERE company_id=?").all(companyId) as Array<{ key: string }>).map(
          (row) => row.key,
        ),
      );
      if (
        input.configuration.tools.blockedToolKeys.some((key) => !knownTools.has(key)) ||
        input.configuration.approvals.additionalRequiredTypes.some(
          (key) => !knownTools.has(key) && !(ALWAYS_APPROVAL_REQUIRED as readonly string[]).includes(key),
        )
      )
        throw new CompanyConfigurationError(
          "unknown_action",
          "Nur registrierte Werkzeuge und feste Freigabeaktionen sind konfigurierbar.",
          400,
        );
      const revision = input.baseRevision + 1;
      const correlationId = `corr_${randomUUID()}`;
      const audit = appendAuditEvent(this.db, {
        companyId,
        actorType: "owner",
        actorId,
        action: "company_configuration.updated",
        entityType: "company_configuration",
        entityId: companyId,
        correlationId,
        details: {
          revision,
          previousRevision: input.baseRevision,
          reason: input.reason,
          configuration: input.configuration,
        },
      });
      this.db
        .prepare(
          "INSERT INTO crew_company_configuration_revisions(company_id,revision,configuration_json,reason,created_by,created_at,correlation_id,audit_event_id) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          companyId,
          revision,
          JSON.stringify(input.configuration),
          input.reason,
          actorId,
          audit.createdAt,
          correlationId,
          audit.id,
        );
      const snapshot = this.snapshot(companyId, actorId);
      this.db.exec("RELEASE company_configuration_change");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK TO company_configuration_change; RELEASE company_configuration_change");
      throw error;
    }
  }
  /** Task row is already reserved. Earlier rows and meeting leases deterministically consume capacity. */
  admitsTask(companyId: string, runId: string, staleAfterMs: number, now = Date.now()): boolean {
    const ahead = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM crew_runs WHERE company_id=? AND status IN ('queued','running') AND COALESCE(heartbeat_at,created_at)>? AND rowid<(SELECT rowid FROM crew_runs WHERE id=?)",
      )
      .get(companyId, now - staleAfterMs, runId) as { n: number };
    const meetings = this.db
      .prepare("SELECT COUNT(*) AS n FROM crew_company_execution_leases WHERE company_id=? AND expires_at>?")
      .get(companyId, now) as { n: number };
    return ahead.n + meetings.n < this.effective(companyId).runtime.maxConcurrentRuns;
  }
  reserveMeeting(companyId: string, timeoutMs: number, staleAfterMs: number, now = Date.now()): string {
    this.db.exec("SAVEPOINT company_meeting_capacity");
    try {
      const runs = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM crew_runs WHERE company_id=? AND status IN ('queued','running') AND COALESCE(heartbeat_at,created_at)>?",
        )
        .get(companyId, now - staleAfterMs) as { n: number };
      const meetings = this.db
        .prepare("SELECT COUNT(*) AS n FROM crew_company_execution_leases WHERE company_id=? AND expires_at>?")
        .get(companyId, now) as { n: number };
      if (runs.n + meetings.n >= this.effective(companyId).runtime.maxConcurrentRuns)
        throw new CompanyConfigurationError(
          "company_capacity",
          "Die Firma hat ihr Limit paralleler Runs erreicht.",
          503,
        );
      this.db.prepare("DELETE FROM crew_company_execution_leases WHERE expires_at<=?").run(now);
      const id = `capacity_${randomUUID()}`;
      this.db
        .prepare("INSERT INTO crew_company_execution_leases(id,company_id,expires_at) VALUES (?,?,?)")
        .run(id, companyId, now + timeoutMs + 10000);
      this.db.exec("RELEASE company_meeting_capacity");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK TO company_meeting_capacity; RELEASE company_meeting_capacity");
      throw error;
    }
  }
  releaseMeeting(id: string): void {
    this.db.prepare("DELETE FROM crew_company_execution_leases WHERE id=?").run(id);
  }
}
