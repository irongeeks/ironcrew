import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// The soft-binding warning is part of the contract ("recorded, never fatal"),
// so the logger is replaced with a spy rather than left to write to stdout.
// `importOriginal` keeps every other export intact — the migrations that
// createTestDb() runs log through this same module.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("../../observability/logger.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../observability/logger.ts")>();
  const child: Record<string, unknown> = {
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  child.child = () => child;
  return { ...actual, logger: child };
});

const { createTestDb, seedCompany } = await import("../domain/test-db.ts");
const { SessionStore, SESSION_TTL_MS } = await import("./session-store.ts");
const { UserMutationError, UserStore } = await import("./user-store.ts");

type Sessions = InstanceType<typeof SessionStore>;
type Users = InstanceType<typeof UserStore>;

let db: DatabaseSync;
let companyId: string;
let users: Users;
let sessions: Sessions;
let ownerId: string;

const PASSWORD = "correct horse battery staple";
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  warnSpy.mockClear();
  db = createTestDb();
  companyId = seedCompany(db);
  users = new UserStore(db);
  sessions = new SessionStore(db);
  ownerId = (await users.create({ email: "owner@example.com", password: PASSWORD }, { companyId })).id;
});

afterEach(() => db.close());

function sessionTableDump(): string {
  return JSON.stringify(db.prepare("SELECT * FROM crew_sessions").all());
}

