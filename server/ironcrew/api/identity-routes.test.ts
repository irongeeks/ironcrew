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
import { generateKeyPairSync, createSign } from "node:crypto";
import { OidcProvider } from "../auth/oidc-provider.ts";
import { OIDC_PENDING_COOKIE } from "./auth-routes.ts";

let db: DatabaseSync;
let app: Express;
let companyId: string;
let auth: CrewAuth;
let orchestrator: CompanyOrchestrator;

beforeEach(() => {
  db = createTestDb();
  app = express();
  app.use(express.json());
  orchestrator = new CompanyOrchestrator(db);
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

describe("four eyes over HTTP", () => {
  /** A parked transfer, plus the two owners who could sign it off. */
  async function transferApproval(cookie: string) {
    await request(app)
      .post("/api/crew/chat")
      .set("Cookie", cookie)
      .send({ body: "Bitte überweise 10.000 EUR an den Lieferanten." })
      .expect(201);
    const list = await request(app).get("/api/crew/approvals").set("Cookie", cookie).expect(200);
    return list.body.approvals[0];
  }

  let anna: string;
  let bob: string;

  beforeEach(async () => {
    await seedUser("anna@example.com", "owner");
    await seedUser("bob@example.com", "owner");
    anna = await login("anna@example.com");
    bob = await login("bob@example.com");
  });

  it("answers 200 and settles at the default quorum of one", async () => {
    const approval = await transferApproval(anna);
    expect(approval.tally).toMatchObject({ required: 1, approvals: 0 });

    const res = await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", anna)
      .send({ decision: "approved", reason: "geprüft" })
      .expect(200);
    expect(res.body.approval.status).toBe("approved");
    expect(res.body.tally).toMatchObject({ approvals: 1, required: 1, satisfied: true });
  });

  it("answers 202 for a vote that is not yet a decision", async () => {
    const approval = await transferApproval(anna);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/quorum`)
      .set("Cookie", anna)
      .send({ required: 2 })
      .expect(200);

    // 202, not 200: a UI that read this as success would tell the owner the
    // transfer is released while it is still waiting for a second human.
    const first = await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", anna)
      .send({ decision: "approved", reason: "sieht gut aus" })
      .expect(202);
    expect(first.body.approval.status).toBe("pending");
    expect(first.body.tally).toMatchObject({ approvals: 1, required: 2, outstanding: 1 });

    const second = await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", bob)
      .send({ decision: "approved", reason: "IBAN geprüft" })
      .expect(200);
    expect(second.body.approval.status).toBe("approved");
  });

  it("refuses the same person voting twice, with a sentence rather than a 500", async () => {
    const approval = await transferApproval(anna);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/quorum`)
      .set("Cookie", anna)
      .send({ required: 2 })
      .expect(200);

    await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", anna)
      .send({ decision: "approved" })
      .expect(202);
    const again = await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", anna)
      .send({ decision: "approved" })
      .expect(409);
    expect(again.body.error).toBe("invalid_approval_review");
    expect(again.body.message).toMatch(/bereits bewertet/);
  });

  it("names each reviewer in the audit chain by their own account", async () => {
    const approval = await transferApproval(anna);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/quorum`)
      .set("Cookie", anna)
      .send({ required: 2 })
      .expect(200);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", anna)
      .send({ decision: "approved" })
      .expect(202);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", bob)
      .send({ decision: "approved" })
      .expect(200);

    const reviewers = listAuditEvents(db, companyId, { limit: 300 })
      .filter((e) => String(e.action).startsWith("approval.review_"))
      .map((e) => String(e.actor_id));
    expect(reviewers).toHaveLength(2);
    expect(new Set(reviewers).size).toBe(2);
    // T-19: a real account id, never the pre-identity "ceo" constant.
    for (const id of reviewers) expect(id).toMatch(/^usr_/);
  });

  it("shows the second reviewer who has already looked, before they add their name", async () => {
    const approval = await transferApproval(anna);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/quorum`)
      .set("Cookie", anna)
      .send({ required: 2 })
      .expect(200);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", anna)
      .send({ decision: "approved", reason: "Betrag stimmt" })
      .expect(202);

    // Readable by the colleague, not only by whoever voted: who has already
    // looked is exactly what the second pair of eyes needs.
    const res = await request(app).get(`/api/crew/approvals/${approval.id}/reviews`).set("Cookie", bob).expect(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].reason).toBe("Betrag stimmt");
    expect(res.body.tally).toMatchObject({ approvals: 1, required: 2, outstanding: 1 });
  });

  it("lets a viewer read the reviews but never cast one", async () => {
    const approval = await transferApproval(anna);
    await seedUser("vera@example.com", "viewer");
    const vera = await login("vera@example.com");

    await request(app).get(`/api/crew/approvals/${approval.id}/reviews`).set("Cookie", vera).expect(200);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/decide`)
      .set("Cookie", vera)
      .send({ decision: "approved" })
      .expect(403);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/quorum`)
      .set("Cookie", vera)
      .send({ required: 2 })
      .expect(403);
  });

  it("refuses a quorum nobody could ever satisfy", async () => {
    const approval = await transferApproval(anna);
    await request(app)
      .post(`/api/crew/approvals/${approval.id}/quorum`)
      .set("Cookie", anna)
      .send({ required: 99 })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// Signing in through a directory
// ---------------------------------------------------------------------------

/**
 * These drive the real Express routes against a real `OidcProvider` with a
 * real RSA keypair and real JWS signatures. The provider's own tests cover
 * token verification in depth; what is tested here is the part only the route
 * layer can get wrong — the redirect out, the state of the pending login, the
 * session that comes back, and the four ways an attacker reaches the callback.
 */
describe("signing in through a directory", () => {
  const ISSUER = "https://idp.example.com";
  const CLIENT_ID = "ironcrew";
  const REDIRECT_URI = "https://crew.local/api/crew/auth/oidc/callback";

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const b64 = (value: unknown) =>
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

  function idToken(claims: Record<string, unknown>): string {
    const signed = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(claims)}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signed);
    return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
  }

  let issuedToken: string | null = null;

  const fetchImpl = (async (url: string | URL) => {
    const target = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (target.includes("openid-configuration")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (target.includes("/jwks")) return json({ keys: [jwk] });
    if (target.includes("/token")) return json({ id_token: issuedToken, token_type: "Bearer", access_token: "at" });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  let ssoApp: Express;
  let ssoAuth: CrewAuth;
  let provider: OidcProvider;

  beforeEach(() => {
    issuedToken = null;
    ssoApp = express();
    ssoApp.use(express.json());
    const orchestrator = new CompanyOrchestrator(db);
    orchestrator.registerRuntime(new MockRuntime({ responseText: "fertig" }));
    provider = new OidcProvider(
      { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "sekrit", redirectUri: REDIRECT_URI },
      { db, fetchImpl },
    );
    const api = registerIronCrewRoutes(ssoApp, { db, orchestrator, oidc: provider });
    ssoAuth = api.auth;
  });

  /** Starts a login and returns the pending handle plus the issuer's params. */
  async function startLogin() {
    const res = await request(ssoApp).get("/api/crew/auth/oidc/start").expect(302);
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${OIDC_PENDING_COOKIE}=`),
    )!;
    const url = new URL(res.headers.location as string);
    return { cookie: cookie.split(";")[0]!, params: url.searchParams, url };
  }

  function claims(params: URLSearchParams, over: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      sub: "subject-1",
      aud: CLIENT_ID,
      exp: now + 300,
      iat: now,
      nonce: params.get("nonce"),
      email: "anna@example.com",
      email_verified: true,
      ...over,
    };
  }

  it("tells the login page a directory exists, and names it", async () => {
    await seedUser("anna@example.com", "owner");
    const res = await request(ssoApp).get("/api/crew/auth/status").expect(200);
    expect(res.body.oidc).toEqual({ configured: true, issuer: ISSUER });
    // Never the client secret, and never the redirect URI's query.
    expect(JSON.stringify(res.body)).not.toContain("sekrit");
  });

  it("reports no directory when none is configured", async () => {
    const plain = express();
    plain.use(express.json());
    const orchestrator = new CompanyOrchestrator(db);
    orchestrator.registerRuntime(new MockRuntime({ responseText: "fertig" }));
    registerIronCrewRoutes(plain, { db, orchestrator });
    const res = await request(plain).get("/api/crew/auth/status").expect(200);
    expect(res.body.oidc).toEqual({ configured: false });
    // And the routes are simply not there to be called.
    await request(plain).get("/api/crew/auth/oidc/start").expect(404);
  });

  it("redirects to the issuer with PKCE, and keeps the verifier off the browser", async () => {
    const { cookie, params, url } = await startLogin();
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("state")).toBeTruthy();
    expect(params.get("nonce")).toBeTruthy();

    // The cookie is an opaque handle. Nothing in it can be swapped for
    // another issuer, and the verifier never leaves the server.
    const handle = cookie.split("=")[1]!;
    expect(handle).not.toContain(params.get("code_challenge")!);
    expect(handle).not.toContain(params.get("state")!);
    expect(handle).not.toContain(ISSUER);
  });

  it("carries the pending cookie SameSite=Lax, or the callback would never see it", async () => {
    // The callback arrives as a top-level navigation from the issuer's
    // origin. A Strict cookie is not sent on one, and the login would fail
    // with "no login in progress" every single time.
    const res = await request(ssoApp).get("/api/crew/auth/oidc/start").expect(302);
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${OIDC_PENDING_COOKIE}=`),
    )!;
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("HttpOnly");
  });

  it("signs in a linked subject and hands back a real crew session", async () => {
    const anna = await seedUser("anna@example.com", "owner");
    provider.identities.link({ userId: anna.id, issuer: ISSUER, subject: "subject-1" });

    const { cookie, params } = await startLogin();
    issuedToken = idToken(claims(params));

    const res = await request(ssoApp)
      .get(`/api/crew/auth/oidc/callback?code=abc&state=${params.get("state")}`)
      .set("Cookie", cookie)
      .expect(302);
    expect(res.headers.location).toBe("/");

    const session = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ironcrew_session="))!;
    // One kind of session in this system, whichever door you came through.
    const whoami = await request(ssoApp).get("/api/crew/auth/status").set("Cookie", session.split(";")[0]!).expect(200);
    expect(whoami.body.authenticated).toBe(true);
    expect(whoami.body.user.id).toBe(anna.id);
  });

  it("refuses a subject nobody linked, and says which one so an owner can", async () => {
    await seedUser("anna@example.com", "owner");
    const { cookie, params } = await startLogin();
    issuedToken = idToken(claims(params, { sub: "somebody-else" }));

    const res = await request(ssoApp)
      .get(`/api/crew/auth/oidc/callback?code=abc&state=${params.get("state")}`)
      .set("Cookie", cookie)
      .expect(302);
    // The code travels; the sentence naming the issuer and the subject stays
    // in the log, because a browser's history is not the place for it.
    expect(res.headers.location).toBe("/?oidc_error=subject_not_linked");
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("ironcrew_session=s");
  });

  it("cannot be replayed: the pending login is consumed by the first callback", async () => {
    const anna = await seedUser("anna@example.com", "owner");
    provider.identities.link({ userId: anna.id, issuer: ISSUER, subject: "subject-1" });

    const { cookie, params } = await startLogin();
    issuedToken = idToken(claims(params));
    await request(ssoApp)
      .get(`/api/crew/auth/oidc/callback?code=abc&state=${params.get("state")}`)
      .set("Cookie", cookie)
      .expect(302);

    // Same cookie, same state, same token: a stolen callback URL replayed
    // from another browser.
    const again = await request(ssoApp)
      .get(`/api/crew/auth/oidc/callback?code=abc&state=${params.get("state")}`)
      .set("Cookie", cookie)
      .expect(302);
    expect(again.headers.location).toBe("/?oidc_error=no_login_in_progress");
  });

  it("refuses a callback with no pending login at all", async () => {
    const res = await request(ssoApp).get("/api/crew/auth/oidc/callback?code=abc&state=whatever").expect(302);
    expect(res.headers.location).toBe("/?oidc_error=no_login_in_progress");
  });

  it("passes the issuer's own refusal on as a code, never its text", async () => {
    const { cookie } = await startLogin();
    const res = await request(ssoApp)
      .get("/api/crew/auth/oidc/callback?error=access_denied&error_description=" + encodeURIComponent("<script>x"))
      .set("Cookie", cookie)
      .expect(302);
    expect(res.headers.location).toBe("/?oidc_error=provider_refused");
    expect(res.headers.location).not.toContain("script");
  });

  it("refuses to redirect anywhere but this origin after login", async () => {
    const anna = await seedUser("anna@example.com", "owner");
    provider.identities.link({ userId: anna.id, issuer: ISSUER, subject: "subject-1" });

    // A protocol-relative URL is how an open redirect sneaks past a naive
    // startsWith("/"), and an open redirect on a login callback is the
    // classic way to make a phishing link look like it came from here.
    for (const evil of ["//evil.example/pwn", "https://evil.example", "/\\evil.example"]) {
      const res = await request(ssoApp)
        .get(`/api/crew/auth/oidc/start?redirectTo=${encodeURIComponent(evil)}`)
        .expect(302);
      const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
        c.startsWith(`${OIDC_PENDING_COOKIE}=`),
      )!;
      const params = new URL(res.headers.location as string).searchParams;
      issuedToken = idToken(claims(params));

      const done = await request(ssoApp)
        .get(`/api/crew/auth/oidc/callback?code=abc&state=${params.get("state")}`)
        .set("Cookie", cookie.split(";")[0]!)
        .expect(302);
      expect(done.headers.location).toBe("/");
    }
  });

  it("keeps a same-origin redirect, which is the point of the parameter", async () => {
    const anna = await seedUser("anna@example.com", "owner");
    provider.identities.link({ userId: anna.id, issuer: ISSUER, subject: "subject-1" });

    const res = await request(ssoApp).get("/api/crew/auth/oidc/start?redirectTo=/projekte").expect(302);
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${OIDC_PENDING_COOKIE}=`),
    )!;
    const params = new URL(res.headers.location as string).searchParams;
    issuedToken = idToken(claims(params));

    const done = await request(ssoApp)
      .get(`/api/crew/auth/oidc/callback?code=abc&state=${params.get("state")}`)
      .set("Cookie", cookie.split(";")[0]!)
      .expect(302);
    expect(done.headers.location).toBe("/projekte");
  });

  it("does not let a disabled account back in through the directory", async () => {
    const anna = await seedUser("anna@example.com", "owner");
    await seedUser("bob@example.com", "owner"); // so the last-owner rule allows it
    provider.identities.link({ userId: anna.id, issuer: ISSUER, subject: "subject-1" });
    ssoAuth.users.update(anna.id, { status: "disabled" });

    const { cookie, params } = await startLogin();
    issuedToken = idToken(claims(params));
    const res = await request(ssoApp)
      .get(`/api/crew/auth/oidc/callback?code=abc&state=${params.get("state")}`)
      .set("Cookie", cookie)
      .expect(302);
    // The local account decides whether it may be used, not the directory.
    expect(res.headers.location).toBe("/?oidc_error=account_unavailable");
  });
});

describe("guards the security review checked", () => {
  it("does not let an operator re-enable a tool an owner disabled", async () => {
    await seedUser("anna@example.com", "owner");
    await seedUser("olli@example.com", "operator");
    const owner = await login("anna@example.com");
    const operator = await login("olli@example.com");

    // Tools are registered by the composition root and by pack installs, not
    // over HTTP, so this is how one comes into existence.
    const toolId = orchestrator.tools.register({
      companyId,
      key: "custom.read",
      label: "Etwas lesen",
      riskClass: "read",
    }).id;

    // Disabling is how an owner takes a capability away — pack uninstall does
    // exactly this and deliberately keeps the grants, so re-enabling restores
    // every surviving grant at a stroke. An operator flipping it back would
    // undo an owner's decision without ever touching a grant.
    await request(app)
      .post(`/api/crew/tools/${toolId}/enabled`)
      .set("Cookie", owner)
      .send({ enabled: false })
      .expect(200);
    await request(app)
      .post(`/api/crew/tools/${toolId}/enabled`)
      .set("Cookie", operator)
      .send({ enabled: true })
      .expect(403);
    await request(app)
      .post(`/api/crew/tools/${toolId}/enabled`)
      .set("Cookie", owner)
      .send({ enabled: true })
      .expect(200);
  });

  it("refuses to lower a quorum over HTTP, and to change it once anybody voted", async () => {
    await seedUser("anna@example.com", "owner");
    const anna = await login("anna@example.com");
    await request(app)
      .post("/api/crew/chat")
      .set("Cookie", anna)
      .send({ body: "Bitte überweise 10.000 EUR an den Lieferanten." })
      .expect(201);
    const list = await request(app).get("/api/crew/approvals").set("Cookie", anna).expect(200);
    const id = list.body.approvals[0].id;

    await request(app).post(`/api/crew/approvals/${id}/quorum`).set("Cookie", anna).send({ required: 2 }).expect(200);
    // One extra request would otherwise undo T-21's whole mitigation.
    const lowered = await request(app)
      .post(`/api/crew/approvals/${id}/quorum`)
      .set("Cookie", anna)
      .send({ required: 1 })
      .expect(409);
    expect(lowered.body.error).toBe("invalid_approval_review");
    expect((await request(app).get(`/api/crew/approvals/${id}/reviews`).set("Cookie", anna)).body.tally.required).toBe(
      2,
    );

    await request(app)
      .post(`/api/crew/approvals/${id}/decide`)
      .set("Cookie", anna)
      .send({ decision: "approved" })
      .expect(202);
    await request(app).post(`/api/crew/approvals/${id}/quorum`).set("Cookie", anna).send({ required: 3 }).expect(409);
  });
});
