import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionContext, runLlmConnectivityTest } from "../qa/connectivity-lib.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("QA session CSRF handling", () => {
  it("sends cookie and CSRF token on mutations, excludes the token from evidence and safe methods", async () => {
    const requests = [];
    vi.stubGlobal("fetch", async (url, init) => {
      requests.push({ url, ...init });
      if (url.endsWith("/api/auth/session")) {
        return new Response(JSON.stringify({ ok: true, csrf_token: "fixture-csrf" }), {
          headers: { "set-cookie": "session=fixture-session; HttpOnly; SameSite=Strict" },
        });
      }
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase());
      const allowed =
        init.headers.Cookie === "session=fixture-session" &&
        (!mutation || init.headers["x-csrf-token"] === "fixture-csrf");
      return new Response(
        JSON.stringify(allowed ? { ok: true, usage: { fixture: { error: null } } } : { error: "csrf_token_invalid" }),
        { status: allowed ? 200 : 403 },
      );
    });
    const context = await createSessionContext();
    expect((await runLlmConnectivityTest(context)).pass).toBe(true);
    for (const method of ["POST", "PUT", "DELETE", "patch"]) {
      expect((await context.requestWithSession({ method, endpoint: "/api/fixture" })).status).toBe(200);
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      await context.requestWithSession({ method, endpoint: "/api/fixture" });
      expect(requests.at(-1).headers["x-csrf-token"]).toBeUndefined();
    }
    expect(JSON.stringify(context.evidence)).not.toContain("fixture-csrf");
    expect(JSON.stringify(context.evidence)).not.toContain("fixture-session");
  });

  it.each([undefined, "", 42])("fails bootstrap when the session CSRF token is invalid (%s)", async (csrf_token) => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, csrf_token }), {
          headers: { "set-cookie": "session=fixture; HttpOnly" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSessionContext()).rejects.toThrow("Session authentication failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
