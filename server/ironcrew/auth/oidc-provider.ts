/**
 * IronCrew — proving a crew account with an identity provider.
 *
 * Migration 0024 is the argument for this file existing at all: an MSP that
 * already runs a directory must not have to switch an account off in two
 * places, because the one somebody forgets is the account of the person who
 * left. This module is the mechanism, and nothing more than the mechanism —
 * it turns "the directory says this is subject X at issuer Y" into "this is
 * crew user usr_…", or into a refusal an operator can act on.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not create a session, set a cookie, or touch Express. The login
 * ends in exactly the `crew_sessions` row a password login would produce
 * (docs/IDENTITY.md), and that row is created by the route layer through the
 * existing `SessionStore` — so there is one session implementation, not two.
 * A second one would be a second place to get revocation, TTL and the
 * `HttpOnly` flags right.
 *
 * It also does not hold the pending login. `beginLogin()` returns the state,
 * nonce and PKCE verifier and it is the caller's job to put them in a
 * short-lived `HttpOnly` cookie and hand them back to `completeLogin()`.
 * Those three values are credentials for the few minutes they live: anyone
 * holding the verifier and state of an in-flight login can complete it.
 *
 * NOTHING HERE IS AUTHENTIK-SPECIFIC
 *
 * Authentik is what this was written for, but every endpoint, key and claim
 * comes out of the issuer's own discovery document, so any OIDC Core provider
 * works. The one Authentik-shaped detail — an issuer URL that ends in a slash
 * (`https://auth.example/application/o/ironcrew/`) — is handled by treating
 * the *discovery document's* `issuer` as canonical rather than the string an
 * operator typed. See `discover()`.
 *
 * WHAT AN ERROR MESSAGE MAY SAY
 *
 * Never the client secret, never the authorization code, never a token, never
 * the raw ID token, and never a response body that could contain any of them.
 * Messages name the field and the step ("the ID token's `aud` does not
 * contain this client"), because that is what an operator needs, and the
 * value is exactly what an attacker probing the endpoint wants back. The
 * `subject` and `issuer` are the deliberate exception: they are opaque public
 * identifiers, and migration 0024 requires that an unknown subject be named
 * so an owner can link it.
 *
 * WHY THE VERIFICATION IS WRITTEN OUT HERE
 *
 * No JOSE library is a dependency of this repository, and adding one to check
 * a signature over an ASCII string with a public key is a supply-chain cost
 * with no benefit: `node:crypto`'s WebCrypto can verify RS/PS/ES directly.
 * What a library would otherwise give us — the claim checks — is the part
 * that actually has to be read and audited, so it is written here in the open
 * rather than configured somewhere else.
 */

import { createHash, randomBytes, timingSafeEqual, webcrypto } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { allRows, oneRow } from "../domain/sql.ts";
import { UserStore, type UserRole } from "./user-store.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-oidc" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `openid` is mandatory; the other two are what fills a display name. */
export const DEFAULT_SCOPES = ["openid", "profile", "email"] as const;

/**
 * How long a started login may take to come back.
 *
 * Ten minutes is generous for "click through a login form and a second
 * factor" and short enough that a pending cookie stolen from a browser
 * history or a shared machine is usually already worthless.
 */
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;

/** Discovery changes on a deploy of the IdP, not on a login. */
export const DEFAULT_DISCOVERY_TTL_MS = 5 * 60_000;

/** Signing keys rotate on the order of days; ten minutes is plenty. */
export const DEFAULT_JWKS_TTL_MS = 10 * 60_000;

/**
 * How often an unknown `kid` may force an out-of-band JWKS refetch.
 *
 * Rotation has to work without an operator restarting anything, so an unknown
 * `kid` refetches immediately — but `kid` is attacker-controlled input, and
 * without a floor between refetches a stream of forged headers turns this
 * process into a load generator pointed at the identity provider. One
 * refetch per 30 s costs a rotation nothing (the affected logins simply
 * succeed on retry) and costs the attacker the amplification.
 */
export const JWKS_REFRESH_COOLDOWN_MS = 30_000;

/** Clocks drift. A minute is the usual allowance and the one OIDC deployments assume. */
export const DEFAULT_CLOCK_TOLERANCE_MS = 60_000;

/**
 * An ID token older than this is refused even if its `exp` is generous.
 *
 * It was minted seconds ago for a code we exchanged seconds ago; an issuer
 * that hands out day-long ID tokens should not thereby hand out a day-long
 * replay window against this system.
 */
export const MAX_ID_TOKEN_AGE_MS = 15 * 60_000;

/** A bound before parsing, so a hostile response cannot buy unbounded work. */
export const MAX_ID_TOKEN_CHARS = 16_384;

/** Per-request timeout. A login must fail fast rather than hang a browser. */
export const DEFAULT_OIDC_TIMEOUT_MS = 10_000;

/**
 * Signature algorithms accepted in an ID token header.
 *
 * `none` and the `HS*` family are absent on purpose, and their absence is the
 * defence: `none` is the original JWT forgery, and accepting `HS256` would
 * let an attacker sign a token with the *public* key material (or with the
 * client secret, which every deployed client shares) and have it verified as
 * if it were the issuer's. The set is a whitelist, so an algorithm nobody
 * reviewed can never be reached by putting its name in a header.
 */
export const SUPPORTED_ID_TOKEN_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
] as const;

export type IdTokenAlg = (typeof SUPPORTED_ID_TOKEN_ALGS)[number];

/** What each accepted `alg` means to WebCrypto, and which key type it needs. */
const ALG_PARAMS: Record<
  IdTokenAlg,
  {
    kty: "RSA" | "EC";
    importParams: webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams;
    verifyParams: webcrypto.AlgorithmIdentifier | webcrypto.RsaPssParams | webcrypto.EcdsaParams;
  }
