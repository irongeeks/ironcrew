import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import crypto, { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  globalApiLimiter,
  strictApiLimiter,
  authApiLimiter,
  loginRateLimiter,
  isLoginLockedOut,
  recordLoginFailure,
  resetLoginFailures,
} from "./rate-limit.ts";
import {
  isPasswordConfigured,
  getPasswordHash,
  verifyPassword,
  hashPassword,
  createRemoteSession,
  validateRemoteSession,
  invalidateRemoteSession,
  invalidateAllRemoteSessions,
} from "./password.ts";

import {
  ALLOWED_ORIGINS,
  ALLOWED_ORIGIN_SUFFIXES,
  IS_PRODUCTION,
  SESSION_AUTH_TOKEN,
  SESSION_COOKIE_NAME,
} from "../config/runtime.ts";

const CSRF_TOKEN = createHash("sha256").update(`csrf:${SESSION_AUTH_TOKEN}`, "utf8").digest("hex");
const TASK_INTERRUPT_TOKEN_SCOPE = "task_interrupt_v1";

let _db: DatabaseSync | undefined;

/**
 * How a crew session is checked, when identity is in use.
 *
 * A callback rather than an import: this module is the generic HTTP security
 * layer and must not depend on the IronCrew domain, but a person who signed
 * in with their own account should not then be asked for the shared password
 * as well. Registered from the composition root
 * (server/server-main.ts); absent in tests and in any deployment that never
 * creates a user, where behaviour is exactly as before.
 */
type CrewSessionResolver = (token: string, ip?: string, userAgent?: string) => boolean;
let _crewSessionResolver: CrewSessionResolver | null = null;

