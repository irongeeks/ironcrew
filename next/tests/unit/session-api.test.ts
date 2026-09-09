import { afterEach, it, expect, vi } from "vitest";
import { request, setCsrf, ApiError, SESSION_EXPIRED_EVENT } from "../../apps/web/src/api.ts";

afterEach(() => {
  setCsrf("");
  vi.unstubAllGlobals();
});
function browser() {
  const window = new EventTarget();
  const expired = vi.fn();
  window.addEventListener(SESSION_EXPIRED_EVENT, expired);
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", { documentElement: { lang: "de" } });
  return expired;
}
const unauthorized = () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 });
it("notifies session expiry once, clears CSRF and preserves the HTTP error", async () => {
  const expired = browser();
  setCsrf("expired-session");
  const fetch = vi.fn().mockResolvedValue(unauthorized());
  vi.stubGlobal("fetch", fetch);
  await expect(request("/orders")).rejects.toMatchObject({ status: 401, name: "ApiError" });
  expect(expired).toHaveBeenCalledOnce();
  fetch.mockResolvedValue(unauthorized());
  await expect(request("/session", { method: "DELETE", body: {} })).rejects.toBeInstanceOf(ApiError);
  expect(expired).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[1]![1].headers["X-CSRF-Token"]).toBe("");
});
it("does not expire a newer session because an older in-flight request receives a delayed 401", async () => {
  const expired = browser();
  setCsrf("old-session");
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = request("/orders");
  setCsrf("fresh-session");
  finish(unauthorized());
  await expect(pending).rejects.toBeInstanceOf(ApiError);
  expect(expired).not.toHaveBeenCalled();
});
it("a rejected login without a session remains a login error", async () => {
  const expired = browser();
  vi.stubGlobal("fetch", async () => unauthorized());
  await expect(request("/session", { method: "POST", body: { password: "invalid-login" } })).rejects.toMatchObject({
    status: 401,
  });
  expect(expired).not.toHaveBeenCalled();
});
