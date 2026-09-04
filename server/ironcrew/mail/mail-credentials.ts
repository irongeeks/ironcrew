/**
 * IronCrew — mailbox credentials, encrypted at rest.
 *
 * Unlike `crew_secrets` (which stores a `SecretRef` and never a value), a
 * mailbox stores its own credentials, encrypted. That is a deliberate,
 * owner-chosen departure from docs/THREAT_MODEL.md's "only SecretRef values
 * are stored in the database", made so a mailbox can be connected without
 * a password manager and so OAuth refresh tokens can be rotated
 * automatically. It is documented as a trade-off in docs/MAIL.md rather
 * than quietly taken.
 *
 * The encryption itself is NOT reinvented here: it delegates to
 * server/oauth/helpers.ts's `encryptSecret`/`decryptSecret` — AES-256-GCM
 * with a key derived from OAUTH_ENCRYPTION_SECRET — which is already the
 * single crypto implementation this application uses for OAuth tokens,
 * PKCE verifiers and messenger tokens. One cipher, one key, one place to
 * audit.
 */

import { decryptSecret, encryptSecret } from "../../oauth/helpers.ts";

/**
 * Everything secret a mailbox might need. Which fields matter depends on
 * the mailbox kind — an IMAP mailbox uses `password`, a JMAP one
 * `bearerToken`, M365/Gmail the OAuth trio.
 */
export interface MailCredentials {
  /** IMAP/SMTP password (or app password). */
  password?: string;
  /** JMAP bearer token. */
  bearerToken?: string;
  /** OAuth client secret (Microsoft 365 / Google). */
  clientSecret?: string;
  /** OAuth refresh token — the durable half, used to mint access tokens. */
  refreshToken?: string;
  /** Cached OAuth access token, refreshed on demand. */
  accessToken?: string;
  /** Epoch ms at which `accessToken` expires. */
  accessTokenExpiresAt?: number;
}

/** Injectable so tests never need a real OAUTH_ENCRYPTION_SECRET in the environment. */
export interface CredentialCipher {
  encrypt(credentials: MailCredentials): string;
  /** An empty blob decrypts to `{}` — a mailbox row may legitimately carry no credentials yet. */
  decrypt(blob: string): MailCredentials;
}

export const defaultCredentialCipher: CredentialCipher = {
  encrypt(credentials: MailCredentials): string {
    return encryptSecret(JSON.stringify(credentials));
  },
  decrypt(blob: string): MailCredentials {
    if (!blob) return {};
    return JSON.parse(decryptSecret(blob)) as MailCredentials;
  },
};

/**
 * In-memory cipher for tests: same contract, no key material, and still
 * not plaintext-by-accident — the blob is base64 so a test that asserts
 * "the password never appears verbatim" stays meaningful.
 */
export function createTestCredentialCipher(): CredentialCipher {
  return {
    encrypt: (credentials) => Buffer.from(JSON.stringify(credentials), "utf8").toString("base64"),
    decrypt: (blob) => (blob ? (JSON.parse(Buffer.from(blob, "base64").toString("utf8")) as MailCredentials) : {}),
  };
}
