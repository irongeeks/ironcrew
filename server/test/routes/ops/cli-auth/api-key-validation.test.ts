import { describe, expect, it } from "vitest";

// Reproducer for B-002 (issue #53): newline-injection in CLI provider API keys.
//
// The original validation at server/modules/routes/ops/cli-auth/routes.ts:88
// only checked `apiKey.startsWith("sk-ant-")`. A payload like
// `sk-ant-valid\nDB_PASSWORD=hijacked\n` passed the prefix test and was
// concatenated literally into the .env file, allowing arbitrary env-var
// injection. The same class of bug existed in the Codex route (line 57).
//
// The fix introduces a strict whole-string validator that rejects any
// character outside the documented Anthropic / OpenAI key alphabet.
import { validateCliApiKey } from "../../../../modules/routes/ops/cli-auth/api-key-validation.ts";

describe("validateCliApiKey — claude / Anthropic (B-002)", () => {
  const malicious: Array<[string, string]> = [
    ["LF newline injection", "sk-ant-api03-good\nDB_PASSWORD=hijacked"],
    ["CRLF newline injection", "sk-ant-api03-good\r\nFOO=bar"],
    ["CR injection", "sk-ant-api03-good\rDROP=table"],
    ["null byte", "sk-ant-api03-good extra"],
    ["space and shell metachars", "sk-ant-api03-good; rm -rf /"],
    ["tab injection", "sk-ant-api03-good\tEXTRA=1"],
    ["wrong prefix", "sk-proj-1234567890abcdef"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["non-string number", 12345 as unknown as string],
    ["non-string null", null as unknown as string],
    ["non-string undefined", undefined as unknown as string],
    ["non-string object", { toString: () => "sk-ant-api03-evil" } as unknown as string],
  ];

  it.each(malicious)("rejects %s", (_label, raw) => {
    expect(() => validateCliApiKey("claude", raw)).toThrow();
  });

  it("accepts a realistic Anthropic key", () => {
    const key = "sk-ant-api03-" + "A".repeat(95);
    expect(validateCliApiKey("claude", key)).toBe(key);
  });

  it("accepts the URL-safe base64 alphabet (letters, digits, _, -)", () => {
    const key = "sk-ant-api03-Az09_-Az09_-Az09_-Az09_-Az09_-Az09_-Az09_-Az";
    expect(validateCliApiKey("claude", key)).toBe(key);
  });

  it("returns the key unchanged when valid (no trimming surprise)", () => {
    const key = "sk-ant-api03-" + "B".repeat(64);
    const out = validateCliApiKey("claude", key);
    expect(out).toBe(key);
    expect(out.length).toBe(key.length);
  });
});

describe("validateCliApiKey — codex / OpenAI (B-002 — same defence)", () => {
  it("rejects a key with newline injection", () => {
    expect(() => validateCliApiKey("codex", "sk-good\nFOO=bar")).toThrow();
  });

  it("accepts a classic sk- key", () => {
    const key = "sk-" + "0123456789abcdefghijklmnopqrstuvwxyz".repeat(2);
    expect(validateCliApiKey("codex", key)).toBe(key);
  });

  it("accepts an sk-proj- key", () => {
    const key = "sk-proj-" + "X".repeat(48);
    expect(validateCliApiKey("codex", key)).toBe(key);
  });

  it("rejects a key that starts with sk-ant- (provider mismatch)", () => {
    const key = "sk-ant-api03-" + "Y".repeat(64);
    expect(() => validateCliApiKey("codex", key)).toThrow(/format|prefix/i);
  });

  it("rejects a Codex key with shell metacharacters", () => {
    expect(() => validateCliApiKey("codex", "sk-good`echo pwned`")).toThrow();
  });
});

describe("validateCliApiKey — error contract", () => {
  it("throws an Error (not a string) so callers can use err.message", () => {
    try {
      validateCliApiKey("claude", "garbage");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/key|format/i);
    }
  });

  it("rejects an unknown provider with a clear error", () => {
    expect(() => validateCliApiKey("gemini" as never, "sk-anything")).toThrow(/provider/i);
  });
});