> = {
  RS256: {
    kty: "RSA",
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: "RSASSA-PKCS1-v1_5",
  },
  RS384: {
    kty: "RSA",
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
    verifyParams: "RSASSA-PKCS1-v1_5",
  },
  RS512: {
    kty: "RSA",
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
    verifyParams: "RSASSA-PKCS1-v1_5",
  },
  PS256: {
    kty: "RSA",
    importParams: { name: "RSA-PSS", hash: "SHA-256" },
    verifyParams: { name: "RSA-PSS", saltLength: 32 },
  },
  PS384: {
    kty: "RSA",
    importParams: { name: "RSA-PSS", hash: "SHA-384" },
    verifyParams: { name: "RSA-PSS", saltLength: 48 },
  },
  PS512: {
    kty: "RSA",
    importParams: { name: "RSA-PSS", hash: "SHA-512" },
    verifyParams: { name: "RSA-PSS", saltLength: 64 },
  },
  ES256: {
    kty: "EC",
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
  ES384: {
    kty: "EC",
    importParams: { name: "ECDSA", namedCurve: "P-384" },
    verifyParams: { name: "ECDSA", hash: "SHA-384" },
  },
  ES512: {
    kty: "EC",
    importParams: { name: "ECDSA", namedCurve: "P-521" },
    verifyParams: { name: "ECDSA", hash: "SHA-512" },
  },
};

function isSupportedAlg(value: unknown): value is IdTokenAlg {
  return (SUPPORTED_ID_TOKEN_ALGS as readonly string[]).includes(value as string);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * What happens on the first login of a subject with no link row.
 *
 * Migration 0024 argues these three at length. In short: `refuse` keeps the
 * local user list the authoritative statement of who may use this system;
 * `link-verified-email` saves an operator from typing a subject by hand and
 * creates no account; `create` hands the directory the ability to add
 * accounts, which is a real delegation and therefore never the default.
 */
export const OIDC_PROVISIONING_MODES = ["refuse", "link-verified-email", "create"] as const;
export type OidcProvisioningMode = (typeof OIDC_PROVISIONING_MODES)[number];

export interface OidcProvisioning {
  mode: OidcProvisioningMode;
  /**
   * The role `create` mode grants. Typed as "not owner" and checked again at
   * runtime, because an owner approves irreversible acts, grants tools and
   * reads the vault: anyone able to create a user in the directory would
   * otherwise be able to mint one without any IronCrew owner deciding
   * anything. That is a strictly weaker path to the strongest role than the
   * one migration 0017 built, so it does not exist here at all.
   */
  role?: Exclude<UserRole, "owner">;
}

export interface OidcProviderConfig {
  /** Issuer URL as configured. The discovery document's `issuer` wins over it. */
  issuer: string;
  clientId: string;
  /**
   * Omit for a public client. PKCE is sent either way; the secret only ever
   * travels in an `Authorization: Basic` header or a POST body to the token
   * endpoint, never in a URL — a credential that has been in a URL is burned
   * by proxy logs and browser history.
   */
  clientSecret?: string;
  /** Must match a redirect URI registered at the issuer, exactly. */
  redirectUri: string;
  /** Defaults to DEFAULT_SCOPES. `openid` is added when a caller forgets it. */
  scopes?: readonly string[];
  /** Defaults to `{ mode: "refuse" }` — fail closed. */
  provisioning?: OidcProvisioning;
  clockToleranceMs?: number;
  discoveryTtlMs?: number;
  jwksTtlMs?: number;
  timeoutMs?: number;
}

export interface OidcProviderDeps {
  db: DatabaseSync;
  /** Injectable so tests drive the real code path with no socket. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, so expiry is testable without waiting for it. */
  now?: () => number;
}

/** A configuration or transport failure. Refusals of a *login* are values, not throws. */
export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type OidcRefusalCode =
  | "discovery_unavailable"
  | "discovery_invalid"
  | "login_expired"
  | "state_mismatch"
  | "state_replayed"
  | "callback_issuer_mismatch"
  | "token_exchange_failed"
  | "id_token_missing"
  | "id_token_malformed"
  | "id_token_alg_unsupported"
  | "id_token_key_unknown"
  | "id_token_signature_invalid"
  | "id_token_issuer_mismatch"
  | "id_token_audience_mismatch"
  | "id_token_expired"
  | "id_token_timestamps_invalid"
  | "id_token_nonce_mismatch"
  | "id_token_subject_missing"
  | "subject_not_linked"
  | "account_unavailable";

export interface OidcRefusal {
  ok: false;
  reason: OidcRefusalCode;
  /** Operator-facing English. Contractually never a secret, a code or a token. */
  message: string;
  /** Present once a subject is known, so an owner can link it in the UI. */
  identity?: { issuer: string; subject: string; email: string | null };
}

export interface OidcLoginSuccess {
  ok: true;
  /** The crew account this directory identity resolves to. */
  userId: string;
  issuer: string;
  subject: string;
  /** How it resolved — for the audit entry the route layer writes. */
  link: "existing" | "email-verified" | "created";
}

export type OidcLoginResult = OidcLoginSuccess | OidcRefusal;

/**
 * Everything the caller must keep between the redirect out and the callback
 * back, and must keep *secret*: the state and verifier together are what let
 * a login be completed. Belongs in an `HttpOnly`, `SameSite=Lax` cookie —
 * `Lax` and not `Strict`, because the callback is a cross-site navigation
 * from the identity provider and `Strict` would drop the cookie exactly when
 * it is needed.
 */
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Canonical issuer this login was started against. */
  issuer: string;
  /** Absolute epoch-ms. Checked by `completeLogin`. */
  expiresAt: number;
  /** Where to send the browser afterwards. Opaque here; the caller validates it. */
  redirectTo?: string;
}

export interface BeginLoginResult {
  authorizationUrl: string;
  pending: PendingLogin;
}

export interface CompleteLoginInput {
  code: string;
  /** The `state` query parameter as it came back from the browser. */
  state: string;
  /** What `beginLogin` returned, read back out of the pending-login cookie. */
  pending: PendingLogin;
  /** RFC 9207 `iss` response parameter, when the issuer sends one. */
  issuer?: string;
}

/** Only the fields this module actually reads — see `assertDiscovery`. */
export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  tokenEndpointAuthMethods: string[] | null;
}

interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Constant-time string comparison for state and nonce.
 *
 * Length is compared first and leaks, which is fine: both values are
 * fixed-length CSPRNG output, so their length is public by construction.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function refuse(reason: OidcRefusalCode, message: string, identity?: OidcRefusal["identity"]): OidcRefusal {
  return identity ? { ok: false, reason, message, identity } : { ok: false, reason, message };
}

/**
 * An endpoint we are willing to send a credential to.
 *
 * The ID token is signed and survives a hostile network, but the *code
 * exchange* is not: it carries the client secret and the authorization code
 * in a request body, and over plaintext both are readable and replayable by
 * anyone on the path. Loopback is exempt because it never leaves the machine
 * and is how an operator tries an identity provider out before there is a
 * certificate.
 */
function assertSafeEndpoint(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new OidcError(`The discovery document has no usable "${field}".`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcError(`The discovery document's "${field}" is not an absolute URL.`);
  }
  if (url.protocol === "https:") return url.toString();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    return url.toString();
  }
  throw new OidcError(`The discovery document's "${field}" is not https (and not loopback); refusing to use it.`);
}

/** Trailing slashes only; the rest of an issuer string is significant. */
function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Describes a transport failure without quoting the error's message.
 *
 * `err.message` is avoided on purpose rather than out of caution: a `fetch`
 * implementation, a proxy agent or an instrumentation wrapper may put the
 * outgoing request — headers and body, so the client secret and the code —
 * into its error text, and this string ends up in a log and often on screen.
 * The origin and Node's `cause.code` (`ECONNREFUSED`, `CERT_HAS_EXPIRED`, …)
 * are what an operator actually needs, and neither can contain a credential.
 */
function describeTransport(err: unknown, url: string): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  const name = err instanceof Error ? err.name : "Error";
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    // A malformed URL is reported by the caller; it must not become a second failure.
  }
  const reason = code ?? name;
  return origin ? `${reason} (${origin})` : reason;
}

/** OAuth error codes are a fixed vocabulary; anything else is not echoed at all. */
function safeOauthErrorCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// The link table
// ---------------------------------------------------------------------------

export interface OidcIdentityRow {
  issuer: string;
  subject: string;
  user_id: string;
  email_at_link: string;
  created_at: number;
  last_login_at: number | null;
}

const IDENTITY_COLUMNS = `issuer, subject, user_id, email_at_link, created_at, last_login_at`;

/**
 * `crew_oidc_identities` — one directory identity, at most one local account.
 *
 * Separate from `OidcProvider` because the Command Center needs the same rows
 * to show and unlink identities on a user page, and a UI that had to spin up
 * a provider (and therefore reach an identity provider over the network) just
 * to list link rows would be a UI that breaks when the IdP is down.
 */
export class OidcIdentityStore {
  constructor(private readonly db: DatabaseSync) {}

  get(issuer: string, subject: string): OidcIdentityRow | null {
    return oneRow<OidcIdentityRow>(
      this.db.prepare(`SELECT ${IDENTITY_COLUMNS} FROM crew_oidc_identities WHERE issuer = ? AND subject = ?`),
      issuer,
      subject,
    );
  }

  listForUser(userId: string): OidcIdentityRow[] {
    return allRows<OidcIdentityRow>(
      this.db.prepare(
        `SELECT ${IDENTITY_COLUMNS} FROM crew_oidc_identities WHERE user_id = ? ORDER BY created_at ASC, rowid ASC`,
      ),
      userId,
    );
  }

