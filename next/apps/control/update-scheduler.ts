import { randomUUID } from "node:crypto";
import { DomainError } from "../../packages/domain/src/index.ts";
import { inMaintenanceWindow, type UpdatePolicyInput } from "../../packages/operations/src/maintenance.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";

type Plan = {
  id: string;
  state: string;
  policyId: string;
  policyFingerprint: string;
  approvedBy?: string;
  expiresAt?: string;
  approvedAt?: string;
};
type Policy = UpdatePolicyInput & { fingerprint: string };
type Attempt = {
  planId: string;
  state: "running" | "queued" | "applied" | "deferred" | "failed" | "effect_unknown";
  bootId: string;
  attemptedAt: string;
  retryNotBefore?: string;
  code?: string;
};
/** Opt-in timing of already explicitly approved plans; never grants or extends an approval. */
export class UpdateScheduler {
  private bootId = randomUUID();
  private options: {
    repo: Repository;
    apply: (scope: Scope, ceoId: string, planId: string) => Promise<unknown>;
    now?: () => Date;
  };
  constructor(options: UpdateScheduler["options"]) {
    this.options = options;
  }
  async tick(scope: Scope) {
    const { repo } = this.options;
    try {
      await repo.assertDispatchAllowed(scope.companyId);
    } catch {
      return;
    }
    const setup = await repo.setupState();
    if (
      !setup ||
      setup.company.id !== scope.companyId ||
      !setup.areas.some((a) => a.id === scope.areaId && a.visibility === "company") ||
      scope.projectId ||
      scope.customerId
    )
      return;
    const now = this.options.now?.() ?? new Date();
    for (const planRecord of await repo.listDocuments<Plan>(scope, "update-plan")) {
      const plan = planRecord.data;
      if (
        plan.state !== "approved" ||
        plan.approvedBy !== setup.ceo.id ||
        !plan.approvedAt ||
        !plan.expiresAt ||
        !Number.isFinite(Date.parse(plan.expiresAt)) ||
        Date.parse(plan.expiresAt) <= now.getTime()
      )
        continue;
      const policy = await repo.getDocument<Policy>(scope, "update-policy", plan.policyId);
      if (
        !policy?.data.autoApplyApproved ||
        policy.data.fingerprint !== plan.policyFingerprint ||
        (await repo.getDocument(scope, "update-policy-revocation", plan.policyId)) ||
        !inMaintenanceWindow(policy.data.window, now)
      )
        continue;
      const id = plan.id + ":" + plan.approvedAt;
      const prior = await repo.getDocument<Attempt>(scope, "update-schedule-attempt", id);
      if (prior && prior.data.state !== "deferred") {
        if (prior.data.state === "running" && prior.data.bootId !== this.bootId)
          await repo.putDocument(
            scope,
            "update-schedule-attempt",
            id,
            { ...prior.data, state: "effect_unknown", code: "scheduler_restart_unknown" },
            { expectedRevision: prior.revision },
          );
        continue;
      }
      if (prior?.data.retryNotBefore && Date.parse(prior.data.retryNotBefore) > now.getTime()) continue;
      const attempt: Attempt = {
        planId: plan.id,
        state: "running",
        bootId: this.bootId,
        attemptedAt: now.toISOString(),
      };
      let claimed;
      try {
        claimed = await repo.putDocument(scope, "update-schedule-attempt", id, attempt, {
          expectedRevision: prior?.revision ?? 0,
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === "revision_conflict") continue;
        throw error;
      }
      let next: Attempt;
      try {
        const outcome = (await this.options.apply(scope, setup.ceo.id, plan.id)) as { state?: unknown };
        if (outcome?.state !== "queued" && outcome?.state !== "applied") throw new Error("update_result_unknown");
        next = { ...attempt, state: outcome.state };
      } catch (error) {
        const known = error instanceof DomainError;
        const code = known ? error.code : "update_effect_unknown";
        const deferred = known && ["updater_unavailable", "maintenance_update_busy", "backup_busy"].includes(code);
        next = {
          ...attempt,
          state: deferred ? "deferred" : known ? "failed" : "effect_unknown",
          code,
          ...(deferred ? { retryNotBefore: new Date(now.getTime() + 30_000).toISOString() } : {}),
        };
      }
      await repo.putDocument(scope, "update-schedule-attempt", id, next, { expectedRevision: claimed.revision });
      return;
    }
  }
}
