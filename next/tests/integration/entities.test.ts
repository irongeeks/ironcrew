import { beforeEach, afterEach, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
let directory: string, repo: Repository, agent: ReturnType<typeof request.agent>, setup: SetupResult, csrf: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-entities-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  agent = request.agent(createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" }));
  const response = await agent
    .post("/api/v1/setup")
    .send({
      token: await issueSetupToken(directory),
      companyName: "Entities",
      ceoName: "CEO",
      password: "fixture-password-1234",
      timezone: "Europe/Berlin",
    })
    .expect(200);
  setup = response.body;
  csrf = response.body.csrfToken;
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const headers = () => ({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() });
async function customer() {
  return (
    await agent
      .post("/api/v1/customers")
      .set(headers())
      .send({ name: "Kunde A", areaId: setup.areas[0]!.id })
      .expect(200)
  ).body;
}
it("creates and revises customers and projects and persists the exact order scope", async () => {
  const c = await customer(),
    areaId = setup.areas[0]!.id;
  const p = (
    await agent
      .post("/api/v1/projects")
      .set(headers())
      .send({ name: "Projekt A", areaId, customerId: c.id })
      .expect(200)
  ).body;
  const scope = { companyId: setup.company.id, areaId, customerId: c.id, projectId: p.id };
  const o = await agent
    .post("/api/v1/orders")
    .set(headers())
    .send({ scope, goal: "Kundenprojekt bearbeiten", kind: "research", budgetLimitUsdMicros: "0" })
    .expect(200);
  expect(o.body.scope).toEqual(scope);
  const changed = await agent
    .patch(`/api/v1/customers/${c.id}`)
    .set(headers())
    .set("If-Match", "1")
    .send({ name: "Kunde umbenannt", description: "Originaler Bereich bleibt bestehen" })
    .expect(200);
  expect(changed.body.revision).toBe(2);
  await agent
    .patch(`/api/v1/customers/${c.id}`)
    .set(headers())
    .set("If-Match", "1")
    .send({ name: "Stale" })
    .expect(409);
  await agent
    .patch(`/api/v1/projects/${p.id}`)
    .set(headers())
    .set("If-Match", "1")
    .send({ name: "Projekt umbenannt" })
    .expect(200);
  expect((await agent.get("/api/v1/customers").expect(200)).body.items[0].name).toBe("Kunde umbenannt");
  expect(
    (await agent.get("/api/v1/projects").expect(200)).body.items.find((item: { id: string }) => item.id === p.id).scope
      .customerId,
  ).toBe(c.id);
});
it("rejects cross-area customers and orders that omit or replace a project's customer", async () => {
  const c = await customer(),
    areaId = setup.areas[0]!.id;
  await agent
    .post("/api/v1/projects")
    .set(headers())
    .send({ name: "Wrong area", areaId: setup.areas[1]!.id, customerId: c.id })
    .expect(403);
  const p = (
    await agent.post("/api/v1/projects").set(headers()).send({ name: "Owned", areaId, customerId: c.id }).expect(200)
  ).body;
  for (const extra of [{}, { customerId: randomUUID() }, { customerId: c.id, areaId: setup.areas[1]!.id }]) {
    await agent
      .post("/api/v1/orders")
      .set(headers())
      .send({
        scope: { companyId: setup.company.id, areaId, projectId: p.id, ...extra },
        goal: "Invalid scope",
        kind: "research",
        budgetLimitUsdMicros: "0",
      })
      .expect(403);
  }
  await agent
    .patch(`/api/v1/projects/${p.id}`)
    .set(headers())
    .set("If-Match", "1")
    .send({ name: "Move", areaId: setup.areas[1]!.id })
    .expect(400);
});
it("supports internal projects without inventing a customer", async () => {
  const areaId = setup.areas[1]!.id;
  const p = (await agent.post("/api/v1/projects").set(headers()).send({ name: "Privates Projekt", areaId }).expect(200))
    .body;
  const o = await agent
    .post("/api/v1/orders")
    .set(headers())
    .send({
      scope: { companyId: setup.company.id, areaId, projectId: p.id },
      goal: "Interner Auftrag",
      kind: "research",
      budgetLimitUsdMicros: "0",
    })
    .expect(200);
  expect(o.body.scope.customerId).toBeUndefined();
});