describe("SessionStore", () => {
  describe("the token is handed out once and never stored", () => {
    it("stores only the SHA-256 of the token", () => {
      const { token, session } = sessions.create(ownerId, { now: NOW });

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(session.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(session.token_hash).not.toBe(token);
    });

    it("leaves the raw token nowhere in the table", () => {
      const { token } = sessions.create(ownerId, { now: NOW });
      expect(sessionTableDump()).not.toContain(token);
      // Not even a prefix long enough to be worth grepping a backup for.
      expect(sessionTableDump()).not.toContain(token.slice(0, 16));
    });

    it("issues a different token every time", () => {
      const first = sessions.create(ownerId, { now: NOW });
      const second = sessions.create(ownerId, { now: NOW });
      expect(first.token).not.toBe(second.token);
      expect(first.session.id).not.toBe(second.session.id);
    });

    it("refuses to open a session for a user that does not exist", () => {
      expect(() => sessions.create("usr_missing")).toThrow(UserMutationError);
    });

    it("defaults to a seven-day lifetime", () => {
      const { session } = sessions.create(ownerId, { now: NOW });
      expect(session.expires_at).toBe(NOW + SESSION_TTL_MS);
      expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60_000);
    });
  });

  describe("resolve", () => {
    it("resolves a raw token to its session and user", () => {
      const { token, session } = sessions.create(ownerId, { now: NOW });
      const resolved = sessions.resolve(token, { now: NOW + 1000 });

      expect(resolved?.session.id).toBe(session.id);
      expect(resolved?.user.id).toBe(ownerId);
      expect(resolved?.user.email).toBe("owner@example.com");
      // The user half is the same password_hash-free shape as everywhere else.
      expect(Object.keys(resolved!.user)).not.toContain("password_hash");
    });

    it("returns null for an unknown token", () => {
      sessions.create(ownerId, { now: NOW });
      expect(sessions.resolve("f".repeat(64), { now: NOW })).toBeNull();
      expect(sessions.resolve("", { now: NOW })).toBeNull();
    });

    it("returns null once the session has expired", () => {
      const { token } = sessions.create(ownerId, { now: NOW, ttlMs: 60_000 });
      expect(sessions.resolve(token, { now: NOW + 59_000 })).not.toBeNull();
      expect(sessions.resolve(token, { now: NOW + 60_000 })).toBeNull();
      expect(sessions.resolve(token, { now: NOW + 3_600_000 })).toBeNull();
    });

    it("cuts a disabled user off immediately, without waiting for the TTL", async () => {
      // A second owner, so the first may be disabled at all.
      await users.create({ email: "spare@example.com", password: PASSWORD, role: "owner" }, { companyId });
      const { token } = sessions.create(ownerId, { now: NOW });
      expect(sessions.resolve(token, { now: NOW + 1000 })).not.toBeNull();

      users.update(ownerId, { status: "disabled" }, { companyId });

      // Unexpired by a long way, and still refused.
      expect(sessions.resolve(token, { now: NOW + 1000 })).toBeNull();
      expect(sessions.resolve(token, { now: NOW + SESSION_TTL_MS - 1 })).toBeNull();
    });

    it("works again when the account is re-enabled", async () => {
      await users.create({ email: "spare@example.com", password: PASSWORD, role: "owner" }, { companyId });
      const { token } = sessions.create(ownerId, { now: NOW });
      users.update(ownerId, { status: "disabled" }, { companyId });
      users.update(ownerId, { status: "active" }, { companyId });
      expect(sessions.resolve(token, { now: NOW + 1000 })).not.toBeNull();
    });

    it("refreshes last_seen_at", () => {
      const { token, session } = sessions.create(ownerId, { now: NOW });
      expect(session.last_seen_at).toBeNull();

      const first = sessions.resolve(token, { now: NOW + 1000 })!;
      expect(first.session.last_seen_at).toBe(NOW + 1000);
      expect(sessions.getById(session.id)?.last_seen_at).toBe(NOW + 1000);

      sessions.resolve(token, { now: NOW + 2000 });
      expect(sessions.getById(session.id)?.last_seen_at).toBe(NOW + 2000);
    });

    it("does not touch last_seen_at when the token does not resolve", () => {
      const { token, session } = sessions.create(ownerId, { now: NOW, ttlMs: 60_000 });
      sessions.resolve(token, { now: NOW + 120_000 });
      expect(sessions.getById(session.id)?.last_seen_at).toBeNull();
    });
  });

  describe("soft binding: drift is recorded, never fatal", () => {
    it("still resolves when the IP and user-agent have changed", () => {
      const { token } = sessions.create(ownerId, { now: NOW, ip: "10.0.0.1", userAgent: "Firefox/1" });

      const resolved = sessions.resolve(token, { now: NOW + 1000, ip: "192.168.5.9", userAgent: "Firefox/2" });
      expect(resolved?.user.id).toBe(ownerId);
    });

    it("logs the drift for incident response", () => {
      const { token } = sessions.create(ownerId, { now: NOW, ip: "10.0.0.1", userAgent: "Firefox/1" });
      sessions.resolve(token, { now: NOW + 1000, ip: "192.168.5.9", userAgent: "Firefox/2" });

      expect(warnSpy).toHaveBeenCalledTimes(2);
      const messages = warnSpy.mock.calls.map((call) => String(call[1]));
      expect(messages).toContain("session IP changed");
      expect(messages).toContain("session user-agent changed");
      // The log line names the session, never the credential that reaches it.
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(createHash("sha256").update(token).digest("hex"));
    });

    it("keeps the values captured at login, so the baseline survives", () => {
      const { token, session } = sessions.create(ownerId, { now: NOW, ip: "10.0.0.1", userAgent: "Firefox/1" });
      sessions.resolve(token, { now: NOW + 1000, ip: "192.168.5.9", userAgent: "Firefox/2" });

      const stored = sessions.getById(session.id)!;
      expect(stored.ip).toBe("10.0.0.1");
      expect(stored.user_agent).toBe("Firefox/1");
    });

    it("says nothing when nothing drifted", () => {
      const { token } = sessions.create(ownerId, { now: NOW, ip: "10.0.0.1", userAgent: "Firefox/1" });
      sessions.resolve(token, { now: NOW + 1000, ip: "10.0.0.1", userAgent: "Firefox/1" });
      sessions.resolve(token, { now: NOW + 2000 });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("revocation", () => {
    it("lists a user's sessions newest first", () => {
      const first = sessions.create(ownerId, { now: NOW });
      const second = sessions.create(ownerId, { now: NOW + 1000 });
      expect(sessions.listForUser(ownerId).map((s) => s.id)).toEqual([second.session.id, first.session.id]);
    });

    it("revokes by token", () => {
      const { token } = sessions.create(ownerId, { now: NOW });
      expect(sessions.revoke(token)).toBe(true);
      expect(sessions.resolve(token, { now: NOW + 1000 })).toBeNull();
      expect(sessions.revoke(token)).toBe(false);
    });

    it("revokes by id, which is all the Command Center ever sees", () => {
      const { token, session } = sessions.create(ownerId, { now: NOW });
      expect(sessions.revokeById(session.id)).toBe(true);
      expect(sessions.resolve(token, { now: NOW + 1000 })).toBeNull();
      expect(sessions.revokeById(session.id)).toBe(false);
    });

    it("logs an account out everywhere", async () => {
      const other = await users.create({ email: "spare@example.com", password: PASSWORD }, { companyId });
      sessions.create(ownerId, { now: NOW });
      sessions.create(ownerId, { now: NOW });
      const kept = sessions.create(other.id, { now: NOW });

      expect(sessions.revokeAllForUser(ownerId)).toBe(2);
      expect(sessions.listForUser(ownerId)).toEqual([]);
      expect(sessions.resolve(kept.token, { now: NOW + 1000 })).not.toBeNull();
      expect(sessions.revokeAllForUser(ownerId)).toBe(0);
    });

    it("sweeps expired sessions and leaves live ones alone", () => {
      const stale = sessions.create(ownerId, { now: NOW, ttlMs: 60_000 });
      const live = sessions.create(ownerId, { now: NOW, ttlMs: 3_600_000 });

      expect(sessions.sweepExpired(NOW + 120_000)).toBe(1);
      expect(sessions.getById(stale.session.id)).toBeNull();
      expect(sessions.getById(live.session.id)).not.toBeNull();
      expect(sessions.sweepExpired(NOW + 120_000)).toBe(0);
    });

    it("cascades sessions away when the user is deleted", async () => {
      await users.create({ email: "spare@example.com", password: PASSWORD, role: "owner" }, { companyId });
      const { token } = sessions.create(ownerId, { now: NOW });

      users.delete(ownerId, { companyId });

      expect(sessions.listForUser(ownerId)).toEqual([]);
      expect(sessions.resolve(token, { now: NOW + 1000 })).toBeNull();
      expect((db.prepare("SELECT COUNT(*) AS n FROM crew_sessions").get() as { n: number }).n).toBe(0);
    });
  });
});
