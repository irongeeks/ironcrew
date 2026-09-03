// Strict whole-string validators for CLI provider API keys.
//
// Both routes that accept user-supplied API keys (Claude, Codex) used to
// rely on `apiKey.startsWith("sk-...")` only. That accepted payloads with
// embedded newlines, shell metacharacters, or trailing junk — which were
// then concatenated into .env (Claude) or ~/.codex/auth.json (Codex).
// See B-002 / issue #53 for the exploit.
//
// Both real Anthropic and real OpenAI keys use the URL-safe base64 alphabet
// (letters, digits, `_`, `-`). Anything outside that set is malformed and
// MUST be rejected before the value crosses any persistence boundary.

const CLAUDE_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,255}$/;
// `(?!ant-)` ensures that a Claude-style sk-ant- key cannot impersonate an
// OpenAI key — provider mismatch must throw, not silently get persisted.
const CODEX_KEY_RE = /^sk-(?!ant-)[A-Za-z0-9_-]{20,255}$/;

export type CliAuthProvider = "claude" | "codex";

/**
 * Validates a CLI provider API key against a strict whole-string regex.
 * Returns the key unchanged when valid; throws an Error otherwise.
 *
 * Defends against B-002 (#53). Both routes that persist the key MUST go
 * through this function.
 */
export function validateCliApiKey(provider: CliAuthProvider, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("invalid API key format: expected non-empty string");
  }
  switch (provider) {
    case "claude":
      if (!CLAUDE_KEY_RE.test(raw)) {
        throw new Error("invalid Anthropic API key format (expected sk-ant- prefix and URL-safe characters)");
      }
      return raw;
    case "codex":
      if (!CODEX_KEY_RE.test(raw)) {
        throw new Error("invalid OpenAI API key format (expected sk- or sk-proj- prefix and URL-safe characters)");
      }
      return raw;
    default: {
      // Exhaustiveness: a future provider must be added explicitly.
      const _exhaustive: never = provider;
      throw new Error(`unknown provider: ${String(_exhaustive)}`);
    }
  }
}
