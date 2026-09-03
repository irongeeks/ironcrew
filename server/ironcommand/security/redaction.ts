/**
 * Iron Command OS — secret redaction.
 *
 * Applied to everything that leaves the runner boundary: stdout/stderr,
 * structured logs, run events, work products and anything rendered in the UI.
 *
 * Principles (docs/THREAT_MODEL.md T-04):
 *  - Redact by PATTERN, not by comparing against a list of known secret values.
 *    A value-based approach only works for secrets the process already knows,
 *    and those are exactly the ones we try hardest never to load.
 *  - Additionally redact known values when they ARE available (belt and braces),
 *    with a minimum length so short/common values cannot blank out whole logs.
 *  - Never throw. Redaction sits on the logging path; a crash here would take
 *    down the very observability we need.
 *  - Report whether anything matched, so callers can attach redaction metadata
 *    to the event rather than silently dropping the fact.
 */

export const REDACTED = "[REDACTED]";

/** Minimum length for a known literal value to be worth redacting. */
const MIN_KNOWN_VALUE_LENGTH = 8;

interface Rule {
  id: string;
  pattern: RegExp;
  /**
   * Replacement. When the pattern captures a label prefix in group 1,
   * the replacement keeps it so logs stay readable ("api_key=[REDACTED]").
   */
  replace: string;
}

/**
 * Order matters: more specific rules first, so a generic assignment rule does
 * not shadow a provider-specific token shape.
 */
const RULES: Rule[] = [
  // --- Provider-specific token shapes -------------------------------------
  { id: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { id: "openai_project_key", pattern: /sk-proj-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { id: "openai_key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  { id: "openrouter_key", pattern: /sk-or-v1-[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { id: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  { id: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: REDACTED },
  { id: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
  { id: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { id: "discord_bot_token", pattern: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, replace: REDACTED },
  { id: "stripe_key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },

  // --- Generic transport shapes -------------------------------------------
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: REDACTED },
  { id: "bearer", pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: `$1 ${REDACTED}` },
  { id: "authorization_header", pattern: /\b(Authorization\s*:\s*)[^\r\n]+/gi, replace: `$1${REDACTED}` },
  { id: "url_credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, replace: `$1${REDACTED}@` },

  // --- Private key blocks --------------------------------------------------
  {
    id: "private_key_block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },

  // --- Key=value assignments for secret-looking names ----------------------
  // Matches: API_KEY=..., "apiKey": "...", password: '...', token = ...
  {
    id: "secret_assignment",
    pattern:
      /(["']?\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|credential|private[_-]?key|access[_-]?key|auth)\b["']?\s*[:=]\s*)(["']?)([^\s"',;)}\]]{4,})\2/gi,
    replace: `$1$2${REDACTED}$2`,
  },
];

export interface RedactionResult {
  text: string;
  /** True when at least one rule or known value matched. */
  redacted: boolean;
  /** Rule ids that fired, for redaction metadata on run events. */
  matchedRules: string[];
}

/** Escape a literal for safe embedding in a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact secrets from `input`.
 *
 * @param knownValues Optional literal secret values (e.g. a resolved SecretRef)
 *   to redact in addition to the patterns. Values shorter than 8 characters are
 *   ignored to avoid nuking unrelated text.
 */
export function redact(input: string, knownValues: readonly string[] = []): RedactionResult {
  if (typeof input !== "string" || input.length === 0) {
    return { text: input ?? "", redacted: false, matchedRules: [] };
  }

  let text = input;
  const matchedRules: string[] = [];

  for (const rule of RULES) {
    // Fresh RegExp per call: the module-level literals carry /g state.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (re.test(text)) {
      matchedRules.push(rule.id);
      text = text.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replace);
    }
  }

  for (const value of knownValues) {
    if (typeof value !== "string" || value.length < MIN_KNOWN_VALUE_LENGTH) continue;
    const re = new RegExp(escapeLiteral(value), "g");
    if (re.test(text)) {
      if (!matchedRules.includes("known_value")) matchedRules.push("known_value");
      text = text.replace(new RegExp(escapeLiteral(value), "g"), REDACTED);
    }
  }

  return { text, redacted: matchedRules.length > 0, matchedRules };
}

/** Convenience wrapper when only the cleaned string is needed. */
export function redactText(input: string, knownValues: readonly string[] = []): string {
  return redact(input, knownValues).text;
}

/** Keys whose values are replaced wholesale during object redaction. */
const SENSITIVE_KEY = /(api[_-]?key|secret|password|passwd|token|credential|private[_-]?key|access[_-]?key|authorization|cookie|session[_-]?id)/i;

/**
 * Deep-redact a structured value (log context, event payload, tool arguments).
 * Cycles are handled; functions and symbols are dropped.
 */
export function redactValue<T>(value: T, knownValues: readonly string[] = []): T {
  const seen = new WeakSet<object>();

  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node === "string") return redactText(node, knownValues);
    if (typeof node === "number" || typeof node === "boolean" || typeof node === "bigint") return node;
    if (typeof node === "function" || typeof node === "symbol") return undefined;

    if (Array.isArray(node)) {
      if (seen.has(node)) return "[Circular]";
      seen.add(node);
      return node.map(walk);
    }

    if (node instanceof Date) return node.toISOString();
    if (node instanceof Error) {
      return { name: node.name, message: redactText(node.message, knownValues) };
    }

    if (typeof node === "object") {
      if (seen.has(node as object)) return "[Circular]";
      seen.add(node as object);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY.test(k) ? REDACTED : walk(v);
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}

/**
 * Stream-safe redactor for CLI stdout/stderr.
 *
 * Chunk boundaries can split a secret in half, which would defeat a naive
 * per-chunk regex. This holds back a tail of the buffer until it is either
 * terminated by a newline or grows past the carry limit.
 */
export class StreamRedactor {
  private carry = "";
  private readonly knownValues: readonly string[];
  private readonly maxCarry: number;

  constructor(knownValues: readonly string[] = [], maxCarry = 4096) {
    this.knownValues = knownValues;
    this.maxCarry = maxCarry;
  }

  /** Feed a chunk; returns the portion that is safe to emit now. */
  push(chunk: string): string {
    this.carry += chunk;
    const lastNewline = this.carry.lastIndexOf("\n");

    let emitUpTo: number;
    if (lastNewline >= 0) {
      emitUpTo = lastNewline + 1;
    } else if (this.carry.length > this.maxCarry) {
      // No newline in sight — emit all but a trailing window that could still
      // be the first half of a split secret.
      emitUpTo = this.carry.length - 256;
    } else {
      return "";
    }

    const emit = this.carry.slice(0, emitUpTo);
    this.carry = this.carry.slice(emitUpTo);
    return redactText(emit, this.knownValues);
  }

  /** Flush whatever is still buffered. Call on stream end. */
  flush(): string {
    const rest = this.carry;
    this.carry = "";
    return rest ? redactText(rest, this.knownValues) : "";
  }
}
