import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetApiRuntimeForTests } from "../api/core";
import { requestJson } from "./panel-api";
beforeEach(() => {
  __resetApiRuntimeForTests();
  sessionStorage.clear();
  sessionStorage.setItem("claw_api_csrf_token", "test-csrf");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each(["/api/crew/project-plans/task/review", "/api/crew/coaching/proposals", "/api/crew/fleet/enrollments"])(
  "sends parseable JSON with the real CSRF transport to %s",
  async (url) => {
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = new Headers(options?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("x-csrf-token")).toBe("test-csrf");
      expect(JSON.parse(String(options?.body))).toEqual({ decision: "approved" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestJson(url, { method: "POST", body: JSON.stringify({ decision: "approved" }) })).toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
