import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { createCrewAuth } from "../auth/crew-auth.ts";
import { registerIronCrewRoutes } from "./routes.ts";

it("uses the existing single-owner bootstrap through the canonical decision route and closes it after account setup", async () => {
  const db = createTestDb();
  try {
    const app = express();
    app.use(express.json());
    const orchestrator = new CompanyOrchestrator(db);
    const api = registerIronCrewRoutes(app, { db, orchestrator, broadcast: () => undefined });
    const snapshot = await request(app).get("/api/crew/people").expect(200);
    const profile = snapshot.body.profiles[0] as { agentId: string; revision: number };
    const requested = await request(app)
      .post(`/api/crew/people/agents/${profile.agentId}/level`)
      .send({ baseRevision: profile.revision, level: "lead", reason: "Lokale Ownerkonfiguration" })
      .expect(201);
    expect(requested.body.approval.requested_by).toBe("ceo");
    expect(orchestrator.career.forAgent(api.companyId, profile.agentId).level).toBe("senior");
    await request(app)
      .post(`/api/crew/approvals/${requested.body.approval.id}/decide`)
      .send({ decision: "approved", reason: "Fachliche Verantwortung geprüft" })
      .expect(200);
    expect(orchestrator.career.forAgent(api.companyId, profile.agentId)).toMatchObject({ level: "lead", revision: 1 });
    expect(orchestrator.approvalReviews.listFor(requested.body.approval.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ reviewer_id: "ceo", verdict: "approved" })]),
    );
    const auth = createCrewAuth(db);
    await auth.users.create({
      email: "owner-bootstrap@example.invalid",
      password: "bootstrap-test-password",
      role: "owner",
    });
    await request(app).get("/api/crew/people").expect(401);
    await request(app)
      .post(`/api/crew/people/agents/${profile.agentId}/level`)
      .send({ baseRevision: 1, level: "senior", reason: "Anonymer Versuch" })
      .expect(401);
    expect(() =>
      orchestrator.career.requestLevel(
        api.companyId,
        profile.agentId,
        { baseRevision: 1, level: "senior", reason: "Direkter Versuch" },
        "ceo",
      ),
    ).toThrow(/Owner/);
  } finally {
    db.close();
  }
});
