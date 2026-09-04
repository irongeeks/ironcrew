/**
 * Business packs, over HTTP.
 *
 * The property worth testing at this layer is the one Phase 4 is judged on:
 * an integration reports itself configured only when an adapter was actually
 * registered at boot. A listing that always said "configured" would be the
 * fake button the roadmap forbids, and it would look identical in a
 * screenshot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { registerIronCrewRoutes } from "./routes.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { ToolStore } from "../domain/tool-store.ts";
import { RoutineStore } from "../domain/routine-store.ts";
import type { CrewAuth } from "../auth/crew-auth.ts";
import type { IntegrationStatus, PackIntegrationAdapter } from "../packs/pack-integration.ts";

let db: DatabaseSync;
let app: Express;
let orchestrator: CompanyOrchestrator;
let companyId: string;
let auth: CrewAuth;

beforeEach(() => {
  db = createTestDb();
  app = express();
  app.use(express.json());
  orchestrator = new CompanyOrchestrator(db);
  orchestrator.registerRuntime(new MockRuntime());
  const api = registerIronCrewRoutes(app, { db, orchestrator });
  companyId = api.companyId;
  auth = api.auth;
});

afterEach(() => db.close());

/** An adapter that answers without a socket, standing in for a configured one. */
function fakeAdapter(key: string, status: IntegrationStatus): PackIntegrationAdapter {
  return { key, label: key, testConnection: async () => status };
}

async function login(email: string, role: "owner" | "operator"): Promise<string> {
  await auth.users.create({ email, password: "correct horse staple", role });
  const res = await request(app).post("/api/crew/auth/login").send({ email, password: "correct horse staple" });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return cookies.find((c) => c.startsWith("ironcrew_session="))!.split(";")[0]!;
}

describe("the catalogue over HTTP", () => {
  it("lists every pack with what it would add", async () => {
    const res = await request(app).get("/api/crew/packs").expect(200);
    expect(res.body.packs.map((p: { key: string }) => p.key)).toEqual([
      "msp",
      "web-agency",
      "finance-de",
      "legal-de",
      "knowledge",
    ]);
    const msp = res.body.packs.find((p: { key: string }) => p.key === "msp");
    expect(msp.installed).toBe(false);
    expect(msp.counts.agents).toBeGreaterThan(0);
  });

  it("reports an integration as not configured when no adapter was registered", async () => {
    const res = await request(app).get("/api/crew/packs").expect(200);
    const msp = res.body.packs.find((p: { key: string }) => p.key === "msp");
    for (const integration of msp.integrations) {
      expect(integration.configured, integration.key).toBe(false);
      // …and says which variables would switch it on, so the operator has
      // something to act on rather than a dead switch.
      expect(integration.env.length).toBeGreaterThan(0);
    }
  });

  it("reports it as configured once an adapter is registered", async () => {
    orchestrator.registerPackIntegration(fakeAdapter("proxmox", { ok: true, message: "da" }));
    const res = await request(app).get("/api/crew/packs").expect(200);
    const msp = res.body.packs.find((p: { key: string }) => p.key === "msp");
    const proxmox = msp.integrations.find((i: { key: string }) => i.key === "proxmox");
    expect(proxmox.configured).toBe(true);
  });

  it("shows the whole definition before anything is installed", async () => {
    const res = await request(app).get("/api/crew/packs/finance-de").expect(200);
    expect(res.body.agents.length).toBeGreaterThan(0);
    expect(res.body.agents[0]).toHaveProperty("displayName");
    expect(res.body.routines.length).toBeGreaterThan(0);
  });

  it("404s for a pack that does not exist", async () => {
    await request(app).get("/api/crew/packs/does-not-exist").expect(404);
  });
});

describe("probing an integration", () => {
  it("says plainly that an unconfigured one is not configured", async () => {
    const res = await request(app).post("/api/crew/packs/msp/integrations/proxmox/test").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/nicht konfiguriert/);
  });

  it("passes a configured adapter's own answer through", async () => {
    orchestrator.registerPackIntegration(fakeAdapter("proxmox", { ok: true, message: "PVE 8.2", version: "8.2" }));
    const res = await request(app).post("/api/crew/packs/msp/integrations/proxmox/test").expect(200);
    expect(res.body).toMatchObject({ ok: true, message: "PVE 8.2", version: "8.2" });
  });

  it("404s for an integration the pack does not declare", async () => {
    await request(app).post("/api/crew/packs/msp/integrations/lexware-office/test").expect(404);
  });
});

describe("installing over HTTP", () => {
  it("hires the posts, registers the tools and leaves the routines off", async () => {
    const res = await request(app).post("/api/crew/packs/knowledge/install").expect(201);
    expect(res.body.created.agents).toBeGreaterThan(0);

    expect(orchestrator.getAgent(companyId, "knowledge-archivar")).not.toBeNull();
    const tool = new ToolStore(db).byKey(companyId, "paperless.search");
    expect(tool?.origin).toBe("pack");
    for (const routine of new RoutineStore(db).list(companyId)) {
      expect(routine.enabled, routine.name).toBe(0);
    }
  });

  it("shows up as installed in the listing afterwards", async () => {
    await request(app).post("/api/crew/packs/knowledge/install").expect(201);
    const res = await request(app).get("/api/crew/packs").expect(200);
    const pack = res.body.packs.find((p: { key: string }) => p.key === "knowledge");
    expect(pack.installed).toBe(true);
    expect(pack.installedVersion).toBe("1.0.0");
  });

  it("refuses a second install with a readable conflict", async () => {
    await request(app).post("/api/crew/packs/knowledge/install").expect(201);
    const res = await request(app).post("/api/crew/packs/knowledge/install").expect(409);
    expect(res.body.error).toBe("invalid_pack_mutation");
  });

  it("removes what it created and reports what it kept", async () => {
    await request(app).post("/api/crew/packs/knowledge/install").expect(201);
    const res = await request(app).post("/api/crew/packs/knowledge/uninstall").expect(200);
    expect(res.body.removed.agents).toBeGreaterThan(0);
    expect(res.body.disabledTools).toBeGreaterThan(0);
    expect(Array.isArray(res.body.kept)).toBe(true);
    expect(orchestrator.getAgent(companyId, "knowledge-archivar")).toBeNull();
  });
});

describe("who may change the org chart", () => {
  it("lets an operator look but not install", async () => {
    const cookie = await login("operator@example.com", "operator");
    await request(app).get("/api/crew/packs").set("Cookie", cookie).expect(200);
    await request(app).post("/api/crew/packs/knowledge/install").set("Cookie", cookie).expect(403);
  });

  it("lets an owner install", async () => {
    const cookie = await login("owner@example.com", "owner");
    await request(app).post("/api/crew/packs/knowledge/install").set("Cookie", cookie).expect(201);
  });

  it("records the installing owner in the audit log", async () => {
    const cookie = await login("owner@example.com", "owner");
    const user = auth.users.byEmail("owner@example.com")!;
    await request(app).post("/api/crew/packs/knowledge/install").set("Cookie", cookie).expect(201);

    const row = db
      .prepare("SELECT actor_id FROM crew_audit_events WHERE company_id = ? AND action = 'pack.installed'")
      .get(companyId) as { actor_id: string };
    expect(row.actor_id).toBe(user.id);
  });
});
