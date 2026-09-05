import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { TaskStore } from "../domain/task-store.ts";
import { ProjectStore } from "../domain/project-store.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { createCrewAuth, type CrewAuth } from "../auth/crew-auth.ts";
import { registerSandboxRoutes } from "./sandbox-routes.ts";
import type { SandboxAccessService } from "../domain/sandbox-access-service.ts";
let db: DatabaseSync;
let app: Express;
let auth: CrewAuth;
let service: SandboxAccessService;
let companyId: string;
let taskId: string;
const revoked = vi.fn();
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  const agentId = seedAgent(db, companyId);
  db.prepare(
    "UPDATE crew_vessels SET runtime_provider='codex' WHERE id=(SELECT vessel_id FROM crew_agents WHERE id=?)",
  ).run(agentId);
  const projectId = new ProjectStore(db).create({ companyId, title: "Sandbox", workspacePath: "/work/sandbox" }).id;
  taskId = new TaskStore(db).create({
    companyId,
    title: "Task",
    projectId,
    assignedAgentId: agentId,
    status: "ready",
  }).id;
  auth = createCrewAuth(db);
  app = express();
  app.use(express.json());
  app.use("/api/crew", auth.identify);
  service = registerSandboxRoutes(app, { db, companyId, auth, onRevoke: revoked });
  revoked.mockClear();
});
afterEach(() => db.close());
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({ email: `${role}@example.invalid`, role, password: "sandbox-test-password" });
  return { user, token: auth.sessions.create(user.id).token };
}
const body = () => ({ taskId, provider: "codex", durationMs: 900000, reason: "Isolierter Migrationstest im Projekt" });
describe("owner sandbox routes", () => {
  it("refuses anonymous/bootstrap elevation and does not expose an API to mint or consume", async () => {
    await request(app).post("/api/crew/sandbox-access/request").send(body()).expect(400);
    await login("owner");
    await request(app).get("/api/crew/sandbox-access").expect(401);
    await request(app).post("/api/crew/sandbox-access/request").send(body()).expect(401);
    await request(app).post("/api/crew/sandbox-access/mint").send(body()).expect(404);
    expect(service.list(companyId).grants).toHaveLength(0);
  });
  it("requires owner role, validates request shape and preserves authenticated actor", async () => {
    const owner = await login("owner");
    for (const role of ["operator", "viewer"] as const) {
      const user = await login(role);
      await request(app)
        .post("/api/crew/sandbox-access/request")
        .set("x-ironcrew-session", user.token)
        .send(body())
        .expect(403);
    }
    await request(app)
      .post("/api/crew/sandbox-access/request")
      .set("x-ironcrew-session", owner.token)
      .send({ ...body(), workspacePath: "/" })
      .expect(400);
    const result = await request(app)
      .post("/api/crew/sandbox-access/request")
      .set("x-ironcrew-session", owner.token)
      .send(body())
      .expect(201);
    expect(result.body.approval).toMatchObject({
      requested_by: owner.user.id,
      status: "pending",
      approval_type: "sandbox_elevation",
    });
    expect(service.list(companyId).grants).toHaveLength(0);
  });
  it("revokes an exact approved grant and triggers active-run cancellation callback", async () => {
    const owner = await login("owner");
    const approved = await request(app)
      .post("/api/crew/sandbox-access/request")
      .set("x-ironcrew-session", owner.token)
      .send(body())
      .expect(201);
    new CompanyOrchestrator(db).reviewApproval(companyId, approved.body.approval.id, "approved", "Geprüft", {
      actorId: owner.user.id,
    });
    const grant = service.settleApproval(companyId, approved.body.approval.id)!;
    const operator = await login("operator");
    await request(app)
      .post(`/api/crew/sandbox-access/${grant.id}/revoke`)
      .set("x-ironcrew-session", operator.token)
      .send({ reason: "stop" })
      .expect(403);
    await request(app)
      .post(`/api/crew/sandbox-access/${grant.id}/revoke`)
      .set("x-ironcrew-session", owner.token)
      .send({ reason: "Nicht mehr erforderlich" })
      .expect(200);
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ id: grant.id, revoked_at: expect.any(Number) }));
    await request(app)
      .post("/api/crew/sandbox-access/foreign/revoke")
      .set("x-ironcrew-session", owner.token)
      .send({ reason: "Stop" })
      .expect(404);
  });
});
