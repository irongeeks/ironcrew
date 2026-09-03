// safeFetch contract:
//   - Every hop (initial URL + every Location target on a redirect) is
//     re-validated through assertSsrfSafeUrl and gets a fresh request-scoped
//     pinned undici dispatcher.  We never let undici follow redirects
//     internally, because its default redirect path skips our SSRF guard and
//     does NOT honour the dispatcher's connect.lookup for IP-literal targets.
//   - Hop limit defaults to 5; exceeding it throws SsrfRedirectLimitError.
//   - init.redirect: "manual" returns the redirect response as-is;
//     "error" throws on the first redirect; default "follow" runs the
//     re-validating loop.

import { Agent, fetch as undiciFetch } from "undici";
import type { LookupFunction } from "node:net";
import { assertSsrfSafeUrl, SsrfBlockedError, type SsrfPinnedAddress } from "./ssrf.ts";

/**
 * Build a request-scoped undici dispatcher whose `connect.lookup` always
 * returns the pinned IP family + address.  This means the HTTP client will
 * NOT perform its own DNS resolution — eliminating the TOCTOU window between
 * `assertSsrfSafeUrl()` (which validates the IP) and the eventual TCP
 * connection (which would otherwise re-resolve the hostname, possibly to a
 * private/metadata IP under a DNS-rebinding attack).
 *
 * The original URL (and therefore the original Host header + TLS SNI) is
 * preserved untouched, so HTTPS certificate validation still matches the
 * advertised hostname.  Only the underlying `socket.connect()` lookup is
 * pinned.
 */
export function createPinnedDispatcher(pin: SsrfPinnedAddress): Agent {
  const lookup: LookupFunction = (_hostname, _options, cb) => {
    // undici types `LookupFunction` matches `dns.lookup`'s signature.
    // We always answer with the pinned IP — never re-resolve.
    cb(null, pin.ip, pin.family);
  };

  return new Agent({
    connect: { lookup },
  });
}

/**
 * Options accepted by {@link safeFetch}.  Mirrors `RequestInit` plus an
 * `allowLocal` flag forwarded to {@link assertSsrfSafeUrl} for call sites
 * that legitimately target local services (Ollama, LM Studio, etc.) and an
 * optional `maxRedirects` override.
 */
export interface SafeFetchInit extends RequestInit {
  allowLocal?: boolean;
  /** Max redirect hops we follow before throwing.  Default 5. */
  maxRedirects?: number;
}

/**
 * Thrown by {@link safeFetch} when the redirect chain exceeds the hop limit.
 * Distinct from {@link SsrfBlockedError} so callers can tell "too many hops"
 * from "blocked target".
 */
export class SsrfRedirectLimitError extends Error {
  readonly code = "SSRF_REDIRECT_LIMIT";
  constructor(message: string) {
    super(message);
    this.name = "SsrfRedirectLimitError";
  }
}

/**
 * Dispatcher factory injection seam — overridden in tests so we can count
 * how many request-scoped dispatchers were created across a redirect chain
 * without standing up real sockets.  Production code uses
 * {@link createPinnedDispatcher} unchanged.
 */
type DispatcherFactory = (pin: SsrfPinnedAddress) => Agent;
let dispatcherFactory: DispatcherFactory = createPinnedDispatcher;

/** @internal — test-only override for the dispatcher factory. */
export function __setDispatcherFactoryForTests(factory: DispatcherFactory | null): void {
  dispatcherFactory = factory ?? createPinnedDispatcher;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

function getHeader(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function stripHeader(init: RequestInit, name: string): RequestInit {
  const headers = init.headers;
  if (!headers) return init;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    next.delete(name);
    return { ...init, headers: next };
  }
  if (Array.isArray(headers)) {
    return { ...init, headers: headers.filter(([k]) => k.toLowerCase() !== lower) };
  }
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() !== lower) next[k] = v;
  }
  return { ...init, headers: next };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/**
 * SSRF-safe drop-in replacement for `fetch(url, init)`.
 *
 * Pipeline:
 *   1. Calls {@link assertSsrfSafeUrl} which resolves DNS once and validates
 *      every returned IP against the blocklist.  Throws {@link SsrfBlockedError}
 *      on any private / loopback / link-local / cloud-metadata target.
 *   2. Builds a request-scoped undici `Agent` whose `connect.lookup` always
 *      returns the validated IP — closing the rebinding TOCTOU window.
 *   3. Performs the fetch with `redirect: "manual"` so undici never follows
 *      a Location header on its own (which would skip our SSRF guard).  If
 *      the response is a redirect and the caller wants follow semantics, we
 *      resolve the Location, run it through assertSsrfSafeUrl again, build a
 *      fresh dispatcher, and re-issue the request.  Up to maxRedirects hops.
 *
 * @throws {SsrfBlockedError} if any hop targets a blocked address range.
 * @throws {SsrfRedirectLimitError} if the chain exceeds maxRedirects.
 */
