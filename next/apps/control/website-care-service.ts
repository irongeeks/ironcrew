import path from "node:path";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Repository, Document } from "../../packages/persistence/src/index.ts";
import { scopeSchema, type Scope, type Mandate, type Json } from "../../packages/contracts/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import { IncidentWorkflow } from "../../packages/domain/workflows/incident.ts";
import type { HostingProfile, HostingDeployment, HostingPackage } from "../../packages/integrations/src/hosting.ts";
import {
  HostingCareHttpClient,
  careBackupSchema,
  careUpdateSchema,
  type HostingCarePort,
  type CareBackupReceipt,
} from "../../packages/integrations/src/hosting-care.ts";
import { IntegrationError } from "../../packages/integrations/src/transport.ts";
import { ProtonPassResolver, type SecretResolver } from "../../packages/integrations/src/secrets.ts";
import { readConfiguration } from "./configuration.ts";
import { recoveryGeneration } from "./oauth-broker.ts";
const micros = z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const schedule = z
  .object({
    cron: z.string().min(5).max(100),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
  })
  .strict();
export const websiteCarePolicySchema = z
  .object({
    profileId: z.uuid(),
    deploymentId: z.uuid(),
    mandateId: z.uuid(),
    mandateVersion: z.number().int().positive(),
    enabled: z.boolean().default(false),
    expiresAt: z.iso.datetime(),
    budgetLimitUsdMicros: micros,
    healthIntervalSeconds: z.number().int().min(30).max(86400),
    incidentBudgetLimitUsdMicros: micros,
    backup: careBackupSchema.extend({ schedule }).strict(),
    update: z
      .object({ candidate: careUpdateSchema, schedule, windowMinutes: z.number().int().min(1).max(360).default(30) })
      .strict()
      .optional(),
  })
  .strict();
const policyResult = websiteCarePolicySchema
  .extend({
    id: z.uuid(),
    scope: scopeSchema,
    orderId: z.uuid(),
    careOrderId: z.uuid(),
    profileFingerprint: hash,
    artifactVersionId: z.uuid(),
    packageSha256: hash,
    generation: z.string().nullable(),
    approvedBy: z.uuid(),
    approvedAt: z.iso.datetime(),
    revision: z.number().int().positive(),
  })
  .strict();
