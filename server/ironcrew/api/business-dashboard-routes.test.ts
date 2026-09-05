import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany, seedAgent } from "../domain/test-db.ts";
import { createCrewAuth, type CrewAuth } from "../auth/crew-auth.ts";
import { BusinessDashboardService } from "../packs/business-dashboard.ts";
import { registerBusinessDashboardRoutes } from "./business-dashboard-routes.ts";
let db: DatabaseSync;
let app: Express;
let auth: CrewAuth;
let agentId: string;
const getAdapter = vi.fn(() => undefined);
beforeEach(() => {
  db = createTestDb();
  const companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  auth = createCrewAuth(db);
  getAdapter.mockClear();
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify);
  const service = new BusinessDashboardService({
    db,
    companyId,
    getAdapter,
    agents: () => [{ id: agentId, displayName: "Atlas" }],
    gate: () => ({ outcome: "denied" }),
  });
  registerBusinessDashboardRoutes(app, { service, auth });
});
afterEach(() => db.close());
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({ email: `${role}@example.invalid`, password: "safe-test-password", role });
  return auth.sessions.create(user.id).token;
}
it("restricts cached business data and refresh to authenticated owners", async () => {
  const owner = await login("owner"),
    operator = await login("operator"),
    viewer = await login("viewer");
  await request(app).get("/api/crew/business-dashboard").expect(401);
  for (const token of [operator, viewer]) {
    await request(app).get("/api/crew/business-dashboard").set("x-ironcrew-session", token).expect(403);
    await request(app)
      .post("/api/crew/business-dashboard/proxmox/refresh")
      .set("x-ironcrew-session", token)
      .send({ agentId })
      .expect(403);
  }
  const snapshot = await request(app).get("/api/crew/business-dashboard").set("x-ironcrew-session", owner).expect(200);
  expect(snapshot.body.sources).toHaveLength(6);
  expect(snapshot.body.sources[0]).toMatchObject({ state: "not_installed", metrics: [], fetchedAt: null });
  expect(getAdapter).not.toHaveBeenCalled();
});
it("rejects URLs, unknown source ids, foreign agents and extra body fields", async () => {
  const owner = await login("owner");
  for (const body of [{}, { agentId: "foreign" }, { agentId, url: "https://example.invalid" }])
    await request(app)
      .post("/api/crew/business-dashboard/proxmox/refresh")
      .set("x-ironcrew-session", owner)
      .send(body)
      .expect(400);
  await request(app)
    .post("/api/crew/business-dashboard/unknown/refresh")
    .set("x-ironcrew-session", owner)
    .send({ agentId })
    .expect(400);
  await request(app)
    .post("/api/crew/business-dashboard/proxmox/refresh")
    .set("x-ironcrew-session", owner)
    .send({ agentId })
    .expect(200);
});
