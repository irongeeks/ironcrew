import type { Document, Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { OpenRouterClient, type Model } from "../../packages/runtime/src/openrouter.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
export type CatalogModel = Model & { available: boolean; observedAt: string };
const storageCodes = new Set([
  "invalid_transaction",
  "revision_conflict",
  "scope_denied",
  "immutable_document",
  "invalid_document",
  "validation_error",
  "persistence_error",
  "company_not_found",
]);
const storageDiagnostic = (error: unknown) => ({
  reason: error instanceof DomainError && error.code !== "persistence_error" ? "storage_rejected" : "storage_failure",
  ...(error instanceof DomainError && storageCodes.has(error.code) ? { code: error.code } : {}),
});
export async function refreshCatalog(repo: Repository, scope: Scope) {
  const client = new OpenRouterClient({
    secret: async () => {
      throw new Error("Catalog never needs an inference credential");
    },
  });
  let status: Document<Record<string, unknown>> | null | undefined;
  let phase: "provider" | "storage" = "storage";
  try {
    status = await repo.getDocument<Record<string, unknown>>(scope, "catalog-status", scope.companyId);
    phase = "provider";
    const models = await client.catalog();
    if (client.catalogDiagnostics?.rejected)
      console.warn("IronCrew catalog entries rejected", client.catalogDiagnostics);
    const observedAt = new Date().toISOString();
    phase = "storage";
    const prior = await repo.listDocuments<CatalogModel>(scope, "model");
    const revisions = new Map(prior.map((model) => [model.id, model.revision]));
    const ids = new Set(models.map((m) => m.id));
    const mutations = models.map((model) => ({
      kind: "model",
      id: shaUuid(model.id),
      data: { ...model, observedAt, available: true },
      expectedRevision: revisions.get(shaUuid(model.id)) ?? 0,
    }));
    for (const old of prior)
      if (!ids.has(old.data.id))
        mutations.push({
          kind: "model",
          id: old.id,
          data: { ...old.data, available: false },
          expectedRevision: old.revision,
        });
    await repo.transactCatalog(scope, [
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
    ]);
    return { models, observedAt };
  } catch (error) {
    // Never log provider payloads, arbitrary exception messages or credentials.
    const diagnostic =
      phase === "storage"
        ? storageDiagnostic(error)
        : {
            reason:
              client.catalogFailure?.reason ??
              (error instanceof DomainError && error.code === "catalog_unavailable"
                ? "provider_response_invalid"
                : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
                  ? "timeout"
                  : "transport"),
          };
    console.error("IronCrew catalog refresh failed", {
      ...diagnostic,
      status: client.catalogFailure?.status,
      diagnostics: client.catalogDiagnostics,
    });
    try {
      const previous = { ...status?.data };
      delete previous.code;
      // A conflicting newer refresh must not be overwritten by this failure.
      if (status !== undefined)
        await repo.putDocument(
          scope,
          "catalog-status",
          scope.companyId,
          {
            ...previous,
            state: "stale",
            lastAttemptAt: new Date().toISOString(),
            messageKey: "errors.catalog_refresh_failed",
            ...diagnostic,
          },
          { expectedRevision: status?.revision ?? 0 },
        );
    } catch (statusError) {
      console.error("IronCrew catalog failure status not saved", storageDiagnostic(statusError));
    }
    throw new DomainError("catalog_refresh_failed", "catalog_refresh_failed", 502);
  }
}
