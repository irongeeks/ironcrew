import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { OpenRouterClient, type Model } from "../../packages/runtime/src/openrouter.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
export type CatalogModel = Model & { available: boolean; observedAt: string };
export async function refreshCatalog(repo: Repository, scope: Scope) {
  const client = new OpenRouterClient({
    secret: async () => {
      throw new Error("Catalog never needs an inference credential");
    },
  });
  const status = await repo.getDocument(scope, "catalog-status", scope.companyId);
  try {
    const models = await client.catalog();
    const observedAt = new Date().toISOString();
    const prior = await repo.listDocuments<CatalogModel>(scope, "model");
    const ids = new Set(models.map((m) => m.id));
    const mutations = models.map((model) => ({
      kind: "model",
      id: shaUuid(model.id),
      data: { ...model, observedAt, available: true },
      expectedRevision: prior.find((p) => p.id === shaUuid(model.id))?.revision ?? 0,
    }));
    for (const old of prior)
      if (!ids.has(old.data.id))
        mutations.push({
          kind: "model",
          id: old.id,
          data: { ...old.data, available: false },
          expectedRevision: old.revision,
        });
    await repo.transact(
      scope,
      [
        ...mutations,
        {
          kind: "catalog-status",
          id: scope.companyId,
          data: { observedAt, state: "ready", count: models.length },
          expectedRevision: status?.revision ?? 0,
        },
      ],
      { type: "catalog.updated", aggregateId: scope.companyId },
    );
    return { models, observedAt };
  } catch {
    await repo.putDocument(
      scope,
      "catalog-status",
      scope.companyId,
      { state: "stale", lastAttemptAt: new Date().toISOString(), messageKey: "catalog.refresh_failed" },
      { expectedRevision: status?.revision ?? 0 },
    );
    throw new Error("catalog_refresh_failed");
  }
}
