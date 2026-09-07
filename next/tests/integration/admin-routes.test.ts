import { beforeEach, afterEach, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
let directory: string,
  repo: Repository,
  app: ReturnType<typeof createApp>,
  agent: ReturnType<typeof request.agent>,
  setup: SetupResult,
  csrf: string,
  scope: Scope;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "control-hardening-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" });
  agent = request.agent(app);
  const token = await issueSetupToken(directory),
    response = await agent
      .post("/api/v1/setup")
      .send({
        token,
        companyName: "Control fixture",
        ceoName: "Fixture CEO",
        password: "fixture-password-1234",
        timezone: "Europe/Berlin",
      })
      .expect(200);
  setup = response.body as SetupResult;
  csrf = response.body.csrfToken as string;
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const headers = () => ({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() });

it("persists channel configuration with compare-and-swap and denies moving an account across areas", async () => {
  const channel = {
    id: randomUUID(),
    provider: "discord",
    enabled: false,
    scope,
    accountId: "fixture-discord",
    publicKeyHex: "a".repeat(64),
    conversationIds: ["conversation"],
  };
  expect((await agent.get("/api/v1/channels/config").expect(200)).body.revision).toBe(0);
  const save = await agent
    .put("/api/v1/channels/config")
    .set(headers())
    .set("If-Match", "0")
    .send({ config: { version: 1, channels: [channel] } })
    .expect(200);
  expect(save.body.revision).toBe(1);
  await agent
    .put("/api/v1/channels/config")
    .set(headers())
    .set("If-Match", "0")
    .send({ config: { version: 1, channels: [] } })
    .expect(409);
  const moved = await agent
    .put("/api/v1/channels/config")
    .set(headers())
    .set("If-Match", "1")
    .send({ config: { version: 1, channels: [{ ...channel, scope: { ...scope, areaId: setup.areas[1]!.id } }] } })
    .expect(409);
  expect(moved.body.code).toBe("channel_account_scope_immutable");
  expect((await agent.get("/api/v1/channels/config").expect(200)).body.config.channels[0].scope).toEqual(scope);
  await agent
    .put("/api/v1/channels/config")
    .set(headers())
    .set("If-Match", "1")
    .send({ config: { version: 1, channels: [] } })
    .expect(200);
  await agent
    .put("/api/v1/channels/config")
    .set(headers())
    .set("If-Match", "2")
    .send({ config: { version: 1, channels: [{ ...channel, scope: { ...scope, areaId: setup.areas[1]!.id } }] } })
    .expect(409);
});
it("issues scoped challenges only for real company areas", async () => {
  const privateScope = { ...scope, areaId: setup.areas[1]!.id };
  await agent
    .post("/api/v1/channels/challenge")
    .set(headers())
    .send({ provider: "discord", scope: privateScope })
    .expect(200);
  expect((await repo.listDocuments(privateScope, "identity-challenge")).length).toBe(1);
  await agent
    .post("/api/v1/channels/challenge")
    .set(headers())
    .send({ provider: "discord", scope: { ...scope, companyId: randomUUID() } })
    .expect(403);
  const bad = await agent
    .post("/api/v1/channels/challenge")
    .set(headers())
    .send({ provider: "discord", scope: { ...scope, areaId: randomUUID() } });
  expect(bad.status).toBeGreaterThanOrEqual(400);
});
it("paginates actual company event history including private orders without duplicating events", async () => {
  const privateScope = { ...scope, areaId: setup.areas[1]!.id };
  const created = await repo.createOrder(privateScope, {
    kind: "research",
    goal: "Private notification",
    budgetLimitUsdMicros: "0",
  });
  const seen = new Set<number>();
  let after = 0,
    found = false;
  for (let page = 0; page < 30; page++) {
    const response = await agent.get(`/api/v1/notifications?after=${after}&limit=2`).expect(200);
    for (const item of response.body.items) {
      expect(seen.has(item.sequence)).toBe(false);
      seen.add(item.sequence);
      expect(Number.isFinite(Date.parse(item.occurredAt))).toBe(true);
      if (item.orderId === created.id) {
        found = true;
        expect(item.scope).toEqual(privateScope);
      }
    }
    if (!response.body.nextCursor) break;
    after = Number(response.body.nextCursor);
  }
  expect(found).toBe(true);
});
it("reports disabled worker enrollment honestly and exposes maintenance policy state", async () => {
  const status = await agent.get("/api/v1/workers/status").expect(200);
  expect(status.body.tlsConfigured).toBe(false);
  expect(status.body.connectUrl).toBeNull();
  const rotated = await agent.post(`/api/v1/workers/${randomUUID()}/rotate`).set(headers()).send({}).expect(409);
  expect(rotated.body.code).toBe("worker_tls_required");
  await agent.get("/api/v1/maintenance").expect(200);
});

it("rejects a foreign-company mail target before saving configuration", async () => {
  const config = (await agent.get("/api/v1/configuration").expect(200)).body;
  const mail = {
    id: randomUUID(),
    scope: { ...scope, companyId: randomUUID() },
    host: "mail.example.invalid",
    port: 465,
    username: "fixture",
    from: "fixture@example.invalid",
    secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "password" },
    enabledTools: ["mail.send"],
  };
  await agent
    .put("/api/v1/configuration")
    .set(headers())
    .send({ ...config, mailConnections: [mail] })
    .expect(409);
  expect((await agent.get("/api/v1/configuration").expect(200)).body.mailConnections).toEqual([]);
});

it("allows repeated successful logins but still limits repeated failed passwords", async () => {
  for (let i = 0; i < 11; i++)
    await agent.post("/api/v1/session").send({ password: "fixture-password-1234" }).expect(200);
  for (let i = 0; i < 10; i++)
    await agent.post("/api/v1/session").send({ password: "incorrect-password-fixture" }).expect(401);
  await agent.post("/api/v1/session").send({ password: "incorrect-password-fixture" }).expect(429);
});

it("rejects conflicting isolation routes and unavailable remote workers before saving configuration", async () => {
  const conflict = await agent
    .put("/api/v1/configuration")
    .set(headers())
    .send({ isolationProfilePath: "/fixture/profile.json", remoteWorkerId: randomUUID() })
    .expect(400);
  expect(conflict.body.code).toBe("validation_failed");
  const absent = await agent
    .put("/api/v1/configuration")
    .set(headers())
    .send({ remoteWorkerId: randomUUID() })
    .expect(409);
  expect(absent.body.code).toBe("remote_worker_unavailable");
  const workerId = randomUUID();
  await repo.putDocument(scope, "worker", workerId, { revoked: false, capabilities: ["workspace.execute"] });
  const noTls = await agent.put("/api/v1/configuration").set(headers()).send({ remoteWorkerId: workerId }).expect(409);
  expect(noTls.body.code).toBe("remote_worker_tls_required");
  expect((await agent.get("/api/v1/configuration").expect(200)).body.remoteWorkerId).toBeUndefined();
});
