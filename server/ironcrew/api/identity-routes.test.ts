/**
 * Identity, from the outside.
 *
 * The store tests already cover hashing, roles and the last-owner rule. What
 * is tested here is the part that did not exist until now: the moment an
 * installation stops being anonymous, and what each role may then do.
 *
 * Every request goes through the real Express stack, so the guards under test
 * are the ones that will run in production — not a function called directly
 * with a hand-made request.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { registerIronCrewRoutes } from "./routes.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { listAuditEvents } from "../domain/audit.ts";
import type { CrewAuth } from "../auth/crew-auth.ts";

let db: DatabaseSync;
let app: Express;
let companyId: string;
let auth: CrewAuth;

beforeEach(() => {
  db = createTestDb();
  app = express();
  app.use(express.json());
  const orchestrator = new CompanyOrchestrator(db);
  orchestrator.registerRuntime(new MockRuntime({ responseText: "fertig" }));
  const api = registerIronCrewRoutes(app, { db, orchestrator });
  companyId = api.companyId;
  auth = api.auth;
});

afterEach(() => db.close());

/** Creates an account directly, so a test does not need a prior account. */
async function seedUser(email: string, role: "owner" | "operator" | "viewer", password = "correct horse staple") {
  return auth.users.create({ email, password, role, displayName: email.split("@")[0] });
}

/** Signs in and returns the session cookie, as a browser would hold it. */
async function login(email: string, password = "correct horse staple"): Promise<string> {
  const res = await request(app).post("/api/crew/auth/login").send({ email, password }).expect(200);
  const raw = res.headers["set-cookie"] as unknown as string[];
  const cookie = raw.find((c) => c.startsWith("ironcrew_session="));
  expect(cookie).toBeTruthy();
  return cookie!.split(";")[0]!;
}

describe("the bootstrap regime", () => {
  it("lets an installation with no accounts work exactly as before", async () => {
    await request(app).get("/api/crew/company").expect(200);
    await request(app).post("/api/crew/goals").send({ title: "Umsatz verdoppeln" }).expect(201);
  });

  it("reports itself as bootstrap, so the UI can offer to create the first account", async () => {
    const res = await request(app).get("/api/crew/auth/status").expect(200);
    expect(res.body).toMatchObject({ bootstrap: true, authenticated: false, user: null });
  });

  it("makes the first account an owner without being asked", async () => {
    const res = await request(app)
      .post("/api/crew/users")
      .send({ email: "robert@example.com", password: "correct horse staple" })
      .expect(201);
    expect(res.body.user.role).toBe("owner");
  });

  it("closes the open door the moment an account exists", async () => {
    await seedUser("robert@example.com", "owner");
    await request(app)
      .post("/api/crew/users")
      .send({ email: "zweiter@example.com", password: "correct horse staple" })
      .expect(401);
  });

  it("locks the whole surface once an account exists", async () => {
    await seedUser("robert@example.com", "owner");
    const read = await request(app).get("/api/crew/company").expect(401);
    expect(read.body.error).toBe("login_required");
    await request(app).post("/api/crew/goals").send({ title: "x" }).expect(401);
  });

  it("cannot be re-entered by deleting the last owner", async () => {
    // The way back to an anonymous installation is deliberately closed: the
    // store refuses to remove the last active owner, so nobody can lock
    // themselves out and nobody can quietly turn the roles off again by
    // deleting accounts. `isBootstrap()` still reads the live table, so a
    // restored-from-empty database starts over correctly — that is a fresh
    // installation, not a downgrade of this one.
    const user = await seedUser("robert@example.com", "owner");
    expect(() => auth.users.delete(user.id)).toThrow(/last active owner/);
    await request(app).get("/api/crew/company").expect(401);
  });
});