  /**
   * Links a subject to an account.
   *
   * `INSERT` without `OR REPLACE`: the composite primary key is the rule that
   * one directory identity maps to at most one local account, and silently
   * overwriting an existing link would be how a second person quietly
   * inherits the first one's account. A conflict is an error the caller has
   * to see.
   */
  link(input: { issuer: string; subject: string; userId: string; emailAtLink?: string | null; now?: number }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO crew_oidc_identities (issuer, subject, user_id, email_at_link, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(input.issuer, input.subject, input.userId, input.emailAtLink ?? "", now);
  }

  unlink(issuer: string, subject: string): boolean {
    const result = this.db
      .prepare("DELETE FROM crew_oidc_identities WHERE issuer = ? AND subject = ?")
      .run(issuer, subject);
    return Number(result.changes) > 0;
  }

  /**
   * Records that this identity was just used.
   *
   * Both rows, and only their `last_login_at`. The identity row answers "is
   * this link still in use, or is it a leftover from a directory nobody
   * migrated"; the user row answers "when was this person last here", which
   * an operator reads in the user list and which would otherwise say "never"
   * for everyone who signs in through SSO. `updated_at` is deliberately not
   * touched: signing in does not change the account, and bumping it would
   * make every login look like an administrative edit.
   */
  noteLogin(issuer: string, subject: string, now: number): void {
    this.db
      .prepare("UPDATE crew_oidc_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?")
      .run(now, issuer, subject);
    this.db
      .prepare(
        "UPDATE crew_users SET last_login_at = ? WHERE id = (SELECT user_id FROM crew_oidc_identities WHERE issuer = ? AND subject = ?)",
      )
      .run(now, issuer, subject);
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

interface JwksKey {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [claim: string]: unknown;
}

export class OidcProvider {
  readonly issuer: string;
  readonly identities: OidcIdentityStore;

  private readonly users: UserStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly scopes: string[];
  private readonly provisioning: Required<OidcProvisioning>;
  private readonly clockToleranceMs: number;
  private readonly discoveryTtlMs: number;
  private readonly jwksTtlMs: number;
  private readonly timeoutMs: number;

  private discoveryCache: { doc: OidcDiscovery; fetchedAt: number } | null = null;
  private discoveryInFlight: Promise<OidcDiscovery> | null = null;
  private jwksCache: { keys: JwksKey[]; fetchedAt: number } | null = null;
  private jwksInFlight: Promise<JwksKey[]> | null = null;
  private lastForcedJwksFetchAt = 0;

  /**
   * State and nonce values already spent, with the moment they may be
   * forgotten.
   *
   * Single-use is enforced here rather than by a database table because a
   * pending login lives for ten minutes in a cookie: a process restart
   * invalidates every login in flight anyway (the browser simply starts a new
   * one), so persisting the register would buy nothing and cost a migration.
   * The consequence to know: with several server processes this register is
   * per-process. Replay protection then rests on the pending cookie, which is
   * cleared by the callback handler — noted rather than hidden, because
   * IronCrew runs one process today and the day it does not, this is the line
   * to revisit.
   */
  private readonly spent = new Map<string, number>();

  constructor(
    private readonly config: OidcProviderConfig,
    deps: OidcProviderDeps,
  ) {
    const issuer = config.issuer?.trim() ?? "";
    if (issuer === "") throw new OidcError("An OIDC provider needs an issuer URL.");
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(issuer);
    } catch {
      throw new OidcError("The OIDC issuer is not an absolute URL.");
    }
    if (issuerUrl.protocol !== "https:" && issuerUrl.protocol !== "http:") {
      throw new OidcError("The OIDC issuer must be an http(s) URL.");
    }
    if ((config.clientId ?? "").trim() === "") throw new OidcError("An OIDC provider needs a client id.");
    if ((config.redirectUri ?? "").trim() === "") throw new OidcError("An OIDC provider needs a redirect URI.");
    try {
      new URL(config.redirectUri);
    } catch {
      throw new OidcError("The OIDC redirect URI is not an absolute URL.");
    }

    const provisioning = config.provisioning ?? { mode: "refuse" };
    if (!(OIDC_PROVISIONING_MODES as readonly string[]).includes(provisioning.mode)) {
      throw new OidcError(`Unknown OIDC provisioning mode "${provisioning.mode}".`);
    }
    // Checked at runtime as well as in the type: this configuration usually
    // arrives as parsed JSON, where the type guarantees nothing.
    if ((provisioning.role as string | undefined) === "owner") {
      throw new OidcError(
        "OIDC provisioning may not grant the owner role: an owner approves irreversible acts and reads the vault, and that grant has to be a local decision.",
      );
    }

    this.issuer = issuer;
    this.users = new UserStore(deps.db);
    this.identities = new OidcIdentityStore(deps.db);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
    // `openid` is what makes this OIDC rather than plain OAuth: without it the
    // issuer returns no ID token and there is nothing to verify.
    const requested = config.scopes && config.scopes.length > 0 ? [...config.scopes] : [...DEFAULT_SCOPES];
    this.scopes = requested.includes("openid") ? requested : ["openid", ...requested];
    this.provisioning = { mode: provisioning.mode, role: provisioning.role ?? "viewer" };
    this.clockToleranceMs = config.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
    this.discoveryTtlMs = config.discoveryTtlMs ?? DEFAULT_DISCOVERY_TTL_MS;
    this.jwksTtlMs = config.jwksTtlMs ?? DEFAULT_JWKS_TTL_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_OIDC_TIMEOUT_MS;
  }

  // --- discovery ----------------------------------------------------------

  /**
   * The issuer's discovery document, cached.
   *
   * The document's own `issuer` becomes canonical: OIDC Discovery requires it
   * to equal the `iss` of every token the issuer mints, so comparing tokens
   * against the operator-typed string would fail over nothing more than a
   * trailing slash — and "SSO stopped working" is then debugged against a
   * character nobody can see. The typed value still has to *match* it modulo
   * that slash, because a document claiming a different issuer than the one
   * we asked is either a misconfiguration or a redirect somewhere we did not
   * intend to trust.
   */
  async discover(): Promise<OidcDiscovery> {
    const now = this.now();
    if (this.discoveryCache && now - this.discoveryCache.fetchedAt < this.discoveryTtlMs) {
      return this.discoveryCache.doc;
    }
    // One fetch even when several logins start at once: the alternative is a
    // thundering herd against the IdP every time the TTL lapses.
    if (this.discoveryInFlight) return this.discoveryInFlight;

    const url = `${trimSlashes(this.issuer)}/.well-known/openid-configuration`;
    this.discoveryInFlight = (async () => {
      const raw = await this.getJson(url, "the discovery document");
      const doc = this.assertDiscovery(raw);
      this.discoveryCache = { doc, fetchedAt: this.now() };
      return doc;
    })();
    try {
      return await this.discoveryInFlight;
    } finally {
      this.discoveryInFlight = null;
    }
  }

  private assertDiscovery(raw: unknown): OidcDiscovery {
    if (!raw || typeof raw !== "object") throw new OidcError("The discovery document was not a JSON object.");
    const doc = raw as Record<string, unknown>;

    const issuer = typeof doc.issuer === "string" ? doc.issuer.trim() : "";
    if (issuer === "") throw new OidcError('The discovery document has no "issuer".');
    if (trimSlashes(issuer) !== trimSlashes(this.issuer)) {
      // Named, not quoted-in-full: both values are public configuration, and
      // an operator cannot fix this without seeing both.
      throw new OidcError(
        `The discovery document reports issuer "${issuer}", but this client is configured for "${this.issuer}".`,
      );
    }

    const authorizationEndpoint = assertSafeEndpoint(doc.authorization_endpoint, "authorization_endpoint");
    const tokenEndpoint = assertSafeEndpoint(doc.token_endpoint, "token_endpoint");
    const jwksUri = assertSafeEndpoint(doc.jwks_uri, "jwks_uri");

    // Only checked when advertised. An issuer that lists its capabilities and
    // does not list ours cannot serve this client, and finding that out here
    // beats finding it out as an unexplained signature failure later.
    const algs = Array.isArray(doc.id_token_signing_alg_values_supported)
      ? doc.id_token_signing_alg_values_supported.filter((a): a is string => typeof a === "string")
      : null;
    if (algs && !algs.some((alg) => isSupportedAlg(alg))) {
      throw new OidcError(
        `The issuer signs ID tokens only with algorithms this client does not accept (${algs.join(", ")}).`,
      );
    }

    const pkceMethods = Array.isArray(doc.code_challenge_methods_supported)
      ? doc.code_challenge_methods_supported.filter((m): m is string => typeof m === "string")
      : null;
    // Absent means "does not advertise", which is common and harmless — we
    // send S256 regardless and an issuer that ignores it is no worse off.
    // Advertising a list *without* S256 is different: it is an issuer that
    // would have us downgrade to `plain`, which is PKCE in name only.
    if (pkceMethods && !pkceMethods.includes("S256")) {
      throw new OidcError("The issuer does not support PKCE with S256, which this client requires.");
    }

    const authMethods = Array.isArray(doc.token_endpoint_auth_methods_supported)
      ? doc.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === "string")
      : null;

    return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri, tokenEndpointAuthMethods: authMethods };
  }

