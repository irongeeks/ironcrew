import dns from "node:dns";
import net from "node:net";

/**
 * Block SSRF targets.
 *
 * Two modes controlled by `options.allowLocal`:
 *
 *  - **strict** (default, `allowLocal: false`):
 *    Blocks cloud metadata, loopback, link-local, 0.0.0.0, RFC 1918,
 *    and IPv6 private ranges.  Use for outbound calls to external APIs
 *    (OpenAI, Anthropic, etc.) where localhost is never expected.
 *
 *  - **local-friendly** (`allowLocal: true`):
 *    Only blocks cloud metadata endpoints (169.254.169.254, metadata.google.internal).
 *    Use for user-configured local services (ComfyUI, MCP servers, self-hosted LLMs)
 *    where localhost / RFC 1918 addresses are normal and expected.
 *
 * Returns true if the URL should be blocked.
 *
 * NOTE: This is a string-based check on the URL hostname only. It does not
 * resolve DNS, so a hostname that resolves to a blocked IP at fetch time will
 * pass this check.  For DNS-rebinding-safe validation, also call
 * {@link assertSsrfSafeUrl}, which resolves the hostname and validates the IP(s).
 */
export function isBlockedSsrfTarget(urlStr: string, options?: { allowLocal?: boolean }): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

    // Always block cloud metadata endpoints regardless of mode
    if (bare === "169.254.169.254" || bare === "metadata.google.internal") return true;

    // In local-friendly mode, only block cloud metadata — allow everything else
    if (options?.allowLocal) return false;

    // Strict mode: block all private/loopback/link-local addresses
    if (bare === "localhost" || bare === "::1") return true;
    if (bare === "0.0.0.0") return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(bare)) return true;
    if (bare.startsWith("169.254.")) return true;
    // Block IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
    if (bare.startsWith("fc") || bare.startsWith("fd") || bare.startsWith("fe80:")) return true;
    // Handle IPv6-mapped IPv4: ::ffff: prefix with dot-decimal (pre-normalization input)
    if (bare.startsWith("::ffff:")) {
      const mapped = bare.slice(7);
      if (isBlockedIpv4(mapped)) return true;
      if (isBlockedIpv4FromHexGroups(mapped)) return true;
    }
    if (isBlockedIpv4(bare)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Decode two colon-separated hex groups (as produced by URL normalization of
 * ::ffff:<ipv4>) back to dotted-decimal and check against blocked ranges.
 * Example: "a00:1" → 10.0.0.1, "c0a8:101" → 192.168.1.1
 */
function isBlockedIpv4FromHexGroups(hexGroups: string): boolean {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hexGroups);
  if (!m) return false;
  const combined = (parseInt(m[1], 16) << 16) | parseInt(m[2], 16);
  const a = (combined >>> 24) & 0xff;
  const b = (combined >>> 16) & 0xff;
  const dotted = `${a}.${b}.${(combined >>> 8) & 0xff}.${combined & 0xff}`;
  return isBlockedIpv4(dotted);
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/**
 * Error thrown by {@link assertSsrfSafeUrl} when the URL or any of its
 * resolved IP addresses fall inside a blocked range.  Callers can
 * `instanceof`-check this to convert the error into a 400 response with a
 * stable shape.
 */
export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Decide whether a literal IP address (IPv4 or IPv6) is blocked given the
 * strict/allowLocal mode.  Used both for direct-IP URLs and for IPs returned
 * by `dns.lookup`.
 */
function isBlockedIp(ip: string, options?: { allowLocal?: boolean }): boolean {
  const family = net.isIP(ip);
  if (family === 0) {
    // Not a valid IP literal — treat as blocked to be safe.
    return true;
  }

  const lower = ip.toLowerCase();

  // Always block cloud metadata IP regardless of mode.
  if (lower === "169.254.169.254") return true;

  if (options?.allowLocal) return false;

  if (family === 4) {
    if (lower === "0.0.0.0") return true;
    return isBlockedIpv4(lower);
  }

  // IPv6
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7);
    if (isBlockedIpv4(mapped)) return true;
    if (isBlockedIpv4FromHexGroups(mapped)) return true;
  }
  return false;
}

/**
 * Resolved address pin returned by {@link assertSsrfSafeUrl}.  Callers pass
 * this to {@link safeFetch} (or build their own dispatcher) so the actual HTTP
 * connection uses the validated IP and does not re-resolve DNS — closing the
 * TOCTOU window where a rebinding resolver could swap in a private IP.
 */
export interface SsrfPinnedAddress {
  /** Original URL string the caller passed in (unchanged — used for SNI/Host). */
  url: string;
  /** IP literal that was validated (IPv4 dotted-decimal or IPv6 string). */
  ip: string;
  /** IP family as returned by `dns.lookup` (4 or 6).  For literal-IP URLs, derived from `net.isIP`. */
  family: 4 | 6;
}

/**
 * DNS-rebinding-safe SSRF validation.
 *
 * Resolves the URL hostname via `dns.lookup` and rejects if any returned IP
 * (A/AAAA) falls inside a blocked range.  Use this BEFORE issuing an outbound
 * fetch from a strict-mode call site (e.g. external API providers) to close
 * the window where an attacker controlling DNS can serve a benign IP at check
 * time and a private/metadata IP at fetch time.
 *
 * For literal-IP URLs, no DNS lookup is performed — the IP itself is checked.
 *
 * Returns the validated IP/family so callers can pin the connection (see
 * {@link safeFetch}).  Without pinning, a rebinding resolver could still swap
 * the IP between the check and the actual fetch — the helper at
 * `server/security/safe-fetch.ts` consumes this pin to defeat that.
 *
 * @throws {SsrfBlockedError}
 */
export async function assertSsrfSafeUrl(
  urlStr: string,
  options?: { allowLocal?: boolean },
): Promise<SsrfPinnedAddress> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${urlStr}`);
  }

  const host = parsed.hostname.toLowerCase();
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // Cheap fast-fail: catch obvious string-based blocks (localhost,
  // metadata.google.internal, direct private-IP literals, etc.) without a
  // DNS round-trip.
  if (isBlockedSsrfTarget(urlStr, options)) {
    throw new SsrfBlockedError(`URL targets a blocked address range: ${urlStr}`);
  }

  // If the host is a literal IP, the string check above already validated it.
  // Skip DNS lookup entirely; pin to the literal.
  const literalFamily = net.isIP(bare);
  if (literalFamily !== 0) {
    return { url: urlStr, ip: bare, family: literalFamily === 6 ? 6 : 4 };
  }

  let resolved: dns.LookupAddress[];
  try {
    resolved = await dns.promises.lookup(bare, { all: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SsrfBlockedError(`DNS lookup failed for ${bare}: ${detail}`);
  }

  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new SsrfBlockedError(`No DNS records returned for ${bare}`);
  }

  for (const entry of resolved) {
    if (isBlockedIp(entry.address, options)) {
      throw new SsrfBlockedError(
        `Hostname ${bare} resolved to blocked address ${entry.address} (DNS rebinding protection)`,
      );
    }
  }

  // Pick the first validated entry as the pin.  All entries have already been
  // checked, so any of them is safe; using the first matches what `dns.lookup`
  // would hand to a default HTTP connector.
  const first = resolved[0];
  const pinnedFamily: 4 | 6 = first.family === 6 ? 6 : 4;
  return { url: urlStr, ip: first.address, family: pinnedFamily };
}
