import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { createCrewAuth, type CrewAuth } from "../auth/crew-auth.ts";
import { registerCharacterRoutes } from "./character-routes.ts";

let db: DatabaseSync;
let app: Express;
let auth: CrewAuth;
let companyId: string;
let agentId: string;
let directory: string;
const appearance = { character_id: "navigator", portrait: null, full_body: null };
const upload = async () => ({
  kind: "portrait",
  contentType: "image/png",
  dataBase64: (
    await sharp({ create: { width: 40, height: 40, channels: 4, background: "teal" } })
      .png()
      .toBuffer()
  ).toString("base64"),
});
async function login(role: "owner" | "operator" | "viewer") {
  const user = await auth.users.create({
    email: `${role}@example.invalid`,
    password: "local-test-password-only",
    role,
  });
  return { user, token: auth.sessions.create(user.id).token };
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "crew-character-api-"));
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  auth = createCrewAuth(db);
  app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/api/crew", auth.identify);
  registerCharacterRoutes(app, { db, companyId, auth, assetsDir: path.join(directory, "assets") });
});
afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("private character routes", () => {
  it("requires a signed-in user for catalog and private images after bootstrap", async () => {
    const owner = await login("owner");
    await request(app).get("/api/crew/character-skins").expect(401);
    await request(app).get("/api/crew/character-assets").expect(401);
    const result = await request(app)
      .get("/api/crew/character-skins")
      .set("x-ironcrew-session", owner.token)
      .expect(200);
    expect(result.body.skins).toHaveLength(20);
  });

  it("only owners may upload or change appearances; viewers can read authenticated private images", async () => {
    const owner = await login("owner");
    const operator = await login("operator");
    const viewer = await login("viewer");
    for (const session of [operator, viewer]) {
      await request(app).get("/api/crew/character-assets").set("x-ironcrew-session", session.token).expect(403);
      await request(app)
        .delete("/api/crew/character-assets/char_00000000000000000000000000000000")
        .set("x-ironcrew-session", session.token)
        .send({ detach: true })
        .expect(403);
      await request(app)
        .post("/api/crew/character-assets/recover")
        .set("x-ironcrew-session", session.token)
        .expect(403);
      await request(app)
        .post("/api/crew/character-assets")
        .set("x-ironcrew-session", session.token)
        .send(await upload())
        .expect(403);
      await request(app)
        .patch(`/api/crew/agents/${agentId}/appearance`)
        .set("x-ironcrew-session", session.token)
        .send(appearance)
        .expect(403);
    }
    const uploaded = await request(app)
      .post("/api/crew/character-assets")
      .set("x-ironcrew-session", owner.token)
      .send(await upload())
      .expect(201);
    const { asset } = uploaded.body;
    const assigned = await request(app)
      .patch(`/api/crew/agents/${agentId}/appearance`)
      .set("x-ironcrew-session", owner.token)
      .send({ ...appearance, portrait: asset.url })
      .expect(200);
    expect(assigned.body.appearance.portrait).toBe(asset.url);
    await request(app).get(asset.url).expect(401);
    const read = await request(app).get(asset.url).set("x-ironcrew-session", viewer.token).expect(200);
    expect(read.headers["content-type"]).toContain("image/webp");
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.isBuffer(read.body)).toBe(true);
    const audit = db
      .prepare("SELECT actor_id FROM crew_audit_events WHERE action = 'agent.appearance_updated'")
      .get() as { actor_id: string };
    expect(audit.actor_id).toBe(owner.user.id);
    const listed = await request(app)
      .get("/api/crew/character-assets")
      .set("x-ironcrew-session", owner.token)
      .expect(200);
    expect(listed.body.assets[0].inUseBy).toEqual([agentId]);
    await request(app).delete(asset.url).set("x-ironcrew-session", owner.token).send({}).expect(409);
    await request(app).delete(asset.url).set("x-ironcrew-session", owner.token).send({ detach: "true" }).expect(400);
    const removed = await request(app)
      .delete(asset.url)
      .set("x-ironcrew-session", owner.token)
      .send({ detach: true })
      .expect(200);
    expect(removed.body).toEqual({ deleted: true, pending: false, detachedAgentIds: [agentId] });
    await request(app).get(asset.url).set("x-ironcrew-session", viewer.token).expect(404);
    expect(fs.readdirSync(path.join(directory, "assets"))).toEqual([]);
  });

  it("rejects invalid uploads and arbitrary appearance fields without changing the agent", async () => {
    const owner = await login("owner");
    for (const update of [
      { ...appearance, professionalRole: "owner" },
      { ...appearance, character_id: "unknown" },
      { ...appearance, portrait: "https://example.invalid/avatar.png" },
    ]) {
      await request(app)
        .patch(`/api/crew/agents/${agentId}/appearance`)
        .set("x-ironcrew-session", owner.token)
        .send(update)
        .expect(400);
    }
    await request(app)
      .post("/api/crew/character-assets")
      .set("x-ironcrew-session", owner.token)
      .send({ ...(await upload()), contentType: "image/svg+xml" })
      .expect(400);
    const other = seedCompany(db);
    const foreignAgent = seedAgent(db, other);
    await request(app)
      .patch(`/api/crew/agents/${foreignAgent}/appearance`)
      .set("x-ironcrew-session", owner.token)
      .send(appearance)
      .expect(404);
    expect(db.prepare("SELECT * FROM crew_agent_appearances").all()).toEqual([]);
  });
});
