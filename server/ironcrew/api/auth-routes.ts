/**
 * IronCrew — signing in, and administering who may.
 *
 * Split from routes.ts because these are the only endpoints that touch
 * credentials, and a file that small is a file a reviewer reads in full.
 *
 * WHAT LOGIN COSTS AN ATTACKER
 *
 * The store already equalises the work (`UserStore.authenticate` runs a full
 * scrypt verification even for an unknown email, so present-vs-absent is not
 * measurable). This layer adds the two things a store cannot: a lockout after
 * repeated failures from one address, and a single answer — "E-Mail oder
 * Passwort stimmt nicht" — for an unknown account, a wrong password and a
 * disabled account alike. Both reuse the machinery the legacy password login
 * already has, rather than growing a second, subtly different one.
 *
 * THE LAST OWNER, AND THE FIRST
 *
 * `UserStore` refuses to demote, disable or delete the last active owner; an
 * installation without one has nobody who can approve anything or create a
 * new owner, and no amount of care afterwards un-bricks it. The other end is
 * here: while no account exists, `POST /users` is open to whoever the shared
 * password already let in, and creates an owner. That is the only moment an
 * unauthenticated caller may create an account.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  isLoginLockedOut,
  recordLoginFailure,
  resetLoginFailures,
  loginRateLimiter,
} from "../../security/rate-limit.ts";
import { shouldUseSecureCookie } from "../../security/auth.ts";
import { CREW_SESSION_COOKIE, crewOf, tokenFromRequest, type CrewAuth } from "../auth/crew-auth.ts";
import { UserMutationError, USER_ROLES, type UserRow } from "../auth/user-store.ts";
import type { SessionRow } from "../auth/session-store.ts";
import { randomBytes } from "node:crypto";
import type { OidcProvider, PendingLogin } from "../auth/oidc-provider.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-auth" });

const loginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const createUserSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  displayName: z.string().max(200).optional(),
  role: z.enum(USER_ROLES).optional(),
});

const updateUserSchema = z.object({
  displayName: z.string().max(200).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

const passwordSchema = z.object({
  currentPassword: z.string().max(1024).optional(),
  newPassword: z.string().min(1).max(1024),
});

function presentUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

/** A session, minus its token hash — that value is not the client's business. */
function presentSession(session: SessionRow, currentId: string | null) {
  return {
    id: session.id,
    ip: session.ip,
    userAgent: session.user_agent,
    createdAt: session.created_at,
    lastSeenAt: session.last_seen_at,
    expiresAt: session.expires_at,
    current: session.id === currentId,
  };
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "";
}

export interface AuthRoutesOptions {
  base: string;
  auth: CrewAuth;
  /**
   * The directory, when an operator configured one. Absent means the password
   * login is the only way in, and `/auth/status` reports that so the gate
   * shows no button behind which nothing stands.
   */
  oidc?: OidcProvider | null;
}

/** Cookie carrying the handle to a login in progress. Not the login itself. */
export const OIDC_PENDING_COOKIE = "ironcrew_oidc_pending";

/**
 * How long a browser has to come back from the identity provider.
 *
 * Long enough to type a password and answer a second factor at an unfamiliar
 * prompt; short enough that an abandoned login is not a credential lying
 * around. The provider enforces its own expiry on the pending login too, so
 * this is the outer of two bounds, not the only one.
 */
const OIDC_PENDING_TTL_MS = 10 * 60_000;

/**
 * Where a redirect after login is allowed to go.
 *
 * Only a path on this origin. `//evil.example` and `/\evil.example` are how a
 * protocol-relative URL sneaks past a naive `startsWith("/")`, and an open
 * redirect on a login callback is the classic way to make a phishing link look
 * like it came from the real system.
 */
