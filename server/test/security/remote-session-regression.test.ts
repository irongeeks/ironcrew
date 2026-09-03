import express from "express";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../../config/runtime.ts";
import { installSecurityMiddleware } from "../../security/auth.ts";
import {
  hashPassword,
  createRemoteSession,
  validateRemoteSession,
  invalidateAllRemoteSessions,
  getPasswordHash,
  type PasswordDb,
} from "../../security/password.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): PasswordDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return raw as unknown as PasswordDb;
}

/**
 * Build a mini Express app with security middleware and a protected test route.
 * When `simulateRemote` is true, a middleware prepended before security
 * overrides `req.socket.remoteAddress` to a non-loopback IP so the auth
 * middleware treats every request as coming from a remote client.
 */
function buildTestApp(db: DatabaseSync, simulateRemote: boolean) {
  const app = express();
  if (simulateRemote) {
    app.use((req, _res, next) => {
      // Socket.remoteAddress is a getter-only property, so we must redefine it.
      Object.defineProperty(req.socket, "remoteAddress", {
        value: "10.0.0.5",
        writable: true,
        configurable: true,
      });
      next();
    });
  }
  installSecurityMiddleware(app, db);
  app.get("/api/core/test", (_req, res) => res.json({ ok: true }));
  // Catch-all error handler so supertest surfaces real errors instead of bare 500

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

// ---------------------------------------------------------------------------
// 1. Remote session cookie is NOT upgraded to master session token
// ---------------------------------------------------------------------------

describe("remote session cookie is not upgraded to master session token (integration)", () => {
  it("remote session cookie is preserved after authenticated API request", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    // Set a password so remote login is possible
    const hash = await hashPassword("testpass");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, /* simulateRemote */ true);

    // Remote user cannot access /api/auth/session without a valid session
    await request(app).get("/api/auth/session").expect(401);

    // Login to get a remote session cookie
    const loginRes = await request(app).post("/api/auth/login").send({ password: "testpass" }).expect(200);

    const setCookieHeader = loginRes.headers["set-cookie"]?.[0] ?? "";
    expect(setCookieHeader).toContain(SESSION_COOKIE_NAME);

    // Extract the session token from the login cookie
    const cookieMatch = setCookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    expect(cookieMatch).not.toBeNull();
    const sessionToken = decodeURIComponent(cookieMatch![1]);

    // Make an authenticated request to a protected endpoint with the remote session cookie
    const protectedRes = await request(app)
      .get("/api/core/test")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`)
      .expect(200);

    expect(protectedRes.body).toEqual({ ok: true });

    // KEY ASSERTION: the response should NOT set a new cookie that replaces
    // the remote session token with the master token. Before the fix, the
    // middleware unconditionally called issueSessionCookie(), which overwrote
    // the remote session cookie with SESSION_AUTH_TOKEN.
    const responseCookies = protectedRes.headers["set-cookie"] ?? [];
    const cookieArray: string[] = Array.isArray(responseCookies) ? responseCookies : [responseCookies];
    const sessionCookie = cookieArray.find((c: string) => c.includes(SESSION_COOKIE_NAME));

    if (sessionCookie) {
      // If the middleware emitted a Set-Cookie, it must NOT contain a different token
      const newMatch = sessionCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
      if (newMatch) {
        const newToken = decodeURIComponent(newMatch[1]);
        expect(newToken).toBe(sessionToken);
      }
    }
    // If no Set-Cookie at all, that's the expected (correct) behavior.
  });

  it("/api/auth/status reports remote + unauthenticated for a remote client with no cookie", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hash = await hashPassword("pw");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, true);

    const res = await request(app).get("/api/auth/status").expect(200);
    expect(res.body.passwordConfigured).toBe(true);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.isRemote).toBe(true);
  });

  it("remote client with invalid cookie gets 401 on protected endpoint", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hash = await hashPassword("pw");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, true);

    await request(app).get("/api/core/test").set("Cookie", `${SESSION_COOKIE_NAME}=bogus-token-value`).expect(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Password change invalidates all remote sessions
// ---------------------------------------------------------------------------

describe("password change invalidates all remote sessions", () => {
  it("changing password followed by invalidateAllRemoteSessions kills all sessions", async () => {
    const db = createTestDb();

    // Set initial password
    const initialHash = await hashPassword("oldpass");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", initialHash);

    // Create two remote sessions
    const token1 = createRemoteSession(db, "10.0.0.1", "browser1");
    const token2 = createRemoteSession(db, "10.0.0.2", "browser2");
    expect(validateRemoteSession(db, token1)).toBe(true);
    expect(validateRemoteSession(db, token2)).toBe(true);

    // Simulate what PUT /api/auth/password now does: update hash + invalidate sessions
    const newHash = await hashPassword("newpass");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", newHash);
    invalidateAllRemoteSessions(db);

    // Both sessions should now be invalid
    expect(validateRemoteSession(db, token1)).toBe(false);
    expect(validateRemoteSession(db, token2)).toBe(false);

    // Password hash should still be present
    expect(getPasswordHash(db)).not.toBeNull();
  });

  it("removing password also invalidates all sessions", async () => {
    const db = createTestDb();
    const hash = await hashPassword("mypass");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const token = createRemoteSession(db, "10.0.0.1", "test-ua");
    expect(validateRemoteSession(db, token)).toBe(true);

    // Simulate what DELETE /api/auth/password does
    db.prepare("DELETE FROM settings WHERE key = 'access_password_hash'").run();
    invalidateAllRemoteSessions(db);

    expect(validateRemoteSession(db, token)).toBe(false);
    expect(getPasswordHash(db)).toBeNull();
  });

  it("non-session settings survive invalidateAllRemoteSessions", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", "scrypt:a:b");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("theme", "dark");

    createRemoteSession(db, "10.0.0.1", "ua");
    invalidateAllRemoteSessions(db);

    // Password hash and other settings remain
    const hash = db.prepare("SELECT value FROM settings WHERE key = ?").get("access_password_hash") as {
      value: string;
    };
    expect(hash.value).toBe("scrypt:a:b");
    const theme = db.prepare("SELECT value FROM settings WHERE key = ?").get("theme") as { value: string };
    expect(theme.value).toBe("dark");
  });

  it("password change via API invalidates existing remote sessions (integration)", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hash = await hashPassword("original");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, true);

    // Login and get session
    const loginRes = await request(app).post("/api/auth/login").send({ password: "original" }).expect(200);
    const loginCookie = loginRes.headers["set-cookie"]?.[0] ?? "";
    const cookieMatch = loginCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    const sessionToken = cookieMatch![1];

    // Verify session works
    await request(app).get("/api/core/test").set("Cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`).expect(200);

    // Change password via the API (need to be authenticated for this)
    await request(app)
      .put("/api/auth/password")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`)
      .send({ current_password: "original", new_password: "changed123abc" })
      .expect(200);

    // The old session should now be invalid
    await request(app).get("/api/core/test").set("Cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`).expect(401);
  });
});

