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
  const fetch = vi.fn().mockResolvedValue(Response.json({ data: [free] }));
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
