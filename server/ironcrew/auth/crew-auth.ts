/**
 * IronCrew — who is asking, and may they.
 *
 * `UserStore` and `SessionStore` have existed since migration 0017 and were
 * never wired to anything: `/api/crew` had no login, no role check, and every
 * audit entry named the constant `"ceo"`. An audit log whose every entry names
 * the same fictional actor proves the wrong thing carefully. This module is
 * the missing half.
 *
 * TWO LAYERS, DIFFERENT QUESTIONS
 *
 * `server/security/auth.ts` answers "may this client talk to the API at all"
 * — the shared password, the bearer token, the legacy remote session. It is
 * unchanged and still runs first. This module answers "who is this person and
 * what may they do", and only for `/api/crew`. Keeping them separate is what
 * lets identity arrive without breaking an installation that has no users.
 *
 * THE BOOTSTRAP RULE
 *
 * While `crew_users` is empty, the installation is pre-identity: the shared
 * password is the only credential there is, and every request acts with full
 * rights, exactly as before. The moment the first account exists, that stops:
 * `/api/crew` then requires a real session, because from then on there *is* a
 * person to name and no reason to accept an anonymous one.
 *
 * This is not a soft default that can be forgotten. It is checked per request
 * against the live table, so creating the first user switches the whole
 * surface over in the same instant — and deleting the last one switches it
 * back rather than bricking the installation.
 *
 * WHY A HUMAN IS STILL `actor_type: "owner"` IN THE AUDIT LOG
 *
 * `crew_audit_events.actor_type` carries a CHECK constraint over
 * ('owner','agent','system','routine'), and the table is an append-only hash
 * chain. Adding a fourth human-ish value would mean rebuilding it — that is,
 * rewriting the chain whose whole purpose is that it cannot be rewritten. So
 * "owner" keeps its original meaning of "a human at the console", and the
 * thing that actually changes is `actor_id`: a real `usr_…` instead of a
 * constant. The person's role travels in the entry's details.
 */

import type { NextFunction, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { parseCookies } from "../../security/auth.ts";
import { SessionStore, type SessionRow } from "./session-store.ts";
import { UserStore, type UserRole, type UserRow } from "./user-store.ts";
import type { ActorType } from "../domain/audit.ts";

/** The cookie the Command Center carries after a login. */
export const CREW_SESSION_COOKIE = "ironcrew_session";

/** Ordered weakest to strongest, so a guard can be expressed as a minimum. */
const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, owner: 2 };

export interface CrewPrincipal {
  user: UserRow;
  session: SessionRow;
}

/**
 * Who is signed in, per request.
 *
 * A WeakMap rather than a property bolted onto Express's `Request` type: a
 * global type augmentation would put `req.crew` on every request in the
 * process — including the upstream routes that know nothing about it — and
 * make an unset value indistinguishable from an unauthenticated one at the
 * type level. Entries die with the request object.
 */
const principals = new WeakMap<Request, CrewPrincipal>();

/** Who is signed in for this request, or null. */
export function crewOf(req: Request): CrewPrincipal | null {
  return principals.get(req) ?? null;
}

export interface CrewAuth {
  /** Attaches `req.crew` when a session resolves. Never rejects. */
  identify(req: Request, res: Response, next: NextFunction): void;
  /** 401 unless someone is signed in — or the installation has no users yet. */
  requireUser(req: Request, res: Response, next: NextFunction): void;
  /** 403 unless the signed-in user is at least `role`. */
  requireRole(role: UserRole): (req: Request, res: Response, next: NextFunction) => void;
  /**
   * Who to record in the audit log for this request.
   *
   * `actorType` is narrowed to the literal "owner" rather than the whole
   * `ActorType` union: several stores accept only the human subset, and a
   * widened type here would force a cast at each of those call sites — a cast
   * being exactly the thing that would let "routine" through one day.
   */
  actorOf(req: Request): { actorType: Extract<ActorType, "owner">; actorId: string };
  /** True while no account exists — the pre-identity regime. */
  isBootstrap(): boolean;
  users: UserStore;
  sessions: SessionStore;
}

export function tokenFromRequest(req: Request): string | null {
  const header = req.header("cookie");
  const cookie = parseCookies(header)[CREW_SESSION_COOKIE];
  if (cookie) return cookie;
  // Also accepted on a header, for scripts and for the CLI. Same token, same
  // checks — a cookie is a transport, not a second class of credential.
  const auth = req.header("x-ironcrew-session");
  return auth && auth.trim() !== "" ? auth.trim() : null;
}

export function createCrewAuth(db: DatabaseSync): CrewAuth {
  const users = new UserStore(db);
  const sessions = new SessionStore(db);

  const isBootstrap = (): boolean => users.count() === 0;

  const identify = (req: Request, _res: Response, next: NextFunction): void => {
    const token = tokenFromRequest(req);
    if (token) {
      const resolved = sessions.resolve(token, {
        ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
        userAgent: req.get("user-agent") ?? undefined,
      });
      if (resolved) principals.set(req, resolved);
    }
    next();
  };

  const requireUser = (req: Request, res: Response, next: NextFunction): void => {
    if (crewOf(req) || isBootstrap()) return next();
    res.status(401).json({
      ok: false,
      error: "login_required",
      message: "Bitte anmelden — dieser Bereich braucht ein Benutzerkonto.",
    });
  };

  const requireRole =
    (role: UserRole) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const principal = crewOf(req);
      // Bootstrap: no accounts, so no roles to check against. The shared
      // password is the only credential and it is full-rights by definition.
      if (!principal) {
        if (isBootstrap()) return next();
        return void res.status(401).json({
          ok: false,
          error: "login_required",
          message: "Bitte anmelden — dieser Bereich braucht ein Benutzerkonto.",
        });
      }
      if (ROLE_RANK[principal.user.role] >= ROLE_RANK[role]) return next();
      res.status(403).json({
        ok: false,
        error: "forbidden",
        message: `Dafür wird mindestens die Rolle "${role}" gebraucht; angemeldet als "${principal.user.role}".`,
      });
    };

  const actorOf = (req: Request): { actorType: Extract<ActorType, "owner">; actorId: string } => ({
    actorType: "owner",
    // "ceo" survives only for the pre-identity installation, where it is the
    // honest answer: nobody has a name yet.
    actorId: crewOf(req)?.user.id ?? "ceo",
  });

  return { identify, requireUser, requireRole, actorOf, isBootstrap, users, sessions };
}

/**
 * Method-based guard for the whole `/api/crew` surface.
 *
 * Reading needs `viewer`, changing needs `operator`. Expressed once here
 * rather than repeated on 135 route registrations: a per-route list is a list
 * somebody forgets to extend, and the endpoint they forget is the one that
 * ends up open. Endpoints that need more than `operator` say so themselves.
 */
export function methodGuard(auth: CrewAuth) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = (req.method ?? "GET").toUpperCase();
    const needed: UserRole = method === "GET" || method === "HEAD" || method === "OPTIONS" ? "viewer" : "operator";
    auth.requireRole(needed)(req, res, next);
  };
}
