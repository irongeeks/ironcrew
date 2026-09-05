import { afterEach, beforeEach, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { createCrewAuth } from "../auth/crew-auth.ts";
import { registerCareerRoutes } from "./career-routes.ts";
let db: ReturnType<typeof createTestDb>,
  app: ReturnType<typeof express>,
  auth: ReturnType<typeof createCrewAuth>,
  companyId: string,
  agentId: string;
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  auth = createCrewAuth(db);
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify);
  registerCareerRoutes(app, { db, companyId, auth });
});
afterEach(() => db.close());
async function login(role: "owner" | "viewer") {
  const u = await auth.users.create({ email: `${role}@example.invalid`, password: "career-test-password", role });
  return { user: u, token: auth.sessions.create(u.id).token };
}
it("authenticates reads and restricts all mutations to owner, no score mutation endpoint", async () => {
  await login("owner");
  await request(app).get("/api/crew/people").expect(401);
  const viewer = await login("viewer");
  await request(app).get("/api/crew/people").set("x-ironcrew-session", viewer.token).expect(200);
  await request(app)
    .put("/api/crew/people/config")
    .set("x-ironcrew-session", viewer.token)
    .send({ baseRevision: 0, enabled: false, departments: [] })
    .expect(403);
  await request(app)
    .post("/api/crew/people/reviews")
    .set("x-ironcrew-session", viewer.token)
    .send({ score: 5 })
    .expect(404);
});
it("validates version and body boundaries, preserves owner identity and cross-company scope", async () => {
  const owner = await login("owner");
  const h = { "x-ironcrew-session": owner.token };
  await request(app)
    .put("/api/crew/people/config")
    .set(h)
    .send({ baseRevision: 0, enabled: false, departments: [] })
    .expect(200);
  await request(app)
    .put("/api/crew/people/config")
    .set(h)
    .send({ baseRevision: 0, enabled: false, departments: [] })
    .expect(409);
  const valid = { baseRevision: 0, level: "lead", reason: "Fachliche Leitung" };
  await request(app)
    .post(`/api/crew/people/agents/${agentId}/level`)
    .set(h)
    .send({ ...valid, permissions: ["*"] })
    .expect(400);
  const response = await request(app).post(`/api/crew/people/agents/${agentId}/level`).set(h).send(valid).expect(201);
  expect(response.body.approval).toMatchObject({
    requested_by: owner.user.id,
    status: "pending",
    approval_type: "agent_lifecycle_change",
  });
  const foreign = seedAgent(db, seedCompany(db));
  await request(app).post(`/api/crew/people/agents/${foreign}/level`).set(h).send(valid).expect(403);
  await request(app).get("/api/crew/people?difficulty=impossible").set(h).expect(400);
});
