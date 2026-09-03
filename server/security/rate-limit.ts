import rateLimit from "express-rate-limit";
import { isLoopbackRequest } from "./auth.ts";

// ---------------------------------------------------------------------------
// Env-driven configuration (all optional, sensible defaults)
// ---------------------------------------------------------------------------
const envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const GLOBAL_WINDOW_MS = envInt("RATE_LIMIT_GLOBAL_WINDOW_MS", 60_000);
const GLOBAL_MAX = envInt("RATE_LIMIT_GLOBAL_MAX", 300);

const STRICT_WINDOW_MS = envInt("RATE_LIMIT_STRICT_WINDOW_MS", 60_000);
const STRICT_MAX = envInt("RATE_LIMIT_STRICT_MAX", 30);

const AUTH_WINDOW_MS = envInt("RATE_LIMIT_AUTH_WINDOW_MS", 60_000);
const AUTH_MAX = envInt("RATE_LIMIT_AUTH_MAX", 20);

const LOGIN_WINDOW_MS = envInt("RATE_LIMIT_LOGIN_WINDOW_MS", 60_000);
const LOGIN_MAX = envInt("RATE_LIMIT_LOGIN_MAX", 5);
const LOGIN_LOCKOUT_THRESHOLD = envInt("RATE_LIMIT_LOGIN_LOCKOUT_THRESHOLD", 10);
const LOGIN_LOCKOUT_MS = envInt("RATE_LIMIT_LOGIN_LOCKOUT_MS", 15 * 60_000);

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------
const standardHeaders = true; // RateLimit-* headers (draft-6)
const legacyHeaders = false; // no X-RateLimit-* clutter

// ---------------------------------------------------------------------------
// Global API limiter — generous baseline for all /api/* routes
// ---------------------------------------------------------------------------
export const globalApiLimiter = rateLimit({
  windowMs: GLOBAL_WINDOW_MS,
  max: GLOBAL_MAX,
  standardHeaders,
  legacyHeaders,
  skip: isLoopbackRequest,
  message: { error: "rate_limited", retry_after_ms: GLOBAL_WINDOW_MS },
});

// ---------------------------------------------------------------------------
// Strict limiter — for write-heavy / abuse-prone endpoints
// (POST /api/inbox, POST /api/messages, POST /api/core/tasks)
// ---------------------------------------------------------------------------
export const strictApiLimiter = rateLimit({
  windowMs: STRICT_WINDOW_MS,
  max: STRICT_MAX,
  standardHeaders,
  legacyHeaders,
  skip: (req) => isLoopbackRequest(req) || req.method === "GET" || req.method === "HEAD",
  message: { error: "rate_limited", retry_after_ms: STRICT_WINDOW_MS },
});

// ---------------------------------------------------------------------------
// Auth limiter — tightest, protects session/token endpoints
// (POST /api/auth/*, /api/oauth/*)
// ---------------------------------------------------------------------------
export const authApiLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: AUTH_MAX,
  standardHeaders,
  legacyHeaders,
  skip: (req) => isLoopbackRequest(req) || req.method === "GET" || req.method === "HEAD",
  message: { error: "rate_limited", retry_after_ms: AUTH_WINDOW_MS },
});

// ---------------------------------------------------------------------------
// Login rate limiter — 5 requests/minute, skips loopback
// ---------------------------------------------------------------------------
export const loginRateLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_MAX,
  standardHeaders,
  legacyHeaders,
  skip: isLoopbackRequest,
  message: { error: "rate_limited", retry_after_ms: LOGIN_WINDOW_MS },
});

// ---------------------------------------------------------------------------
// Login IP lockout — in-memory tracker for repeated failures
// ---------------------------------------------------------------------------
interface LoginRecord {
  count: number;
  lockedUntil: number;
}

const loginFailures = new Map<string, LoginRecord>();

export function isLoginLockedOut(ip: string): boolean {
  const record = loginFailures.get(ip);
  if (!record) return false;
  if (record.count < LOGIN_LOCKOUT_THRESHOLD) return false;
  return Date.now() < record.lockedUntil;
}

export function recordLoginFailure(ip: string): void {
  const existing = loginFailures.get(ip);
  const count = (existing?.count ?? 0) + 1;
  const lockedUntil = count >= LOGIN_LOCKOUT_THRESHOLD ? Date.now() + LOGIN_LOCKOUT_MS : (existing?.lockedUntil ?? 0);
  loginFailures.set(ip, { count, lockedUntil });
}

export function resetLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}
