import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { createCrewAuth, methodGuard, type CrewAuth } from "../auth/crew-auth.ts";
import { CompanyConfigurationStore } from "../policy/company-configuration-store.ts";
import { registerCompanyConfigurationRoutes } from "./company-configuration-routes.ts";
let db: DatabaseSync, app: Express, auth: CrewAuth, store: CompanyConfigurationStore, companyId: string;
const changed = vi.fn();
const base = "/api/crew/configuration";
beforeEach(() => {
  changed.mockClear();
  db = createTestDb();
  companyId = seedCompany(db);
  store = new CompanyConfigurationStore(db);
  auth = createCrewAuth(db);
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify, methodGuard(auth));
  registerCompanyConfigurationRoutes(app, { store, companyId, auth, onChanged: changed });
});
afterEach(() => db.close());
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({ email: role + "@example.invalid", password: "safe-test-password", role });
  return auth.sessions.create(user.id).token;
}
it("allows guarded bootstrap, then reports permissions and rejects viewer/operator writes", async () => {
  expect((await request(app).get(base).expect(200)).body.canEdit).toBe(true);
  const owner = await login("owner"),
    viewer = await login("viewer"),
    operator = await login("operator");
  await request(app).get(base).expect(401);
  const first = (await request(app).get(base).set("x-ironcrew-session", viewer).expect(200)).body;
  expect(first.canEdit).toBe(false);
  const input = {
    baseRevision: first.revision,
    reason: "Kapazität der Firma nachvollziehbar begrenzen.",
    configuration: { ...first.configuration, runtime: { ...first.configuration.runtime, maxConcurrentRuns: 2 } },
  };
  for (const token of [viewer, operator])
    await request(app).put(base).set("x-ironcrew-session", token).send(input).expect(403);
  await request(app)
    .put(base)
    .set("x-ironcrew-session", owner)
    .send({ ...input, permissions: [] })
    .expect(400);
  const saved = await request(app).put(base).set("x-ironcrew-session", owner).send(input).expect(200);
  expect(saved.body).toMatchObject({
    canEdit: true,
    revision: 1,
    configuration: { runtime: { maxConcurrentRuns: 2 } },
  });
  expect(changed).toHaveBeenCalledTimes(1);
  await request(app).put(base).set("x-ironcrew-session", owner).send(input).expect(409);
  expect(changed).toHaveBeenCalledTimes(1);
  expect((await request(app).get(base).set("x-ironcrew-session", viewer).expect(200)).body.history).toHaveLength(1);
});
