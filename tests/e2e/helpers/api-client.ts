import { request, type APIRequestContext } from "@playwright/test";

/** All helper contexts must target the isolated suite's own frontend. */
export function baseURLFromEnv(): string {
  const isolatedUrl = "http://127.0.0.1:8810";
  if (process.env.PW_BASE_URL && process.env.PW_BASE_URL !== isolatedUrl) {
    throw new Error("Refusing to run E2E requests against a non-isolated base URL");
  }
  return isolatedUrl;
}

/**
 * Prime a CSRF token + session cookie by calling `/api/auth/session`, then
 * return a fresh APIRequestContext that auto-includes the `x-csrf-token`
 * header on every request.
 *
 * Use this when a spec needs to POST/PATCH/PUT/DELETE against `/api/*` from
 * an isolated context (instead of relying on the test-level `request`
 * fixture). On the normal dev server CSRF is globally enforced for all
 * state-changing `/api/*` requests, so this is the only reliable way to
 * talk to the API from a raw `request.newContext()` call.
 */
export async function loggedInRequest(baseURL: string = baseURLFromEnv()): Promise<APIRequestContext> {
  const primer = await request.newContext({ baseURL });
  try {
    const sessionRes = await primer.get("/api/auth/session");
    if (!sessionRes.ok()) {
      throw new Error(`GET /api/auth/session failed (status=${sessionRes.status()})`);
    }
    const body = (await sessionRes.json()) as { csrf_token?: string };
    const csrfToken = body.csrf_token;
    if (!csrfToken) {
      throw new Error("No csrf_token returned from /api/auth/session");
    }

    // Carry the session cookie from the primer into the returned context so
    // the CSRF guard (which compares cookie-bound session) is satisfied.
    const storage = await primer.storageState();
    return await request.newContext({
      baseURL,
      extraHTTPHeaders: { "x-csrf-token": csrfToken },
      storageState: storage,
    });
  } finally {
    await primer.dispose();
  }
}

/**
 * Build a raw `ws://` or `wss://` URL for a given path, derived from the
 * configured base URL. Used by specs that open a raw WebSocket (the Playwright
 * APIRequestContext can't upgrade), replacing hardcoded `127.0.0.1:8810`.
 */
export function wsUrl(path: string, baseURL: string = baseURLFromEnv()): string {
  const parsed = new URL(baseURL);
  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${wsProtocol}//${parsed.host}${normalizedPath}`;
}

/**
 * Build an `Origin` header value matching the base URL (required by the
 * server's WebSocket origin check).
 */
export function wsOrigin(baseURL: string = baseURLFromEnv()): string {
  const parsed = new URL(baseURL);
  return `${parsed.protocol}//${parsed.host}`;
}
