/**
 * IronCrew — login sessions.
 *
 * Migration 0017 explains why sessions left the `settings` key-value table: a
 * session keyed by its own token cannot be listed per user, revoked per user,
 * or indexed by expiry, and all three are what an operator needs on the day
 * something goes wrong.
 *
 * WHAT IS STORED IS NOT WHAT IS SENT
 *
 * `create` returns the raw token exactly once. Only its SHA-256 is written,
 * so a stolen database file yields no usable session — the same reason the
 * password column holds a hash rather than a password. There is deliberately
 * no way to read a token back out: if it is lost, the session is gone and a
 * new login is the recovery path.
 *
 * SHA-256 and not scrypt, on purpose. A session token is 32 bytes of
 * `randomBytes`, so there is no low-entropy guess for an attacker to grind
 * through and nothing for a slow KDF to buy; what it would cost instead is
 * ~50 ms on *every authenticated request*, which is a real price for no gain.
 * A password is a human's guessable secret and does need the slow hash.
 *
 * REVOCATION MUST NOT WAIT FOR THE TTL
 *
 * `resolve` re-reads the account on every request rather than trusting what
 * was true at login, so disabling a user cuts their existing sessions off
 * immediately. A seven-day TTL on an account someone was just locked out of
 * would be seven days of access nobody intended to grant.
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { allRows, oneRow } from "../domain/sql.ts";
import { UserMutationError, UserStore, type UserRow } from "./user-store.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-sessions" });

/** Seven days, matching the legacy remote-session TTL in security/password.ts. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

/** 32 bytes of CSPRNG output — 256 bits, far past guessing. */
const TOKEN_BYTES = 32;

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  ip: string;
  user_agent: string;
  expires_at: number;
  created_at: number;
  last_seen_at: number | null;
}

const SESSION_COLUMNS = `id, token_hash, user_id, ip, user_agent, expires_at, created_at, last_seen_at`;

export interface CreateSessionOpts {
  ip?: string;
  userAgent?: string;
  ttlMs?: number;
  now?: number;
}

export interface ResolveSessionOpts {
  now?: number;
  ip?: string;
  userAgent?: string;
}

/** Hex SHA-256 — the only form of a token that ever touches disk. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class SessionStore {
  private readonly users: UserStore;

  constructor(private readonly db: DatabaseSync) {
    // Reuse UserStore rather than re-listing the user columns here, so the
    // `password_hash`-free row shape has exactly one definition.
    this.users = new UserStore(db);
  }

  /**
   * Opens a session and returns the raw token exactly once — it is never
   * recoverable afterwards, because only its hash is stored.
   */
  create(userId: string, opts: CreateSessionOpts = {}): { token: string; session: SessionRow } {
    // Checked rather than left to the foreign key, so a bad user id is a
    // domain error the API can answer 400 to instead of a raw SQLite crash.
    if (!this.users.get(userId)) {
      throw new UserMutationError(`User "${userId}" does not exist.`);
    }

    const now = opts.now ?? Date.now();
    const ttl = opts.ttlMs ?? SESSION_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new UserMutationError("A session needs a positive lifetime.");
    }

    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const id = newId("sess");
    this.db
      .prepare(
        `INSERT INTO crew_sessions (id, token_hash, user_id, ip, user_agent, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, hashToken(token), userId, opts.ip ?? "", opts.userAgent ?? "", now + ttl, now);

    return { token, session: this.getById(id)! };
  }

  /**
   * Resolves a raw token to its session and user, or null when the token is
   * unknown, the session has expired, or the account behind it is gone or
   * disabled.
   *
   * All four answer null identically: a caller learns "not authenticated" and
   * nothing else about which of the four it was.
   */
  resolve(token: string, opts: ResolveSessionOpts = {}): { session: SessionRow; user: UserRow } | null {
    const now = opts.now ?? Date.now();
    const session = oneRow<SessionRow>(
      this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM crew_sessions WHERE token_hash = ?`),
      hashToken(token),
    );
    if (!session) return null;

    // Expired rows are left in place for `sweepExpired` rather than deleted
    // here: `resolve` runs on every request and should not take a write lock
    // to tidy up.
    if (session.expires_at <= now) return null;

    const user = this.users.get(session.user_id);
    if (!user || user.status !== "active") return null;

    this.noteDrift(session, opts);

    this.db.prepare("UPDATE crew_sessions SET last_seen_at = ? WHERE id = ?").run(now, session.id);
    return { session: { ...session, last_seen_at: now }, user };
  }

  /**
   * Soft binding, mirroring the reasoning already written for
   * `validateRemoteSession` in server/security/password.ts: drift in IP or
   * user-agent is logged for incident response and never fails the request.
   * Mobile clients roam across cell, wifi and VPN, and browser user-agents
   * rotate on every minor update; hard-binding would force constant re-logins
   * without meaningfully raising the bar for an attacker who already holds
   * the cookie.
   *
   * The stored values stay as captured at login. Overwriting them with each
   * request would erase the baseline and with it the ability to notice the
   * drift at all.
   */
  private noteDrift(session: SessionRow, opts: ResolveSessionOpts): void {
    // The session id, never the token or its hash — a log line that carries
    // either hands a reader a live credential.
    if (opts.ip && session.ip && opts.ip !== session.ip) {
      log.warn({ sessionId: session.id, oldIp: session.ip, newIp: opts.ip }, "session IP changed");
    }
    if (opts.userAgent && session.user_agent && opts.userAgent !== session.user_agent) {
      log.warn(
        { sessionId: session.id, oldUserAgent: session.user_agent, newUserAgent: opts.userAgent },
        "session user-agent changed",
      );
    }
  }

  getById(id: string): SessionRow | null {
    return oneRow<SessionRow>(this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM crew_sessions WHERE id = ?`), id);
  }

  /** Newest first — what an operator wants when asking "where is this account signed in". */
  listForUser(userId: string): SessionRow[] {
    return allRows<SessionRow>(
      this.db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM crew_sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`,
      ),
      userId,
    );
  }

  /** Signs out one session by its raw token. True when a row was removed. */
  revoke(token: string): boolean {
    const result = this.db.prepare("DELETE FROM crew_sessions WHERE token_hash = ?").run(hashToken(token));
    return Number(result.changes) > 0;
  }

  /**
   * Signs out one session by its id — the form the Command Center has, since
   * it can list sessions but can never see a token.
   */
  revokeById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM crew_sessions WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  /** "Log this account out everywhere." Returns how many sessions ended. */
  revokeAllForUser(userId: string): number {
    const result = this.db.prepare("DELETE FROM crew_sessions WHERE user_id = ?").run(userId);
    return Number(result.changes);
  }

  /**
   * Removes sessions past their expiry. They are already unusable — `resolve`
   * refuses them — so this is hygiene, not enforcement, and is safe to run
   * from a scheduled job at any interval.
   */
  sweepExpired(now = Date.now()): number {
    const result = this.db.prepare("DELETE FROM crew_sessions WHERE expires_at <= ?").run(now);
    return Number(result.changes);
  }
}
