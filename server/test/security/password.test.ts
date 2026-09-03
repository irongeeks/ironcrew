import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  hashPassword,
  verifyPassword,
  createRemoteSession,
  validateRemoteSession,
  invalidateRemoteSession,
  invalidateAllRemoteSessions,
  isPasswordConfigured,
  getPasswordHash,
  type PasswordDb,
} from "../../security/password.ts";

function createTestDb(): PasswordDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return raw as unknown as PasswordDb;
}

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------

describe("hashPassword", () => {
  it("returns a scrypt-prefixed string with three colon-separated parts", async () => {
    const hash = await hashPassword("my-secret");
    const parts = hash.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("scrypt");
    // base64 salt and hash should be non-empty
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("produces different salts on successive calls", async () => {
    const h1 = await hashPassword("same");
    const h2 = await hashPassword("same");
    expect(h1).not.toBe(h2);
    // Both should still verify
    expect(await verifyPassword("same", h1)).toBe(true);
    expect(await verifyPassword("same", h2)).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("returns true for the correct password", async () => {
    const hash = await hashPassword("correct-horse");
    expect(await verifyPassword("correct-horse", hash)).toBe(true);
  });

  it("returns false for the wrong password", async () => {
    const hash = await hashPassword("correct-horse");
    expect(await verifyPassword("wrong-horse", hash)).toBe(false);
  });

  it("returns false for a malformed stored hash (missing parts)", async () => {
    expect(await verifyPassword("anything", "scrypt:onlyonepart")).toBe(false);
  });

  it("returns false for a completely invalid stored string", async () => {
    expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });

  it("returns false when prefix is not scrypt", async () => {
    const hash = await hashPassword("pw");
    const tampered = hash.replace("scrypt", "bcrypt");
    expect(await verifyPassword("pw", tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Remote session management
// ---------------------------------------------------------------------------

describe("createRemoteSession", () => {
  it("returns a 64-character hex token", () => {
    const db = createTestDb();
    const token = createRemoteSession(db, "1.2.3.4", "TestAgent/1.0");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists session data in the settings table", () => {
    const db = createTestDb();
    const token = createRemoteSession(db, "10.0.0.1", "curl/7");
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`remote_session:${token}`) as {
      value: string;
    };
    const data = JSON.parse(row.value);
    expect(data.ip).toBe("10.0.0.1");
    expect(data.user_agent).toBe("curl/7");
    expect(data.created_at).toBeTruthy();
  });
});

describe("validateRemoteSession", () => {
  it("returns true for a valid, non-expired session", () => {
    const db = createTestDb();
    const token = createRemoteSession(db, "1.2.3.4", "UA");
    expect(validateRemoteSession(db, token)).toBe(true);
  });

  it("returns false for a non-existent token", () => {
    const db = createTestDb();
    expect(validateRemoteSession(db, "deadbeef".repeat(8))).toBe(false);
  });

  it("returns false for an expired session", () => {
    const db = createTestDb();
    const token = createRemoteSession(db, "1.2.3.4", "UA");
    // Manually backdate the session beyond 7 days
    const expired = JSON.stringify({
      created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      ip: "1.2.3.4",
      user_agent: "UA",
    });
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(expired, `remote_session:${token}`);
    expect(validateRemoteSession(db, token)).toBe(false);
  });
});

describe("invalidateRemoteSession", () => {
  it("removes a single session", () => {
    const db = createTestDb();
    const t1 = createRemoteSession(db, "1.1.1.1", "A");
    const t2 = createRemoteSession(db, "2.2.2.2", "B");
    invalidateRemoteSession(db, t1);
    expect(validateRemoteSession(db, t1)).toBe(false);
    expect(validateRemoteSession(db, t2)).toBe(true);
  });
});

describe("invalidateAllRemoteSessions", () => {
  it("removes all sessions", () => {
    const db = createTestDb();
    const t1 = createRemoteSession(db, "1.1.1.1", "A");
    const t2 = createRemoteSession(db, "2.2.2.2", "B");
    invalidateAllRemoteSessions(db);
    expect(validateRemoteSession(db, t1)).toBe(false);
    expect(validateRemoteSession(db, t2)).toBe(false);
  });

  it("does not remove non-session settings", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("other_key", "keep-me");
    createRemoteSession(db, "1.1.1.1", "A");
    invalidateAllRemoteSessions(db);
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("other_key") as { value: string };
    expect(row.value).toBe("keep-me");
  });
});

// ---------------------------------------------------------------------------
// Password configuration helpers
// ---------------------------------------------------------------------------

describe("isPasswordConfigured", () => {
  it("returns false when no password hash is stored", () => {
    const db = createTestDb();
    expect(isPasswordConfigured(db)).toBe(false);
  });

  it("returns true when a password hash exists", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", "scrypt:abc:def");
    expect(isPasswordConfigured(db)).toBe(true);
  });

  it("returns false when the stored value is empty", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", "");
    expect(isPasswordConfigured(db)).toBe(false);
  });
});

describe("getPasswordHash", () => {
  it("returns null when no hash is stored", () => {
    const db = createTestDb();
    expect(getPasswordHash(db)).toBeNull();
  });

  it("returns the stored hash string", () => {
    const db = createTestDb();
    const hash = "scrypt:c2FsdA==:aGFzaA==";
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);
    expect(getPasswordHash(db)).toBe(hash);
  });
});
