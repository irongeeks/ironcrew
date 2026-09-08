import { beforeEach, afterEach, it, expect, vi } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";

let directory: string, repo: Repository, agent: ReturnType<typeof request.agent>, csrf: string, scope: Scope;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-catalog-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  agent = request.agent(createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" }));
  const setup = await agent
    .post("/api/v1/setup")
    .send({
      token: await issueSetupToken(directory),
      companyName: "Catalog fixture",
      ceoName: "CEO",
      password: "fixture-password-1234",
      timezone: "UTC",
    })
    .expect(200);
  csrf = setup.body.csrfToken;
  scope = { companyId: setup.body.company.id, areaId: setup.body.areas[0].id };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const refresh = () =>
  agent.post("/api/v1/models/refresh").set({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }).send({});
const free = {
  id: "fixture/model:free",
  name: "Free fixture",
  pricing: { prompt: "0", completion: "0" },
  supported_parameters: ["tools"],
};

it("refreshes mixed catalogs through the API and retains valid free models", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: [
          free,
          {
            ...free,
            id: "fixture/priced",
            pricing: { prompt: "0.01", completion: "0.02", overrides: [{ tier: "special" }] },
          },
          { id: "DO-NOT-LOG-PROVIDER-DATA", name: 123 },
        ],
      }),
    ),
  );
  expect((await refresh().expect(200)).body.count).toBe(2);
  expect((await agent.get("/api/v1/models").expect(200)).body.items.map((item: { id: string }) => item.id)).toContain(
    free.id,
  );
  expect(warning).toHaveBeenCalled();
  expect(JSON.stringify(warning.mock.calls)).not.toContain("DO-NOT-LOG");
});

it("reports a catalog error, logs safe causes and retains cached models on failure", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.fn().mockImplementation(async () => Response.json({ data: [free] }));
  vi.stubGlobal("fetch", fetch);
  await refresh().expect(200);
  fetch.mockResolvedValue(Response.json({ data: [{ id: "DO-NOT-LOG-SECRET", name: 123 }] }));
  const response = await refresh().expect(502);
  expect(response.body).toMatchObject({ code: "catalog_refresh_failed", messageKey: "errors.catalog_refresh_failed" });
  const models = (await agent.get("/api/v1/models").expect(200)).body.items;
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ id: free.id, available: true });
  const status = await repo.getDocument(scope, "catalog-status", scope.companyId);
  expect(status?.data).toMatchObject({ state: "stale", messageKey: "errors.catalog_refresh_failed" });
  expect(error).toHaveBeenCalled();
  expect(JSON.stringify(error.mock.calls) + JSON.stringify(response.body)).not.toContain("DO-NOT-LOG");
});

it.each([99, 100, 579, 1200])("persists all %i models through HTTP and SQLite", async (count) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: Array.from({ length: count }, (_, i) => ({ ...free, id: `fixture/model-${i}:free` })) }),
      ),
  );
  expect((await refresh().expect(200)).body.count).toBe(count);
  const models: { available: boolean }[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: { available: boolean }[]; nextCursor: string | null } = (
      await agent
        .get("/api/v1/models")
        .query(cursor ? { cursor } : {})
        .expect(200)
    ).body;
    models.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(models).toHaveLength(count);
  expect(models.every((model: { available: boolean }) => model.available)).toBe(true);
  expect((await repo.getDocument(scope, "catalog-status", scope.companyId))?.data).toMatchObject({
    state: "ready",
    count,
  });
});

it("refreshes large catalogs repeatedly and retires missing models without dropping history", async () => {
  const models = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...free, id: `fixture/model-${offset + i}:free` }));
  const fetch = vi.fn().mockImplementation(async () => Response.json({ data: models(0, 579) }));
  vi.stubGlobal("fetch", fetch);
  await refresh().expect(200);
  fetch.mockImplementation(async () => Response.json({ data: models(200, 600) }));
  await refresh().expect(200);
  await refresh().expect(200);
  const stored = await repo.listDocuments<{ available: boolean }>(scope, "model");
  expect(stored).toHaveLength(800);
  expect(stored.filter((model) => model.data.available)).toHaveLength(600);
  fetch.mockImplementation(async () => Response.json({ data: [] }));
  await refresh().expect(200);
  expect(
    (await repo.listDocuments<{ available: boolean }>(scope, "model")).filter((model) => model.data.available),
  ).toHaveLength(0);
  expect((await repo.getDocument(scope, "catalog-status", scope.companyId))?.data).toMatchObject({
    state: "ready",
    count: 0,
  });
  expect(await repo.verifyAudit(scope.companyId)).toBe(true);
});

