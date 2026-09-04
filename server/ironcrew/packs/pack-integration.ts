/**
 * IronCrew — the contract every business-pack integration implements.
 *
 * Modelled on `SecretProvider`, `SearchProvider` and `MailProvider`, which all
 * settled on the same two ideas, so this one does not invent a third:
 *
 * 1. **`testConnection()` reports, it does not throw.** It is what the
 *    Settings panel calls to tell an operator whether a system is actually
 *    reachable and the credentials actually work. A probe that throws is a
 *    probe whose failure has to be caught somewhere else to be useful, and
 *    "not configured" is an answer, not an exception.
 * 2. **`fetchImpl` is injectable.** The tests then drive the real code path —
 *    URL building, auth headers, response mapping, error surfacing — with no
 *    socket and no server. Every one of these adapters talks to a system that
 *    does not exist in CI, and a test that mocks the adapter instead of its
 *    transport tests nothing.
 *
 * THE HONEST LIMIT, WRITTEN DOWN
 *
 * None of these adapters has been run against a live instance from this
 * repository. They are written against each vendor's published API, and their
 * tests assert the request they build and the mapping they perform. That is a
 * real guarantee — a wrong URL or a dropped auth header fails a test — and it
 * is not the same as "verified against a real Proxmox cluster". Where an
 * adapter is unverified, `docs/BUSINESS_PACKS.md` says so, and
 * `testConnection()` is what an operator runs on day one to find out.
 *
 * NEVER LOG A CREDENTIAL
 *
 * These adapters hold API tokens. An error message may name the host, the
 * path and the status code; it may never carry the token, the password, or a
 * response body that might echo one. Same rule as
 * `SecretProvider.resolve()` — an error message is the one place a secret
 * leaks without anybody noticing.
 */

export class PackIntegrationError extends Error {
  /** The HTTP status, when the failure came from a response. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "PackIntegrationError";
    this.status = status;
  }
}

export interface IntegrationStatus {
  ok: boolean;
  /** Human-readable, and contractually never a credential. */
  message: string;
  /** The product version, when the probe can learn it cheaply. */
  version?: string;
}

export interface PackIntegrationAdapter {
  /** Stable key, matching the pack's `integrations[].key`. */
  readonly key: string;
  readonly label: string;
  /** Reachability and auth. Reports rather than throws. */
  testConnection(): Promise<IntegrationStatus>;
}

/** Options every HTTP-backed adapter takes. */
export interface HttpIntegrationOptions {
  /** Base URL of the instance, e.g. "https://pve.intern.example:8006". */
  baseUrl: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 15s: a probe must not hang a page. */
  timeoutMs?: number;
}

export const DEFAULT_INTEGRATION_TIMEOUT_MS = 15_000;

/**
 * Strips a trailing slash so `${baseUrl}${path}` is never `//path`.
 *
 * A double slash is accepted by some servers, 404s on others, and breaks
 * signature-based auth on a third kind. Normalising once here is cheaper than
 * six adapters each remembering.
 */
export function normaliseBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") throw new PackIntegrationError("Die Basis-URL fehlt.");
  return trimmed.replace(/\/+$/, "");
}

/**
 * One HTTP call with a timeout, returning the raw Response.
 *
 * The timeout is an `AbortController` rather than a `Promise.race`, so a hung
 * request is actually cancelled instead of merely abandoned — an abandoned
 * socket still holds a file descriptor, and a page that probes six
 * integrations would hold six.
 */
export async function integrationFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_INTEGRATION_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new PackIntegrationError(`Zeitüberschreitung nach ${timeoutMs} ms.`);
    }
    // The host and the reason, never the request body: an outbound body may
    // carry the very credential this message would then travel with.
    throw new PackIntegrationError(`Nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parses a JSON body, turning a non-JSON answer into a readable failure. */
export async function integrationJson<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PackIntegrationError(`${what}: die Antwort war kein JSON (HTTP ${response.status}).`, response.status);
  }
}
