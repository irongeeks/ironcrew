import { afterEach, beforeEach, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { createCrewAuth, methodGuard, type CrewAuth } from "../auth/crew-auth.ts";
import { CompanyPolicyStore } from "../policy/company-policy-store.ts";
import { registerCompanyPolicyRoutes } from "./company-policy-routes.ts";
let db: DatabaseSync, app: Express, auth: CrewAuth, store: CompanyPolicyStore, companyId: string;
const base = "/api/crew/policies/vendor";
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  auth = createCrewAuth(db);
  store = new CompanyPolicyStore(db);
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify, methodGuard(auth));
  registerCompanyPolicyRoutes(app, { store, companyId, auth });
});
afterEach(() => db.close());
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({ email: role + "@example.invalid", password: "safe-test-password", role });
  return auth.sessions.create(user.id).token;
}
it("guards ownership, validates strict input, persists and rejects stale writes", async () => {
  const owner = await login("owner"),
    viewer = await login("viewer"),
    operator = await login("operator");
  await request(app).get(base).expect(401);
  const first = (await request(app).get(base).set("x-ironcrew-session", viewer).expect(200)).body;
  const input = {
    baseRevision: first.revision,
    baselineFingerprint: first.baselineFingerprint,
    reason: "Kein externer Provider ist aktuell freigegeben.",
    restrictions: { allowedFamilies: [], allowedProviders: [] },
  };
  for (const token of [viewer, operator])
    await request(app).put(base).set("x-ironcrew-session", token).send(input).expect(403);
  await request(app)
    .put(base)
    .set("x-ironcrew-session", owner)
    .send({ ...input, blockedFamilies: [] })
    .expect(400);
  const saved = await request(app).put(base).set("x-ironcrew-session", owner).send(input).expect(200);
  expect(saved.body.revision).toBe(1);
  expect(saved.body.effectivePolicy.allowed_families).toEqual([]);
  await request(app).put(base).set("x-ironcrew-session", owner).send(input).expect(409);
});
it("lets viewers check the persisted family and exact provider selection without mutations", async () => {
  await login("owner");
  const viewer = await login("viewer");
  const before = store.snapshot(companyId);
  const permitted = await request(app)
    .post(`${base}/check`)
    .set("x-ironcrew-session", viewer)
    .send({ model: "openai/test", provider: before.baseline.allowedProviders[0] })
    .expect(200);
  expect(permitted.body.decision.allowed).toBe(true);
  const denied = await request(app)
    .post(`${base}/check`)
    .set("x-ironcrew-session", viewer)
    .send({ model: "openai/test", provider: "UnapprovedHost" })
    .expect(200);
  expect(denied.body.decision).toMatchObject({ allowed: false, code: "provider_not_allowed" });
  const blocked = await request(app)
    .post(`${base}/check`)
    .set("x-ironcrew-session", viewer)
    .send({ model: "deepseek/test" })
    .expect(200);
  expect(blocked.body.decision.allowed).toBe(false);
  await request(app)
    .post(`${base}/check`)
    .set("x-ironcrew-session", viewer)
    .send({ model: "openai/test", restrictions: {} })
    .expect(400);
  expect(store.snapshot(companyId)).toEqual(before);
});
