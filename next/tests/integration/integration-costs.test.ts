import request from "supertest";
import { createApp } from "../../apps/control/app.ts";
import { hashPassword } from "../../apps/control/auth.ts";
import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Repository } from "../../packages/persistence/src/index.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { IntegrationCostService, type IntegrationCharge } from "../../apps/control/integration-costs.ts";
import { IntegrationService, type IntegrationConnection } from "../../packages/integrations/src/service.ts";
import { defaultTransport } from "../../packages/integrations/src/transport.ts";
import type { Json, ToolAction } from "../../packages/contracts/src/index.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(limits: { company?: string; order?: string; mandate?: string } = {}, api = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "search-costs-"));
  let repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Search costs",
    ceoName: "Owner",
    passwordHash: api ? await hashPassword("search-fixture-password-1234") : "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: limits.company ?? "100",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  const order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Paid search fixture",
    budgetLimitUsdMicros: limits.order ?? "100",
  });
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["research.search"],
    targetIds: [randomUUID()],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 10,
    maxDurationSeconds: 60,
    maxCostUsdMicros: limits.mandate ?? "100",
  };
  await repo.createMandate(mandate);
  let hits = 0,
    status = 200,
    disconnect = false,
    hang = false;
  const server = createServer((req, res) => {
    hits++;
    expect(req.headers["x-subscription-token"]).toBe("fixture-token");
    if (disconnect) {
      req.socket.destroy();
      return;
    }
    if (hang) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ web: { results: [{ title: "Fixture", url: "https://example.invalid/fact" }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection: IntegrationConnection = {
    id: mandate.targetIds[0]!,
    scope,
    provider: "brave",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    allowHttp: true,
    secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "password" },
    enabledTools: ["research.search"],
    schemaTag: "fixture",
    pricing: {
      id: randomUUID(),
      version: 1,
      toolId: "research.search",
      currency: "USD",
      requestUsdMicros: "10",
      validFrom: "2020-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      sourceUrl: "https://example.invalid/contract",
    },
  };
  const action = async (wrapped = false) => {
    const input = {
      id: randomUUID(),
      toolId: "research.search",
      targetId: connection.id,
      scope,
      args: { query: "fixture" },
    };
    const args = (wrapped ? { targetId: connection.id, parameters: input.args } : input.args) as Json;
    const stored: ToolAction & { targetId: string } = {
      id: input.id,
      runId: randomUUID(),
      orderId: order.id,
      scope,
      toolId: input.toolId,
      toolVersion: 1,
      args,
      argumentsSha256: sha256(args),
      status: "running",
      mandateId: mandate.id,
      mandateVersion: 1,
      evidenceRefs: [],
      targetId: connection.id,
    };
    await repo.putDocument(scope, "action", input.id, stored);
    return input;
  };
  const service = (c = connection) =>
    new IntegrationService({
      connections: [c],
      secrets: { resolve: async () => "fixture-token" },
      authorize: async () => {},
      meteredRequest: new IntegrationCostService(repo).request,
      transport: (request) => defaultTransport({ ...request, timeoutMs: 500 }),
    });
  cleanups.push(async () => {
    await repo.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get repo() {
      return repo;
    },
    directory,
    scope,
    connection,
    mandate,
    action,
    service,
    get hits() {
      return hits;
    },
    set status(value: number) {
      status = value;
    },
    set hang(value: boolean) {
      hang = value;
    },
    set disconnect(value: boolean) {
      disconnect = value;
    },
    async restart() {
      await repo.close();
      repo = await Repository.open(path.join(directory, "company.sqlite"));
    },
  };
}
it("charges real successful HTTP exactly once across restart with the administrative price and both action argument shapes", async () => {
  const f = await fixture();
  const a = await f.action();
  await f.service().execute(a);
  expect(f.hits).toBe(1);
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({
    spentUsdMicros: "10",
    availableUsdMicros: "90",
    reservedUsdMicros: "0",
  });
  const charge = await f.repo.getDocument<IntegrationCharge>(f.scope, "integration-charge", a.id);
  expect(charge!.data).toMatchObject({
    status: "settled",
    actualUsdMicros: "10",
    price: { version: 1 },
    httpStatus: 200,
  });
  expect(JSON.stringify(charge)).not.toContain("fixture-token");
  await f.restart();
  await expect(f.service().execute(a)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  expect(f.hits).toBe(1);
  await f.service().execute(await f.action(true));
  expect((await f.repo.budget(f.scope.companyId)).spentUsdMicros).toBe("20");
});
it.each(["company", "order", "mandate"] as const)(
  "enforces cumulative %s limits before a second HTTP request",
  async (kind) => {
    const f = await fixture({ [kind]: "15" });
    await f.service().execute(await f.action());
    await expect(f.service().execute(await f.action())).rejects.toThrow();
    expect(f.hits).toBe(1);
    expect((await f.repo.budget(f.scope.companyId)).spentUsdMicros).toBe("10");
  },
);
it("fails closed for absent/expired prices and changing an already registered version", async () => {
  const f = await fixture();
  const a = await f.action();
  await expect(f.service({ ...f.connection, pricing: undefined }).execute(a)).rejects.toMatchObject({
    code: "configuration",
  });
  await expect(
    f
      .service({ ...f.connection, pricing: { ...f.connection.pricing!, expiresAt: "2021-01-01T00:00:00.000Z" } })
      .execute(a),
  ).rejects.toMatchObject({ code: "integration_price_expired" });
  expect(f.hits).toBe(0);
  await f.service().execute(a);
  await expect(
    f
      .service({ ...f.connection, pricing: { ...f.connection.pricing!, requestUsdMicros: "11" } })
      .execute(await f.action()),
  ).rejects.toMatchObject({ code: "integration_price_version_conflict" });
  expect(f.hits).toBe(1);
});
it.each(["provider", "disconnect", "timeout"])(
  "holds unknown %s costs across restart without automatic HTTP retries",
  async (kind) => {
    const f = await fixture();
    if (kind === "provider") f.status = 503;
    else if (kind === "disconnect") f.disconnect = true;
    else f.hang = true;
    const a = await f.action();
    await expect(f.service().execute(a)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
    expect(f.hits).toBe(1);
    expect(await f.repo.budget(f.scope.companyId)).toMatchObject({
      spentUsdMicros: "0",
      unreconciledUsdMicros: "10",
      availableUsdMicros: "90",
    });
    await f.restart();
    await expect(f.service().execute(a)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
    expect(f.hits).toBe(1);
  },
);
it("atomically admits only one concurrent action when the remaining budget fits one request", async () => {
  const f = await fixture({ company: "15" }),
    a = await f.action(),
    b = await f.action();
  const results = await Promise.allSettled([f.service().execute(a), f.service().execute(b)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.hits).toBe(1);
});
it("does not release another in-flight attempt on a concurrent duplicate", async () => {
  const f = await fixture(),
    a = await f.action();
  const results = await Promise.allSettled([f.service().execute(a), f.service().execute(a)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.hits).toBe(1);
  expect((await f.repo.budget(f.scope.companyId)).spentUsdMicros).toBe("10");
});
it("rechecks a revoked mandate immediately before dispatch and releases only its own known unstarted reservation", async () => {
  const f = await fixture();
  const original = f.repo.reserveAndTransact.bind(f.repo);
  f.repo.reserveAndTransact = async (...args) => {
    const r = await original(...args);
    await f.repo.revokeMandate(f.scope, f.mandate.id, 1);
    return r;
  };
  const a = await f.action();
  await expect(f.service().execute(a)).rejects.toThrow();
  expect(f.hits).toBe(0);
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({
    spentUsdMicros: "0",
    reservedUsdMicros: "0",
    availableUsdMicros: "100",
  });
  expect((await f.repo.getDocument<IntegrationCharge>(f.scope, "integration-charge", a.id))!.data.status).toBe(
    "cancelled",
  );
});
it("keeps the pre-dispatch ledger reservation when process persistence fails after actual HTTP success", async () => {
  const f = await fixture(),
    a = await f.action();
  f.repo.settleAndTransact = async () => {
    throw Error("simulated process persistence failure");
  };
  await expect(f.service().execute(a)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  expect(f.hits).toBe(1);
  await f.restart();
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({ reservedUsdMicros: "10", availableUsdMicros: "90" });
  await expect(f.service().execute(a)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  expect(f.hits).toBe(1);
});
it("never accepts mismatched cost arguments or a foreign target as the persisted action", async () => {
  const f = await fixture(),
    a = await f.action();
  await expect(f.service().execute({ ...a, args: { query: "changed" } })).rejects.toMatchObject({
    code: "integration_cost_arguments_changed",
  });
  expect(f.hits).toBe(0);
});
it("stores explicit CEO provider evidence atomically, allows a proven zero charge, and rejects repeat or foreign reconciliation", async () => {
  const f = await fixture(),
    a = await f.action();
  f.status = 503;
  await expect(f.service().execute(a)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  const costs = new IntegrationCostService(f.repo),
    identity = (await f.repo.getIdentity())!;
  const evidence = {
    mediaType: "text/plain",
    description: "Local provider statement fixture",
    contentBase64: Buffer.from("Fixture provider statement: rejected request billed USD 0").toString("base64"),
  };
  const body = { actualUsdMicros: "0", evidence };
  await expect(costs.reconcile(f.scope.companyId, identity.id, a.id, 2, body)).rejects.toMatchObject({
    code: "integration_action_still_running",
  });
  const stored = (await f.repo.getDocument<ToolAction>(f.scope, "action", a.id))!;
  await f.repo.putDocument(
    f.scope,
    "action",
    a.id,
    { ...stored.data, status: "effect_unknown" },
    { expectedRevision: stored.revision },
  );
  await expect(costs.reconcile(f.scope.companyId, randomUUID(), a.id, 2, body)).rejects.toMatchObject({
    code: "ceo_required",
  });
  const result = await costs.reconcile(f.scope.companyId, identity.id, a.id, 2, body);
  expect(result).toMatchObject({ status: "settled", actualUsdMicros: "0", revision: 3 });
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({
    unreconciledUsdMicros: "0",
    availableUsdMicros: "100",
  });
  expect(
    (await f.repo.getDocument<{ contentBase64: string }>(f.scope, "integration-cost-evidence", a.id))!.data
      .contentBase64,
  ).toBe(evidence.contentBase64);
  expect(JSON.stringify(await costs.list(f.scope.companyId, identity.id))).not.toContain(evidence.contentBase64);
  await expect(costs.reconcile(f.scope.companyId, identity.id, a.id, 3, body)).rejects.toMatchObject({
    code: "integration_cost_already_settled",
  });
});
it("uses the actual CEO session/CSRF/If-Match/idempotency boundary to reconcile provider costs after a real HTTP failure", async () => {
  const f = await fixture({}, true),
    a = await f.action();
  f.status = 503;
  await expect(f.service().execute(a)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  const stored = (await f.repo.getDocument<ToolAction>(f.scope, "action", a.id))!;
  await f.repo.putDocument(
    f.scope,
    "action",
    a.id,
    { ...stored.data, status: "effect_unknown" },
    { expectedRevision: stored.revision },
  );
  const app = createApp({ repo: f.repo, directory: f.directory, publicOrigin: "http://127.0.0.1:8790" }),
    agent = request.agent(app);
  await agent.get("/api/v1/integration-costs").expect(401);
  const login = await agent.post("/api/v1/session").send({ password: "search-fixture-password-1234" }).expect(200);
  const body = {
    actualUsdMicros: "4",
    evidence: {
      mediaType: "text/plain",
      description: "Provider fixture statement",
      contentBase64: Buffer.from("Actual billed fixture cost: 4 USD micros").toString("base64"),
    },
  };
  const url = `/api/v1/integration-costs/${a.id}/reconcile`;
  await agent.post(url).send(body).expect(403);
  await agent
    .post(url)
    .set({ "X-CSRF-Token": login.body.csrfToken, "Idempotency-Key": randomUUID() })
    .send(body)
    .expect(400);
  const listing = await agent.get("/api/v1/integration-costs").expect(200);
  expect(listing.body.charges[0]).toMatchObject({ status: "unreconciled", revision: 2 });
  const headers = { "X-CSRF-Token": login.body.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": "2" };
  const result = await agent.post(url).set(headers).send(body).expect(200);
  expect(result.body).toMatchObject({ status: "settled", actualUsdMicros: "4", revision: 3 });
  await agent.post(url).set(headers).send(body).expect(200);
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({
    spentUsdMicros: "4",
    unreconciledUsdMicros: "0",
    availableUsdMicros: "96",
  });
  expect(await f.repo.listDocuments(f.scope, "integration-cost-evidence")).toHaveLength(1);
  expect(f.hits).toBe(1);
});