export async function safeFetch(url: string, init?: SafeFetchInit): Promise<Response> {
  const { allowLocal, maxRedirects, ...rest } = init ?? {};
  const limit = typeof maxRedirects === "number" && maxRedirects >= 0 ? maxRedirects : DEFAULT_MAX_REDIRECTS;
  const callerRedirectMode: "follow" | "error" | "manual" =
    (rest.redirect as "follow" | "error" | "manual" | undefined) ?? "follow";

  let currentUrl = url;
  let currentInit: RequestInit = { ...rest };
  // Drop the caller's redirect mode from the init we hand to undici — we
  // always force "manual" internally and emulate the requested mode ourselves.
  delete (currentInit as { redirect?: unknown }).redirect;

  const dispatchersToClose: Agent[] = [];

  const closeAll = () => {
    for (const d of dispatchersToClose) {
      d.close().catch(() => {});
    }
  };

  try {
    for (let hop = 0; ; hop++) {
      const pin = await assertSsrfSafeUrl(currentUrl, { allowLocal: !!allowLocal });
      const dispatcher = dispatcherFactory(pin);
      dispatchersToClose.push(dispatcher);

      let response: Response;
      try {
        response = (await undiciFetch(currentUrl, {
          ...(currentInit as Parameters<typeof undiciFetch>[1]),
          dispatcher,
          redirect: "manual",
        })) as unknown as Response;
      } catch (err) {
        closeAll();
        throw err;
      }

      const isRedirect = REDIRECT_STATUSES.has(response.status);
      if (!isRedirect) {
        // Schedule teardown of every dispatcher used in this chain after the
        // body has had a chance to be consumed.  Agent.close() drains idle
        // sockets but does not abort active streams, so this is safe with SSE.
        const toClose = dispatchersToClose.slice();
        queueMicrotask(() => {
          for (const d of toClose) {
            d.close().catch(() => {});
          }
        });
        return response;
      }

      // It's a redirect.  Honour caller's redirect mode.
      if (callerRedirectMode === "manual") {
        const toClose = dispatchersToClose.slice();
        queueMicrotask(() => {
          for (const d of toClose) {
            d.close().catch(() => {});
          }
        });
        return response;
      }
      if (callerRedirectMode === "error") {
        // Drain body, throw a fetch-style error.
        await response.body?.cancel().catch(() => {});
        closeAll();
        throw new TypeError(`Redirect not allowed (status ${response.status} from ${currentUrl})`);
      }

      // "follow" — extract Location, re-validate, re-pin, and continue.
      const location = response.headers.get("location");
      if (!location) {
        // No Location → cannot follow; return as-is (browsers do the same).
        const toClose = dispatchersToClose.slice();
        queueMicrotask(() => {
          for (const d of toClose) {
            d.close().catch(() => {});
          }
        });
        return response;
      }

      // Drain the redirect response body before moving on.
      await response.body?.cancel().catch(() => {});

      if (hop >= limit) {
        closeAll();
        throw new SsrfRedirectLimitError(
          `safeFetch exceeded redirect limit of ${limit} (last hop: ${currentUrl} → ${location})`,
        );
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        closeAll();
        throw new TypeError(`Invalid Location header on redirect from ${currentUrl}: ${location}`);
      }

      // HTTP semantics for method/body across the redirect.  We follow the
      // browser-practical convention undici itself uses when redirect:"follow"
      // is enabled:
      //   - 303: change method to GET, drop body.
      //   - 301/302: if method is not GET/HEAD, change to GET and drop body.
      //   - 307/308: preserve method and body.
      const status = response.status;
      const currentMethod = (currentInit.method ?? "GET").toUpperCase();
      let nextMethod = currentMethod;
      let nextBody = currentInit.body;
      if (status === 303) {
        nextMethod = "GET";
        nextBody = undefined;
      } else if (status === 301 || status === 302) {
        if (currentMethod !== "GET" && currentMethod !== "HEAD") {
          nextMethod = "GET";
          nextBody = undefined;
        }
      }
      // 307 / 308 preserve method+body.

      let nextInit: RequestInit = {
        ...currentInit,
        method: nextMethod,
        body: nextBody as RequestInit["body"],
      };

      // Cross-origin hop: strip Authorization (browsers do this).
      if (!sameOrigin(currentUrl, nextUrl) && getHeader(nextInit, "authorization")) {
        nextInit = stripHeader(nextInit, "authorization");
      }

      currentUrl = nextUrl;
      currentInit = nextInit;
      // loop continues — next iteration validates currentUrl and creates a
      // fresh pinned dispatcher.
    }
  } catch (err) {
    closeAll();
    if (err instanceof SsrfBlockedError || err instanceof SsrfRedirectLimitError) throw err;
    throw err;
  }
}
