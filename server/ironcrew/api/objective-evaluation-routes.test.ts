import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { createCrewAuth, type CrewAuth } from "../auth/crew-auth.ts";
import { registerObjectiveEvaluationRoutes } from "./objective-evaluation-routes.ts";
let app: Express;
let db: DatabaseSync;
let auth: CrewAuth;
beforeEach(() => {
  db = createTestDb();
  const companyId = seedCompany(db);
  auth = createCrewAuth(db);
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify);
  registerObjectiveEvaluationRoutes(app, { db, companyId, auth });
});
afterEach(() => db.close());
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({ email: `${role}@example.invalid`, password: "local-testing-password", role });
  return auth.sessions.create(user.id).token;
}
const rubric = () => ({
  key: "source-check",
  baseVersion: 0,
  title: "Quellencheck",
  reason: "Nachvollziehbare Quellen prüfen.",
  cases: [{ id: "source", label: "Quelle", kind: "contains", expected: "Quelle" }],
});
describe("objective evaluation API", () => {
  it("enforces authenticated reads, owner rubric edits and operator measurements", async () => {
    const owner = await login("owner");
    const operator = await login("operator");
    const viewer = await login("viewer");
    await request(app).get("/api/crew/evaluations").expect(401);
    for (const token of [operator, viewer])
      await request(app)
        .post("/api/crew/evaluations/rubrics")
        .set("x-ironcrew-session", token)
        .send(rubric())
        .expect(403);
    const result = await request(app)
      .post("/api/crew/evaluations/rubrics")
      .set("x-ironcrew-session", owner)
      .send(rubric())
      .expect(201);
    const read = await request(app).get("/api/crew/evaluations").set("x-ironcrew-session", viewer).expect(200);
    expect(read.body).toMatchObject({ canEdit: false, canMeasure: false, rubrics: [{ id: result.body.rubric.id }] });
    await request(app)
      .post("/api/crew/evaluations/measure")
      .set("x-ironcrew-session", viewer)
      .send({ rubricId: result.body.rubric.id, runId: "missing" })
      .expect(403);
    await request(app)
      .post("/api/crew/evaluations/measure")
      .set("x-ironcrew-session", operator)
      .send({ rubricId: result.body.rubric.id, runId: "missing" })
      .expect(404);
    await request(app).get("/api/crew/evaluations/missing/replay").set("x-ironcrew-session", viewer).expect(404);
  });
  it("returns conflict for stale versions and refuses body-provided scope, actor or score", async () => {
    await request(app).post("/api/crew/evaluations/rubrics").send(rubric()).expect(201);
    await request(app).post("/api/crew/evaluations/rubrics").send(rubric()).expect(409);
    for (const patch of [{ companyId: "another" }, { actorId: "other" }, { score: 100 }])
      await request(app)
        .post("/api/crew/evaluations/rubrics")
        .send({ ...rubric(), ...patch })
        .expect(400);
    await request(app)
      .post("/api/crew/evaluations/measure")
      .send({ rubricId: "a", runId: "b", score: 100 })
      .expect(400);
  });
});
