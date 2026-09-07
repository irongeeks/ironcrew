import { shaUuid } from "../../packages/runtime/src/engine.ts";
import type { Mutation } from "../../packages/persistence/src/index.ts";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { DomainError, sameScope } from "../../packages/domain/src/index.ts";
import { channelConfigSchema, readChannelConfiguration } from "./channel-routes.ts";
import {
  ResearchWatch,
  watchReviewSchema,
  type WatchDefinition,
} from "../../packages/domain/workflows/research-watch.ts";
import type { MutationHandler } from "./workflow-routes.ts";
export function registerAdminRoutes(
  app: Express,
  {
    repo,
    directory,
    context,
    mutate,
  }: { repo: Repository; directory: string; context: (res: Response) => Scope; mutate: MutationHandler },
) {
  const revision = (req: Request) => {
    const raw = req.get("If-Match") ?? "";
    if (!/^(0|[1-9]\d*)$/.test(raw)) throw new DomainError("revision_required", undefined, 400);
    return Number(raw);
  };
  app.get("/api/v1/channels/config", async (_req, res) => {
    const scope = context(res),
      stored = await repo.getDocument(scope, "channel-configuration", scope.companyId);
    res.json({ config: await readChannelConfiguration(directory, repo), revision: stored?.revision ?? 0 });
  });
  app.put(
    "/api/v1/channels/config",
    mutate(async (req, res) => {
      const scope = context(res),
        config = channelConfigSchema.parse(z.object({ config: channelConfigSchema }).strict().parse(req.body).config),
        old = await readChannelConfiguration(directory, repo);
      const mutations: Mutation[] = [];
      const bindings = await repo.listCompanyDocuments<{ provider: string; accountId: string }>(
        scope.companyId,
        "channel-identity",
      );
      for (const channel of config.channels) {
        if (channel.scope.companyId !== scope.companyId) throw new DomainError("scope_denied", undefined, 403);
        await repo.listDocuments(channel.scope, "channel-identity");
        const registryId = shaUuid(JSON.stringify([channel.provider, channel.accountId])),
          registry = await repo.getDocument<{ scope: Scope }>(scope, "channel-account-scope", registryId);
        const binding = bindings.find(
          (b) => b.data.provider === channel.provider && b.data.accountId === channel.accountId,
        );
        if (
          (registry && !sameScope(registry.data.scope, channel.scope)) ||
          (binding && !sameScope(binding.scope, channel.scope))
        )
          throw new DomainError("channel_account_scope_immutable");
        if (!registry)
          mutations.push({
            kind: "channel-account-scope",
            id: registryId,
            data: { provider: channel.provider, accountId: channel.accountId, scope: channel.scope },
            immutable: true,
          });
        const previous = old.channels.find((c) => c.provider === channel.provider && c.accountId === channel.accountId);
        if (previous && !sameScope(previous.scope, channel.scope))
          throw new DomainError("channel_account_scope_immutable");
        if (channel.enabled && channel.provider !== "discord" && !config.proton)
          throw new DomainError("channel_secret_unconfigured");
      }
      mutations.push({
        kind: "channel-configuration",
        id: scope.companyId,
        data: config,
        expectedRevision: revision(req),
      });
      await repo.transact(scope, mutations, { type: "channel.configuration_changed", aggregateId: scope.companyId });
      const saved = (await repo.getDocument(scope, "channel-configuration", scope.companyId))!;
      return { config: saved.data, revision: saved.revision };
    }),
  );
  app.get("/api/v1/channels/bindings", async (_req, res) =>
    res.json({
      items: (await repo.listCompanyDocuments<Record<string, unknown>>(context(res).companyId, "channel-identity")).map(
        (d) => ({ id: d.id, ...d.data, scope: d.scope, revision: d.revision }),
      ),
      nextCursor: null,
    }),
  );
  const watch = async (req: Request, res: Response) => {
    const orderId = z.uuid().parse(req.params.id),
      id = z.uuid().parse(req.params.watchId);
    const order = (await repo.listAllOrders(context(res).companyId)).find((o) => o.id === orderId);
    if (!order) throw new DomainError("order_not_found", undefined, 404);
    const doc = await repo.getDocument<WatchDefinition>(order.scope, "research-watch", id);
    if (!doc || doc.data.orderId !== orderId) throw new DomainError("watch_not_found", undefined, 404);
    return doc;
  };
  app.patch(
    "/api/v1/orders/:id/research/watches/:watchId",
    mutate(async (req, res) => {
      const doc = await watch(req, res),
        input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      if (doc.data.activeCheckId) throw new DomainError("watch_check_active");
      return repo.putDocument(
        doc.scope,
        "research-watch",
        doc.id,
        { ...doc.data, ...input },
        { expectedRevision: revision(req), eventType: input.enabled ? "watch.enabled" : "watch.paused" },
      );
    }),
  );
  app.post(
    "/api/v1/orders/:id/research/watches/:watchId/checks/:checkId/review",
    mutate(async (req, res) => {
      const doc = await watch(req, res),
        identity = await repo.getIdentity();
      if (!identity || identity.companyId !== doc.scope.companyId)
        throw new DomainError("ceo_required", undefined, 403);
      return new ResearchWatch(repo, directory).review(
        doc.scope,
        doc.id,
        z.uuid().parse(req.params.checkId),
        identity.id,
        watchReviewSchema.parse(req.body),
        "ceo",
      );
    }),
  );
  app.get("/api/v1/notifications", async (req, res) => {
    const after = z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.query.after ?? 0),
      limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(req.query.limit ?? 50);
    const rows = await repo.eventsForCompany(context(res).companyId, after, limit + 1);
    const hasMore = rows.length > limit,
      shown = rows.slice(0, limit);
    const orders = new Set((await repo.listAllOrders(context(res).companyId)).map((o) => o.id));
    res.json({
      items: shown.map((e) => ({
        id: e.id,
        sequence: e.sequence,
        type: e.type,
        aggregateId: e.aggregateId,
        scope: e.scope,
        occurredAt: e.occurredAt,
        orderId: orders.has(e.aggregateId)
          ? e.aggregateId
          : e.data && typeof e.data === "object" && "orderId" in e.data && typeof e.data.orderId === "string"
            ? e.data.orderId
            : undefined,
      })),
      nextCursor: hasMore ? String(shown.at(-1)!.sequence) : null,
      lastSequence: shown.at(-1)?.sequence ?? after,
    });
  });
}
