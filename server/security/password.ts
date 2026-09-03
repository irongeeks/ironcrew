import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal SQLite-like DB handle used by session helpers. */
export type PasswordDb = {
  prepare: (sql: string) => {
    run: (...args: any[]) => any;
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
  };
};

// ---------------------------------------------------------------------------
// scrypt parameters
// ---------------------------------------------------------------------------

// scrypt parameters chosen per OWASP 2024 Password Storage Cheat Sheet for
// interactive login (N=2^14, r=8, p=1). Empirically ~50 ms per hash on modern
// x86 hardware — acceptable latency on login, still expensive to brute-force.
// If hardware gets significantly faster (or under attack pressure), bump
// SCRYPT_N to the next power of two (32768, 65536, …). Do NOT change
// SCRYPT_R or SCRYPT_KEYLEN without a migration plan: every stored hash
// encodes these implicitly via its byte layout and would become unverifiable.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

const SESSION_PREFIX = "remote_session:";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PASSWORD_HASH_KEY = "access_password_hash";

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using scrypt.
 * Returns a string in the format `scrypt:<base64-salt>:<base64-hash>`.
 */
export function hashPassword(plaintext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(SALT_BYTES);
    scrypt(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt.toString("base64")}:${derived.toString("base64")}`);
    });
  });
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * Uses timing-safe comparison.
 */
export function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") {
      return resolve(false);
    }

    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[1], "base64");
      expected = Buffer.from(parts[2], "base64");
    } catch {
      return resolve(false);
    }

    if (expected.length !== SCRYPT_KEYLEN) {
      return resolve(false);
    }

    scrypt(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derived) => {
      if (err) return reject(err);
      try {
        resolve(timingSafeEqual(derived, expected));
      } catch {
        resolve(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Remote session management
// ---------------------------------------------------------------------------

/**
 * Create a new remote session token and persist it in the settings table.
 * Returns a 64-character hex token (32 random bytes).
 */
export function createRemoteSession(db: PasswordDb, ip: string, userAgent: string): string {
  const token = randomBytes(32).toString("hex");
  const key = `${SESSION_PREFIX}${token}`;
  const value = JSON.stringify({
    created_at: new Date().toISOString(),
    ip,
    user_agent: userAgent,
  });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  return token;
}

/**
 * Validate that a remote session token exists and has not expired (7-day TTL).
 *
 * When `currentIp` and/or `currentUa` are provided, this performs *soft*
 * binding validation against the IP/UA captured at session creation:
 *   - On mismatch we emit a `console.warn` with a session-id prefix and the
 *     old/new values so incident response can correlate after the fact.
 *   - We deliberately do NOT invalidate the session. Mobile clients roam
 *     across networks (cell ↔ wifi ↔ VPN) and browser user-agents rotate on
 *     every minor update; hard-binding would force re-login constantly and
 *     erode trust in the product without meaningfully raising the bar for
 *     an attacker who already has the cookie.
 */
export function validateRemoteSession(db: PasswordDb, token: string, currentIp?: string, currentUa?: string): boolean {
  const key = `${SESSION_PREFIX}${token}`;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return false;

  try {
    const data = JSON.parse(row.value) as { created_at: string; ip?: string; user_agent?: string };
    const created = new Date(data.created_at).getTime();
    if (Date.now() - created >= SESSION_TTL_MS) return false;

    // Soft binding: log drift, don't block.
    const sessionIdPrefix = token.slice(0, 8);
    if (currentIp && data.ip && currentIp !== data.ip) {
      console.warn(
        `[security] remote session IP changed: session_id_prefix=${sessionIdPrefix} old_ip=${data.ip} new_ip=${currentIp}`,
      );
    }
    if (currentUa && data.user_agent && currentUa !== data.user_agent) {
      console.warn(
        `[security] remote session user-agent changed: session_id_prefix=${sessionIdPrefix} old_ua=${JSON.stringify(data.user_agent)} new_ua=${JSON.stringify(currentUa)}`,
      );
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove a single remote session. */
export function invalidateRemoteSession(db: PasswordDb, token: string): void {
  const key = `${SESSION_PREFIX}${token}`;
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** Remove all remote sessions. */
export function invalidateAllRemoteSessions(db: PasswordDb): void {
  db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`${SESSION_PREFIX}%`);
}

// ---------------------------------------------------------------------------
// Password configuration helpers
// ---------------------------------------------------------------------------

/** Check whether an access password has been configured. */
export function isPasswordConfigured(db: PasswordDb): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PASSWORD_HASH_KEY) as
    | { value: string }
    | undefined;
  return row !== undefined && row.value.length > 0;
}

/** Return the stored password hash, or null if none is set. */
export function getPasswordHash(db: PasswordDb): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PASSWORD_HASH_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
