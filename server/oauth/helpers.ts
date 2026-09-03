import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { OAUTH_BASE_HOST, PORT } from "../config/runtime.ts";

// ---------------------------------------------------------------------------
// OAuth encryption helpers
// ---------------------------------------------------------------------------
export const OAUTH_ENCRYPTION_SECRET = process.env.OAUTH_ENCRYPTION_SECRET || process.env.SESSION_SECRET || "";

const PLACEHOLDER_SECRET = "__CHANGE_ME__";

export type EncryptionSecretStatus = {
  status: "ok" | "missing" | "placeholder" | "fallback";
  source: "OAUTH_ENCRYPTION_SECRET" | "SESSION_SECRET" | "none";
};

/**
 * Startup guard: inspects encryption secret config and (optionally) existing
 * OAuth credential rows, and either throws a clear error or returns a list of
 * warnings to log. Called eagerly during server boot so misconfiguration is
 * visible immediately instead of only when an OAuth operation runs.
 */
export function assertOAuthEncryptionReady(deps: { countOAuthCredentials: () => number }): { warnings: string[] } {
  const status = getEncryptionSecretStatus();
  const warnings: string[] = [];

  if (status.status === "ok") {
    return { warnings };
  }

  const existingCount = safeCount(deps.countOAuthCredentials);

  if (status.status === "missing" || status.status === "placeholder") {
    if (existingCount > 0) {
      throw new Error(
        `OAUTH_ENCRYPTION_SECRET is ${status.status} but ${existingCount} encrypted OAuth ` +
          `credential(s) are present — they cannot be decrypted. Set OAUTH_ENCRYPTION_SECRET ` +
          `in .env to the value used when the tokens were stored, or delete the rows from the ` +
          `oauth_credentials table and re-authenticate. Generate a new secret with: ` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }
    warnings.push(
      `OAUTH_ENCRYPTION_SECRET is ${status.status}. OAuth features are disabled until you set ` +
        `it in .env (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))").`,
    );
    return { warnings };
  }

  // status === "fallback" — legacy SESSION_SECRET in use
  warnings.push(
    "SECURITY: OAUTH_ENCRYPTION_SECRET is not set; falling back to legacy SESSION_SECRET. " +
      "This fallback is DEPRECATED and will be removed in a future release. " +
      "Migrate now: copy the current SESSION_SECRET value to OAUTH_ENCRYPTION_SECRET in .env " +
      "(and remove SESSION_SECRET once confirmed). Existing encrypted credentials will keep " +
      "working as long as the value is identical.",
  );
  return { warnings };
}

function safeCount(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

/**
 * Inspects the current environment to classify how the OAuth encryption secret
 * is configured. Reads process.env at call time so tests and startup guards
 * both see the live state.
 */
export function getEncryptionSecretStatus(): EncryptionSecretStatus {
  const primary = process.env.OAUTH_ENCRYPTION_SECRET;
  const legacy = process.env.SESSION_SECRET;

  if (primary && primary !== PLACEHOLDER_SECRET) {
    return { status: "ok", source: "OAUTH_ENCRYPTION_SECRET" };
  }
  if (primary === PLACEHOLDER_SECRET) {
    return { status: "placeholder", source: "OAUTH_ENCRYPTION_SECRET" };
  }
  if (legacy && legacy !== PLACEHOLDER_SECRET) {
    return { status: "fallback", source: "SESSION_SECRET" };
  }
  if (legacy === PLACEHOLDER_SECRET) {
    return { status: "placeholder", source: "SESSION_SECRET" };
  }
  return { status: "missing", source: "none" };
}

function oauthEncryptionKey(): Buffer {
  if (!OAUTH_ENCRYPTION_SECRET || OAUTH_ENCRYPTION_SECRET === PLACEHOLDER_SECRET) {
    throw new Error(
      "Missing or default OAUTH_ENCRYPTION_SECRET — set a strong random value in .env " +
        "(generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")",
    );
  }
  return createHash("sha256").update(OAUTH_ENCRYPTION_SECRET, "utf8").digest();
}

export function encryptSecret(plaintext: string): string {
  const key = oauthEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4) throw new Error("invalid_encrypted_payload");
  const [ver, ivB64, tagB64, ctB64] = parts;
  // Empty ciphertext (parts[3] === "") is legal — encryptSecret("") emits it.
  if (ver !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("invalid_encrypted_payload");
  const key = oauthEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}

// ---------------------------------------------------------------------------
// OAuth web-auth constants & PKCE helpers
// ---------------------------------------------------------------------------
export const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || `http://${OAUTH_BASE_HOST}:${PORT}`;

// OAuth client credentials — must be configured via environment variables.
// No built-in fallbacks are shipped; set OAUTH_GITHUB_CLIENT_ID,
// OAUTH_GOOGLE_CLIENT_ID, and OAUTH_GOOGLE_CLIENT_SECRET in .env.
export const BUILTIN_GITHUB_CLIENT_ID = process.env.OAUTH_GITHUB_CLIENT_ID ?? "";
export const BUILTIN_GOOGLE_CLIENT_ID = process.env.OAUTH_GOOGLE_CLIENT_ID ?? "";
export const BUILTIN_GOOGLE_CLIENT_SECRET = process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? "";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function pkceVerifier(): string {
  return b64url(randomBytes(32));
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}

// ---------------------------------------------------------------------------
// OAuth helper functions
// ---------------------------------------------------------------------------
export function sanitizeOAuthRedirect(raw: string | undefined): string {
  if (!raw) return "/";
  try {
    const u = new URL(raw);
    // WHATWG URL keeps IPv6 hostnames bracketed (e.g. "[::1]"); strip the brackets
    // so the equality check against "::1" matches.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".ts.net")) return raw;
  } catch {
    // not absolute URL - treat as path
  }
  // Reject protocol-relative URLs (e.g. "//evil.example.com/path"). Browsers
  // resolve "//host/path" against the current scheme and navigate off-site,
  // so they must not be treated as safe relative redirects.
  if (raw.startsWith("//")) return "/";
  if (raw.startsWith("/")) return raw;
  return "/";
}

export function appendOAuthQuery(url: string, key: string, val: string): string {
  const u = new URL(url);
  u.searchParams.set(key, val);
  return u.toString();
}