  // --- step one: send the browser to the issuer ---------------------------

  /**
   * Starts a login.
   *
   * Throws rather than returning a refusal: a discovery failure means no
   * login can be started at all, which is an operator problem (the IdP is
   * down, or the issuer is mistyped) and not a rejected user.
   */
  async beginLogin(opts: { redirectTo?: string; prompt?: string } = {}): Promise<BeginLoginResult> {
    const discovery = await this.discover();
    const now = this.now();

    // 32 bytes each. State and nonce defend different things and are
    // therefore separate values: state binds the callback to *this browser's*
    // request (CSRF), nonce binds the ID token to *this* authentication
    // (replay of a token minted for another login).
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const codeVerifier = b64url(randomBytes(32));
    const codeChallenge = b64url(createHash("sha256").update(codeVerifier, "ascii").digest());

    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (opts.prompt) url.searchParams.set("prompt", opts.prompt);

    const pending: PendingLogin = {
      state,
      nonce,
      codeVerifier,
      issuer: discovery.issuer,
      expiresAt: now + PENDING_LOGIN_TTL_MS,
      ...(opts.redirectTo ? { redirectTo: opts.redirectTo } : {}),
    };
    return { authorizationUrl: url.toString(), pending };
  }

  // --- step two: the browser comes back -----------------------------------

  /**
   * Finishes a login: exchanges the code, verifies the ID token, resolves the
   * crew account.
   *
   * Returns a refusal rather than throwing for everything a caller might see
   * in normal operation, including every attack in this file's threat model.
   * The route layer turns a refusal into a 401 with a generic message and
   * logs the reason; it must not put `message` in front of an anonymous
   * visitor, because "no crew account is linked to subject X" is information
   * an operator needs and a stranger does not.
   */
  async completeLogin(input: CompleteLoginInput): Promise<OidcLoginResult> {
    const now = this.now();
    const { pending } = input;

    if (!pending || typeof pending.state !== "string" || pending.state === "") {
      return refuse("state_mismatch", "This callback has no pending login; start the login again.");
    }
    if (!Number.isFinite(pending.expiresAt) || pending.expiresAt <= now) {
      return refuse("login_expired", "This login took too long to come back; start it again.");
    }
    // Compared before anything is spent or fetched: a callback that does not
    // belong to this browser's login is a CSRF attempt, and answering it must
    // cost nothing.
    if (typeof input.state !== "string" || !safeEqual(input.state, pending.state)) {
      return refuse("state_mismatch", "The callback state does not match the pending login.");
    }
    if (!this.spend(`state:${pending.state}`, pending.expiresAt)) {
      return refuse("state_replayed", "This login callback was already used once.");
    }
    // RFC 9207. When the issuer names itself in the callback, a callback
    // relayed from a *different* issuer (the OAuth mix-up attack) is visible
    // before the code is sent anywhere.
    if (input.issuer !== undefined && trimSlashes(input.issuer) !== trimSlashes(pending.issuer)) {
      return refuse(
        "callback_issuer_mismatch",
        "The callback names a different issuer than the login was started against.",
      );
    }
    if (typeof input.code !== "string" || input.code === "") {
      return refuse("token_exchange_failed", "The callback carried no authorization code.");
    }

    let discovery: OidcDiscovery;
    try {
      discovery = await this.discover();
    } catch (err) {
      const message = err instanceof OidcError ? err.message : "The issuer's discovery document could not be read.";
      return refuse(err instanceof OidcError ? "discovery_invalid" : "discovery_unavailable", message);
    }
    if (trimSlashes(discovery.issuer) !== trimSlashes(pending.issuer)) {
      return refuse("callback_issuer_mismatch", "The issuer changed while this login was in flight; start it again.");
    }

    let idToken: string;
    try {
      idToken = await this.exchangeCode(input.code, pending.codeVerifier, discovery);
    } catch (err) {
      // `err.message` here is built by `exchangeCode`, which never puts the
      // code, the secret or a response body into it.
      return refuse("token_exchange_failed", err instanceof OidcError ? err.message : "The token exchange failed.");
    }

    const verified = await this.verifyIdToken(idToken, discovery, pending.nonce, now);
    if (!verified.ok) return verified;

    // The nonce is spent only after the token verified against it. Spending
    // it earlier would let a failed attempt burn the nonce of a login the
    // legitimate user is still completing.
    if (!this.spend(`nonce:${pending.nonce}`, pending.expiresAt)) {
      return refuse("id_token_nonce_mismatch", "This ID token's nonce was already used.");
    }

    return this.resolveAccount(verified.claims, now);
  }

  // --- token exchange -----------------------------------------------------

