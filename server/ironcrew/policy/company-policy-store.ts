/** Original IronCrew policy restrictions: YAML is the immutable ceiling; SQLite holds owner revisions. */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  companyPolicyRestrictionsSchema,
  saveCompanyPolicySchema,
  type CompanyPolicyRestrictions,
  type CompanyPolicyRevision,
  type CompanyPolicySnapshot,
} from "../../../src/shared/company-policy.ts";
import { appendAuditEvent, canonicalJson } from "../domain/audit.ts";
import { redact } from "../security/redaction.ts";
import { defaultVendorPolicyPath, loadVendorPolicyFromFile, type VendorPolicy } from "./vendor-policy.ts";

export class CompanyPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "CompanyPolicyError";
  }
}
interface StoredRevision {
  revision: number;
  restrictions_json: string;
  baseline_fingerprint: string;
  reason: string;
  created_by: string;
  created_at: number;
  correlation_id: string;
  audit_event_id: string;
}
export class CompanyPolicyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly baselineLoader: () => VendorPolicy = () => loadVendorPolicyFromFile(defaultVendorPolicyPath()),
  ) {}
  private company(companyId: string): void {
    if (!this.db.prepare("SELECT 1 FROM crew_companies WHERE id=?").get(companyId))
      throw new CompanyPolicyError("company_not_found", "Firma nicht gefunden.", 404);
  }
  private current(companyId: string): StoredRevision | undefined {
    return this.db
      .prepare("SELECT * FROM crew_company_policy_revisions WHERE company_id=? ORDER BY revision DESC LIMIT 1")
      .get(companyId) as StoredRevision | undefined;
  }
  private choices(policy: VendorPolicy): CompanyPolicyRestrictions {
    return {
      allowedFamilies: [...policy.allowed_families],
      allowedProviders: [...policy.openrouter.allowed_providers],
    };
  }
  private fingerprint(policy: VendorPolicy): string {
    return createHash("sha256").update(canonicalJson(policy)).digest("hex");
  }
  private restricted(baseline: VendorPolicy, restrictions: CompanyPolicyRestrictions): VendorPolicy {
    return {
      ...baseline,
      allowed_families: baseline.allowed_families.filter((value) => restrictions.allowedFamilies.includes(value)),
      openrouter: {
        ...baseline.openrouter,
        allowed_providers: baseline.openrouter.allowed_providers.filter((value) =>
          restrictions.allowedProviders.includes(value),
        ),
      },
    };
  }
  effective(companyId: string): VendorPolicy {
    this.company(companyId);
    const baseline = this.baselineLoader();
    const row = this.current(companyId);
    return row
      ? this.restricted(baseline, companyPolicyRestrictionsSchema.parse(JSON.parse(row.restrictions_json)))
      : baseline;
  }
  private present(row: StoredRevision): CompanyPolicyRevision {
    return {
      revision: row.revision,
      createdAt: row.created_at,
      createdBy: row.created_by,
      reason: row.reason,
      baselineFingerprint: row.baseline_fingerprint,
      restrictions: companyPolicyRestrictionsSchema.parse(JSON.parse(row.restrictions_json)),
      correlationId: row.correlation_id,
      auditEventId: row.audit_event_id,
    };
  }
  private snapshotOf(companyId: string, baseline: VendorPolicy): CompanyPolicySnapshot {
    const rows = this.db
      .prepare("SELECT * FROM crew_company_policy_revisions WHERE company_id=? ORDER BY revision DESC LIMIT 100")
      .all(companyId) as unknown as StoredRevision[];
    const restrictions = rows[0] ? this.present(rows[0]).restrictions : this.choices(baseline);
    return {
      revision: rows[0]?.revision ?? 0,
      baselineFingerprint: this.fingerprint(baseline),
      baseline: this.choices(baseline),
      restrictions,
      effectivePolicy: this.restricted(baseline, restrictions),
      history: rows.map((row) => this.present(row)),
    };
  }
  snapshot(companyId: string): CompanyPolicySnapshot {
    this.company(companyId);
    return this.snapshotOf(companyId, this.baselineLoader());
  }
  private owner(actorId: string): void {
    const user = this.db.prepare("SELECT role,status FROM crew_users WHERE id=?").get(actorId) as
      | { role: string; status: string }
      | undefined;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM crew_users").get() as { n: number };
    if (count.n === 0 && actorId === "ceo") return;
    if (user?.role !== "owner" || user.status !== "active")
      throw new CompanyPolicyError("owner_required", "Nur aktive Owner dürfen die Vendor-Policy ändern.", 403);
  }
  save(companyId: string, raw: unknown, actorId: string): CompanyPolicySnapshot {
    this.owner(actorId);
    this.company(companyId);
    const input = saveCompanyPolicySchema.parse(raw);
    if (redact(input.reason).text !== input.reason)
      throw new CompanyPolicyError("secret_in_reason", "Die Begründung darf keine Zugangsdaten enthalten.", 400);
    this.db.exec("SAVEPOINT company_policy_change");
    try {
      const baseline = this.baselineLoader();
      const fingerprint = this.fingerprint(baseline);
      const current = this.current(companyId);
      if ((current?.revision ?? 0) !== input.baseRevision)
        throw new CompanyPolicyError(
          "stale_revision",
          "Die Policy wurde inzwischen geändert. Neu laden und erneut prüfen.",
        );
      if (fingerprint !== input.baselineFingerprint)
        throw new CompanyPolicyError(
          "stale_baseline",
          "Die zentrale YAML-Policy wurde geändert. Neu laden und erneut prüfen.",
        );
      if (
        input.restrictions.allowedFamilies.some((value) => !baseline.allowed_families.includes(value)) ||
        input.restrictions.allowedProviders.some((value) => !baseline.openrouter.allowed_providers.includes(value))
      )
        throw new CompanyPolicyError(
          "outside_baseline",
          "Die Auswahl darf die zentrale Vendor-Policy nicht erweitern.",
          403,
        );
      const revision = input.baseRevision + 1;
      const correlationId = `corr_${randomUUID()}`;
      const audit = appendAuditEvent(this.db, {
        companyId,
        actorType: "owner",
        actorId,
        action: "vendor_policy.updated",
        entityType: "vendor_policy",
        entityId: companyId,
        correlationId,
        details: {
          revision,
          previousRevision: input.baseRevision,
          baselineFingerprint: fingerprint,
          reason: input.reason,
          restrictions: input.restrictions,
        },
      });
      this.db
        .prepare(
          `INSERT INTO crew_company_policy_revisions
        (company_id,revision,restrictions_json,baseline_fingerprint,reason,created_by,created_at,correlation_id,audit_event_id)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          companyId,
          revision,
          JSON.stringify(input.restrictions),
          fingerprint,
          input.reason,
          actorId,
          audit.createdAt,
          correlationId,
          audit.id,
        );
      const snapshot = this.snapshotOf(companyId, baseline);
      this.db.exec("RELEASE company_policy_change");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK TO company_policy_change; RELEASE company_policy_change");
      throw error;
    }
  }
}