export const websiteCarePolicyResultSchema = policyResult;
type Policy = Omit<z.infer<typeof policyResult>, "revision">;
type DeploymentRecord = {
  id: string;
  profileId: string;
  profileFingerprint: string;
  orderId: string;
  state: string;
  deployment: HostingDeployment;
};
type State = {
  nextCheckAt: string;
  nextBackupAt: string;
  nextUpdateAt?: string;
  lastCheckAt?: string;
  lastBackupAt?: string;
  lastUpdateAt?: string;
  attemptedUpdateVersion?: string;
  incidentOrderId?: string;
  outageEventId?: string;
  lastError?: string;
};
export const websiteCareJobSchema = z
  .object({
    id: z.uuid(),
    policyId: z.uuid(),
    policyRevision: z.number().int().positive(),
    orderId: z.uuid(),
    kind: z.enum(["check", "backup", "update"]),
    slot: z.iso.datetime(),
    state: z.enum(["running", "succeeded", "failed", "effect_unknown", "rolled_back"]),
    owner: z.string(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().optional(),
    errorCode: z.string().optional(),
    evidence: z.unknown().optional(),
    incidentOrderId: z.uuid().optional(),
  })
  .strict();
type Job = z.infer<typeof websiteCareJobSchema>;
export const websiteCareStatusSchema = z
  .object({
    policies: z.array(policyResult),
    states: z.array(z.object({ policyId: z.uuid(), data: z.unknown() }).strict()),
    jobs: z.array(websiteCareJobSchema),
    offered: z.literal(true),
    automaticWithoutMandate: z.literal(false),
  })
  .strict();
const instanceId = randomUUID();
export class WebsiteCareService {
  readonly repo: Repository;
  readonly directory: string;
  readonly port: HostingCarePort;
  readonly now: () => Date;
  constructor(options: {
    repo: Repository;
    directory: string;
    port?: HostingCarePort;
    secrets?: SecretResolver;
    now?: () => Date;
  }) {
    this.repo = options.repo;
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    const secrets: SecretResolver = options.secrets ?? {
      resolve: async (ref, reason) => {
        const c = await readConfiguration(this.directory);
        if (!c.proton) throw new DomainError("hosting_secret_unconfigured");
        return new ProtonPassResolver({
          executable: c.proton.executable,
          environment: {
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            SYSTEMROOT: process.env.SYSTEMROOT,
            PATH: path.dirname(c.proton.executable),
            ...(c.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: c.proton.sessionDirectory } : {}),
          },
        }).resolve(ref, reason);
      },
    };
    this.port = options.port ?? new HostingCareHttpClient(secrets);
  }
  private next(value: z.infer<typeof schedule>) {
    try {
      return CronExpressionParser.parse(value.cron, { tz: value.timezone, currentDate: this.now() })
        .next()
        .toISOString();
    } catch {
      throw new DomainError("care_schedule_invalid");
    }
  }
  private updateWindow(update: NonNullable<Policy["update"]>) {
    const now = this.now().getTime();
    const start = CronExpressionParser.parse(update.schedule.cron, {
      tz: update.schedule.timezone,
      currentDate: new Date(now + 1),
    })
      .prev()
      .getTime();
    return now >= start && now < start + update.windowMinutes * 60000;
  }
  private async ceo(scope: Scope, id: string) {
    const i = await this.repo.getIdentity();
    if (!i || i.companyId !== scope.companyId || i.id !== id) throw new DomainError("ceo_required", undefined, 403);
  }
  async status(scope: Scope, orderId: string) {
    await this.repo.getOrder(scope, orderId);
    const policies = (await this.repo.listDocuments<Policy>(scope, "website-care-policy")).filter(
        (p) => p.data.orderId === orderId,
      ),
      ids = new Set(policies.map((p) => p.id));
    return websiteCareStatusSchema.parse({
      policies: policies.map((p) => ({ ...p.data, revision: p.revision })),
      states: (await this.repo.listDocuments<State>(scope, "website-care-state"))
        .filter((s) => ids.has(s.id))
        .map((s) => ({ policyId: s.id, data: s.data })),
      jobs: (await this.repo.listDocuments<Job>(scope, "website-care-job"))
        .filter((j) => ids.has(j.data.policyId))
        .map((j) => j.data),
      offered: true,
      automaticWithoutMandate: false,
    });
  }
  async configure(
    scope: Scope,
    orderId: string,
    ceoId: string,
    input: unknown,
    edit?: { id: string; revision: number },
  ) {
    await this.ceo(scope, ceoId);
    const parsed = websiteCarePolicySchema.parse(input),
      order = await this.repo.getOrder(scope, orderId);
    if (order.kind !== "website") throw new DomainError("website_order_required");
    this.next(parsed.backup.schedule);
    if (parsed.update) this.next(parsed.update.schedule);
    if (Date.parse(parsed.expiresAt) <= this.now().getTime()) throw new DomainError("care_policy_expired");
    const deployment = await this.repo.getDocument<DeploymentRecord>(scope, "hosting-deployment", parsed.deploymentId),
      profile = await this.repo.getDocument<HostingProfile>(scope, "hosting-profile", parsed.profileId);
    if (
      !deployment ||
      !profile ||
      deployment.data.orderId !== orderId ||
      deployment.data.profileId !== profile.id ||
      deployment.data.profileFingerprint !== profile.data.fingerprint ||
      deployment.data.state !== "verified"
    )
      throw new DomainError("care_verified_hosting_required");
    const mandate = await this.repo.getDocument<Mandate>(
      scope,
      "mandate",
      `${parsed.mandateId}:${parsed.mandateVersion}`,
    );
    const required = ["website.care.check", "website.care.backup", ...(parsed.update ? ["website.care.update"] : [])];
    if (
      !mandate ||
      required.some((tool) => !mandate.data.allowedToolIds.includes(tool)) ||
      !mandate.data.targetIds.includes(profile.id) ||
      mandate.data.revokedAt ||
      Date.parse(mandate.data.expiresAt) < Date.parse(parsed.expiresAt) ||
      (await this.repo.getDocument(scope, "mandate_revocation", `${parsed.mandateId}:${parsed.mandateVersion}`))
    )
      throw new DomainError("care_mandate_invalid");
    if (
      BigInt(parsed.budgetLimitUsdMicros) > BigInt(mandate.data.maxCostUsdMicros) ||
      BigInt(parsed.backup.costUsdMicros) + BigInt(parsed.update?.candidate.costUsdMicros ?? "0") >
        BigInt(parsed.budgetLimitUsdMicros)
    )
      throw new DomainError("care_budget_exceeded");
    const old = edit ? await this.repo.getDocument<Policy>(scope, "website-care-policy", edit.id) : undefined;
    if (edit && (!old || old.revision !== edit.revision || old.data.orderId !== orderId))
      throw new DomainError("revision_conflict");
    const peers = (await this.repo.listDocuments<Policy>(scope, "website-care-policy")).filter(
      (p) => p.id !== old?.id && p.data.enabled && p.data.deploymentId === parsed.deploymentId,
    );
    if (parsed.enabled && peers.length) throw new DomainError("care_policy_overlap");
    const id = old?.id ?? randomUUID(),
      data: Policy = {
        ...parsed,
        id,
        scope,
        orderId,
        careOrderId: old?.data.careOrderId ?? id,
        profileFingerprint: profile.data.fingerprint,
        artifactVersionId: deployment.data.deployment.artifactVersionId,
        packageSha256: deployment.data.deployment.packageSha256,
        generation: await recoveryGeneration(this.repo, scope),
        approvedBy: ceoId,
        approvedAt: this.now().toISOString(),
      };
    const lease = await this.repo.getDocument<{ policyId: string }>(scope, "website-care-target", parsed.deploymentId);
    if (parsed.enabled && lease && lease.data.policyId !== id) {
      const owner = await this.repo.getDocument<Policy>(scope, "website-care-policy", lease.data.policyId);
      if (owner?.data.enabled && owner.data.deploymentId === parsed.deploymentId)
        throw new DomainError("care_policy_overlap");
    }
    const lockMutation = parsed.enabled
      ? [
          {
            kind: "website-care-target",
            id: parsed.deploymentId,
            data: { policyId: id },
            expectedRevision: lease?.revision ?? 0,
          },
        ]
      : [];
    if (old) {
      const careOrder = await this.repo.getOrder(scope, data.careOrderId);
      if (careOrder.budgetLimitUsdMicros !== data.budgetLimitUsdMicros)
        throw new DomainError("care_order_budget_change_requires_separate_ceo_update");
      await this.repo.transact(
        scope,
        [{ kind: "website-care-policy", id, data, expectedRevision: old.revision }, ...lockMutation],
        { type: "website.care.configured", aggregateId: orderId },
      );
    } else {
      const setup = await this.repo.snapshot(scope.companyId);
      await this.repo.createOrderAndTransact(
        scope,
        {
          id,
          kind: "website",
          goal: `Technische Betreuung: ${order.goal}`,
          leadEmployeeId: setup.employees.find((e) => e.seedKey === "operations")!.id,
          budgetLimitUsdMicros: data.budgetLimitUsdMicros,
          acceptanceCriteria: [
            "Mandated hosted website health, encrypted backups and exact approved runtime patches",
            "Content and SEO are separate orders",
          ],
        },
        [{ kind: "website-care-policy", id, data, expectedRevision: 0 }, ...lockMutation],
        { type: "website.care.configured", aggregateId: orderId },
      );
    }
    const state = await this.repo.getDocument<State>(scope, "website-care-state", id);
    await this.repo.putDocument(
      scope,
      "website-care-state",
      id,
      {
        ...state?.data,
        nextCheckAt: this.now().toISOString(),
        nextBackupAt: this.next(parsed.backup.schedule),
        ...(parsed.update ? { nextUpdateAt: this.next(parsed.update.schedule) } : {}),
      },
      { expectedRevision: state?.revision ?? 0 },
    );
    return policyResult.parse({ ...data, revision: (old?.revision ?? 0) + 1 });
  }
  private async context(policy: Document<Policy>) {
    const p = policy.data,
      fresh = await this.repo.getDocument<Policy>(p.scope, "website-care-policy", p.id);
    if (
      !fresh ||
      fresh.revision !== policy.revision ||
      !fresh.data.enabled ||
      Date.parse(p.expiresAt) <= this.now().getTime() ||
      (await recoveryGeneration(this.repo, p.scope)) !== p.generation
    )
      throw new DomainError("care_authorization_changed");
    await this.repo.assertDispatchAllowed(p.scope.companyId);
    const profile = await this.repo.getDocument<HostingProfile>(p.scope, "hosting-profile", p.profileId),
      deployment = await this.repo.getDocument<DeploymentRecord>(p.scope, "hosting-deployment", p.deploymentId);
    if (
      !profile ||
      profile.data.fingerprint !== p.profileFingerprint ||
      !deployment ||
      deployment.data.state !== "verified" ||
      deployment.data.deployment.artifactVersionId !== p.artifactVersionId ||
      deployment.data.deployment.packageSha256 !== p.packageSha256
    )
      throw new DomainError("care_target_changed");
    const artifact = await this.repo.getDocument<{ sha256: string; packageSha256: string }>(
      p.scope,
      "artifact",
      p.artifactVersionId,
    );
    if (!artifact || artifact.data.packageSha256 !== p.packageSha256) throw new DomainError("care_artifact_changed");
    const packet: HostingPackage = {
      artifactVersionId: p.artifactVersionId,
      packageSha256: p.packageSha256,
      archiveSha256: deployment.data.deployment.archiveSha256,
      entrySha256: artifact.data.sha256,
      archive: Buffer.alloc(0),
    };
    return { profile: profile.data, deployment: deployment.data.deployment, packet };
  }
  async run(scope: Scope, orderId: string, ceoId: string, policyId: string, kind: Job["kind"]) {
    await this.ceo(scope, ceoId);
    const policy = await this.repo.getDocument<Policy>(scope, "website-care-policy", policyId);
    if (!policy || policy.data.orderId !== orderId) throw new DomainError("care_policy_missing");
    return this.execute(policy, kind, this.now().toISOString());
  }
  async tickCompany(companyId: string) {
    for (const policy of await this.repo.listCompanyDocuments<Policy>(companyId, "website-care-policy")) {
      if (!policy.data.enabled) continue;
      const state = await this.repo.getDocument<State>(policy.scope, "website-care-state", policy.id);
      if (!state) continue;
      for (const [kind, due] of [
        ["check", state.data.nextCheckAt],
        ["backup", state.data.nextBackupAt],
        ["update", state.data.nextUpdateAt],
      ] as const) {
        if (
          due &&
          Date.parse(due) <= this.now().getTime() &&
          (kind !== "update" || state.data.attemptedUpdateVersion !== policy.data.update?.candidate.version)
        )
          try {
            if (kind === "update" && policy.data.update && !this.updateWindow(policy.data.update)) {
              const current = (await this.repo.getDocument<State>(policy.scope, "website-care-state", policy.id))!;
              await this.repo.putDocument(
                policy.scope,
                "website-care-state",
                policy.id,
                {
                  ...current.data,
                  nextUpdateAt: this.next(policy.data.update.schedule),
                  lastError: "care_update_window_missed",
                },
                { expectedRevision: current.revision },
              );
              continue;
            }
            await this.execute(policy, kind, due);
          } catch {
            /* Persisted job errors remain visible; no uncontrolled scheduler rejection loop. */
          }
      }
    }
  }
  private async execute(policy: Document<Policy>, kind: Job["kind"], slot: string) {
    const p = policy.data;
    await this.context(policy);
    if (kind === "update" && !p.update) throw new DomainError("care_update_not_approved");
    if (kind === "update" && !this.updateWindow(p.update!)) throw new DomainError("care_update_outside_window");
    const previous = (await this.repo.listDocuments<Job>(p.scope, "website-care-job")).filter(
      (j) => j.data.policyId === p.id && ["running", "effect_unknown"].includes(j.data.state),
    );
    for (const job of previous)
      if (job.data.state === "running" && job.data.owner !== instanceId)
        await this.repo.putDocument(
          p.scope,
          "website-care-job",
          job.id,
          { ...job.data, state: "effect_unknown", errorCode: "care_process_interrupted" },
          { expectedRevision: job.revision },
        );
    if (previous.length) throw new DomainError("care_effect_unreconciled");
    const id = shaUuid(`website-care:${p.id}:${policy.revision}:${kind}:${slot}`),
      existing = await this.repo.getDocument<Job>(p.scope, "website-care-job", id);
    if (existing) return existing.data;
    const state = (await this.repo.getDocument<State>(p.scope, "website-care-state", p.id))!,
      job: Job = {
        id,
        policyId: p.id,
        policyRevision: policy.revision,
        orderId: p.orderId,
        kind,
        slot,
        state: "running",
        owner: instanceId,
        startedAt: this.now().toISOString(),
      };
    const next = {
      ...state.data,
      ...(kind === "check"
        ? { nextCheckAt: new Date(this.now().getTime() + p.healthIntervalSeconds * 1000).toISOString() }
        : kind === "backup"
          ? { nextBackupAt: this.next(p.backup.schedule) }
          : { nextUpdateAt: this.next(p.update!.schedule) }),
    };
    await this.repo.transact(
      p.scope,
      [
        { kind: "website-care-job", id, data: job, expectedRevision: 0 },
        { kind: "website-care-state", id: p.id, data: next, expectedRevision: state.revision },
      ],
      { type: "website.care.started", aggregateId: p.orderId, data: { jobId: id, kind } },
    );
    let result: unknown;
    try {
      if (kind === "check")
        result = await this.perform(policy, id, "check", "0", async (auth) => {
          const c = await this.context(policy);
          return this.port.check(c.profile, c.deployment, c.packet, auth);
        });
      else if (kind === "backup") result = await this.backup(policy, id);
      else {
        const c = await this.context(policy),
          candidate = p.update!.candidate;
        const backup = await this.backup(policy, shaUuid(id + ":backup"));
        result = await this.perform(policy, id, "update", candidate.costUsdMicros, async (auth) => {
          await this.port.version(
            c.profile,
            c.deployment,
            candidate.currentVersion,
            candidate.currentManifestSha256,
            auth,
          );
          const receipt = await this.port.update(c.profile, c.deployment, id, candidate, backup.backup, auth);
          try {
            await this.port.version(c.profile, c.deployment, candidate.version, candidate.manifestSha256, auth);
            const health = await this.port.check(c.profile, c.deployment, c.packet, auth);
            return { receipt, health };
          } catch {
            await this.port.rollback(c.profile, c.deployment, shaUuid(id + ":rollback"), receipt, auth);
            await this.port.version(
              c.profile,
              c.deployment,
              receipt.previousVersion,
              receipt.previousManifestSha256,
              auth,
            );
            const health = await this.port.check(c.profile, c.deployment, c.packet, auth);
            return { rolledBack: true, receipt, health };
          }
        });
      }
      const rolledBack = Boolean((result as { rolledBack?: boolean })?.rolledBack);
      const latest = (await this.repo.getDocument<State>(p.scope, "website-care-state", p.id))!;
      const data = {
        ...latest.data,
        lastError: rolledBack ? "care_update_rolled_back" : undefined,
        ...(kind === "check"
          ? { lastCheckAt: this.now().toISOString(), outageEventId: undefined }
          : kind === "backup"
            ? { lastBackupAt: this.now().toISOString() }
            : { lastUpdateAt: this.now().toISOString(), attemptedUpdateVersion: p.update!.candidate.version }),
      };
      const finished: Job = {
        ...job,
        state: rolledBack ? "rolled_back" : "succeeded",
        finishedAt: this.now().toISOString(),
        evidence: result,
      };
      await this.repo.transact(
        p.scope,
        [
          { kind: "website-care-job", id, data: finished, expectedRevision: 1 },
          { kind: "website-care-state", id: p.id, data, expectedRevision: latest.revision },
        ],
        { type: "website.care.finished", aggregateId: p.orderId, data: { jobId: id, state: finished.state } },
      );
      return finished;
    } catch (error) {
      const unknown = error instanceof IntegrationError && error.effectStatus === "effect_unknown",
        code = error instanceof DomainError || error instanceof IntegrationError ? error.code : "care_operation_failed";
      const latest = (await this.repo.getDocument<State>(p.scope, "website-care-state", p.id))!;
      let incidentOrderId = latest.data.incidentOrderId,
        outageEventId = latest.data.outageEventId;
      if ((kind === "check" && ["provider", "transport", "timeout", "auth"].includes(code)) || unknown) {
        outageEventId ??= id;
        const incident = await new IncidentWorkflow(this.repo, this.now).ingest(p.scope, {
          provider: "website-care",
          accountId: p.id,
          eventId: outageEventId,
          targetId: p.profileId,
          summary: `Technische Betreuung erfordert Prüfung: ${p.orderId}`,
          budgetLimitUsdMicros: p.incidentBudgetLimitUsdMicros,
        });
        incidentOrderId = incident.data.orderId;
      }
      const finished: Job = {
        ...job,
        state: unknown ? "effect_unknown" : "failed",
        finishedAt: this.now().toISOString(),
        errorCode: code,
        ...(incidentOrderId ? { incidentOrderId } : {}),
      };
      await this.repo.transact(
        p.scope,
        [
          { kind: "website-care-job", id, data: finished, expectedRevision: 1 },
          {
            kind: "website-care-state",
            id: p.id,
            data: { ...latest.data, lastError: code, incidentOrderId, outageEventId },
            expectedRevision: latest.revision,
          },
        ],
        { type: "website.care.failed", aggregateId: p.orderId, data: { jobId: id, code } },
      );
      return finished;
    }
  }
  private async backup(policy: Document<Policy>, id: string) {
    return (await this.perform(policy, id, "backup", policy.data.backup.costUsdMicros, async (auth) => {
      const c = await this.context(policy);
      return this.port.backup(c.profile, c.deployment, id, policy.data.backup, auth);
    })) as { backup: CareBackupReceipt; probe: unknown };
  }
  private async perform(
    policy: Document<Policy>,
    id: string,
    kind: Job["kind"],
    cost: string,
    execute: (authorize: () => Promise<void>) => Promise<unknown>,
  ) {
    const p = policy.data,
      actions = new ManagedActions(this.repo, path.join(this.directory, "receipts"));
    const result = await actions.perform(
      {
        id,
        scope: p.scope,
        orderId: p.careOrderId,
        toolId: `website.care.${kind}`,
        targetId: p.profileId,
        args: {
          policyId: p.id,
          policyRevision: policy.revision,
          policySha256: sha256(p),
          deploymentId: p.deploymentId,
          artifactVersionId: p.artifactVersionId,
          packageSha256: p.packageSha256,
          ...(kind === "backup" ? { backup: p.backup } : kind === "update" ? { update: p.update! } : {}),
        } as Json,
        effect: kind === "check" ? "read" : "external_change",
        mandateId: p.mandateId,
        mandateVersion: p.mandateVersion,
      },
      async (action) => {
        const auth = async () => {
          const fresh = await this.context(policy);
          if (kind === "update" && !this.updateWindow(p.update!)) throw new DomainError("care_update_outside_window");
          await this.repo.assertAuthorized(p.scope, {
            action,
            targetId: p.profileId,
            effect: kind === "check" ? "read" : "external_change",
            costUsdMicros: cost,
            durationSeconds:
              Math.ceil(fresh.profile.timeoutMs / 1000) * (kind === "update" ? 12 : kind === "backup" ? 2 : 3) + 1,
          });
        };
        await auth();
        const budget = await this.repo.budget(p.scope.companyId);
        await this.repo.reserveAndTransact(
          p.scope,
          {
            id,
            periodId: budget.periodId,
            orderId: p.careOrderId,
            actionId: id,
            mandateId: p.mandateId,
            mandateVersion: p.mandateVersion,
            amountUsdMicros: cost,
          },
          [
            {
              kind: "website-care-charge",
              id,
              data: { policyId: p.id, actionId: id, kind, costUsdMicros: cost, status: "reserved" },
              expectedRevision: 0,
            },
          ],
          { type: "website.care.cost_reserved", aggregateId: p.orderId, data: { actionId: id, cost } },
        );
        try {
          const evidence = await execute(auth);
          await this.repo.settleAndTransact(
            p.scope,
            { reservationId: id, actualMicros: cost },
            [
              {
                kind: "website-care-charge",
                id,
                data: { policyId: p.id, actionId: id, kind, costUsdMicros: cost, status: "settled" },
                expectedRevision: 1,
              },
            ],
            { type: "website.care.cost_settled", aggregateId: p.orderId },
          );
          return evidence;
        } catch (error) {
          await this.repo.settleAndTransact(
            p.scope,
            { reservationId: id, ...(kind === "check" ? { actualMicros: "0" } : {}) },
            [
              {
                kind: "website-care-charge",
                id,
                data: {
                  policyId: p.id,
                  actionId: id,
                  kind,
                  costUsdMicros: cost,
                  status: kind === "check" ? "settled" : "unreconciled",
                },
                expectedRevision: 1,
              },
            ],
            { type: "website.care.cost_failed", aggregateId: p.orderId },
          );
          if (kind !== "check")
            throw new IntegrationError("provider", "Pflegewirkung oder Abrechnung unklar.", "effect_unknown");
          throw error;
        }
      },
    );
    if (result.state !== "succeeded") {
      if (result.state === "effect_unknown")
        throw new IntegrationError("provider", "Pflegewirkung ungeklärt.", "effect_unknown");
      throw new DomainError(
        typeof (result.data as { code?: unknown })?.code === "string"
          ? (result.data as { code: string }).code
          : "care_operation_failed",
      );
    }
    return result.data;
  }
}