export function setCrewSessionResolver(resolver: CrewSessionResolver | null): void {
  _crewSessionResolver = resolver;
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

export function isLoopbackRequest(req: { socket?: { remoteAddress?: string } }): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

export function isTrustedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (isLoopbackHostname(u.hostname)) return true;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => u.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

export function parseCookies(headerValue: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headerValue) return out;
  for (const part of headerValue.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function bearerToken(req: Request): string | null {
  const raw = req.header("authorization");
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function getCsrfToken(): string {
  return CSRF_TOKEN;
}

export function csrfTokenFromRequest(req: Request): string | null {
  const raw = req.header("x-csrf-token");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldRequireCsrf(req: Request): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !bearerToken(req);
}

export function hasValidCsrfToken(req: Request): boolean {
  const token = csrfTokenFromRequest(req);
  if (!token) return false;
  return safeSecretEquals(token, CSRF_TOKEN);
}

export function buildTaskInterruptControlToken(taskId: string, sessionId: string): string {
  const input = `${TASK_INTERRUPT_TOKEN_SCOPE}:${SESSION_AUTH_TOKEN}:${taskId}:${sessionId}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hasValidTaskInterruptControlToken(taskId: string, sessionId: string, providedToken: string): boolean {
  const token = providedToken.trim();
  if (!token) return false;
  const expected = buildTaskInterruptControlToken(taskId, sessionId);
  return safeSecretEquals(token, expected);
}

export function cookieToken(req: Request): string | null {
  const cookies = parseCookies(req.header("cookie"));
  const token = cookies[SESSION_COOKIE_NAME];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function isAuthenticated(req: Request): boolean {
  const bearer = bearerToken(req);
  if (bearer && safeSecretEquals(bearer, SESSION_AUTH_TOKEN)) return true;
  const token = cookieToken(req);
  if (safeSecretEquals(token ?? "", SESSION_AUTH_TOKEN)) return true;
  if (_db && token) {
    const ip = req.ip ?? req.socket?.remoteAddress ?? undefined;
    const ua = req.get("user-agent") ?? undefined;
    if (validateRemoteSession(_db, token, ip, ua)) return true;
  }
  // A user signed in with their own account. One login, not two: the crew
  // session is a stronger credential than the shared password — it names a
  // person, expires, and can be revoked — so it satisfies this layer as well.
  if (_crewSessionResolver) {
    const crewToken = crewSessionToken(req);
    if (crewToken) {
      const ip = req.ip ?? req.socket?.remoteAddress ?? undefined;
      const ua = req.get("user-agent") ?? undefined;
      if (_crewSessionResolver(crewToken, ip, ua)) return true;
    }
  }
  return false;
}

/** The IronCrew session cookie, or the header a script would send instead. */
function crewSessionToken(req: Request): string | null {
  const cookie = parseCookies(req.header("cookie"))["ironcrew_session"];
  if (cookie) return cookie;
  const header = req.header("x-ironcrew-session");
  return header && header.trim() !== "" ? header.trim() : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function shouldUseSecureCookie(req: Request): boolean {
  const xfProto = req.header("x-forwarded-proto");
  return Boolean(req.secure || xfProto === "https");
}

export function issueSessionCookie(req: Request, res: Response): void {
  if (safeSecretEquals(cookieToken(req) ?? "", SESSION_AUTH_TOKEN)) return;
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (shouldUseSecureCookie(req)) cookie.push("Secure");
  res.append("Set-Cookie", cookie.join("; "));
}

export function isPublicApiPath(pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname === "/api/auth/session") return true;
  if (pathname === "/api/auth/status") return true;
  if (pathname === "/api/auth/login") return true;
  if (pathname === "/api/auth/logout") return true;
  // The IronCrew login is a front door of its own: requiring the shared
  // password to reach it would mean two passwords for one sign-in, and on an
  // installation that has moved to accounts the shared one is exactly what
  // should stop being handed around.
  if (pathname === "/api/crew/auth/login") return true;
  if (pathname === "/api/crew/auth/logout") return true;
  if (pathname === "/api/crew/auth/status") return true;
  // The directory login is the same front door by another route. Both halves
  // of the flow are unauthenticated by definition — the person has not proved
  // anything yet at `start`, and at `callback` they are holding the issuer's
  // code and nothing else. Leaving them out would put the shared password in
  // front of the sign-in that exists to retire it.
  if (pathname === "/api/crew/auth/oidc/start") return true;
  if (pathname === "/api/crew/auth/oidc/callback") return true;
  if (pathname === "/api/inbox") return true;
  if (pathname === "/api/openapi.json") return true;
  if (pathname === "/api/docs" || pathname.startsWith("/api/docs/")) return true;
  if (pathname === "/api/oauth/start") return true;
  if (pathname.startsWith("/api/oauth/callback/")) return true;
  return false;
}

export function safeSecretEquals(a: string, b: string): boolean {
  const key = Buffer.from(SESSION_AUTH_TOKEN || "fallback-key");
  const ha = crypto.createHmac("sha256", key).update(a).digest();
  const hb = crypto.createHmac("sha256", key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function incomingMessageBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw || Array.isArray(raw)) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function incomingMessageCookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw || Array.isArray(raw)) return null;
  const cookies = parseCookies(raw);
  const token = cookies[SESSION_COOKIE_NAME];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function isIncomingMessageAuthenticated(req: IncomingMessage): boolean {
  const bearer = incomingMessageBearerToken(req);
  if (bearer && safeSecretEquals(bearer, SESSION_AUTH_TOKEN)) return true;
  const cookie = incomingMessageCookieToken(req);
  if (safeSecretEquals(cookie ?? "", SESSION_AUTH_TOKEN)) return true;
  if (_db && cookie) {
    const ip = req.socket?.remoteAddress ?? undefined;
    const uaHeader = req.headers["user-agent"];
    const ua = typeof uaHeader === "string" ? uaHeader : undefined;
    if (validateRemoteSession(_db, cookie, ip, ua)) return true;
  }
  return false;
}

export function isIncomingMessageOriginTrusted(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return true;
  return isTrustedOrigin(origin);
}

export function installSecurityMiddleware(app: Express, db?: DatabaseSync): void {
  _db = db;
  // In production, only allow encrypted WebSocket origins. In development we
  // keep ws: so the Vite dev server and HTTP-served local builds continue to work.
  const connectSrc = IS_PRODUCTION ? ["'self'", "wss:"] : ["'self'", "ws:", "wss:"];
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc,
          workerSrc: ["'self'", "blob:"],
          frameSrc: ["'self'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );

  const corsMiddleware = cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (isTrustedOrigin(origin)) return callback(null, true);
      return callback(new Error("origin_not_allowed"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-inbox-secret", "x-csrf-token", "x-task-interrupt-token"],
    maxAge: 600,
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    corsMiddleware(req, res, (err) => {
      if (err) {
        return res.status(403).json({ error: "origin_not_allowed" });
      }
      next();
    });
  });

  app.use(express.json({ limit: "12mb" }));

  // ── Rate limiting (skipped for loopback) ──
  app.use("/api/", globalApiLimiter);
  app.use("/api/auth/", authApiLimiter);
  app.use("/api/oauth/", authApiLimiter);
  app.use("/api/inbox", strictApiLimiter);
  app.use("/api/messages", strictApiLimiter);
  app.use("/api/core/tasks", strictApiLimiter);

  app.get("/api/auth/status", (_req, res) => {
    res.json({
      passwordConfigured: _db ? isPasswordConfigured(_db) : false,
      authenticated: isAuthenticated(_req),
      isRemote: !isLoopbackRequest(_req),
    });
  });

  app.get("/api/auth/session", (req, res) => {
    const bearer = bearerToken(req);
    const hasBearerAuth = bearer !== null && safeSecretEquals(bearer, SESSION_AUTH_TOKEN);

    if (isLoopbackRequest(req) || hasBearerAuth) {
      issueSessionCookie(req, res);
      return res.json({ ok: true, csrf_token: CSRF_TOKEN });
    }

    // Remote: check for valid remote session cookie
    if (_db) {
      const token = cookieToken(req);
      if (token) {
        const ip = req.ip ?? req.socket?.remoteAddress ?? undefined;
        const ua = req.get("user-agent") ?? undefined;
        if (validateRemoteSession(_db, token, ip, ua)) {
          return res.json({ ok: true, csrf_token: CSRF_TOKEN });
        }
      }
    }

    return res.status(401).json({ error: "unauthorized" });
  });

  app.post("/api/auth/login", loginRateLimiter, async (req, res) => {
    if (!_db) return res.status(503).json({ error: "not_available" });

    const ip = req.socket.remoteAddress ?? "unknown";
    if (isLoginLockedOut(ip)) {
      return res.status(429).json({ error: "too_many_attempts", retry_after_ms: 15 * 60 * 1000 });
    }

    const { password } = req.body ?? {};
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "password_required" });
    }

    const hash = getPasswordHash(_db);
    if (!hash) {
      return res.status(403).json({ error: "remote_access_not_configured" });
    }

    const valid = await verifyPassword(password, hash);
    if (!valid) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: "invalid_password" });
    }

    resetLoginFailures(ip);
    const ua = req.header("user-agent") ?? "unknown";
    const sessionToken = createRemoteSession(_db, ip, ua);

    const cookie = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${7 * 24 * 60 * 60}`,
    ];
    if (shouldUseSecureCookie(req)) cookie.push("Secure");
    res.append("Set-Cookie", cookie.join("; "));
    res.json({ ok: true, csrf_token: CSRF_TOKEN });
  });

  app.post("/api/auth/logout", (req, res) => {
    if (_db) {
      const token = cookieToken(req);
      if (token) invalidateRemoteSession(_db, token);
    }
    const cookie = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
    res.append("Set-Cookie", cookie.join("; "));
    res.json({ ok: true });
  });

  app.put("/api/auth/password", requireAuth, async (req, res) => {
    if (!_db) return res.status(503).json({ error: "not_available" });

    const { password, current_password, new_password } = req.body ?? {};
    const existingHash = getPasswordHash(_db);

    if (existingHash) {
      if (!current_password || typeof current_password !== "string") {
        return res.status(400).json({ error: "current_password_required" });
      }
      if (!new_password || typeof new_password !== "string" || new_password.length < 12) {
        // Minimum 12 chars aligns with NIST SP 800-63B / OWASP guidance for
        // human-chosen passwords. Keeping the same error `code` so clients
        // can continue matching on it; UI should surface the new minimum.
        return res.status(400).json({ error: "new_password_required" });
      }
      const valid = await verifyPassword(current_password, existingHash);
      if (!valid) return res.status(401).json({ error: "invalid_password" });
      const hash = await hashPassword(new_password);
      _db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);
      invalidateAllRemoteSessions(_db);
      return res.json({ ok: true });
    }

    const pw = password ?? new_password;
    if (!pw || typeof pw !== "string" || pw.length < 12) {
      // Minimum 12 chars aligns with NIST SP 800-63B / OWASP guidance.
      return res.status(400).json({ error: "password_required" });
    }
    const hash = await hashPassword(pw);
    _db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("access_password_hash", hash);
    return res.json({ ok: true });
  });

  app.delete("/api/auth/password", requireAuth, async (req, res) => {
    if (!_db) return res.status(503).json({ error: "not_available" });

    const { current_password } = req.body ?? {};
    const existingHash = getPasswordHash(_db);
    if (!existingHash) return res.status(404).json({ error: "no_password_configured" });

    if (!current_password || typeof current_password !== "string") {
      return res.status(400).json({ error: "current_password_required" });
    }
    const valid = await verifyPassword(current_password, existingHash);
    if (!valid) return res.status(401).json({ error: "invalid_password" });

    _db.prepare("DELETE FROM settings WHERE key = 'access_password_hash'").run();
    invalidateAllRemoteSessions(_db);
    return res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (isPublicApiPath(req.path)) return next();
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    // Only issue the master session cookie for loopback/bearer requests.
    // Remote-session-authenticated users already have their own session cookie;
    // overwriting it with SESSION_AUTH_TOKEN would bypass the password model.
    if (isLoopbackRequest(req) || bearerToken(req)) {
      issueSessionCookie(req, res);
    }
    return next();
  });

  // ── Global CSRF guard for all /api/ state-changing requests ──
  // Applies after auth so we can rely on the authenticated-session invariant.
  // Bearer-authenticated requests (API clients, CLI) are exempt via shouldRequireCsrf().
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (isPublicApiPath(req.path)) return next();
    if (!shouldRequireCsrf(req)) return next();
    if (hasValidCsrfToken(req)) return next();
    return res.status(403).json({ error: "csrf_token_invalid" });
  });
}
