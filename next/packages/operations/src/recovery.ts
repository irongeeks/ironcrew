import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Repository, type Mutation } from "../../persistence/src/index.ts";
import type { Scope } from "../../contracts/src/index.ts";
import { OperationError } from "./common.ts";
export interface RecoveryReport {
  generation: string;
  restoredAt: string;
  dispatchPaused: true;
  schedulesPaused: true;
  revokedSessions: number;
  fencedWorkers: number;
  pausedSchedules: number;
  unknownActions: number;
  unknownRemoteExecutions: number;
  invalidatedUpdateApprovals: number;
  requiresEffectReconciliation: true;
}
/** Runs only on the validated staging database while no application is using it. Uses normal mutations to preserve audit. */
export async function prepareRecovery(databasePath: string): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    generation: randomUUID(),
    restoredAt: new Date().toISOString(),
    dispatchPaused: true,
    schedulesPaused: true,
    revokedSessions: 0,
    fencedWorkers: 0,
    pausedSchedules: 0,
    unknownActions: 0,
    unknownRemoteExecutions: 0,
    invalidatedUpdateApprovals: 0,
    requiresEffectReconciliation: true,
  };
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let documents: {
    company_id: string;
    area_id: string;
    customer_id: string;
    project_id: string;
    kind: string;
    id: string;
    revision: number;
    data: string;
  }[];
  try {
    const version = db.prepare("SELECT version FROM schema_version").get();
    if (version?.version !== 1) throw new OperationError("schema", "Nicht unterstütztes Wiederherstellungsschema.");
    documents = db
      .prepare(
        "SELECT company_id,area_id,customer_id,project_id,kind,id,revision,data FROM documents WHERE kind IN ('session','worker','schedule','tool-action','action','worker-lease','worker-enrollment','worker_lease','worker_enrollment','remote-execution','update-plan','update-executor-job','update-schedule-attempt','maintenance-update-active','finance-processing-rule','finance-reminder-policy','reminder-rule','mail-inbox-policy')",
      )
      .all() as unknown as typeof documents;
  } finally {
    db.close();
  }
  const repo = await Repository.open(databasePath);
  try {
    const setup = await repo.setupState();
    if (!setup) return report;
    for (const area of setup.areas.filter((area) => area.visibility === "company").slice(0, 1)) {
      const scope = { companyId: setup.company.id, areaId: area.id };
      const prior = await repo.getDocument(scope, "recovery-state", setup.company.id);
      await repo.putDocument(scope, "recovery-state", setup.company.id, report, {
        expectedRevision: prior?.revision ?? 0,
        eventType: "recovery.started",
      });
    }
    const groups = new Map<string, { scope: Scope; mutations: Mutation[] }>();
    for (const row of documents) {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      let changed = false;
      const extras: Mutation[] = [];
      if (row.kind === "session") {
        data.revoked = true;
        data.expiresAt = 0;
        data.recoveryGeneration = report.generation;
        report.revokedSessions++;
        changed = true;
      }
      if (row.kind === "worker") {
        data.generation = Number(data.generation ?? 0) + 1;
        data.status = "offline";
        data.revoked = true;
        data.sequence = 0;
        data.credentialHash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
        data.recoveryGeneration = report.generation;
        report.fencedWorkers++;
        changed = true;
      }
      if (["worker-lease", "worker-enrollment", "worker_lease", "worker_enrollment"].includes(row.kind)) {
        data.revoked = true;
        data.state = "expired";
        data.expiresAt = "1970-01-01T00:00:00.000Z";
        data.recoveryGeneration = report.generation;
        changed = true;
      }
      if (["finance-processing-rule", "finance-reminder-policy"].includes(row.kind) && data.state === "active") {
        data.state = "disabled";
        delete data.approvedBy;
        delete data.approvedAt;
        changed = true;
      }
      if (row.kind === "reminder-rule" && data.enabled === true) {
        const scope = {
          companyId: row.company_id,
          areaId: row.area_id,
          ...(row.customer_id ? { customerId: row.customer_id } : {}),
          ...(row.project_id ? { projectId: row.project_id } : {}),
        };
        if (!(await repo.getDocument(scope, "reminder-rule-revocation", row.id)))
          extras.push({
            kind: "reminder-rule-revocation",
            id: row.id,
            data: { id: row.id, recoveryGeneration: report.generation, at: report.restoredAt },
            immutable: true,
          });
      }
      if (row.kind === "mail-inbox-policy" && data.enabled === true) {
        data.enabled = false;
        changed = true;
      }
      if (row.kind === "schedule") {
        data.enabled = false;
        data.paused = true;
        data.recoveryGeneration = report.generation;
        report.pausedSchedules++;
        changed = true;
      }
      if (["tool-action", "action"].includes(row.kind) && ["dispatched", "running"].includes(String(data.status))) {
        data.status = "effect_unknown";
        data.recoveryGeneration = report.generation;
        report.unknownActions++;
        changed = true;
      }
      if (row.kind === "remote-execution" && ["dispatched", "uploading"].includes(String(data.state))) {
        // Transfer tickets and staging bytes belong to the old worker generation and are not restored.
        data.state = "effect_unknown";
        data.code = "recovery_generation_changed";
        data.recoveryGeneration = report.generation;
        report.unknownRemoteExecutions++;
        changed = true;
      }
      if (row.kind === "update-plan" && data.state === "approved") {
        // Restore cannot carry a prior CEO execution consent into a new operational generation.
        // Keep the proposal/evidence so it can be reviewed and explicitly approved again.
        data.state = "planned";
        delete data.approvedBy;
        delete data.approvedAt;
        delete data.expiresAt;
        data.errorCode = "recovery_approval_invalidated";
        data.recoveryGeneration = report.generation;
        report.invalidatedUpdateApprovals++;
        changed = true;
      } else if (row.kind === "update-plan" && ["queued", "running"].includes(String(data.state))) {
        data.state = "effect_unknown";
        data.errorCode = "recovery_generation_changed";
        data.recoveryGeneration = report.generation;
        changed = true;
      }
      if (
        (["update-executor-job", "maintenance-update-active"].includes(row.kind) &&
          ["queued", "running"].includes(String(data.state))) ||
        (row.kind === "update-schedule-attempt" && ["running", "deferred"].includes(String(data.state)))
      ) {
        data.state = "effect_unknown";
        data.code = "recovery_generation_changed";
        data.recoveryGeneration = report.generation;
        changed = true;
      }
      if (!changed && !extras.length) continue;
      const scope: Scope = {
        companyId: row.company_id,
        areaId: row.area_id,
        ...(row.customer_id ? { customerId: row.customer_id } : {}),
        ...(row.project_id ? { projectId: row.project_id } : {}),
      };
      const key = JSON.stringify(scope);
      const group = groups.get(key) ?? { scope, mutations: [] };
      if (changed) group.mutations.push({ kind: row.kind, id: row.id, data, expectedRevision: row.revision });
      group.mutations.push(...extras);
      groups.set(key, group);
    }
    for (const group of groups.values())
      await repo.transact(group.scope, group.mutations, {
        type: "recovery.credentials_revoked",
        aggregateId: report.generation,
        data: { requiresEffectReconciliation: true },
      });
    for (const area of setup.areas.filter((area) => area.visibility === "company").slice(0, 1)) {
      const scope = { companyId: setup.company.id, areaId: area.id };
      const prior = await repo.getDocument(scope, "recovery-state", setup.company.id);
      await repo.putDocument(scope, "recovery-state", setup.company.id, report, {
        expectedRevision: prior!.revision,
        eventType: "recovery.prepared",
      });
    }
    return report;
  } finally {
    await repo.close();
  }
}
