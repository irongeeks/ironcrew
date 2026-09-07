import { configuredMailInboxService } from "./mail-inbox-configured.ts";
import { FinanceService } from "./finance-service.ts";
import { WebsiteCareService } from "./website-care-service.ts";
import { IncidentService } from "./incident-service.ts";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Mandate, Scope } from "../../packages/contracts/src/index.ts";
import { Scheduler, type Schedule } from "../../packages/domain/workflows/automation.ts";
import { DomainError, canonicalJson } from "../../packages/domain/src/index.ts";
import { route, type Model } from "../../packages/runtime/src/openrouter.ts";
import type { Runtime } from "../../packages/runtime/src/engine.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
import { refreshCatalog } from "./catalog.ts";
import { configuredResearchWatch } from "./research-watch-routes.ts";
import type { WatchDefinition } from "../../packages/domain/workflows/research-watch.ts";
import { ModelRatings, ratingRoutingStats } from "../../packages/runtime/src/ratings.ts";

/** One coordinator per control instance. Pending fires survive a process restart. */
export class BackgroundCoordinator {
  private busy = false;
  private pauses = 0;
  private stopped = false;
  private idleWaiters = new Set<() => void>();
  private nextCatalogAttempt = 0;
  private readonly repo: Repository;
  private readonly getRuntime: () => Runtime | undefined;
  private readonly catalogRefresh: typeof refreshCatalog;
  private readonly directory?: string;
  private readonly incidentService?: IncidentService;
  private readonly watchCheck?: (watch: WatchDefinition, checkId: string) => Promise<unknown>;
  constructor(
    repo: Repository,
    getRuntime: () => Runtime | undefined,
    catalogRefresh = refreshCatalog,
    directory?: string,
    watchCheck?: (watch: WatchDefinition, checkId: string) => Promise<unknown>,
  ) {
    this.repo = repo;
    this.getRuntime = getRuntime;
    this.catalogRefresh = catalogRefresh;
    this.directory = directory;
    this.incidentService = directory ? new IncidentService({ repo, directory }) : undefined;
    this.watchCheck = watchCheck;
  }
  async tick(now = new Date()) {
    if (this.busy || this.pauses || this.stopped) return;
    this.busy = true;
    try {
      const setup = await this.repo.setupState();
      if (!setup) return;
      const companyScope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
      try {
        await this.repo.assertDispatchAllowed(setup.company.id);
      } catch {
        return;
      }
      if (this.incidentService) await this.incidentService.tick(companyScope);
      if (this.directory) await configuredMailInboxService(this.repo, this.directory).tick(setup.company.id);
      if (this.directory)
        await new FinanceService({ repo: this.repo, directory: this.directory }).tick(setup.company.id);
      if (this.directory)
        await new WebsiteCareService({ repo: this.repo, directory: this.directory }).tickCompany(setup.company.id);
      if (now.getTime() >= this.nextCatalogAttempt) {
        this.nextCatalogAttempt = now.getTime() + 900_000;
        const catalog = await this.repo.getDocument<{ observedAt?: string }>(
          companyScope,
          "catalog-status",
          setup.company.id,
        );
        if (!catalog?.data.observedAt || now.getTime() - Date.parse(catalog.data.observedAt) >= 900_000) {
          try {
            const fresh = await this.catalogRefresh(this.repo, companyScope);
            if (this.getRuntime()) this.getRuntime()!.models = fresh.models;
          } catch {
            /* refreshCatalog persists its stale status; no inference credentials are used. */
          }
        }
      }
      if (this.pauses || this.stopped) return;
      await this.repo.assertDispatchAllowed(setup.company.id);
      if (this.directory || this.watchCheck) {
        for (const watch of await this.repo.listCompanyDocuments<WatchDefinition>(setup.company.id, "research-watch")) {
          if (this.pauses || this.stopped) return;
          if (!watch.data.enabled || Date.parse(watch.data.nextCheckAt) > now.getTime()) continue;
          await this.repo.assertDispatchAllowed(setup.company.id);
          const checkId = shaUuid("watch:" + watch.id + ":" + watch.data.nextCheckAt);
          try {
            if (this.watchCheck) await this.watchCheck(watch.data, checkId);
            else
              await configuredResearchWatch(this.repo, this.directory!, watch.data).check(watch.scope, watch.id, {
                checkId,
              });
          } catch (error) {
            const prior = await this.repo.getDocument(watch.scope, "research-watch-status", watch.id);
            await this.repo.putDocument(
              watch.scope,
              "research-watch-status",
              watch.id,
              {
                watchId: watch.id,
                state: "blocked",
                reason: error instanceof DomainError ? error.code : "watch_check_failed",
                at: now.toISOString(),
              },
              { expectedRevision: prior?.revision ?? 0 },
            );
          }
        }
      }
      const scopes = new Map<string, Scope>();
      for (const area of setup.areas) {
        const scope = { companyId: setup.company.id, areaId: area.id };
        scopes.set(canonicalJson(scope), scope);
      }
      for (const schedule of await this.repo.listCompanyDocuments<Schedule>(setup.company.id, "schedule"))
        scopes.set(canonicalJson(schedule.scope), schedule.scope);
      await this.repo.budget(setup.company.id);
      for (const scope of scopes.values()) {
        if (this.pauses || this.stopped) return;
        await new Scheduler(this.repo).tick(scope, now);
        const schedules = await this.repo.listDocuments<Schedule>(scope, "schedule");
        for (const fire of await this.repo.listDocuments<{ orderId: string; scheduleId: string }>(
          scope,
          "schedule-fire",
        )) {
          const id = fire.data.orderId;
          if (await this.repo.getDocument(scope, "schedule-dispatch", id)) continue;
          const schedule = schedules.find((s) => s.id === fire.data.scheduleId)?.data;
          if (!schedule || !schedule.enabled) continue;
          const order = await this.repo.getOrder(scope, id);
          if (!["inbox", "planning", "ready", "running"].includes(order.status)) continue;
          const mandate = await this.repo.getDocument<Mandate>(
            scope,
            "mandate",
            schedule.mandateId + ":" + schedule.mandateVersion,
          );
          if (
            !mandate ||
            mandate.data.revokedAt ||
            Date.parse(mandate.data.expiresAt) <= now.getTime() ||
            (await this.repo.getDocument(
              scope,
              "mandate_revocation",
              schedule.mandateId + ":" + schedule.mandateVersion,
            ))
          )
            continue;
          const runtime = this.getRuntime();
          if (!runtime) {
            await this.status(scope, id, "model_not_configured");
            continue;
          }
          if (await this.repo.getDocument(scope, "run", id)) {
            // A surviving run may already have dispatched a model request: never blindly repeat it.
            await this.repo.putDocument(
              scope,
              "schedule-dispatch",
              id,
              { orderId: id, state: "handed_to_runtime", recovered: true },
              { immutable: true },
            );
            continue;
          }
          const tools = await runtime.localTools(id, scope);
          const budget = await this.repo.budget(scope.companyId);
          const profile = await this.repo.getDocument<{ modelOverride?: string | null }>(
            companyScope,
            "employee-profile",
            order.leadEmployeeId,
          );
          const ratingStats = ratingRoutingStats(
            await new ModelRatings(this.repo).summaries(scope.companyId, { orderKind: order.kind }),
          );
          const selection = route(
            runtime.models,
            {
              messages: [{ role: "user", content: order.goal }],
              tools: tools.map((t) => ({
                type: "function",
                function: {
                  name: t.id.replaceAll(".", "__"),
                  description: t.description,
                  parameters: z.toJSONSchema(t.schema),
                },
              })),
              max_tokens: 4096,
            },
            budget.availableUsdMicros,
            profile?.data.modelOverride ?? undefined,
            ratingStats,
          );
          if (!selection.selected) {
            await this.status(scope, id, "no_routable_model");
            continue;
          }
          try {
            // Plan creation is a durable CAS. The schedule's versioned mandate provides routine authority.
            if (order.planVersion === 0)
              await this.repo.commitPlan(scope, id, order.revision, {
                steps: [
                  schedule.goal,
                  "Verify the result and record evidence; pause for any required concrete approval.",
                ],
                acceptanceCriteria: order.acceptanceCriteria,
              });
            const selectionId = shaUuid("schedule:" + id + ":" + selection.selected.model.id);
            if (!(await this.repo.getDocument(scope, "model-selection", selectionId)))
              await this.repo.putDocument(
                scope,
                "model-selection",
                selectionId,
                {
                  orderId: id,
                  modelId: selection.selected.model.id,
                  score: selection.selected.score,
                  samples: selection.selected.samples,
                  estimatedUsdMicros: selection.selected.cost,
                  source: "schedule",
                  at: now.toISOString(),
                },
                { immutable: true },
              );
            if (this.pauses || this.stopped) return;
            await runtime.start(scope, id, mandate.data, selection.selected.model.id, mandate.data.targetIds[0] ?? id);
            await this.repo.putDocument(
              scope,
              "schedule-dispatch",
              id,
              { orderId: id, state: "handed_to_runtime", at: now.toISOString() },
              { immutable: true },
            );
          } catch (error) {
            await this.status(scope, id, error instanceof DomainError ? error.code : "schedule_dispatch_failed");
          }
        }
      }
    } finally {
      this.busy = false;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
  private idle(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.idleWaiters.add(resolve)) : Promise.resolve();
  }
  /** Pause synchronously, then wait for the current tick before a backup snapshot. */
  async pause(): Promise<() => void> {
    this.pauses++;
    await this.idle();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.pauses--;
      }
    };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }
  private async status(scope: Scope, id: string, reason: string) {
    const old = await this.repo.getDocument(scope, "schedule-status", id);
    await this.repo.putDocument(
      scope,
      "schedule-status",
      id,
      { orderId: id, state: "blocked", reason, at: new Date().toISOString() },
      { expectedRevision: old?.revision ?? 0 },
    );
  }
}
export type CatalogRefreshResult = { models: Model[]; observedAt: string };
