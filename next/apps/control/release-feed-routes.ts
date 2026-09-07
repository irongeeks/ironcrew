import type { Express, Response } from "express";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import {
  ReleaseFeedService,
  readReleaseFeedConfiguration,
  releaseCandidateSchema,
  releaseFeedTrustFingerprint,
} from "../../packages/operations/src/release-feed.ts";
import type { MaintenanceService } from "./maintenance-service.ts";
import type { MutationHandler } from "./workflow-routes.ts";
export const releaseDiscoverInputSchema = z.object({ policyId: z.uuid() }).strict();
export const releaseStagePlanInputSchema = z.object({}).strict();
export const releaseCandidatesResultSchema = z
  .object({ configured: z.boolean(), candidates: z.array(releaseCandidateSchema) })
  .strict();
export const releaseDiscoverResultSchema = z.object({ candidates: z.array(releaseCandidateSchema) }).strict();
export const releaseStagePlanResultSchema = z
  .object({
    candidateId: z.uuid(),
    planId: z.uuid(),
    state: z.enum(["planned", "approved", "queued", "running", "applied", "failed", "effect_unknown"]),
  })
  .strict();
export async function configuredReleaseFeed(options: { repo: Repository; directory: string; currentVersion?: string }) {
  const configuration = await readReleaseFeedConfiguration(options.directory);
  return configuration ? new ReleaseFeedService({ ...options, configuration }) : undefined;
}
const queues = new WeakMap<Repository, Map<string, Promise<unknown>>>();
export function registerReleaseFeedRoutes(
  app: Express,
  options: {
    repo: Repository;
    directory: string;
    currentVersion?: string;
    maintenance: MaintenanceService;
    context: (res: Response) => Promise<{ scope: Scope; ceoId: string }> | { scope: Scope; ceoId: string };
    mutate: MutationHandler;
  },
) {
  app.get("/api/v1/maintenance/releases", async (_req, res) => {
    const actor = await options.context(res);
    const feed = await configuredReleaseFeed(options);
    res.json(
      releaseCandidatesResultSchema.parse({
        configured: !!feed,
        candidates: feed ? await feed.list(actor.scope, actor.ceoId) : [],
      }),
    );
  });
  app.post(
    "/api/v1/maintenance/releases/discover",
    options.mutate(async (req, res) => {
      const actor = await options.context(res),
        input = releaseDiscoverInputSchema.parse(req.body),
        feed = await configuredReleaseFeed(options);
      if (!feed) throw new DomainError("release_feed_not_configured");
      return releaseDiscoverResultSchema.parse({
        candidates: await feed.discover(actor.scope, actor.ceoId, input.policyId),
      });
    }),
  );
  app.post(
    "/api/v1/maintenance/releases/candidates/:id/stage-plan",
    options.mutate(async (req, res) => {
      const actor = await options.context(res),
        id = z.uuid().parse(req.params.id);
      releaseStagePlanInputSchema.parse(req.body ?? {});
      let map = queues.get(options.repo);
      if (!map) {
        map = new Map();
        queues.set(options.repo, map);
      }
      const prior = map.get(id) ?? Promise.resolve();
      const operation = prior
        .catch(() => {})
        .then(async () => {
          const feed = await configuredReleaseFeed(options);
          if (!feed) throw new DomainError("release_feed_not_configured");
          const staged = await feed.stage(actor.scope, actor.ceoId, id);
          const fresh = await configuredReleaseFeed(options);
          if (!fresh || JSON.stringify(fresh.config) !== JSON.stringify(feed.config))
            throw new DomainError("release_feed_changed");
          const existing = (
            await options.repo.listDocuments<{
              id: string;
              policyId: string;
              policyFingerprint: string;
              releaseDirectory: string;
              manifestSha256: string;
              state: string;
            }>(actor.scope, "update-plan")
          ).find(
            (p) =>
              p.data.policyId === staged.candidate.policyId &&
              p.data.policyFingerprint === staged.candidate.policyFingerprint &&
              p.data.releaseDirectory === staged.releaseDirectory &&
              p.data.manifestSha256 === staged.candidate.release.manifestSha256,
          );
          const plan =
            existing?.data ??
            (await options.maintenance.proposeUpdate(
              actor.scope,
              actor.ceoId,
              staged.candidate.policyId,
              staged.releaseDirectory,
            ));
          return releaseStagePlanResultSchema.parse({ candidateId: id, planId: plan.id, state: plan.state });
        });
      map.set(id, operation);
      try {
        return await operation;
      } finally {
        if (map.get(id) === operation) map.delete(id);
      }
    }),
  );
}

