import { afterEach, beforeEach, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany, seedAgent } from "../domain/test-db.ts";
import { createCrewAuth, type CrewAuth } from "../auth/crew-auth.ts";
import { RoutingStore } from "../domain/routing-store.ts";
import { VesselStore } from "../domain/vessel-store.ts";
import { registerRoutingRoutes } from "./routing-routes.ts";
let db: DatabaseSync, app: Express, auth: CrewAuth, store: RoutingStore, companyId: string, agentId: string;
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  auth = createCrewAuth(db);
  store = new RoutingStore(db);
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify);
  registerRoutingRoutes(app, { store, companyId, auth });
});
afterEach(() => db.close());
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({ email: role + "@example.invalid", password: "safe-test-password", role });
  return auth.sessions.create(user.id).token;
}
it("requires an authenticated owner, validates JSON, persists revisions and bindings with audit", async () => {
  const owner = await login("owner"),
    viewer = await login("viewer");
  await request(app).get("/api/crew/routing").expect(401);
  const first = await request(app).get("/api/crew/routing").set("x-ironcrew-session", viewer).expect(200);
  expect(first.body.revision).toBe(1);
  const config = first.body.config;
  const vessel = new VesselStore(db).create({ companyId, key: "test", runtimeProvider: "mock" });
  config.profiles.find((p: { key: string }) => p.key === "coding").primary = {
    vesselId: vessel.id,
    runtimeType: "mock",
    model: "example",
    vendorModel: "openai/example",
  };
  await request(app)
    .put("/api/crew/routing")
    .set("x-ironcrew-session", viewer)
    .send({ expectedRevision: 1, config })
    .expect(403);
  await request(app)
    .put("/api/crew/routing")
    .set("x-ironcrew-session", owner)
    .set("Content-Type", "text/plain")
    .send(JSON.stringify({ expectedRevision: 1, config }))
    .expect(400);
  await request(app)
    .put("/api/crew/routing")
    .set("x-ironcrew-session", owner)
    .send({ expectedRevision: 1, config })
    .expect(200);
  await request(app)
    .put("/api/crew/routing")
    .set("x-ironcrew-session", owner)
    .send({ expectedRevision: 1, config })
    .expect(409);
  await request(app)
    .put(`/api/crew/routing/agents/${agentId}`)
    .set("x-ironcrew-session", viewer)
    .send({ profileKey: "coding" })
    .expect(403);
  await request(app)
    .put(`/api/crew/routing/agents/${agentId}`)
    .set("x-ironcrew-session", owner)
    .send({ profileKey: "coding" })
    .expect(200);
  const restarted = new RoutingStore(db);
  expect(restarted.snapshot(companyId)).toMatchObject({ revision: 2, bindings: [{ agentId, profileKey: "coding" }] });
  expect(db.prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE action LIKE 'routing.%'").get()).toMatchObject({
    n: 3,
  });
  const other = seedCompany(db, "other");
  const foreign = seedAgent(db, other);
  await request(app)
    .put(`/api/crew/routing/agents/${foreign}`)
    .set("x-ironcrew-session", owner)
    .send({ profileKey: "coding" })
    .expect(404);
  await request(app)
    .put(`/api/crew/routing/agents/${agentId}`)
    .set("x-ironcrew-session", owner)
    .send({ profileKey: null })
    .expect(200);
  expect(restarted.binding(companyId, agentId)).toBeNull();
});