describe("logging in", () => {
  beforeEach(async () => {
    await seedUser("robert@example.com", "owner");
  });

  it("returns a session cookie and the account behind it", async () => {
    const res = await request(app)
      .post("/api/crew/auth/login")
      .send({ email: "robert@example.com", password: "correct horse staple" })
      .expect(200);
    expect(res.body.user.email).toBe("robert@example.com");
    expect(res.body.user).not.toHaveProperty("password_hash");
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("accepts the email in any capitalisation", async () => {
    await request(app)
      .post("/api/crew/auth/login")
      .send({ email: "Robert@Example.com", password: "correct horse staple" })
      .expect(200);
  });

  it("answers a wrong password and an unknown account identically", async () => {
    const wrong = await request(app)
      .post("/api/crew/auth/login")
      .send({ email: "robert@example.com", password: "falsch" })
      .expect(401);
    const unknown = await request(app)
      .post("/api/crew/auth/login")
      .send({ email: "niemand@example.com", password: "falsch" })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("refuses a disabled account without saying that it is disabled", async () => {
    const user = auth.users.byEmail("robert@example.com")!;
    await seedUser("zweiter@example.com", "owner"); // so the last-owner rule allows it
    auth.users.update(user.id, { status: "disabled" });

    const res = await request(app)
      .post("/api/crew/auth/login")
      .send({ email: "robert@example.com", password: "correct horse staple" })
      .expect(401);
    expect(res.body.error).toBe("invalid_credentials");
  });

  it("carries the session on a following request", async () => {
    const cookie = await login("robert@example.com");
    const res = await request(app).get("/api/crew/auth/status").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ authenticated: true, bootstrap: false });
    expect(res.body.user.email).toBe("robert@example.com");
  });

  it("accepts the same token on a header, for scripts", async () => {
    const res = await request(app)
      .post("/api/crew/auth/login")
      .send({ email: "robert@example.com", password: "correct horse staple" })
      .expect(200);
    const token = decodeURIComponent(
      String((res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ironcrew_session="))!)
        .split(";")[0]!
        .split("=")[1]!,
    );
    await request(app).get("/api/crew/company").set("x-ironcrew-session", token).expect(200);
  });

  it("revokes the session server-side on logout, not only in the browser", async () => {
    const cookie = await login("robert@example.com");
    await request(app).post("/api/crew/auth/logout").set("Cookie", cookie).expect(200);
    // The same cookie value, replayed as a thief would.
    await request(app).get("/api/crew/company").set("Cookie", cookie).expect(401);
  });
});

describe("what each role may do", () => {
  beforeEach(async () => {
    await seedUser("owner@example.com", "owner");
    await seedUser("operator@example.com", "operator");
    await seedUser("viewer@example.com", "viewer");
  });

  it("lets a viewer read", async () => {
    const cookie = await login("viewer@example.com");
    await request(app).get("/api/crew/company").set("Cookie", cookie).expect(200);
    await request(app).get("/api/crew/tasks").set("Cookie", cookie).expect(200);
  });

  it("refuses a viewer any change, and says what is missing", async () => {
    const cookie = await login("viewer@example.com");
    const res = await request(app).post("/api/crew/goals").set("Cookie", cookie).send({ title: "x" }).expect(403);
    expect(res.body.error).toBe("forbidden");
    expect(res.body.message).toContain("operator");
  });

  it("lets an operator run the company", async () => {
    const cookie = await login("operator@example.com");
    await request(app).post("/api/crew/goals").set("Cookie", cookie).send({ title: "Umsatz" }).expect(201);
  });

  it("refuses an operator the decisions that hand out authority", async () => {
    const cookie = await login("operator@example.com");
    // Approving is the owner's alone (T-01).
    await request(app)
      .post("/api/crew/approvals/apr_missing/decide")
      .set("Cookie", cookie)
      .send({ decision: "approved" })
      .expect(403);
    // So is a vault secret …
    await request(app)
      .post("/api/crew/secrets")
      .set("Cookie", cookie)
      .send({ name: "x", provider: "vaultwarden", itemRef: "y" })
      .expect(403);
    // … and the list of who may use the system.
    await request(app).get("/api/crew/users").set("Cookie", cookie).expect(403);
  });

  it("lets an owner do all three", async () => {
    const cookie = await login("owner@example.com");
    await request(app).get("/api/crew/users").set("Cookie", cookie).expect(200);
    await request(app)
      .post("/api/crew/secrets")
      .set("Cookie", cookie)
      .send({ name: "mail", provider: "vaultwarden", itemRef: "Mail" })
      .expect(201);
  });
});

describe("the audit log names a person", () => {
  it("records the signed-in user's id rather than the constant", async () => {
    await seedUser("robert@example.com", "owner");
    const user = auth.users.byEmail("robert@example.com")!;
    const cookie = await login("robert@example.com");

    await request(app).post("/api/crew/goals").set("Cookie", cookie).send({ title: "Nachweisbar handeln" }).expect(201);

    const events = listAuditEvents(db, companyId, { limit: 50 }) as Array<{ action: string; actor_id: string }>;
    const goalEvent = events.find((e) => e.action.startsWith("goal."));
    expect(goalEvent?.actor_id).toBe(user.id);
    expect(goalEvent?.actor_id).not.toBe("ceo");
  });

  it("still says ceo while nobody has a name — the honest answer, not a placeholder", async () => {
    await request(app).post("/api/crew/goals").send({ title: "Vor der Identität" }).expect(201);
    const events = listAuditEvents(db, companyId, { limit: 50 }) as Array<{ action: string; actor_id: string }>;
    expect(events.find((e) => e.action.startsWith("goal."))?.actor_id).toBe("ceo");
  });

  it("names the deciding owner on an approval", async () => {
    await seedUser("robert@example.com", "owner");
    const user = auth.users.byEmail("robert@example.com")!;
    const cookie = await login("robert@example.com");

    // A sensitive instruction parks a task and raises an approval.
    await request(app)
      .post("/api/crew/chat")
      .set("Cookie", cookie)
      .send({ body: "Bitte kündige den Vertrag mit dem Lieferanten und überweise die Abfindung." })
      .expect(201);

    const pending = await request(app).get("/api/crew/approvals").set("Cookie", cookie).expect(200);
    const approval = pending.body.approvals[0];
    expect(approval).toBeTruthy();

    await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", cookie)
      .send({ decision: "approved", reason: "geprüft" })
      .expect(200);

    const decisions = await request(app).get("/api/crew/decisions").set("Cookie", cookie).expect(200);
    expect(decisions.body.decisions[0].decided_by).toBe(user.id);
  });
});

describe("managing accounts", () => {
  let cookie: string;

  beforeEach(async () => {
    await seedUser("owner@example.com", "owner");
    cookie = await login("owner@example.com");
  });

  it("creates, lists and disables a colleague", async () => {
    const created = await request(app)
      .post("/api/crew/users")
      .set("Cookie", cookie)
      .send({ email: "kollege@example.com", password: "correct horse staple", role: "operator" })
      .expect(201);

    const list = await request(app).get("/api/crew/users").set("Cookie", cookie).expect(200);
    expect(list.body.users.map((u: { email: string }) => u.email)).toContain("kollege@example.com");

    await request(app)
      .patch(`/api/crew/users/${created.body.user.id}`)
      .set("Cookie", cookie)
      .send({ status: "disabled" })
      .expect(200);
  });

  it("ends a disabled colleague's sessions immediately", async () => {
    await seedUser("kollege@example.com", "operator");
    const theirCookie = await login("kollege@example.com");
    const them = auth.users.byEmail("kollege@example.com")!;

    await request(app).get("/api/crew/company").set("Cookie", theirCookie).expect(200);
    await request(app)
      .patch(`/api/crew/users/${them.id}`)
      .set("Cookie", cookie)
      .send({ status: "disabled" })
      .expect(200);
    await request(app).get("/api/crew/company").set("Cookie", theirCookie).expect(401);
  });

  it("refuses to disable the last owner", async () => {
    const owner = auth.users.byEmail("owner@example.com")!;
    const res = await request(app)
      .patch(`/api/crew/users/${owner.id}`)
      .set("Cookie", cookie)
      .send({ status: "disabled" })
      .expect(409);
    expect(res.body.message).toContain("last active owner");
  });

  it("never returns a password hash, whatever the endpoint", async () => {
    const list = await request(app).get("/api/crew/users").set("Cookie", cookie).expect(200);
    expect(JSON.stringify(list.body)).not.toContain("scrypt:");
    expect(list.body.users[0]).not.toHaveProperty("passwordHash");
  });
});

describe("a person's own account", () => {
  it("changes the password only against the current one", async () => {
    await seedUser("robert@example.com", "owner");
    const cookie = await login("robert@example.com");

    await request(app)
      .post("/api/crew/auth/password")
      .set("Cookie", cookie)
      .send({ currentPassword: "falsch", newPassword: "ein neues langes passwort" })
      .expect(403);

    await request(app)
      .post("/api/crew/auth/password")
      .set("Cookie", cookie)
      .send({ currentPassword: "correct horse staple", newPassword: "ein neues langes passwort" })
      .expect(200);

    await request(app)
      .post("/api/crew/auth/login")
      .send({ email: "robert@example.com", password: "ein neues langes passwort" })
      .expect(200);
  });

  it("ends every other session when the password changes", async () => {
    await seedUser("robert@example.com", "owner");
    const firstDevice = await login("robert@example.com");
    const secondDevice = await login("robert@example.com");

    await request(app)
      .post("/api/crew/auth/password")
      .set("Cookie", secondDevice)
      .send({ currentPassword: "correct horse staple", newPassword: "ein neues langes passwort" })
      .expect(200);

    await request(app).get("/api/crew/company").set("Cookie", firstDevice).expect(401);
  });

  it("lists and revokes its own sessions, and knows which one is in use", async () => {
    await seedUser("robert@example.com", "owner");
    const cookie = await login("robert@example.com");
    await login("robert@example.com");

    const res = await request(app).get("/api/crew/auth/sessions").set("Cookie", cookie).expect(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("token_hash");

    const other = res.body.sessions.find((s: { current: boolean }) => !s.current);
    await request(app).delete(`/api/crew/auth/sessions/${other.id}`).set("Cookie", cookie).expect(200);
    expect((await request(app).get("/api/crew/auth/sessions").set("Cookie", cookie)).body.sessions).toHaveLength(1);
  });

  it("will not let someone revoke a session that is not theirs", async () => {
    await seedUser("owner@example.com", "owner");
    await seedUser("kollege@example.com", "operator");
    const ownerCookie = await login("owner@example.com");
    await login("kollege@example.com");

    const them = auth.users.byEmail("kollege@example.com")!;
    const theirSession = auth.sessions.listForUser(them.id)[0]!;
    // 404 rather than 403: "that session exists, but is not yours" is
    // information nobody needs.
    await request(app).delete(`/api/crew/auth/sessions/${theirSession.id}`).set("Cookie", ownerCookie).expect(404);
  });
});
