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
}

export function registerCrewAuthRoutes(app: Express, opts: AuthRoutesOptions): void {
  const { base, auth } = opts;
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
    });
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
