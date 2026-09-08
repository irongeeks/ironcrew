import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { OpenRouterClient, type Model } from "../../packages/runtime/src/openrouter.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
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
    if (client.catalogDiagnostics?.rejected)
      console.warn("IronCrew catalog entries rejected", client.catalogDiagnostics);
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
          data: {
            observedAt,
            state: "ready",
            count: models.length,
            rejectedCount: client.catalogDiagnostics?.rejected ?? 0,
          },
          expectedRevision: status?.revision ?? 0,
        },
      ],
      { type: "catalog.updated", aggregateId: scope.companyId },
    );
    return { models, observedAt };
  } catch (error) {
    // Never log provider payloads, arbitrary exception messages or credentials.
    const reason =
      client.catalogFailure?.reason ??
      (error instanceof DomainError && error.code === "catalog_unavailable"
        ? "provider_response_invalid"
        : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout"
          : "transport_or_storage_failure");
    console.error("IronCrew catalog refresh failed", {
      reason,
      status: client.catalogFailure?.status,
      diagnostics: client.catalogDiagnostics,
    });
    await repo.putDocument(
      scope,
      "catalog-status",
      scope.companyId,
      { state: "stale", lastAttemptAt: new Date().toISOString(), messageKey: "errors.catalog_refresh_failed", reason },
      { expectedRevision: status?.revision ?? 0 },
    );
    throw new DomainError("catalog_refresh_failed", "catalog_refresh_failed", 502);
  }
}
