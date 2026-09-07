import path from "node:path";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { createPublicKey, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { Repository as RecoveryRepository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import {
  backupPolicySchema,
  updatePolicySchema,
  nextMaintenance,
  inMaintenanceWindow,
  localSlot,
  updateClass,
  retentionCandidates,
  verifyOwnedArchive,
  deleteOwnedArchive,
  restoreBackup,
  verifyRelease,
  activateRelease,
  hashFile,
  type BackupPolicyInput,
  type UpdatePolicyInput,
  type BackupResult,
  type OwnedArchive,
  type ActivateReleaseOptions,
} from "../../packages/operations/src/index.ts";
export type OnlineBackup = (input: {
  ageExecutable: string;
  recipient: string;
  outputDirectory: string;
}) => Promise<BackupResult>;
const bootId = randomUUID();
export interface BackupPolicy extends BackupPolicyInput {
  id: string;
  enabled: boolean;
  fingerprint: string;
  proposedBy: string;
  proposedAt: string;
  probeId?: string;
  activatedBy?: string;
  nextDueAt?: string;
  lastLocalSlot?: string;
  retryNotBefore?: string;
}
interface Archive extends OwnedArchive {
  policyId: string;
  policyFingerprint: string;
  manifest: BackupResult["manifest"];
}
interface Probe {
  id: string;
  policyId: string;
  fingerprint: string;
  archiveId: string;
  archiveSha256: string;
  completedAt: string;
  state: "passed";
  companyId: string;
  revokedSessions: number;
}
interface UpdatePolicy extends UpdatePolicyInput {
  id: string;
  fingerprint: string;
  proposedBy: string;
  proposedAt: string;
}
interface UpdatePlan {
  id: string;
  policyId: string;
  policyFingerprint: string;
  releaseDirectory: string;
  manifestSha256: string;
  executorConfigurationSha256?: string;
  fromVersion: string;
  toVersion: string;
  updateClass: "patch" | "minor" | "major";
  state: "planned" | "approved" | "queued" | "running" | "applied" | "failed" | "effect_unknown";
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  expiresAt?: string;
  backupId?: string;
  errorCode?: string;
  previousDirectory?: string;
}
export interface MaintenanceOptions {
  repo: Repository;
  directory: string;
  onlineBackup: OnlineBackup;
  now?: () => Date;
  currentVersion?: string;
  releaseLifecycle?: Pick<ActivateReleaseOptions, "beforeActivate" | "healthCheck" | "restartPrevious">;
  updateConfigurationFingerprint?: () => Promise<string>;
  updateExecutor?: (request: {
    scope: Scope;
    ceoId: string;
    planId: string;
  }) => Promise<import("../../packages/operations/src/updater.ts").UpdateQueueResult>;
  platform?: string;
  arch?: string;
}
export class MaintenanceService {
  private readonly options: MaintenanceOptions;
  private busy = false;
  private recovered = new Set<string>();
  constructor(options: MaintenanceOptions) {
    this.options = options;
  }
  private get repo() {
    return this.options.repo;
  }
  private now() {
    return (this.options.now ?? (() => new Date()))();
  }
  private async ceo(scope: Scope, ceoId: string) {
    const setup = await this.repo.snapshot(scope.companyId);
    if (
      setup.ceo.id !== ceoId ||
      scope.customerId ||
      scope.projectId ||
      !setup.areas.some((area) => area.id === scope.areaId && area.visibility === "company")
    )
      throw new DomainError("maintenance_ceo_required", "Company CEO context required", 403);
  }
  async list(scope: Scope, ceoId: string) {
    await this.ceo(scope, ceoId);
    return {
      backupPolicies: (await this.repo.listDocuments<BackupPolicy>(scope, "backup-policy")).map((item) => ({
        ...item.data,
        revision: item.revision,
      })),
      backups: (await this.repo.listDocuments<Archive>(scope, "maintenance-archive")).map((item) => item.data),
      probes: (await this.repo.listDocuments<Probe>(scope, "maintenance-probe")).map((item) => item.data),
      backupJobs: (await this.repo.listDocuments(scope, "maintenance-job")).map((item) => item.data),
      updatePolicies: (await this.repo.listDocuments<UpdatePolicy>(scope, "update-policy")).map((item) => item.data),
      updatePlans: (await this.repo.listDocuments<UpdatePlan>(scope, "update-plan")).map((item) => item.data),
      updateScheduleAttempts: (await this.repo.listDocuments(scope, "update-schedule-attempt")).map(
        (item) => item.data,
      ),
    };
  }
  async proposeBackupPolicy(scope: Scope, ceoId: string, input: unknown) {
    await this.ceo(scope, ceoId);
    const parsed = backupPolicySchema.parse(input);
    nextMaintenance(parsed.cron, parsed.timezone, this.now());
    const dataRoot = await realpath(this.options.directory);
    const destination = await realpath(parsed.destination).catch(() =>
      realpath(path.dirname(parsed.destination)).then((parent) => path.join(parent, path.basename(parsed.destination))),
    );
    parsed.destination = destination;
    if (destination === dataRoot || destination.startsWith(dataRoot + path.sep))
      throw new DomainError("backup_destination_inside_data");
    const id = randomUUID();
    const policy: BackupPolicy = {
      ...parsed,
      id,
      enabled: false,
      fingerprint: sha256(parsed),
      proposedBy: ceoId,
      proposedAt: this.now().toISOString(),
    };
    return (await this.repo.putDocument(scope, "backup-policy", id, policy)).data;
  }
  private async policy(scope: Scope, id: string) {
    const record = await this.repo.getDocument<BackupPolicy>(scope, "backup-policy", id);
    if (!record) throw new DomainError("backup_policy_missing");
    return record;
  }
  private async createArchive(scope: Scope, policy: BackupPolicy): Promise<Archive> {
    const result = await this.options.onlineBackup({
      ageExecutable: policy.ageExecutable,
      recipient: policy.recipient,
      outputDirectory: policy.destination,
    });
    const archive: Archive = {
      id: randomUUID(),
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      state: "available",
      archivePath: result.archivePath,
      sha256: result.sha256,
      createdAt: this.now().toISOString(),
      manifest: result.manifest,
    };
    await verifyOwnedArchive(archive, policy.destination);
    if (result.manifest.format !== "ironcrew-backup" || result.manifest.complete !== true)
      throw new DomainError("backup_unconfirmed");
    await this.repo.putDocument(scope, "maintenance-archive", archive.id, archive);
    return archive;
  }
  async probeBackupPolicy(scope: Scope, ceoId: string, id: string, input: { identityPath: string }) {
    await this.ceo(scope, ceoId);
    z.string().refine(path.isAbsolute).parse(input.identityPath);
    const policy = await this.policy(scope, id),
      archive = await this.createArchive(scope, policy.data);
    const staging = await mkdtemp(path.join(this.options.directory, ".restore-probe-"));
    try {
      const result = await restoreBackup({
        archivePath: archive.archivePath,
        identityPath: input.identityPath,
        ageExecutable: policy.data.ageExecutable,
        targetDirectory: path.join(staging, "restored"),
        beforeActivate: async () => {},
      });
      const recovered = await RecoveryRepository.open(path.join(result.targetDirectory, "company.sqlite"));
      try {
        const setup = await recovered.setupState();
        if (setup?.company.id !== scope.companyId || !(await recovered.verifyAudit(scope.companyId)))
          throw new DomainError("restore_probe_company_mismatch");
      } finally {
        await recovered.close();
      }
      await verifyOwnedArchive(archive, policy.data.destination);
      const probe: Probe = {
        id: randomUUID(),
        policyId: id,
        fingerprint: policy.data.fingerprint,
        archiveId: archive.id,
        archiveSha256: archive.sha256,
        completedAt: this.now().toISOString(),
        state: "passed",
        companyId: scope.companyId,
        revokedSessions: result.recovery.revokedSessions,
      };
      await this.repo.putDocument(scope, "maintenance-probe", probe.id, probe, { immutable: true });
      await this.repo.putDocument(
        scope,
        "backup-policy",
        id,
        { ...policy.data, probeId: probe.id },
        { expectedRevision: policy.revision },
      );
      return probe;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  private async checkedProbe(scope: Scope, policy: BackupPolicy) {
    const proof = policy.probeId
      ? await this.repo.getDocument<Probe>(scope, "maintenance-probe", policy.probeId)
      : undefined;
    if (
      !proof ||
      proof.data.fingerprint !== policy.fingerprint ||
      proof.data.companyId !== scope.companyId ||
      proof.data.state !== "passed" ||
      this.now().getTime() - Date.parse(proof.data.completedAt) > 30 * 86400000 ||
      Date.parse(proof.data.completedAt) > this.now().getTime() + 60000
    )
      throw new DomainError("restore_probe_required");
    const archive = await this.repo.getDocument<Archive>(scope, "maintenance-archive", proof.data.archiveId);
    if (!archive || archive.data.state !== "available" || archive.data.sha256 !== proof.data.archiveSha256)
      throw new DomainError("restore_probe_archive_missing");
    await verifyOwnedArchive(archive.data, policy.destination);
    return proof.data;
  }
  async activateBackupPolicy(scope: Scope, ceoId: string, id: string) {
    await this.ceo(scope, ceoId);
    const record = await this.policy(scope, id);
    await this.checkedProbe(scope, record.data);
    return (
      await this.repo.putDocument(
        scope,
        "backup-policy",
        id,
        {
          ...record.data,
          enabled: true,
          activatedBy: ceoId,
          nextDueAt: nextMaintenance(record.data.cron, record.data.timezone, this.now()),
        },
        { expectedRevision: record.revision },
      )
    ).data;
  }
  async pauseBackupPolicy(scope: Scope, ceoId: string, id: string) {
    await this.ceo(scope, ceoId);
    const record = await this.policy(scope, id);
    return (
      await this.repo.putDocument(
        scope,
        "backup-policy",
        id,
        { ...record.data, enabled: false },
        { expectedRevision: record.revision },
      )
    ).data;
  }
  private async retention(scope: Scope, policy: BackupPolicy) {
    const records = (await this.repo.listDocuments<Archive>(scope, "maintenance-archive")).filter(
      (item) => item.data.policyId === policy.id && item.data.policyFingerprint === policy.fingerprint,
    );
    const proof = policy.probeId
      ? await this.repo.getDocument<Probe>(scope, "maintenance-probe", policy.probeId)
      : undefined;
    const candidates = retentionCandidates(
      records.map((item) => item.data),
      policy,
      proof ? [proof.data.archiveId] : [],
    );
    for (const archive of candidates) {
      try {
        await deleteOwnedArchive(archive, policy.destination);
        const record = records.find((item) => item.id === archive.id)!;
        await this.repo.putDocument(
          scope,
          "maintenance-archive",
          archive.id,
          { ...archive, state: "deleted" },
          { expectedRevision: record.revision },
        );
      } catch (error) {
        await this.repo.putDocument(
          scope,
          "retention-issue",
          randomUUID(),
          { archiveId: archive.id, code: code(error), observedAt: this.now().toISOString() },
          { immutable: true },
        );
      }
    }
  }
  async tick(scope: Scope) {
    if (this.busy) return;
    this.busy = true;
    try {
      try {
        await this.repo.assertDispatchAllowed(scope.companyId);
      } catch {
        return;
      }
      if (!this.recovered.has(sha256(scope))) {
        for (const kind of ["maintenance-job", "update-plan", "maintenance-update-active"])
          for (const item of await this.repo.listDocuments<{ state: string; bootId?: string }>(scope, kind)) {
            if (item.data.state === "running" && item.data.bootId !== bootId)
              await this.repo.putDocument(
                scope,
                kind,
                item.id,
                { ...item.data, state: "effect_unknown", code: "maintenance_interrupted" },
                { expectedRevision: item.revision },
              );
          }
        this.recovered.add(sha256(scope));
      }
      for (const record of await this.repo.listDocuments<BackupPolicy>(scope, "backup-policy")) {
        const policy = record.data;
        if (
          !policy.enabled ||
          !policy.nextDueAt ||
          Date.parse(policy.nextDueAt) > this.now().getTime() ||
          (policy.retryNotBefore && Date.parse(policy.retryNotBefore) > this.now().getTime())
        )
          continue;
        const id = randomUUID(),
          dueAt = policy.nextDueAt,
          slot = localSlot(new Date(dueAt), policy.timezone);
        const next = {
          ...policy,
          nextDueAt: nextMaintenance(policy.cron, policy.timezone, this.now()),
          lastLocalSlot: slot,
          retryNotBefore: undefined,
        };
        if (policy.lastLocalSlot === slot) {
          await this.repo.putDocument(scope, "backup-policy", policy.id, next, { expectedRevision: record.revision });
          continue;
        }
        try {
          await this.repo.transact(
            scope,
            [
              { kind: "backup-policy", id: policy.id, data: next, expectedRevision: record.revision },
              {
                kind: "maintenance-job",
                id,
                data: { id, policyId: policy.id, dueAt, state: "running", bootId, startedAt: this.now().toISOString() },
                expectedRevision: 0,
              },
            ],
            { type: "backup.scheduled", aggregateId: id },
          );
        } catch (error) {
          if (code(error) === "revision_conflict") continue;
          throw error;
        }
        try {
          const current = await this.policy(scope, policy.id);
          if (!current.data.enabled) throw new DomainError("backup_policy_paused");
          const archive = await this.createArchive(scope, current.data);
          await this.repo.putDocument(
            scope,
            "maintenance-job",
            id,
            {
              id,
              policyId: policy.id,
              dueAt,
              state: "succeeded",
              archiveId: archive.id,
              finishedAt: this.now().toISOString(),
            },
            { expectedRevision: 1 },
          );
        } catch (error) {
          if (error instanceof DomainError && error.code === "backup_busy") {
            // The snapshot callback guarantees this code before starting any archive worker.
            const retryAt = new Date(this.now().getTime() + 30_000).toISOString();
            const deferred = {
              id,
              policyId: policy.id,
              dueAt,
              state: "deferred",
              code: "backup_busy",
              retryAt,
              finishedAt: this.now().toISOString(),
            };
            const current = await this.policy(scope, policy.id);
            if (current.data.nextDueAt === next.nextDueAt && current.data.lastLocalSlot === slot) {
              try {
                await this.repo.transact(
                  scope,
                  [
                    { kind: "maintenance-job", id, data: deferred, expectedRevision: 1 },
                    {
                      kind: "backup-policy",
                      id: policy.id,
                      data: {
                        ...current.data,
                        nextDueAt: dueAt,
                        lastLocalSlot: policy.lastLocalSlot,
                        retryNotBefore: retryAt,
                      },
                      expectedRevision: current.revision,
                    },
                  ],
                  { type: "backup.deferred", aggregateId: id },
                );
              } catch (conflict) {
                if (code(conflict) !== "revision_conflict") throw conflict;
                // A newer CEO policy change takes precedence over rescheduling this slot.
                await this.repo.putDocument(scope, "maintenance-job", id, deferred, { expectedRevision: 1 });
              }
            } else await this.repo.putDocument(scope, "maintenance-job", id, deferred, { expectedRevision: 1 });
            continue;
          }
          await this.repo.putDocument(
            scope,
            "maintenance-job",
            id,
            {
              id,
              policyId: policy.id,
              dueAt,
              state: "effect_unknown",
              code: code(error),
              finishedAt: this.now().toISOString(),
            },
            { expectedRevision: 1 },
          );
        }
        await this.retention(scope, policy);
      }
    } finally {
      this.busy = false;
    }
  }
  async proposeUpdatePolicy(scope: Scope, ceoId: string, input: unknown) {
    await this.ceo(scope, ceoId);
    const parsed = updatePolicySchema.parse(input);
    nextMaintenance(parsed.window.cron, parsed.window.timezone, this.now());
    if (createPublicKey(parsed.trustedPublicKeyPem).asymmetricKeyType !== "ed25519")
      throw new DomainError("release_trust");
    const dataRoot = await realpath(this.options.directory),
      install = path.resolve(parsed.installDirectory);
    if (install === dataRoot || install.startsWith(dataRoot + path.sep) || dataRoot.startsWith(install + path.sep))
      throw new DomainError("update_install_overlaps_data");
    const backup = await this.policy(scope, parsed.backupPolicyId);
    if (!backup.data.enabled) throw new DomainError("backup_policy_inactive");
    await this.checkedProbe(scope, backup.data);
    const id = randomUUID();
    return (
      await this.repo.putDocument(
        scope,
        "update-policy",
        id,
        { ...parsed, id, fingerprint: sha256(parsed), proposedBy: ceoId, proposedAt: this.now().toISOString() },
        { immutable: true },
      )
    ).data;
  }
  async proposeUpdate(scope: Scope, ceoId: string, policyId: string, releaseDirectory: string) {
    await this.ceo(scope, ceoId);
    z.string().refine(path.isAbsolute).parse(releaseDirectory);
    const policy = await this.repo.getDocument<UpdatePolicy>(scope, "update-policy", policyId);
    if (!policy) throw new DomainError("update_policy_missing");
    if (await this.repo.getDocument(scope, "update-policy-revocation", policyId))
      throw new DomainError("update_policy_revoked");
    const manifest = await verifyRelease(releaseDirectory, policy.data.trustedPublicKeyPem, {
      platform: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
    });
    const installed = await this.repo.getDocument<{ version: string }>(
      scope,
      "maintenance-installed-release",
      scope.companyId,
    );
    const fromVersion = installed?.data.version ?? this.options.currentVersion ?? "0.4.0",
      kind = updateClass(fromVersion, manifest.version);
    if (!policy.data.allowedClasses.includes(kind)) throw new DomainError("update_class_denied");
    const plan: UpdatePlan = {
      id: randomUUID(),
      policyId,
      policyFingerprint: policy.data.fingerprint,
      releaseDirectory,
      manifestSha256: await hashFile(path.join(releaseDirectory, "release-manifest.json")),
      ...(this.options.updateConfigurationFingerprint
        ? { executorConfigurationSha256: await this.options.updateConfigurationFingerprint() }
        : {}),
      fromVersion,
      toVersion: manifest.version,
      updateClass: kind,
      state: "planned",
      createdAt: this.now().toISOString(),
    };
    return (await this.repo.putDocument(scope, "update-plan", plan.id, plan)).data;
  }
  async approveUpdate(scope: Scope, ceoId: string, id: string) {
    await this.ceo(scope, ceoId);
    const plan = await this.repo.getDocument<UpdatePlan>(scope, "update-plan", id);
    if (!plan || plan.data.state !== "planned") throw new DomainError("update_plan_state");
    return (
      await this.repo.putDocument(
        scope,
        "update-plan",
        id,
        {
          ...plan.data,
          state: "approved",
          approvedBy: ceoId,
          approvedAt: this.now().toISOString(),
          expiresAt: new Date(this.now().getTime() + 86400000).toISOString(),
        },
        { expectedRevision: plan.revision },
      )
    ).data;
  }
  async revokeUpdatePolicy(scope: Scope, ceoId: string, id: string) {
    await this.ceo(scope, ceoId);
    if (!(await this.repo.getDocument(scope, "update-policy", id))) throw new DomainError("update_policy_missing");
    const existing = await this.repo.getDocument(scope, "update-policy-revocation", id);
    if (existing) return existing.data;
    return (
      await this.repo.putDocument(
        scope,
        "update-policy-revocation",
        id,
        { policyId: id, revokedBy: ceoId, revokedAt: this.now().toISOString() },
        { immutable: true },
      )
    ).data;
  }
  async applyUpdate(scope: Scope, ceoId: string, id: string) {
    await this.ceo(scope, ceoId);
    if (!this.options.releaseLifecycle && !this.options.updateExecutor)
      throw new DomainError("maintenance_executor_not_configured");
    const plan = await this.repo.getDocument<UpdatePlan>(scope, "update-plan", id);
    if (!plan || plan.data.state !== "approved") throw new DomainError("update_plan_state");
    if (!plan.data.expiresAt || Date.parse(plan.data.expiresAt) <= this.now().getTime())
      throw new DomainError("update_approval_expired");
    if (await this.repo.getDocument(scope, "update-policy-revocation", plan.data.policyId))
      throw new DomainError("update_policy_revoked");
    const installed = await this.repo.getDocument<{ version: string }>(
      scope,
      "maintenance-installed-release",
      scope.companyId,
    );
    if (plan.data.fromVersion !== (installed?.data.version ?? this.options.currentVersion ?? "0.4.0"))
      throw new DomainError("update_base_changed");
    const policy = await this.repo.getDocument<UpdatePolicy>(scope, "update-policy", plan.data.policyId);
    if (
      !policy ||
      policy.data.fingerprint !== plan.data.policyFingerprint ||
      !policy.data.allowedClasses.includes(plan.data.updateClass)
    )
      throw new DomainError("update_policy_changed");
    if (!inMaintenanceWindow(policy.data.window, this.now())) throw new DomainError("maintenance_window_closed");
    if ((await hashFile(path.join(plan.data.releaseDirectory, "release-manifest.json"))) !== plan.data.manifestSha256)
      throw new DomainError("update_release_changed");
    await verifyRelease(plan.data.releaseDirectory, policy.data.trustedPublicKeyPem, {
      platform: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
    });
    const backupPolicy = await this.policy(scope, policy.data.backupPolicyId);
    if (!backupPolicy.data.enabled) throw new DomainError("backup_policy_inactive");
    await this.checkedProbe(scope, backupPolicy.data);
    if (this.options.updateExecutor) return this.options.updateExecutor({ scope, ceoId, planId: id });
    const active = await this.repo.getDocument<{ state: string }>(scope, "maintenance-update-active", scope.companyId);
    if (active && active.data.state !== "idle") throw new DomainError("maintenance_update_busy");
    await this.repo.transact(
      scope,
      [
        { kind: "update-plan", id, data: { ...plan.data, state: "running", bootId }, expectedRevision: plan.revision },
        {
          kind: "maintenance-update-active",
          id: scope.companyId,
          data: { planId: id, state: "running", bootId },
          expectedRevision: active?.revision ?? 0,
        },
      ],
      { type: "maintenance.update_started", aggregateId: id },
    );
    const runningRevision = plan.revision + 1;
    let archive: Archive | undefined;
    try {
      archive = await this.createArchive(scope, backupPolicy.data);
      const result = await activateRelease({
        ...this.options.releaseLifecycle!,
        releaseDirectory: plan.data.releaseDirectory,
        installDirectory: policy.data.installDirectory,
        trustedPublicKeyPem: policy.data.trustedPublicKeyPem,
        currentSchemaVersion: 1,
        platform: this.options.platform,
        arch: this.options.arch,
        beforeActivate: async () => {
          if (!inMaintenanceWindow(policy.data.window, this.now())) throw new DomainError("maintenance_window_closed");
          if (await this.repo.getDocument(scope, "update-policy-revocation", policy.data.id))
            throw new DomainError("update_policy_revoked");
          await this.options.releaseLifecycle!.beforeActivate();
        },
      });
      const applied = {
        ...plan.data,
        state: "applied",
        backupId: archive.id,
        previousDirectory: result.previousDirectory,
      };
      await this.repo.transact(
        scope,
        [
          { kind: "update-plan", id, data: applied, expectedRevision: runningRevision },
          {
            kind: "maintenance-installed-release",
            id: scope.companyId,
            data: {
              version: result.manifest.version,
              manifestSha256: plan.data.manifestSha256,
              observedAt: this.now().toISOString(),
            },
            expectedRevision: installed?.revision ?? 0,
          },
          {
            kind: "maintenance-update-active",
            id: scope.companyId,
            data: { planId: id, state: "idle" },
            expectedRevision: (active?.revision ?? 0) + 1,
          },
        ],
        { type: "maintenance.release_applied", aggregateId: id },
      );
      return applied;
    } catch (error) {
      await this.repo.putDocument(
        scope,
        "update-plan",
        id,
        { ...plan.data, state: "effect_unknown", ...(archive ? { backupId: archive.id } : {}), errorCode: code(error) },
        { expectedRevision: runningRevision },
      );
      throw error;
    }
  }
}
function code(error: unknown) {
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "maintenance_failed";
}
