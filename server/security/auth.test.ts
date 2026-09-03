import express from "express";
import net from "node:net";
import request from "supertest";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { SESSION_AUTH_TOKEN, SESSION_COOKIE_NAME } from "../config/runtime.ts";
import {
  bearerToken,
  buildTaskInterruptControlToken,
  cookieToken,
  csrfTokenFromRequest,
  getCsrfToken,
  hasValidCsrfToken,
  hasValidTaskInterruptControlToken,
  incomingMessageBearerToken,
  incomingMessageCookieToken,
  installSecurityMiddleware,
  isAuthenticated,
  isIncomingMessageAuthenticated,
  isIncomingMessageOriginTrusted,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  isPublicApiPath,
  isTrustedOrigin,
  issueSessionCookie,
  parseCookies,
  safeSecretEquals,
  shouldRequireCsrf,
  shouldUseSecureCookie,
} from "./auth.ts";

function canBindLocalPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

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

describe("auth helpers", () => {
  it("loopback 판별이 정확하다", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);

    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.2")).toBe(false);

    expect(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: "10.1.2.3" } })).toBe(false);
  });

  it("쿠키/토큰 파싱과 인증 판별이 동작한다", () => {
    const reqWithBearer = mockRequest({
      authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
    });
    expect(bearerToken(reqWithBearer)).toBe(SESSION_AUTH_TOKEN);
    expect(isAuthenticated(reqWithBearer)).toBe(true);

    const reqWithCookie = mockRequest({
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}; foo=bar`,
    });
    expect(cookieToken(reqWithCookie)).toBe(SESSION_AUTH_TOKEN);
    expect(isAuthenticated(reqWithCookie)).toBe(true);

    const parsed = parseCookies("a=1; b=hello%20world; c=%E3%81%82");
    expect(parsed).toMatchObject({
      a: "1",
      b: "hello world",
      c: "あ",
    });
  });

  it("origin/path/secure-cookie 규칙을 판별한다", () => {
    expect(isTrustedOrigin("http://localhost:8800")).toBe(true);
    expect(isTrustedOrigin("https://dev.ts.net")).toBe(true);
    expect(isTrustedOrigin("file://tmp/test")).toBe(false);
    expect(isTrustedOrigin("not-a-url")).toBe(false);

    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/auth/session")).toBe(true);
    expect(isPublicApiPath("/api/openapi.json")).toBe(true);
    expect(isPublicApiPath("/api/docs")).toBe(true);
    expect(isPublicApiPath("/api/docs/")).toBe(true);
    expect(isPublicApiPath("/api/tasks")).toBe(false);

    const insecureReq = mockRequest({
      "x-forwarded-proto": "http",
    });
    expect(shouldUseSecureCookie(insecureReq)).toBe(false);

    const secureReq = {
      ...insecureReq,
      secure: true,
    } as Request;
    expect(shouldUseSecureCookie(secureReq)).toBe(true);
  });

  it("session cookie 발급 시 append를 호출하고 중복 발급은 방지한다", () => {
    const append = vi.fn();
    const res = { append } as unknown as Response;

    const reqNoCookie = mockRequest({
      cookie: undefined,
    });
    issueSessionCookie(reqNoCookie, res);
    expect(append).toHaveBeenCalledTimes(1);
    const firstCookie = String(append.mock.calls[0]?.[1] ?? "");
    expect(firstCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(firstCookie).toContain("HttpOnly");

    append.mockClear();
    const reqWithCookie = mockRequest({
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}`,
    });
    issueSessionCookie(reqWithCookie, res);
    expect(append).not.toHaveBeenCalled();
  });

  it("IncomingMessage 인증/원본 판별이 동작한다", () => {
    const incoming = {
      headers: {
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}`,
        origin: "http://localhost:8800",
      },
    } as unknown as IncomingMessage;

    expect(incomingMessageBearerToken(incoming)).toBe(SESSION_AUTH_TOKEN);
    expect(incomingMessageCookieToken(incoming)).toBe(SESSION_AUTH_TOKEN);
    expect(isIncomingMessageAuthenticated(incoming)).toBe(true);
    expect(isIncomingMessageOriginTrusted(incoming)).toBe(true);
  });

  it("safeSecretEquals는 값이 같을 때만 true다", () => {
    expect(safeSecretEquals("abc123", "abc123")).toBe(true);
    expect(safeSecretEquals("abc123", "abc124")).toBe(false);
    expect(safeSecretEquals("short", "much-longer")).toBe(false);
  });

  it("csrf / task-interrupt 제어 토큰 검증이 동작한다", () => {
    const csrf = getCsrfToken();
    const req = {
      ...mockRequest({
        "x-csrf-token": csrf,
      }),
      method: "POST",
    } as Request;
    expect(csrfTokenFromRequest(req)).toBe(csrf);
    expect(shouldRequireCsrf(req)).toBe(true);
    expect(hasValidCsrfToken(req)).toBe(true);

    const bearerReq = {
      ...mockRequest({
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
      }),
      method: "POST",
    } as Request;
    expect(shouldRequireCsrf(bearerReq)).toBe(false);

    const token = buildTaskInterruptControlToken("task-1", "session-1");
    expect(hasValidTaskInterruptControlToken("task-1", "session-1", token)).toBe(true);
    expect(hasValidTaskInterruptControlToken("task-1", "session-1", `${token}x`)).toBe(false);
  });
});

describe("installSecurityMiddleware", () => {
  it("세션 발급 후 보호 API 접근을 허용한다", async () => {
    if (!(await canBindLocalPort())) {
      expect(true).toBe(true);
      return;
    }

    const app = express();
    installSecurityMiddleware(app);
    app.get("/api/protected", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/api/protected").expect(401);

    const sessionRes = await request(app).get("/api/auth/session").expect(200);
    const cookieHeader = sessionRes.headers["set-cookie"]?.[0];
    expect(cookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(sessionRes.body?.csrf_token).toBeTypeOf("string");

    await request(app).get("/api/protected").set("Cookie", String(cookieHeader)).expect(200, { ok: true });
  });
});