  /**
   * Trades the code for tokens and returns the raw ID token.
   *
   * Only the ID token is kept. IronCrew calls no API on the user's behalf, so
   * an access or refresh token would be a stored credential with no purpose —
   * and `userinfo` is deliberately not called either: every claim this module
   * decides anything on has to be one the issuer *signed*, and a userinfo
   * body is not signed.
   */
  private async exchangeCode(code: string, codeVerifier: string, discovery: OidcDiscovery): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: codeVerifier,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };

    const secret = this.config.clientSecret;
    if (secret) {
      // `client_secret_basic` is the spec's default and the only method an
      // issuer must support; `client_secret_post` is used when the issuer
      // advertises a list that omits basic. Either way the secret is in a
      // header or a body, never in the URL.
      const methods = discovery.tokenEndpointAuthMethods;
      const useBasic = !methods || methods.includes("client_secret_basic") || !methods.includes("client_secret_post");
      if (useBasic) {
        const credential = Buffer.from(
          `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(secret)}`,
          "utf8",
        ).toString("base64");
        headers.authorization = `Basic ${credential}`;
      } else {
        body.set("client_secret", secret);
      }
    }

    const response = await this.request(discovery.tokenEndpoint, {
      method: "POST",
      headers,
      body: body.toString(),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The body is not quoted: a token endpoint answering with HTML is
      // usually a proxy error page, and on a good day the body it did not
      // manage to send would have been tokens.
      throw new OidcError(`The token endpoint answered with something that is not JSON (HTTP ${response.status}).`);
    }
    const payload = (parsed ?? {}) as Record<string, unknown>;

    if (!response.ok) {
      const oauthError = safeOauthErrorCode(payload.error);
      // The OAuth `error` code is a fixed vocabulary ("invalid_grant", …) and
      // safe to surface. `error_description` is free text from the issuer and
      // is never included: several implementations echo the request into it.
      throw new OidcError(
        oauthError
          ? `The token endpoint refused the exchange (HTTP ${response.status}, ${oauthError}).`
          : `The token endpoint refused the exchange (HTTP ${response.status}).`,
      );
    }

    const idToken = payload.id_token;
    if (typeof idToken !== "string" || idToken === "") {
      throw new OidcError("The token response carried no id_token; is the `openid` scope configured at the issuer?");
    }
    return idToken;
  }

  // --- ID token verification ----------------------------------------------

  private async verifyIdToken(
    idToken: string,
    discovery: OidcDiscovery,
    nonce: string,
    now: number,
  ): Promise<{ ok: true; claims: IdTokenClaims } | OidcRefusal> {
    if (idToken.length > MAX_ID_TOKEN_CHARS) {
      return refuse("id_token_malformed", "The ID token is implausibly large; refusing to parse it.");
    }
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      return refuse("id_token_malformed", "The ID token is not a three-part JWS.");
    }

    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return refuse("id_token_malformed", "The ID token's header or payload is not valid JSON.");
    }
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") {
      return refuse("id_token_malformed", "The ID token's header or payload is not a JSON object.");
    }

    const alg = header.alg;
    if (!isSupportedAlg(alg)) {
      // Covers "none" and the HS* family. See SUPPORTED_ID_TOKEN_ALGS.
      return refuse(
        "id_token_alg_unsupported",
        `The ID token is signed with "${typeof alg === "string" ? alg : "an unnamed algorithm"}", which this client does not accept.`,
      );
    }
    const kid = typeof header.kid === "string" ? header.kid : null;

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
    const signature = Buffer.from(parts[2], "base64url");
    if (signature.length === 0) {
      return refuse("id_token_malformed", "The ID token carries no signature.");
    }

    let keys = await this.jwks(discovery, false);
    let candidates = selectKeys(keys, alg, kid);
    if (candidates.length === 0 && kid) {
      // Rotation: the issuer signed with a key minted after our last fetch.
      // One forced refetch, rate-limited, then the answer is final.
      keys = await this.jwks(discovery, true);
      candidates = selectKeys(keys, alg, kid);
    }
    if (candidates.length === 0) {
      return refuse(
        "id_token_key_unknown",
        kid
          ? `The issuer's key set has no key "${kid}" usable for ${alg}.`
          : `The issuer's key set has no key usable for ${alg}.`,
      );
    }

    let signatureOk = false;
    for (const jwk of candidates) {
      if (await verifyWith(jwk, alg, signed, signature)) {
        signatureOk = true;
        break;
      }
    }
    if (!signatureOk) {
      return refuse(
        "id_token_signature_invalid",
        "The ID token's signature does not verify against the issuer's keys.",
      );
    }

    // --- claims, in the order that fails cheapest first -------------------

    const iss = typeof claims.iss === "string" ? claims.iss : "";
    if (iss === "" || trimSlashes(iss) !== trimSlashes(discovery.issuer)) {
      return refuse("id_token_issuer_mismatch", "The ID token's `iss` is not this issuer.");
    }

    const aud = claims.aud;
    const audiences =
      typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === "string") : [];
    if (!audiences.includes(this.config.clientId)) {
      return refuse("id_token_audience_mismatch", "The ID token's `aud` does not contain this client.");
    }
    // OIDC Core 3.1.3.7: with several audiences the token was minted for more
    // than one party, and `azp` says which one it was actually for. Accepting
    // it without that check lets a token issued for another client at the
    // same issuer be presented here.
    if (audiences.length > 1 && claims.azp !== this.config.clientId) {
      return refuse(
        "id_token_audience_mismatch",
        "The ID token has several audiences and its `azp` is not this client.",
      );
    }

    const exp = typeof claims.exp === "number" ? claims.exp : null;
    const iat = typeof claims.iat === "number" ? claims.iat : null;
    if (exp === null || iat === null) {
      return refuse("id_token_timestamps_invalid", "The ID token has no numeric `exp`/`iat`.");
    }
    if (exp * 1000 <= now - this.clockToleranceMs) {
      return refuse("id_token_expired", "The ID token has expired.");
    }
    if (iat * 1000 > now + this.clockToleranceMs) {
      return refuse("id_token_timestamps_invalid", "The ID token's `iat` is in the future.");
    }
    if (now - iat * 1000 > MAX_ID_TOKEN_AGE_MS + this.clockToleranceMs) {
      return refuse(
        "id_token_timestamps_invalid",
        "The ID token is older than this client accepts, whatever its `exp` says.",
      );
    }

    // Absent and wrong are the same answer on purpose: an issuer that drops
    // the nonce leaves this login open to replay just as surely as a token
    // minted for someone else's login does.
    const tokenNonce = typeof claims.nonce === "string" ? claims.nonce : "";
    if (tokenNonce === "" || !safeEqual(tokenNonce, nonce)) {
      return refuse("id_token_nonce_mismatch", "The ID token's `nonce` does not match this login.");
    }

    const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
    if (sub === "") {
      return refuse("id_token_subject_missing", "The ID token has no `sub`; there is nothing to link an account to.");
    }

    return {
      ok: true,
      claims: {
        iss,
        sub,
        aud: audiences.length === 1 ? audiences[0] : audiences,
        exp,
        iat,
        nonce: tokenNonce,
        ...(typeof claims.azp === "string" ? { azp: claims.azp } : {}),
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
        ...(typeof claims.email_verified === "boolean" ? { email_verified: claims.email_verified } : {}),
        ...(typeof claims.name === "string" ? { name: claims.name } : {}),
        ...(typeof claims.preferred_username === "string" ? { preferred_username: claims.preferred_username } : {}),
      },
    };
  }

  // --- account resolution -------------------------------------------------

  /**
   * A verified directory identity, turned into a crew account — or refused.
   *
   * This is the line migration 0024 spends most of its header on. The subject
   * decides, always. The email is consulted at most once, at link time, and
   * never again: an address that changes upstream must not move an account,
   * and an address handed to the next person with the same name must not hand
   * them the previous person's role and history.
   */
  private async resolveAccount(claims: IdTokenClaims, now: number): Promise<OidcLoginResult> {
    const issuer = claims.iss;
    const subject = claims.sub;
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const identity = { issuer, subject, email: email === "" ? null : email };

    const existing = this.identities.get(issuer, subject);
    if (existing) {
      const user = this.users.get(existing.user_id);
      if (!user || user.status !== "active") {
        // The account, not the directory, decides whether it may be used. A
        // person disabled here stays disabled even while the directory still
        // happily authenticates them — which is the whole point of the local
        // user list being the grant.
        return refuse(
          "account_unavailable",
          "The crew account linked to this directory identity is disabled or no longer exists.",
          identity,
        );
      }
      this.identities.noteLogin(issuer, subject, now);
      log.info({ userId: user.id, issuer, subject }, "crew SSO login");
      return { ok: true, userId: user.id, issuer, subject, link: "existing" };
    }

    // Migration 0017's bootstrap rule, restated: the first account is an owner
    // and is created deliberately by a human at the console. A directory that
    // was just pointed at this box does not get to decide who that is.
    if (this.users.count() === 0) {
      return refuse(
        "subject_not_linked",
        `No crew account exists yet. Create the first account locally, then link issuer "${issuer}" subject "${subject}" to it.`,
        identity,
      );
    }

    switch (this.provisioning.mode) {
      case "link-verified-email":
        return this.linkByVerifiedEmail(claims, identity, now);
      case "create":
        return this.createForSubject(claims, identity, now);
      case "refuse":
      default:
        return refuse(
          "subject_not_linked",
          `No crew account is linked to subject "${subject}" at issuer "${issuer}". An owner has to create the account and link this identity before it can sign in.`,
          identity,
        );
    }
  }

  /**
   * `link-verified-email`: attach a new subject to an *existing* account.
   *
   * Creates no account and grants no role — it only saves an operator from
   * typing a subject by hand. `email_verified` is required rather than
   * preferred: an issuer that lets a user type their own unverified address
   * would otherwise let that user claim the owner's account by typing the
   * owner's address into their own profile.
   */
  private linkByVerifiedEmail(
    claims: IdTokenClaims,
    identity: NonNullable<OidcRefusal["identity"]>,
    now: number,
  ): OidcLoginResult {
    const { issuer, subject } = identity;
    if (!identity.email || claims.email_verified !== true) {
      return refuse(
        "subject_not_linked",
        `Subject "${subject}" at issuer "${issuer}" is not linked, and its ID token carries no verified email address to link it by.`,
        identity,
      );
    }
    const user = this.users.byEmail(identity.email);
    if (!user || user.status !== "active") {
      return refuse(
        "subject_not_linked",
        `Subject "${subject}" at issuer "${issuer}" is not linked, and no active crew account has its email address.`,
        identity,
      );
    }
    this.identities.link({ issuer, subject, userId: user.id, emailAtLink: identity.email, now });
    this.identities.noteLogin(issuer, subject, now);
    log.info({ userId: user.id, issuer, subject }, "crew SSO identity linked by verified email");
    return { ok: true, userId: user.id, issuer, subject, link: "email-verified" };
  }

  /**
   * `create`: the opt-in that lets the directory add accounts.
   *
   * Bounded in three ways, all of them from migration 0024's header. The role
   * is never `owner` (refused in the constructor). The bootstrap case never
   * reaches here. And an email that already belongs to a local account is a
   * *refusal*, not a link: silently attaching the subject to that account
   * would be exactly the email-matching this whole design refuses, arrived at
   * through the back door.
   */
  private async createForSubject(
    claims: IdTokenClaims,
    identity: NonNullable<OidcRefusal["identity"]>,
    now: number,
  ): Promise<OidcLoginResult> {
    const { issuer, subject } = identity;
    if (!identity.email || claims.email_verified !== true) {
      return refuse(
        "subject_not_linked",
        `Subject "${subject}" at issuer "${issuer}" has no verified email address, and an account needs one.`,
        identity,
      );
    }
    if (this.users.byEmail(identity.email)) {
      return refuse(
        "subject_not_linked",
        `An account with this email address already exists locally. Link subject "${subject}" at issuer "${issuer}" to it deliberately rather than by email.`,
        identity,
      );
    }

    // `crew_users.password_hash` is NOT NULL and stays that way (migration
    // 0024): "no password means anyone" was refused in 0017. So the account
    // gets a password nobody has ever seen — 48 bytes of CSPRNG output that
    // is hashed and dropped on the floor. The account is reachable only
    // through the directory until an owner deliberately sets a password on
    // it, which is precisely the intent.
    const unknowablePassword = b64url(randomBytes(48));
    const displayName = claims.name ?? claims.preferred_username ?? "";
    const user = await this.users.create({
      email: identity.email,
      password: unknowablePassword,
      displayName,
      role: this.provisioning.role,
    });

    this.identities.link({ issuer, subject, userId: user.id, emailAtLink: identity.email, now });
    this.identities.noteLogin(issuer, subject, now);
    log.info({ userId: user.id, role: user.role, issuer, subject }, "crew SSO account provisioned");
    return { ok: true, userId: user.id, issuer, subject, link: "created" };
  }

  // --- JWKS ---------------------------------------------------------------

  private async jwks(discovery: OidcDiscovery, force: boolean): Promise<JwksKey[]> {
    const now = this.now();
    const fresh = this.jwksCache && now - this.jwksCache.fetchedAt < this.jwksTtlMs;
    if (fresh && !force) return this.jwksCache!.keys;
    if (force && this.jwksCache && now - this.lastForcedJwksFetchAt < JWKS_REFRESH_COOLDOWN_MS) {
      // Cooled down: answer from cache. See JWKS_REFRESH_COOLDOWN_MS — this is
      // what stops an attacker-chosen `kid` from being a fetch amplifier. Only
      // *forced* fetches are counted, so a rotation is picked up on the first
      // unknown `kid` rather than up to a cooldown later.
      return this.jwksCache.keys;
    }
    if (this.jwksInFlight) return this.jwksInFlight;
    // Claimed before the request, not after: a forced fetch that fails must
    // still consume the window, or an unreachable issuer plus forged `kid`s
    // is the amplifier again.
    if (force) this.lastForcedJwksFetchAt = now;

    this.jwksInFlight = (async () => {
      const raw = await this.getJson(discovery.jwksUri, "the key set");
      const keys = Array.isArray((raw as { keys?: unknown } | null)?.keys)
        ? ((raw as { keys: unknown[] }).keys.filter((k) => !!k && typeof k === "object") as JwksKey[])
        : [];
      if (keys.length === 0) throw new OidcError("The issuer's key set contains no keys.");
      this.jwksCache = { keys, fetchedAt: this.now() };
      return keys;
    })();
    try {
      return await this.jwksInFlight;
    } catch (err) {
      // A failed refetch must not throw away keys that still work: an issuer
      // that is briefly unreachable would otherwise take every login with it,
      // including the operator's login to go and look at why.
      if (this.jwksCache) {
        log.warn({ reason: err instanceof Error ? err.name : "error" }, "JWKS refresh failed; using cached keys");
        return this.jwksCache.keys;
      }
      throw err;
    } finally {
      this.jwksInFlight = null;
    }
  }

  // --- plumbing -----------------------------------------------------------

  private async getJson(url: string, what: string): Promise<unknown> {
    const response = await this.request(url, { method: "GET", headers: { accept: "application/json" } });
    const text = await response.text();
    if (!response.ok) throw new OidcError(`Could not read ${what} (HTTP ${response.status}).`);
    try {
      return JSON.parse(text);
    } catch {
      throw new OidcError(`Could not read ${what}: the answer was not JSON (HTTP ${response.status}).`);
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new OidcError(`The identity provider did not answer within ${this.timeoutMs} ms.`);
      }
      throw new OidcError(`The identity provider is not reachable: ${describeTransport(err, url)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Marks a one-time value used. False means it had already been spent.
   *
   * Expired entries are dropped on the way past, so the register cannot grow
   * without bound from failed logins: every entry has an expiry inherited
   * from the pending login it belongs to.
   */
  private spend(key: string, expiresAt: number): boolean {
    const now = this.now();
    for (const [seen, expiry] of this.spent) {
      if (expiry <= now) this.spent.delete(seen);
    }
    if (this.spent.has(key)) return false;
    this.spent.set(key, expiresAt);
    return true;
  }
}

// ---------------------------------------------------------------------------
// JWKS selection and signature verification
// ---------------------------------------------------------------------------

/**
 * The keys that could plausibly have signed this token.
 *
 * A `kid` in the header narrows to that key; without one, every key of the
 * right type is a candidate and each is tried. `use` and `alg` are honoured
 * when the issuer states them — a key published for encryption must not be
 * accepted for a signature.
 */
function selectKeys(keys: JwksKey[], alg: IdTokenAlg, kid: string | null): JwksKey[] {
  const wanted = ALG_PARAMS[alg];
  return keys.filter((key) => {
    if (kid !== null && key.kid !== kid) return false;
    if (key.kty !== wanted.kty) return false;
    if (key.use !== undefined && key.use !== "sig") return false;
    if (key.alg !== undefined && key.alg !== alg) return false;
    return true;
  });
}

/**
 * One key, one signature check, via WebCrypto.
 *
 * Import failures are answered `false` rather than thrown: a malformed key in
 * an otherwise good key set must not take down verification against the other
 * keys, and a hostile key set must not be able to raise an exception out of a
 * login handler.
 */
async function verifyWith(jwk: JwksKey, alg: IdTokenAlg, signed: Buffer, signature: Buffer): Promise<boolean> {
  const params = ALG_PARAMS[alg];
  try {
    const key = await webcrypto.subtle.importKey(
      "jwk",
      // The JWKS is JSON from the issuer; WebCrypto is what actually
      // validates its shape, and rejects anything it cannot use.
      { ...jwk, key_ops: ["verify"], ext: true } as webcrypto.JsonWebKey,
      params.importParams,
      false,
      ["verify"],
    );
    // Copied into plain views: Node's `Buffer` is a `Uint8Array` over a
    // possibly shared ArrayBuffer, which WebCrypto's `BufferSource` does not
    // accept.
    return await webcrypto.subtle.verify(params.verifyParams, key, new Uint8Array(signature), new Uint8Array(signed));
  } catch {
    return false;
  }
}
