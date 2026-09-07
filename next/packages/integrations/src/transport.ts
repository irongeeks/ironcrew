import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export type IntegrationErrorCode =
  | "configuration"
  | "authorization"
  | "auth"
  | "quota"
  | "rate_limit"
  | "validation"
  | "conflict"
  | "timeout"
  | "transport"
  | "provider"
  | "ssrf"
  | "response_limit";
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly effectStatus: "failed" | "effect_unknown";
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(
    code: IntegrationErrorCode,
    message: string,
    effectStatus: "failed" | "effect_unknown" = "failed",
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.effectStatus = effectStatus;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Only set by a trusted, administratively configured connector; never by model arguments. */
  trustedEndpoint?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
export type ResolveAddresses = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Conservative global-unicast allowlist. IPv4-mapped IPv6, transition and documentation ranges fail closed. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99) || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  const first = parseInt(normalized.split(":")[0], 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !normalized.startsWith("2001:") &&
    !normalized.startsWith("2002:") &&
    !normalized.startsWith("3fff:")
  );
}

export async function validatePublicUrl(
  value: string,
  resolve: ResolveAddresses = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationError("validation", "Ungültige Quellen-URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["443", "80"].includes(url.port))
  )
    throw new IntegrationError("ssrf", "Quellen-URL ist nicht zulässig.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  } catch {
    throw new IntegrationError("transport", "Quellen-DNS ist nicht erreichbar.");
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new IntegrationError("ssrf", "Quelle verweist auf ein gesperrtes Netzwerkziel.");
  return { url, addresses };
}

/** Resolves exactly once and pins the socket lookup to the validated address, preventing DNS rebinding. No redirects. */
export function createHttpTransport(
  resolve: ResolveAddresses = (host) => lookup(host, { all: true, verbatim: true }),
): HttpTransport {
  return async (input) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new IntegrationError("configuration", "Connector-URL ist ungültig.");
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new IntegrationError("configuration", "Connector-URL ist ungültig.");
    const validated = input.trustedEndpoint ? undefined : await validatePublicUrl(input.url, resolve);
    const selected = validated?.addresses[0];
    const method = input.method ?? "GET";
    const writing = !["GET", "HEAD", "PROPFIND"].includes(method);
    const effect = writing ? "effect_unknown" : "failed";
    return new Promise<HttpResponse>((resolveResponse, reject) => {
      let finished = false;
      const finish = (error?: IntegrationError, response?: HttpResponse) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolveResponse(response!);
      };
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method,
          headers: input.headers,
          agent: false,
          ...(selected
            ? {
                lookup: (_host, options, callback) => {
                  if (typeof options === "object" && options.all)
                    callback(null, [{ address: selected.address, family: selected.family }]);
                  else callback(null, selected.address, selected.family);
                },
              }
            : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (input.maxBytes ?? 2 * 1024 * 1024)) {
              finish(new IntegrationError("response_limit", "Providerantwort überschreitet das Größenlimit.", effect));
              res.destroy();
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () =>
            finish(new IntegrationError("transport", "Providerverbindung wurde unterbrochen.", effect)),
          );
          res.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers))
              if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
            finish(undefined, { status: res.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
          });
        },
      );
      const timer = setTimeout(
        () => {
          finish(new IntegrationError("timeout", "Provider hat nicht rechtzeitig geantwortet.", effect));
          req.destroy();
        },
        input.timeoutMs ?? (writing ? 60000 : 30000),
      );
      req.on("error", () => finish(new IntegrationError("transport", "Providerverbindung fehlgeschlagen.", effect)));
      req.end(input.body);
    });
  };
}
export const defaultTransport = createHttpTransport();

export function redact<T>(value: T, secrets: readonly string[]): T {
  const scrub = (text: string): string =>
    secrets
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .reduce((out, secret) => out.split(secret).join("[REDACTED]"), text);
  const walk = (input: unknown): unknown =>
    typeof input === "string"
      ? scrub(input)
      : Array.isArray(input)
        ? input.map(walk)
        : input && typeof input === "object"
          ? Object.fromEntries(Object.entries(input).map(([key, value]) => [scrub(key), walk(value)]))
          : input;
  return walk(value) as T;
}

export function checkResponse(response: HttpResponse, writing: boolean): void {
  if (response.status >= 200 && response.status < 300) return;
  const s = response.status;
  const code: IntegrationErrorCode =
    s === 401 || s === 403
      ? "auth"
      : s === 402
        ? "quota"
        : s === 409 || s === 412
          ? "conflict"
          : s === 429
            ? "rate_limit"
            : s >= 300 && s < 400
              ? "configuration"
              : s >= 400 && s < 500
                ? "validation"
                : "provider";
  const raw = response.headers["retry-after"];
  const retryAfterMs = raw
    ? Math.max(0, /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now())
    : undefined;
  throw new IntegrationError(
    code,
    `Providerantwort HTTP ${s}.`,
    writing && s >= 500 ? "effect_unknown" : "failed",
    s,
    retryAfterMs,
  );
}

export async function safeFetch(
  url: string,
  options: { transport?: HttpTransport; maxBytes?: number } = {},
): Promise<{ url: string; observedAt: string; content: string; mediaType: string; status: number }> {
  const response = await (options.transport ?? defaultTransport)({ url, maxBytes: options.maxBytes ?? 1024 * 1024 });
  checkResponse(response, false);
  return {
    url,
    observedAt: new Date().toISOString(),
    content: response.body.toString("utf8"),
    mediaType: response.headers["content-type"] ?? "application/octet-stream",
    status: response.status,
  };
}