export const releaseDiscoveryStatusSchema = z
  .object({
    feedId: z.uuid(),
    lastAttemptAt: z.iso.datetime(),
    lastSuccessAt: z.iso.datetime().optional(),
    nextDueAt: z.iso.datetime(),
    state: z.enum(["checking", "checked", "failed"]),
    checkedPolicies: z.number().int().min(0),
    errors: z.array(z.object({ policyId: z.uuid().optional(), code: z.string().regex(/^[a-z0-9_]{1,80}$/) }).strict()),
  })
  .strict();
/** Called inside the control's existing quiesce/drain boundary. Index discovery only: never stages or approves. */
export async function discoverDueReleases(
  options: { repo: Repository; directory: string; currentVersion?: string },
  scope: Scope,
  ceoId: string,
  now = new Date(),
) {
  const feed = await configuredReleaseFeed(options);
  if (!feed) return { status: "not_configured" as const };
  await feed.list(scope, ceoId); // Validate authority before persisting the scheduling claim.
  const key = "discovery:" + scope.companyId + ":" + feed.config.id;
  let map = queues.get(options.repo);
  if (!map) {
    map = new Map();
    queues.set(options.repo, map);
  }
  const previous = map.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const stored = await options.repo.getDocument<z.infer<typeof releaseDiscoveryStatusSchema>>(
        scope,
        "release-discovery-status",
        feed.config.id,
      );
      if (stored && Date.parse(stored.data.nextDueAt) > now.getTime()) return { status: "not_due" as const };
      const pending = releaseDiscoveryStatusSchema.parse({
        feedId: feed.config.id,
        lastAttemptAt: now.toISOString(),
        ...(stored?.data.lastSuccessAt ? { lastSuccessAt: stored.data.lastSuccessAt } : {}),
        nextDueAt: new Date(now.getTime() + 15 * 60000).toISOString(),
        state: "checking",
        checkedPolicies: 0,
        errors: [],
      });
      const claim = await options.repo.putDocument(
        scope,
        "release-discovery-status",
        feed.config.id,
        pending,
        stored ? { expectedRevision: stored.revision } : {},
      );
      const errors: z.infer<typeof releaseDiscoveryStatusSchema>["errors"] = [];
      let checked = 0;
      const code = (error: unknown) => {
        const value = (error as { code?: unknown })?.code;
        return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value) ? value : "release_discovery_failed";
      };
      try {
        await options.repo.assertDispatchAllowed(scope.companyId);
        for (const policy of await options.repo.listDocuments<{ trustedPublicKeyPem: string }>(
          scope,
          "update-policy",
        )) {
          if (
            releaseFeedTrustFingerprint(policy.data.trustedPublicKeyPem) !==
              releaseFeedTrustFingerprint(feed.config.trustedPublicKeyPem) ||
            (await options.repo.getDocument(scope, "update-policy-revocation", policy.id))
          )
            continue;
          try {
            await feed.discover(scope, ceoId, policy.id);
            checked++;
          } catch (error) {
            errors.push({ policyId: policy.id, code: code(error) });
          }
        }
      } catch (error) {
        errors.push({ code: code(error) });
      }
      const result = releaseDiscoveryStatusSchema.parse({
        ...pending,
        state: errors.length ? "failed" : "checked",
        checkedPolicies: checked,
        errors,
        ...(!errors.length ? { lastSuccessAt: now.toISOString() } : {}),
      });
      await options.repo.putDocument(scope, "release-discovery-status", feed.config.id, result, {
        expectedRevision: claim.revision,
      });
      return { status: "checked" as const, result };
    });
  map.set(key, operation);
  try {
    return await operation;
  } finally {
    if (map.get(key) === operation) map.delete(key);
  }
}
