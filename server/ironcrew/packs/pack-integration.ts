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
 * Describes a transport failure without handing a credential to the log.
 *
 * THIS IS A SECURITY BOUNDARY, NOT A FORMATTING CHOICE
 *
 * The obvious implementation interpolates `err.message`, and that is what
 * this helper used to do. The flaw only becomes visible when you read all six
 * adapters at once: three had independently grown their own scrubber to strip
 * their credential back out of the message this helper produced, and three
 * had not. A defence each caller must remember is a defence half the callers
 * forget — and the half that forgot were holding a Proxmox token and a
 * Lexware key. A `fetch` implementation, a proxy agent or an instrumentation
 * wrapper may put the outgoing request, headers included, into its error
 * text.
 *
 * So the redaction moved in here, where every adapter gets it. The adapter
 * still declares *what* is secret, because only it knows; the helper decides
 * *that* it is removed, because that part must not be optional.
 *
 * `cause.code` is preferred over the message because Node's fetch sets the
 * message to the useless "fetch failed" and puts the answer in the cause:
 * `ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`,
 * `DEPTH_ZERO_SELF_SIGNED_CERT` — which is exactly what an operator with a
 * self-signed UniFi console needs to read.
 */
function describeTransportError(err: unknown, url: string, secrets: readonly string[]): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  const fallback = err instanceof Error ? err.message : String(err);

  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    // A malformed URL is its own problem, reported by the caller. It must not
    // turn this message into a second failure.
  }

  const reason = redactSecrets(code ?? fallback ?? "unbekannter Transportfehler", secrets);
  return origin ? `Nicht erreichbar (${reason}): ${origin}` : `Nicht erreichbar: ${reason}`;
}

/**
 * Removes known secret values from a message.
 *
 * Longest first, so a token that contains another value's prefix cannot leave
 * a fragment behind. Values shorter than four characters are ignored: they
 * are not credentials, and blanking them would shred ordinary words.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("«entfernt»");
  }
  return out;
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
  /** Values that must never appear in a failure message. See above. */
  secrets: readonly string[] = [],
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
    throw new PackIntegrationError(describeTransportError(err, url, secrets));
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
