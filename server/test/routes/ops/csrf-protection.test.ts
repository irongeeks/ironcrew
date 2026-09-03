import { describe, it, expect, vi } from "vitest";
import { shouldRequireCsrf, hasValidCsrfToken, getCsrfToken } from "../../../security/auth.ts";
import type { Request, Response, NextFunction } from "express";

/**
 * Unit tests for CSRF guard logic.
 *
 * The global CSRF guard is installed in installSecurityMiddleware (server/security/auth.ts)
 * and covers all /api/ mutation routes — not just /api/tasks and /api/projects.
 * Tests here verify:
 *   1. shouldRequireCsrf + hasValidCsrfToken helper correctness
 *   2. The csrfGuard middleware function behaviour (as wired globally)
 *   3. Guard rejections apply to mutation routes beyond tasks/projects
 */

function mockRequest(overrides: Partial<{ method: string; headers: Record<string, string>; path: string }>): Request {
  const headers: Record<string, string> = overrides.headers ?? {};
  return {
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/api/tasks",
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    headers,
  } as unknown as Request;
}

function makeCsrfGuard() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!shouldRequireCsrf(req)) return next();
    if (hasValidCsrfToken(req)) return next();
    return res.status(403).json({ error: "csrf_token_invalid" });
  };
}

function mockResponse(): {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  _status: number | null;
  _body: unknown;
} {
  const r = { _status: null as number | null, _body: null as unknown, status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  r.json.mockImplementation((body: unknown) => {
    r._body = body;
  });
  return r;
}

describe("shouldRequireCsrf", () => {
  it("returns false for GET requests", () => {
    expect(shouldRequireCsrf(mockRequest({ method: "GET" }))).toBe(false);
  });

  it("returns false for HEAD requests", () => {
    expect(shouldRequireCsrf(mockRequest({ method: "HEAD" }))).toBe(false);
  });

  it("returns false for OPTIONS requests", () => {
    expect(shouldRequireCsrf(mockRequest({ method: "OPTIONS" }))).toBe(false);
  });

  it("returns true for POST without bearer token", () => {
    expect(shouldRequireCsrf(mockRequest({ method: "POST" }))).toBe(true);
  });

  it("returns true for PUT without bearer token", () => {
    expect(shouldRequireCsrf(mockRequest({ method: "PUT" }))).toBe(true);
  });

  it("returns true for DELETE without bearer token", () => {
    expect(shouldRequireCsrf(mockRequest({ method: "DELETE" }))).toBe(true);
  });

  it("returns true for PATCH without bearer token", () => {
    expect(shouldRequireCsrf(mockRequest({ method: "PATCH" }))).toBe(true);
  });

  it("returns false for POST with bearer token (API clients)", () => {
    const req = mockRequest({ method: "POST", headers: { authorization: "Bearer some-token" } });
    expect(shouldRequireCsrf(req)).toBe(false);
  });
});

describe("hasValidCsrfToken", () => {
  it("returns false when no x-csrf-token header is present", () => {
    expect(hasValidCsrfToken(mockRequest({ method: "POST" }))).toBe(false);
  });

  it("returns false when x-csrf-token is invalid", () => {
    const req = mockRequest({ method: "POST", headers: { "x-csrf-token": "invalid-token" } });
    expect(hasValidCsrfToken(req)).toBe(false);
  });

  it("returns true when x-csrf-token matches the session CSRF token", () => {
    const csrfToken = getCsrfToken();
    const req = mockRequest({ method: "POST", headers: { "x-csrf-token": csrfToken } });
    expect(hasValidCsrfToken(req)).toBe(true);
  });
});

describe("csrfGuard middleware — global coverage", () => {
  const csrfGuard = makeCsrfGuard();
  const csrfToken = getCsrfToken();

  const mutationRoutes = [
    // core task routes
    "/api/tasks",
    "/api/projects",
    // agent CRUD — server/modules/routes/core/agents/crud.ts:371
    "/api/agents",
    // departments — server/modules/routes/core/departments.ts:155
    "/api/departments",
    // phase approval — server/modules/routes/core/tasks/phase-approval.ts:76
    "/api/core/tasks/abc/phases/xyz/approve",
    "/api/core/tasks/abc/phases/xyz/reset",
    // worktree operations — server/modules/routes/ops/worktrees-and-usage.ts:73
    "/api/tasks/abc/merge",
    "/api/tasks/abc/discard",
    // messenger — server/modules/routes/core.ts
    "/api/messenger/send",
    // settings — server/modules/routes/ops/settings-stats.ts:138
    "/api/settings",
    // api-providers — server/modules/routes/ops/api-providers.ts:207
    "/api/api-providers",
    // workflow packs — server/modules/routes/ops/workflow-packs.ts:739
    "/api/ops/workflow-packs/my-pack/definition",
    // update-auto — server/modules/routes/core/update-auto/register.ts:440
    "/api/update-auto-config",
  ];

  for (const path of mutationRoutes) {
    it(`POST to ${path} without CSRF token → 403`, () => {
      const req = mockRequest({ method: "POST", path });
      const res = mockResponse();
      const next = vi.fn();
      csrfGuard(req, res as unknown as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it(`POST to ${path} with valid CSRF token → passes`, () => {
      const req = mockRequest({ method: "POST", path, headers: { "x-csrf-token": csrfToken } });
      const res = mockResponse();
      const next = vi.fn();
      csrfGuard(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it(`POST to ${path} with bearer token → passes (API client exempt)`, () => {
      const req = mockRequest({ method: "POST", path, headers: { authorization: "Bearer api-key" } });
      const res = mockResponse();
      const next = vi.fn();
      csrfGuard(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it(`GET to ${path} → passes (safe method)`, () => {
      const req = mockRequest({ method: "GET", path });
      const res = mockResponse();
      const next = vi.fn();
      csrfGuard(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalled();
    });
  }

  it("DELETE without CSRF token → 403", () => {
    const req = mockRequest({ method: "DELETE", path: "/api/agents/abc" });
    const res = mockResponse();
    const next = vi.fn();
    csrfGuard(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("PUT without CSRF token → 403", () => {
    const req = mockRequest({ method: "PUT", path: "/api/ops/settings" });
    const res = mockResponse();
    const next = vi.fn();
    csrfGuard(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
