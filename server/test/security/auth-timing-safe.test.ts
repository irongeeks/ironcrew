import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import type { Request } from "express";
import { SESSION_AUTH_TOKEN, SESSION_COOKIE_NAME } from "../../config/runtime.ts";
import { isAuthenticated, isIncomingMessageAuthenticated, safeSecretEquals } from "../../security/auth.ts";

function mockRequest(headers: Record<string, string | undefined>): Request {
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    secure: false,
    socket: {
      remoteAddress: "127.0.0.1",
    },
  } as unknown as Request;
}

describe("timing-safe auth comparison", () => {
  it("isAuthenticated returns true with valid bearer token", () => {
    const req = mockRequest({ authorization: `Bearer ${SESSION_AUTH_TOKEN}` });
    expect(isAuthenticated(req)).toBe(true);
  });

  it("isAuthenticated returns false with invalid bearer token", () => {
    const req = mockRequest({ authorization: "Bearer wrong-token-value" });
    expect(isAuthenticated(req)).toBe(false);
  });

  it("isAuthenticated works with valid cookie", () => {
    const req = mockRequest({
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}`,
    });
    expect(isAuthenticated(req)).toBe(true);
  });

  it("isAuthenticated returns false with no credentials", () => {
    const req = mockRequest({});
    expect(isAuthenticated(req)).toBe(false);
  });

  it("isIncomingMessageAuthenticated returns true with valid bearer", () => {
    const incoming = {
      headers: { authorization: `Bearer ${SESSION_AUTH_TOKEN}` },
    } as unknown as IncomingMessage;
    expect(isIncomingMessageAuthenticated(incoming)).toBe(true);
  });

  it("isIncomingMessageAuthenticated returns false with invalid bearer", () => {
    const incoming = {
      headers: { authorization: "Bearer invalid-token" },
    } as unknown as IncomingMessage;
    expect(isIncomingMessageAuthenticated(incoming)).toBe(false);
  });

  it("isIncomingMessageAuthenticated returns true with valid cookie", () => {
    const incoming = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}` },
    } as unknown as IncomingMessage;
    expect(isIncomingMessageAuthenticated(incoming)).toBe(true);
  });

  it("isIncomingMessageAuthenticated returns false with no credentials", () => {
    const incoming = { headers: {} } as unknown as IncomingMessage;
    expect(isIncomingMessageAuthenticated(incoming)).toBe(false);
  });

  it("safeSecretEquals handles different-length strings", () => {
    expect(safeSecretEquals("short", "much-longer-string")).toBe(false);
    expect(safeSecretEquals("abc", "abc")).toBe(true);
    expect(safeSecretEquals("", "")).toBe(true);
    expect(safeSecretEquals("a", "b")).toBe(false);
  });
});