function safeRedirect(value: unknown): string {
  if (typeof value !== "string" || value === "") return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export function registerCrewAuthRoutes(app: Express, opts: AuthRoutesOptions): void {
  const { base, auth } = opts;
  const oidc = opts.oidc ?? null;
  const { users, sessions } = auth;

  const setSessionCookie = (req: Request, res: Response, token: string, expiresAt: number): void => {
    const cookie = [
      `${CREW_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Expires=${new Date(expiresAt).toUTCString()}`,
    ];
    if (shouldUseSecureCookie(req)) cookie.push("Secure");
    res.append("Set-Cookie", cookie.join("; "));
  };

  const clearSessionCookie = (req: Request, res: Response): void => {
    const cookie = [`${CREW_SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
    if (shouldUseSecureCookie(req)) cookie.push("Secure");
    res.append("Set-Cookie", cookie.join("; "));
  };

  // --- who am I -----------------------------------------------------------

  /**
   * Answers before a login, on purpose: the UI has to know whether to show a
   * login form, a "create the first account" form, or nothing at all. It
   * reveals only whether accounts exist, never who they are.
   */
  app.get(`${base}/auth/status`, (req, res) => {
    const principal = crewOf(req);
    res.json({
      bootstrap: auth.isBootstrap(),
      authenticated: principal !== null,
      user: principal ? presentUser(principal.user) : null,
      // Whether there is a second way in at all. Reported rather than left to
      // the UI to guess, so an installation without a directory shows no
      // "Mit Authentik anmelden" button with nothing behind it. The issuer is
      // named because an operator needs to see *which* directory this box
      // trusts; nothing else about the configuration is exposed, and never
      // the client secret.
      oidc: oidc ? { configured: true, issuer: oidc.issuer } : { configured: false },
    });
  });

  // --- signing in through the directory ------------------------------------
  //
  // WHY THE LOGIN IN PROGRESS LIVES ON THE SERVER
  //
  // Between the redirect out and the callback back, three secrets have to
  // survive: the PKCE code verifier, the nonce, and the state. The obvious
  // place is a cookie, and it is the wrong one here. A cookie is a value the
  // browser holds and anything that can set cookies for this origin can
  // replace — swap the issuer in it and the callback would exchange the code
  // at somewhere else entirely. Signing it would fix that and needs a signing
  // key this installation does not have.
  //
  // So the pending login stays here, in memory, and the browser carries only
  // an opaque handle. There is nothing in the cookie to tamper with.
  //
  // The cost, stated plainly: a restart during a login loses it and the person
  // starts again, and a second control-plane process would not find the
  // handle. The provider's own replay registry is already in-process for the
  // same reason (see oidc-provider.ts), so this adds no new limitation.
  const pendingLogins = new Map<string, { pending: PendingLogin; expiresAt: number }>();

  function rememberPending(pending: PendingLogin): string {
    const now = Date.now();
    // Swept on write rather than on a timer: an abandoned login is a few
    // hundred bytes, and a timer here would be a second thing to shut down.
    for (const [key, value] of pendingLogins) if (value.expiresAt <= now) pendingLogins.delete(key);
    const handle = randomBytes(32).toString("base64url");
    pendingLogins.set(handle, { pending, expiresAt: now + OIDC_PENDING_TTL_MS });
    return handle;
  }

  function takePending(handle: string | undefined): PendingLogin | null {
    if (!handle) return null;
    const found = pendingLogins.get(handle);
    // Single use, whatever the outcome: a login attempt is consumed by being
    // answered, so a replayed callback finds nothing.
    pendingLogins.delete(handle);
    if (!found || found.expiresAt <= Date.now()) return null;
    return found.pending;
  }

  const setPendingCookie = (req: Request, res: Response, handle: string): void => {
    const cookie = [
      `${OIDC_PENDING_COOKIE}=${handle}`,
      "Path=/",
      "HttpOnly",
      // Lax, not Strict, and this is the one place that difference matters:
      // the callback arrives as a top-level navigation from the identity
      // provider's origin, and a Strict cookie is not sent on one. The cookie
      // holds an opaque handle to a single-use login attempt, so Lax costs
      // nothing here.
      "SameSite=Lax",
      `Max-Age=${Math.floor(OIDC_PENDING_TTL_MS / 1000)}`,
    ];
    if (shouldUseSecureCookie(req)) cookie.push("Secure");
    res.append("Set-Cookie", cookie.join("; "));
  };

  const clearPendingCookie = (req: Request, res: Response): void => {
    const cookie = [`${OIDC_PENDING_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (shouldUseSecureCookie(req)) cookie.push("Secure");
    res.append("Set-Cookie", cookie.join("; "));
  };

  function pendingHandle(req: Request): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === OIDC_PENDING_COOKIE) return rest.join("=") || undefined;
    }
    return undefined;
  }

  app.get(`${base}/auth/oidc/start`, loginRateLimiter, async (req, res) => {
    if (!oidc) {
      return void res.status(404).json({ ok: false, error: "oidc_not_configured" });
    }
    try {
      const { authorizationUrl, pending } = await oidc.beginLogin({
        redirectTo: safeRedirect(req.query.redirectTo),
      });
      setPendingCookie(req, res, rememberPending(pending));
      res.redirect(302, authorizationUrl);
    } catch (err) {
      // Discovery failed: the directory is down or misconfigured. Said here
      // rather than swallowed, because the person is staring at a login page
      // that did nothing.
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "oidc login could not be started");
      res.redirect(302, "/?oidc_error=provider_unreachable");
    }
  });

  app.get(`${base}/auth/oidc/callback`, loginRateLimiter, async (req, res) => {
    if (!oidc) {
      return void res.status(404).json({ ok: false, error: "oidc_not_configured" });
    }

    const pending = takePending(pendingHandle(req));
    clearPendingCookie(req, res);

    // The identity provider's own refusal comes back as `error`, and the
    // person needs to land somewhere that says so rather than on a blank
    // callback URL. Only the code travels, never `error_description`, which
    // is attacker-influenced text on its way into a URL.
    const idpError = typeof req.query.error === "string" ? req.query.error : null;
    if (idpError) {
      log.warn({ error: idpError }, "identity provider refused the login");
      return void res.redirect(302, "/?oidc_error=provider_refused");
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!pending || !code || !state) {
      // No pending login means a callback nobody here started: a replay, a
      // bookmark, or a restart mid-login. Indistinguishable on purpose.
      return void res.redirect(302, "/?oidc_error=no_login_in_progress");
    }

    const issuerParam = typeof req.query.iss === "string" ? req.query.iss : undefined;
    const result = await oidc.completeLogin({ code, state, pending, issuer: issuerParam });

    if (!result.ok) {
      // The reason is logged in full for an operator and reduced to a code in
      // the URL. Refusal messages name the issuer and subject so an owner can
      // link an account, and neither belongs in a browser's history.
      log.warn({ reason: result.reason, message: result.message }, "oidc login refused");
      return void res.redirect(302, `/?oidc_error=${encodeURIComponent(result.reason)}`);
    }

    const ip = clientIp(req);
    const { token, session } = sessions.create(result.userId, {
      ip,
      userAgent: req.get("user-agent") ?? undefined,
    });
    setSessionCookie(req, res, token, session.expires_at);
    // Ends in exactly the row a password login would have produced. There is
    // one kind of session in this system, and `actor_id` stays the same
    // `usr_…` whichever door the person came through (docs/IDENTITY.md).
    log.info({ userId: result.userId, issuer: result.issuer, link: result.link }, "crew login via directory");
    res.redirect(302, safeRedirect(pending.redirectTo));
  });

  app.post(`${base}/auth/login`, loginRateLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res
        .status(400)
        .json({ ok: false, error: "validation_failed", message: "E-Mail und Passwort nötig." });
    }

    const ip = clientIp(req);
    if (isLoginLockedOut(ip)) {
      return void res.status(429).json({
        ok: false,
        error: "locked_out",
        message: "Zu viele Fehlversuche. Bitte später erneut probieren.",
      });
    }

    const user = await users.authenticate(parsed.data.email, parsed.data.password);
    if (!user) {
      recordLoginFailure(ip);
      // One answer for unknown account, wrong password and disabled account.
      // Which of the three it was is exactly what an attacker is probing for.
      log.warn({ ip }, "crew login failed");
      return void res
        .status(401)
        .json({ ok: false, error: "invalid_credentials", message: "E-Mail oder Passwort stimmt nicht." });
    }

    resetLoginFailures(ip);
    const { token, session } = sessions.create(user.id, { ip, userAgent: req.get("user-agent") ?? undefined });
    setSessionCookie(req, res, token, session.expires_at);
    log.info({ userId: user.id, role: user.role }, "crew login");
    res.json({ ok: true, user: presentUser(user) });
  });

  app.post(`${base}/auth/logout`, (req, res) => {
    const token = tokenFromRequest(req);
    // Revoked server-side as well as cleared client-side: a cookie the browser
    // forgets is still a valid credential to anyone who copied it.
    if (token) sessions.revoke(token);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get(`${base}/auth/sessions`, auth.requireUser, (req, res) => {
    const principal = crewOf(req);
    if (!principal) return void res.json({ sessions: [] });
    res.json({
      sessions: sessions.listForUser(principal.user.id).map((s) => presentSession(s, principal.session.id)),
    });
  });

  app.delete(`${base}/auth/sessions/:id`, auth.requireUser, (req, res) => {
    const principal = crewOf(req);
    if (!principal) return void res.status(401).json({ ok: false, error: "login_required" });

    const session = sessions.getById(String(req.params.id));
    // Only your own sessions, and a 404 rather than a 403 for someone else's:
    // "that session exists but is not yours" is information nobody needs.
    if (!session || session.user_id !== principal.user.id) {
      return void res.status(404).json({ ok: false, error: "session_not_found" });
    }
    sessions.revokeById(session.id);
    if (session.id === principal.session.id) clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  /**
   * Changing your own password.
   *
   * The current password is required even though the session already proves
   * possession of the account: a session cookie is the thing an attacker is
   * most likely to have stolen, and a password change is how they would make
   * that theft permanent.
   */
  app.post(`${base}/auth/password`, auth.requireUser, async (req, res) => {
    const principal = crewOf(req);
    if (!principal) return void res.status(401).json({ ok: false, error: "login_required" });

    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ ok: false, error: "validation_failed", message: "Neues Passwort nötig." });
    }
    const verified = await users.authenticate(principal.user.email, parsed.data.currentPassword ?? "");
    if (!verified) {
      return void res
        .status(403)
        .json({ ok: false, error: "invalid_credentials", message: "Das aktuelle Passwort stimmt nicht." });
    }

    try {
      await users.setPassword(principal.user.id, parsed.data.newPassword, {
        actorType: "owner",
        actorId: principal.user.id,
      });
    } catch (err) {
      if (err instanceof UserMutationError) {
        return void res.status(400).json({ ok: false, error: "invalid_password", message: err.message });
      }
      throw err;
    }

    // Every other session of this account goes: if the reason for the change
    // was a suspected theft, leaving the thief signed in defeats it.
    const revoked = sessions.revokeAllForUser(principal.user.id);
    const { token, session } = sessions.create(principal.user.id, {
      ip: clientIp(req),
      userAgent: req.get("user-agent") ?? undefined,
    });
    setSessionCookie(req, res, token, session.expires_at);
    res.json({ ok: true, revokedSessions: Math.max(0, revoked - 1) });
  });

  // --- user administration ------------------------------------------------

  app.get(`${base}/users`, auth.requireRole("owner"), (_req, res) => {
    res.json({ users: users.list().map(presentUser) });
  });

  app.post(`${base}/users`, async (req, res) => {
    // The one unauthenticated write in this file, and only while no account
    // exists: somebody has to be able to create the first owner, and at that
    // moment the shared password is the only credential there is.
    const bootstrap = auth.isBootstrap();
    const principal = crewOf(req);
    if (!bootstrap && principal?.user.role !== "owner") {
      return void res.status(principal ? 403 : 401).json({
        ok: false,
        error: principal ? "forbidden" : "login_required",
        message: "Benutzer anlegen darf nur ein Owner.",
      });
    }

    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({
        ok: false,
        error: "validation_failed",
        message: "E-Mail und Passwort nötig.",
        details: parsed.error.issues,
      });
    }

    try {
      const user = await users.create(parsed.data, {
        actorType: "owner",
        actorId: principal?.user.id ?? "ceo",
      });
      log.info({ userId: user.id, role: user.role, bootstrap }, "crew user created");
      res.status(201).json({ ok: true, user: presentUser(user) });
    } catch (err) {
      if (err instanceof UserMutationError) {
        return void res.status(400).json({ ok: false, error: "invalid_user", message: err.message });
      }
      throw err;
    }
  });

  app.patch(`${base}/users/:id`, auth.requireRole("owner"), (req, res) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ ok: false, error: "validation_failed", details: parsed.error.issues });
    }
    const principal = crewOf(req);
    try {
      const user = users.update(String(req.params.id), parsed.data, {
        actorType: "owner",
        actorId: principal?.user.id ?? "ceo",
      });
      if (!user) return void res.status(404).json({ ok: false, error: "user_not_found" });
      // A disabled account's sessions stop resolving on the next request
      // anyway (SessionStore re-reads the account), but revoking is explicit
      // and immediate rather than implicit and eventual.
      if (user.status === "disabled") sessions.revokeAllForUser(user.id);
      res.json({ ok: true, user: presentUser(user) });
    } catch (err) {
      if (err instanceof UserMutationError) {
        return void res.status(409).json({ ok: false, error: "invalid_user_mutation", message: err.message });
      }
      throw err;
    }
  });

  app.post(`${base}/users/:id/password`, auth.requireRole("owner"), async (req, res) => {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ ok: false, error: "validation_failed", message: "Neues Passwort nötig." });
    }
    const principal = crewOf(req);
    try {
      const user = await users.setPassword(String(req.params.id), parsed.data.newPassword, {
        actorType: "owner",
        actorId: principal?.user.id ?? "ceo",
      });
      if (!user) return void res.status(404).json({ ok: false, error: "user_not_found" });
      // An owner resetting someone else's password ends that person's
      // sessions: the usual reason for the reset is that they lost control of
      // the account.
      sessions.revokeAllForUser(user.id);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof UserMutationError) {
        return void res.status(400).json({ ok: false, error: "invalid_password", message: err.message });
      }
      throw err;
    }
  });

  app.delete(`${base}/users/:id`, auth.requireRole("owner"), (req, res) => {
    const principal = crewOf(req);
    try {
      users.delete(String(req.params.id), { actorType: "owner", actorId: principal?.user.id ?? "ceo" });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof UserMutationError) {
        return void res.status(409).json({ ok: false, error: "invalid_user_mutation", message: err.message });
      }
      throw err;
    }
  });
}