it("rolls back an entire large snapshot when its last model conflicts", async () => {
  const { shaUuid } = await import("../../packages/runtime/src/engine.ts");
  const models = Array.from({ length: 579 }, (_, i) => ({ ...free, id: `fixture/model-${i}:free` }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: models })));
  await refresh().expect(200);
  const before = await repo.listDocuments(scope, "model");
  const status = await repo.getDocument(scope, "catalog-status", scope.companyId);
  const events = await repo.events(scope);
  const mutations = before.map((model) => ({
    kind: "model",
    id: model.id,
    data: { ...(model.data as object), available: false },
    expectedRevision: model.revision,
  }));
  mutations[578]!.expectedRevision = 0;
  await expect(
    repo.transactCatalog(scope, [
      ...mutations,
      {
        kind: "catalog-status",
        id: scope.companyId,
        data: { state: "ready", count: 0 },
        expectedRevision: status!.revision,
      },
    ]),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await repo.listDocuments(scope, "model")).toEqual(before);
  expect(await repo.getDocument(scope, "catalog-status", scope.companyId)).toEqual(status);
  expect(await repo.events(scope)).toEqual(events);
  expect(await repo.getDocument(scope, "model", shaUuid(models[578]!.id))).toEqual(before[578]);
});

it("keeps the generic transaction limit and rejects non-catalog writes on the bulk path", async () => {
  const mutations = Array.from({ length: 101 }, (_, i) => ({ kind: "fixture", id: String(i), data: {} }));
  await expect(
    repo.transact(scope, mutations, { type: "fixture", aggregateId: scope.companyId }),
  ).rejects.toMatchObject({ code: "invalid_transaction" });
  await expect(
    repo.transactCatalog(scope, [...mutations, { kind: "catalog-status", id: scope.companyId, data: {} }]),
  ).rejects.toMatchObject({ code: "invalid_transaction" });
  await expect(repo.transactCatalog(scope, [])).rejects.toMatchObject({ code: "invalid_transaction" });
  expect(await repo.listDocuments(scope, "fixture")).toEqual([]);
});

it.each([
  ["invalid_transaction", "storage_rejected"],
  ["persistence_error", "storage_failure"],
])("reports safe storage cause %s separately from transport", async (code, reason) => {
  const { DomainError } = await import("../../packages/domain/src/index.ts");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => Response.json({ data: [free] })),
  );
  await refresh().expect(200);
  vi.spyOn(repo, "transactCatalog").mockRejectedValueOnce(new DomainError(code, "DO-NOT-LOG-SECRET"));
  const response = await refresh().expect(502);
  expect(error).toHaveBeenCalledWith("IronCrew catalog refresh failed", expect.objectContaining({ reason, code }));
  expect((await repo.getDocument(scope, "catalog-status", scope.companyId))?.data).toMatchObject({
    state: "stale",
    reason,
    code,
    count: 1,
  });
  expect(await repo.listDocuments(scope, "model")).toHaveLength(1);
  expect(JSON.stringify(error.mock.calls) + JSON.stringify(response.body)).not.toContain("DO-NOT-LOG");
});

it("does not mask the refresh error when recording failure status also fails", async () => {
  const { DomainError } = await import("../../packages/domain/src/index.ts");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DO-NOT-LOG-SECRET")));
  const original = repo.putDocument.bind(repo);
  vi.spyOn(repo, "putDocument").mockImplementation((...args) =>
    args[1] === "catalog-status"
      ? Promise.reject(new DomainError("revision_conflict", "DO-NOT-LOG-SECRET"))
      : original(...args),
  );
  const response = await refresh().expect(502);
  expect(response.body.code).toBe("catalog_refresh_failed");
  expect(error).toHaveBeenCalledWith(
    "IronCrew catalog refresh failed",
    expect.objectContaining({ reason: "transport" }),
  );
  expect(error).toHaveBeenCalledWith("IronCrew catalog failure status not saved", {
    reason: "storage_rejected",
    code: "revision_conflict",
  });
  expect(JSON.stringify(error.mock.calls) + JSON.stringify(response.body)).not.toContain("DO-NOT-LOG");
});

it("clears obsolete storage codes on a subsequent provider failure", async () => {
  const { DomainError } = await import("../../packages/domain/src/index.ts");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.fn().mockImplementation(async () => Response.json({ data: [free] }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(repo, "transactCatalog").mockRejectedValueOnce(new DomainError("invalid_transaction"));
  await refresh().expect(502);
  fetch.mockRejectedValueOnce(new Error("DO-NOT-LOG"));
  await refresh().expect(502);
  const status = (await repo.getDocument(scope, "catalog-status", scope.companyId))?.data;
  expect(status).toMatchObject({ state: "stale", reason: "transport" });
  expect(status).not.toHaveProperty("code");
});

it("preserves a newer successful refresh when an older concurrent request fails", async () => {
  const { refreshCatalog } = await import("../../apps/control/catalog.ts");
  vi.spyOn(console, "error").mockImplementation(() => {});
  let rejectFirst!: (error: Error) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const pending = new Promise<Response>((_, reject) => {
    rejectFirst = reject;
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(() => {
        signalStarted();
        return pending;
      })
      .mockImplementation(async () => Response.json({ data: [free] })),
  );
  const first = refreshCatalog(repo, scope);
  const rejected = expect(first).rejects.toMatchObject({ code: "catalog_refresh_failed" });
  await started;
  await refreshCatalog(repo, scope);
  const ready = await repo.getDocument(scope, "catalog-status", scope.companyId);
  const models = await repo.listDocuments(scope, "model");
  rejectFirst(new Error("DO-NOT-LOG"));
  await rejected;
  expect(await repo.getDocument(scope, "catalog-status", scope.companyId)).toEqual(ready);
  expect(await repo.listDocuments(scope, "model")).toEqual(models);
});
