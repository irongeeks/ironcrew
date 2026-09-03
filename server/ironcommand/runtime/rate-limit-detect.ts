/**
 * Iron Command OS — rate-limit detection in CLI output.
 *
 * Real CLI runtimes report a rate limit as ordinary text on stdout/stderr,
 * not as a structured signal. Iron Command's own principle (docs/ARCHITECTURE.md
 * invariant 10) is that a rate limit must never surface as a generic failure,
 * so CliAdapterRuntime scans every chunk through this before falling back to
 * "the process just exited badly".
 *
 * Deliberately text-based rather than exit-code-based: a rate-limited CLI
 * commonly still exits non-zero, and by the time it does the useful signal
 * (which limit, when it resets) is already in the text that scrolled past.
 */

export interface RateLimitMatch {
  /** The phrase that matched, for the audit/event payload. */
  matchedText: string;
  /** Epoch ms, when the text carries a parseable reset time. */
  resetAt?: number;
}

const KEYWORD_PATTERNS: RegExp[] = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota exceeded/i,
  /usage limit reached/i,
  /overloaded/i, // Anthropic's "Overloaded" 529 wording
];

/**
 * Look for "retry after Ns" / "retry in Ns" style phrasing and turn it into
 * an absolute epoch timestamp relative to `now`.
 */
function extractRelativeRetry(text: string, now: number): number | undefined {
  const m = /retry(?:[\s-]?after|[\s-]?in)?\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|second|m|min|minute)s?\b/i.exec(text);
  if (!m) return undefined;
  const amount = Number(m[1]);
  const unit = m[2].toLowerCase();
  // "ms" -> 1, "m"/"min"/"minute" -> 60_000, "s"/"sec"/"second" -> 1000.
  const unitMs = unit === "ms" ? 1 : unit.startsWith("m") ? 60_000 : 1000;
  return now + amount * unitMs;
}

/** Look for an absolute ISO-8601 timestamp anywhere in the text. */
function extractIsoTimestamp(text: string): number | undefined {
  const m = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(text);
  if (!m) return undefined;
  const parsed = Date.parse(m[1]);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Scan `text` for a rate-limit signal. Returns null when nothing matches.
 *
 * `now` is injectable for deterministic tests of the relative-retry parsing.
 */
export function detectRateLimit(text: string, now: number = Date.now()): RateLimitMatch | null {
  if (!text) return null;

  for (const pattern of KEYWORD_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const resetAt = extractIsoTimestamp(text) ?? extractRelativeRetry(text, now);
    return { matchedText: m[0], resetAt };
  }
  return null;
}
