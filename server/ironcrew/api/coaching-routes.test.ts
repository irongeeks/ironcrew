import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { createCrewAuth, type CrewAuth } from "../auth/crew-auth.ts";
import { registerCoachingRoutes } from "./coaching-routes.ts";

let db: DatabaseSync;
let app: Express;
let auth: CrewAuth;
let companyId: string;
let agentId: string;
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  auth = createCrewAuth(db);
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify);
  registerCoachingRoutes(app, { db, companyId, auth });
});
afterEach(() => db.close());
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({ email: `${role}@example.invalid`, password: "local-test-password", role });
  return { user, token: auth.sessions.create(user.id).token };
}
const proposal = () => ({
  agentId,
  title: "Quellenprüfung",
  guidance: "Quellen im Review prüfen.",
  skills: [],
  cases: [{ label: "Quellen", kind: "guidance_contains", expected: "Quellen" }],
});
describe("coaching API authorization and workflow", () => {
  it("persists operator draft and evaluation, but only a human owner can approve the version", async () => {
    const owner = await login("owner");
    const operator = await login("operator");
    const viewer = await login("viewer");
    await request(app).get(`/api/crew/coaching?agentId=${agentId}`).expect(401);
    await request(app)
      .post("/api/crew/coaching/proposals")
      .set("x-ironcrew-session", viewer.token)
      .send(proposal())
      .expect(403);
    const draft = await request(app)
      .post("/api/crew/coaching/proposals")
      .set("x-ironcrew-session", operator.token)
      .send(proposal())
      .expect(201);
    const id = draft.body.proposal.id;
    await request(app)
      .post(`/api/crew/coaching/proposals/${id}/evaluate`)
      .set("x-ironcrew-session", viewer.token)
      .send({})
      .expect(403);
    const evaluated = await request(app)
      .post(`/api/crew/coaching/proposals/${id}/evaluate`)
      .set("x-ironcrew-session", operator.token)
      .send({})
      .expect(200);
    expect(evaluated.body.proposal.evaluation).toMatchObject({ passed: true, passedCases: 1, totalCases: 1 });
    await request(app)
      .post(`/api/crew/coaching/proposals/${id}/review`)
      .set("x-ironcrew-session", operator.token)
      .send({ decision: "approve", reason: "Nicht berechtigt" })
      .expect(403);
    await request(app)
      .post(`/api/crew/coaching/proposals/${id}/review`)
      .set("x-ironcrew-session", owner.token)
      .send({ decision: "approve", reason: "Kriterien und Text geprüft." })
      .expect(200);
    const view = await request(app)
      .get(`/api/crew/coaching?agentId=${agentId}`)
      .set("x-ironcrew-session", viewer.token)
      .expect(200);
    expect(view.body.current).toMatchObject({ version: 1, approvedBy: owner.user.id });
    await request(app)
      .post(`/api/crew/coaching/proposals/${id}/review`)
      .set("x-ironcrew-session", owner.token)
      .send({ decision: "approve", reason: "Doppelt" })
      .expect(409);
  });
  it("rejects foreign agents and body-driven company/actor/score overrides", async () => {
    const owner = await login("owner");
    const other = seedCompany(db, "other");
    const foreign = seedAgent(db, other);
    await request(app).get(`/api/crew/coaching?agentId=${foreign}`).set("x-ironcrew-session", owner.token).expect(404);
    for (const extra of [{ companyId: other }, { actorId: "someone" }, { policy: { may_approve: true } }])
      await request(app)
        .post("/api/crew/coaching/proposals")
        .set("x-ironcrew-session", owner.token)
        .send({ ...proposal(), ...extra })
        .expect(400);
    const draft = await request(app)
      .post("/api/crew/coaching/proposals")
      .set("x-ironcrew-session", owner.token)
      .send(proposal())
      .expect(201);
    await request(app)
      .post(`/api/crew/coaching/proposals/${draft.body.proposal.id}/evaluate`)
      .set("x-ironcrew-session", owner.token)
      .send({ passed: true })
      .expect(400);
    await request(app)
      .post(`/api/crew/coaching/proposals/${draft.body.proposal.id}/review`)
      .set("x-ironcrew-session", owner.token)
      .send({ decision: "approve", reason: "skip evaluation" })
      .expect(409);
  });
  it("saves sourced notes separately and requires nonempty review reasons", async () => {
    const owner = await login("owner");
    await request(app)
      .post("/api/crew/coaching/notes")
      .set("x-ironcrew-session", owner.token)
      .send({ agentId, kind: "one_on_one", title: "Review", body: "Quellen künftig ausdrücklich verlinken." })
      .expect(201);
    const draft = await request(app)
      .post("/api/crew/coaching/proposals")
      .set("x-ironcrew-session", owner.token)
      .send(proposal())
      .expect(201);
    await request(app)
      .post(`/api/crew/coaching/proposals/${draft.body.proposal.id}/review`)
      .set("x-ironcrew-session", owner.token)
      .send({ decision: "reject", reason: "" })
      .expect(400);
    await request(app)
      .post(`/api/crew/coaching/proposals/${draft.body.proposal.id}/review`)
      .set("x-ironcrew-session", owner.token)
      .send({ decision: "reject", reason: "Bitte mit Abnahmekriterien konkretisieren." })
      .expect(200);
    const view = await request(app)
      .get(`/api/crew/coaching?agentId=${agentId}`)
      .set("x-ironcrew-session", owner.token)
      .expect(200);
    expect(view.body.notes).toHaveLength(1);
    expect(view.body.current).toBeNull();
    expect(view.body.proposals[0].status).toBe("rejected");
  });
});