// ---------------------------------------------------------------------------
// 3. Unauthenticated remote user does not trigger app bootstrap
// ---------------------------------------------------------------------------

describe("unauthenticated remote user gets 401 on bootstrap endpoints (integration)", () => {
  it("/api/auth/session returns 401 for unauthenticated remote user", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hash = await hashPassword("pw");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, true);

    // /api/auth/session is the bootstrap endpoint the frontend calls.
    // For a remote user with no cookie, it must return 401.
    // This is what prevents AppAuthenticated from mounting.
    const res = await request(app).get("/api/auth/session").expect(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("/api/auth/status shows authenticated:false for remote user with no credentials", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hash = await hashPassword("pw");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, true);

    const res = await request(app).get("/api/auth/status").expect(200);
    expect(res.body).toEqual({
      passwordConfigured: true,
      authenticated: false,
      isRemote: true,
    });
  });

  it("protected endpoints return 401 for unauthenticated remote user", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hash = await hashPassword("pw");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, true);

    await request(app).get("/api/core/test").expect(401);
  });

  it("after login, /api/auth/session returns 200 for remote user with valid cookie", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hash = await hashPassword("pw");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);

    const app = buildTestApp(db, true);

    // Login
    const loginRes = await request(app).post("/api/auth/login").send({ password: "pw" }).expect(200);
    const loginCookie = loginRes.headers["set-cookie"]?.[0] ?? "";
    const cookieMatch = loginCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    const sessionToken = cookieMatch![1];

    // Now /api/auth/session should succeed (this is what triggers app bootstrap)
    const sessionRes = await request(app)
      .get("/api/auth/session")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`)
      .expect(200);

    expect(sessionRes.body.ok).toBe(true);
    expect(typeof sessionRes.body.csrf_token).toBe("string");
  });
});
