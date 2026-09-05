import type { DatabaseSync } from "node:sqlite";
import { RoutingError, type RoutingStore } from "../domain/routing-store.ts";
import type { VesselRow } from "../domain/vessel-store.ts";
import type { RouteTarget, RoutingProfile } from "../../../src/shared/routing-profiles.ts";
import type { AgentRuntime } from "./run-events.ts";
import { appendAuditEvent } from "../domain/audit.ts";
import type { BudgetEngine } from "../policy/budget-engine.ts";

export interface RouteSelection {
  target: RouteTarget;
  vessel: VesselRow;
  runtime: AgentRuntime;
  workspacePath: string;
  profileKey: string;
  revision: number;
  fallbackIndex: number;
}
/** Bound unresponsive probes, retaining no raw provider output in routing errors. */
async function probe<T>(action: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5000);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function selectProfileRoute(options: {
  db: DatabaseSync;
  store: RoutingStore;
  budgets: BudgetEngine;
  runtimes: ReadonlyMap<string, AgentRuntime>;
  companyId: string;
  agentId: string;
  taskId: string | null;
  projectId: string | null;
  correlationId: string;
  binding: { revision: number; profile: RoutingProfile };
  sensitive: boolean;
  workspace: (runtime: AgentRuntime) => Promise<string>;
}): Promise<RouteSelection> {
  const { db, store, budgets, runtimes, companyId, agentId, taskId, projectId, correlationId, binding } = options;
  const profile = binding.profile;
  const audit = (action: string, details: Record<string, unknown>, outcome: "ok" | "denied" = "ok") =>
    appendAuditEvent(db, {
      companyId,
      actorType: "system",
      actorId: "profile-router",
      action,
      entityType: "routing_profile",
      entityId: profile.key,
      taskId,
      correlationId,
      outcome,
      details: { profileKey: profile.key, revision: binding.revision, agentId, ...details },
    });
  if (!profile.allowedSensitivity.includes(options.sensitive ? "confidential" : "internal")) {
    audit("routing.denied", { reason: "sensitivity" }, "denied");
    throw new RoutingError("sensitivity", "Routingprofil ist für diese Vertraulichkeit nicht freigegeben.", 403);
  }
  const candidates = [
    ...(profile.primary ? [profile.primary] : []),
    ...(profile.allowFallback ? profile.fallbacks : []),
  ];
  for (let index = 0; index < candidates.length; index++) {
    const target = candidates[index];
    // Policy, scope, workspace and budgets are hard stops, never excuses to
    // route around a denial via another candidate.
    let vessel: VesselRow;
    try {
      vessel = store.target(companyId, target);
      budgets.assertRunPermitted(companyId, {
        agentId,
        taskId,
        projectId,
        runtimeType: target.runtimeType,
        provider: target.runtimeType,
      });
      budgets.assertRunPermitted(companyId, {
        agentId,
        taskId,
        projectId,
        runtimeType: target.runtimeType,
        provider: target.vendorModel.split("/")[0],
      });
    } catch (error) {
      audit(
        "routing.denied",
        { reason: "policy_scope_or_budget", candidate: index, vesselId: target.vesselId },
        "denied",
      );
      throw error;
    }
    const runtime = runtimes.get(target.runtimeType);
    let unavailable = "";
    if (!runtime) unavailable = "runtime_not_registered";
    const cooling = db
      .prepare(
        `SELECT 1 FROM crew_run_requests q JOIN crew_runs r ON r.id=q.run_id WHERE q.company_id=? AND q.status IN ('queued','running') AND q.not_before>? AND r.runtime_type=? AND r.status='rate_limited' LIMIT 1`,
      )
      .get(companyId, Date.now(), target.runtimeType);
    if (cooling) unavailable = "rate_limited";
    if (store.activeCount(companyId, vessel.id) >= vessel.max_concurrency) unavailable = "capacity";
    if (unavailable) {
      audit("routing.candidate_unavailable", {
        candidate: index,
        vesselId: vessel.id,
        runtimeType: target.runtimeType,
        reason: unavailable,
      });
      continue;
    }
    const capabilities = await probe(() => runtime!.capabilities());
    if (!capabilities) {
      audit("routing.candidate_unavailable", { candidate: index, reason: "capability_probe_unavailable" });
      continue;
    }
    for (const required of profile.requiredCapabilities)
      if (capabilities[required] !== true) {
        audit("routing.denied", { candidate: index, reason: "capability_unconfirmed", capability: required }, "denied");
        throw new RoutingError(
          "capability_unconfirmed",
          `Runtime bestätigt die benötigte Fähigkeit „${required}“ nicht.`,
          403,
        );
      }
    const workspacePath = await options.workspace(runtime!);
    const health = await probe(() => runtime!.healthCheck());
    const auth = health?.healthy && health.installed ? await probe(() => runtime!.authStatus()) : null;
    // Unverified auth is not falsely reported as authenticated. A run may
    // still attempt the official runtime's own auth/JIT-SecretRef boundary.
    const authRefused = auth && auth.verification !== "unverified" && !auth.authenticated;
    if (!health?.healthy || !health.installed || !auth || authRefused) {
      audit("routing.candidate_unavailable", {
        candidate: index,
        vesselId: vessel.id,
        reason: authRefused ? "not_authenticated" : "runtime_unavailable",
      });
      continue;
    }
    audit("routing.selected", {
      candidate: index,
      vesselId: vessel.id,
      runtimeType: target.runtimeType,
      model: target.model,
      vendorModel: target.vendorModel,
      fallback: index > 0,
    });
    return {
      target,
      vessel,
      runtime: runtime!,
      workspacePath,
      profileKey: profile.key,
      revision: binding.revision,
      fallbackIndex: index,
    };
  }
  audit("routing.unavailable", { attempted: candidates.length, fallbackAllowed: profile.allowFallback }, "denied");
  throw new RoutingError(
    "routing_unavailable",
    "Keine freigegebene Route ist derzeit verfügbar. Es wurde kein Run gestartet.",
    503,
  );
}
