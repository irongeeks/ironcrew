import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/runtime.ts", () => ({
  SESSION_AUTH_TOKEN: "test-session-token-abc123",
  SESSION_COOKIE_NAME: "claw_session",
  ALLOWED_ORIGINS: ["https://trusted.example.com"],
  ALLOWED_ORIGIN_SUFFIXES: [".ts.net", ".internal.dev"],
}));

import {
  bearerToken,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  isPublicApiPath,
  isTrustedOrigin,
  parseCookies,
  shouldRequireCsrf,
} from "../../security/auth.ts";
import type { Request } from "express";

function mockReq(
  headers: Record<string, string | undefined>,
  overrides: Partial<{ method: string; socket: { remoteAddress?: string } }> = {},
): Request {
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    method: overrides.method ?? "GET",
    secure: false,
    socket: overrides.socket ?? { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// isLoopbackHostname
// ---------------------------------------------------------------------------
describe("isLoopbackHostname", () => {
  it("returns true for localhost", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
  });

  it("returns true for 127.0.0.1", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  it("returns true for [::1]", () => {
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("is case-insensitive for localhost", () => {
    expect(isLoopbackHostname("LocalHost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
  });

  it("returns false for example.com", () => {
    expect(isLoopbackHostname("example.com")).toBe(false);
  });

  it("returns false for 192.168.1.1", () => {
    expect(isLoopbackHostname("192.168.1.1")).toBe(false);
  });

  it("returns false for 0.0.0.0", () => {
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLoopbackAddress
// ---------------------------------------------------------------------------
describe("isLoopbackAddress", () => {
  it("returns true for 127.0.0.1", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("returns true for ::ffff:127.0.0.1", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("returns false for 10.0.0.1", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLoopbackAddress("")).toBe(false);
  });

  it("returns false for 192.168.1.1", () => {
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLoopbackRequest
// ---------------------------------------------------------------------------
describe("isLoopbackRequest", () => {
  it("returns true when socket has loopback remoteAddress", () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: "::1" } })).toBe(true);
  });

  it("returns false when socket has non-loopback remoteAddress", () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: "10.1.2.3" } })).toBe(false);
  });

  it("returns false when socket is missing", () => {
    expect(isLoopbackRequest({})).toBe(false);
  });

  it("returns false when socket.remoteAddress is undefined", () => {
    expect(isLoopbackRequest({ socket: {} })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTrustedOrigin
// ---------------------------------------------------------------------------
describe("isTrustedOrigin", () => {
  it("trusts http://localhost origins", () => {
    expect(isTrustedOrigin("http://localhost:8800")).toBe(true);
    expect(isTrustedOrigin("http://localhost")).toBe(true);
  });

  it("trusts https://127.0.0.1 origins", () => {
    expect(isTrustedOrigin("https://127.0.0.1:3000")).toBe(true);
  });

  it("trusts http://[::1] origins", () => {
    expect(isTrustedOrigin("http://[::1]:8800")).toBe(true);
  });

  it("trusts explicitly configured ALLOWED_ORIGINS", () => {
    expect(isTrustedOrigin("https://trusted.example.com")).toBe(true);
  });

  it("trusts origins matching ALLOWED_ORIGIN_SUFFIXES", () => {
    expect(isTrustedOrigin("https://myhost.ts.net")).toBe(true);
    expect(isTrustedOrigin("https://app.internal.dev")).toBe(true);
  });

  it("rejects non-loopback, non-configured origins", () => {
    expect(isTrustedOrigin("https://evil.com")).toBe(false);
    expect(isTrustedOrigin("https://attacker.example.com")).toBe(false);
  });

  it("rejects file:// protocol", () => {
    expect(isTrustedOrigin("file:///tmp/test")).toBe(false);
  });

  it("rejects invalid URL strings", () => {
    expect(isTrustedOrigin("not-a-url")).toBe(false);
    expect(isTrustedOrigin("")).toBe(false);
  });

  it("rejects non-http/https protocols", () => {
    expect(isTrustedOrigin("ftp://localhost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseCookies
// ---------------------------------------------------------------------------
describe("parseCookies", () => {
  it("parses standard key=value pairs", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("decodes URI-encoded values", () => {
    expect(parseCookies("name=hello%20world")).toEqual({ name: "hello world" });
  });

  it("handles multi-cookie headers", () => {
    const result = parseCookies("a=1; b=2; c=3");
    expect(Object.keys(result)).toHaveLength(3);
    expect(result.a).toBe("1");
    expect(result.b).toBe("2");
    expect(result.c).toBe("3");
  });

  it("returns empty object for undefined input", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseCookies("")).toEqual({});
  });

  it("handles values with = in them", () => {
    const result = parseCookies("token=abc=def=ghi");
    expect(result.token).toBe("abc=def=ghi");
  });

  it("skips malformed entries without =", () => {
    const result = parseCookies("valid=1; invalid; also=2");
    expect(result).toEqual({ valid: "1", also: "2" });
  });

  it("preserves raw value when decodeURIComponent fails", () => {
    const result = parseCookies("bad=%ZZ");
    expect(result.bad).toBe("%ZZ");
  });
});

// ---------------------------------------------------------------------------
// bearerToken
// ---------------------------------------------------------------------------
describe("bearerToken", () => {
  it("extracts token from Authorization: Bearer xxx", () => {
    const req = mockReq({ authorization: "Bearer my-token" });
    expect(bearerToken(req)).toBe("my-token");
  });

  it("is case insensitive for Bearer prefix", () => {
    const req = mockReq({ authorization: "bearer my-token" });
    expect(bearerToken(req)).toBe("my-token");

    const req2 = mockReq({ authorization: "BEARER my-token" });
    expect(bearerToken(req2)).toBe("my-token");
  });

  it("returns null when authorization header is missing", () => {
    const req = mockReq({});
    expect(bearerToken(req)).toBeNull();
  });

  it("returns null for non-Bearer auth schemes", () => {
    const req = mockReq({ authorization: "Basic dXNlcjpwYXNz" });
    expect(bearerToken(req)).toBeNull();
  });

  it("trims whitespace around the token", () => {
    const req = mockReq({ authorization: "Bearer   spaced-token   " });
    expect(bearerToken(req)).toBe("spaced-token");
  });
});

// ---------------------------------------------------------------------------
// isPublicApiPath
// ---------------------------------------------------------------------------
describe("isPublicApiPath", () => {
  it("returns true for /api/health", () => {
    expect(isPublicApiPath("/api/health")).toBe(true);
  });

  it("returns true for /api/auth/session", () => {
    expect(isPublicApiPath("/api/auth/session")).toBe(true);
  });

  it("returns true for /api/inbox", () => {
    expect(isPublicApiPath("/api/inbox")).toBe(true);
  });

  it("returns true for /api/openapi.json", () => {
    expect(isPublicApiPath("/api/openapi.json")).toBe(true);
  });

  it("returns true for /api/docs and /api/docs/*", () => {
    expect(isPublicApiPath("/api/docs")).toBe(true);
    expect(isPublicApiPath("/api/docs/")).toBe(true);
    expect(isPublicApiPath("/api/docs/some-page")).toBe(true);
  });

  it("returns true for /api/oauth/start", () => {
    expect(isPublicApiPath("/api/oauth/start")).toBe(true);
  });

  it("returns true for /api/oauth/callback/*", () => {
    expect(isPublicApiPath("/api/oauth/callback/github")).toBe(true);
  });

  it("returns false for private paths", () => {
    expect(isPublicApiPath("/api/tasks")).toBe(false);
    expect(isPublicApiPath("/api/agents")).toBe(false);
    expect(isPublicApiPath("/api/messages")).toBe(false);
    expect(isPublicApiPath("/api/settings")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldRequireCsrf
// ---------------------------------------------------------------------------
describe("shouldRequireCsrf", () => {
  it("returns false for GET requests", () => {
    const req = mockReq({}, { method: "GET" });
    expect(shouldRequireCsrf(req)).toBe(false);
  });

  it("returns false for HEAD requests", () => {
    const req = mockReq({}, { method: "HEAD" });
    expect(shouldRequireCsrf(req)).toBe(false);
  });

  it("returns false for OPTIONS requests", () => {
    const req = mockReq({}, { method: "OPTIONS" });
    expect(shouldRequireCsrf(req)).toBe(false);
  });

  it("returns true for POST without Bearer token", () => {
    const req = mockReq({}, { method: "POST" });
    expect(shouldRequireCsrf(req)).toBe(true);
  });

  it("returns false for POST with Bearer token", () => {
    const req = mockReq({ authorization: "Bearer some-token" }, { method: "POST" });
    expect(shouldRequireCsrf(req)).toBe(false);
  });

  it("returns true for PUT without Bearer token", () => {
    const req = mockReq({}, { method: "PUT" });
    expect(shouldRequireCsrf(req)).toBe(true);
  });

  it("returns true for DELETE without Bearer token", () => {
    const req = mockReq({}, { method: "DELETE" });
    expect(shouldRequireCsrf(req)).toBe(true);
  });
});
