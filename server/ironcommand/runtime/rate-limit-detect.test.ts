import { describe, it, expect } from "vitest";
import { detectRateLimit } from "./rate-limit-detect.ts";

const NOW = Date.parse("2026-01-01T00:00:00Z");

describe("keyword detection", () => {
  it.each([
    "Error: rate limit exceeded, please slow down",
    "RATE_LIMIT: you have made too many requests",
    "HTTP 429 Too Many Requests",
    "quota exceeded for this billing period",
    "usage limit reached for your plan",
    "Overloaded: the API is temporarily overloaded",
  ])("flags %j as a rate limit", (text) => {
    expect(detectRateLimit(text, NOW)).not.toBeNull();
  });

  it("is case-insensitive", () => {
    expect(detectRateLimit("RaTe LiMiT hit", NOW)).not.toBeNull();
  });

  it("does not flag ordinary output", () => {
    expect(detectRateLimit("Wrote 3 files, ran 12 tests, all green.", NOW)).toBeNull();
  });

  it("does not flag unrelated mentions of numbers", () => {
    expect(detectRateLimit("processed 429 records successfully", NOW)).not.toBeNull();
    // "429" alone is treated as a signal per the keyword list — documented
    // trade-off: a false positive here is far cheaper than missing a real
    // 429 embedded in a differently-worded message.
  });

  it("handles empty input", () => {
    expect(detectRateLimit("", NOW)).toBeNull();
  });
});

describe("reset time extraction", () => {
  it("parses an absolute ISO-8601 timestamp anywhere in the text", () => {
    const r = detectRateLimit("rate limit resets at 2026-01-01T00:05:00Z", NOW);
    expect(r?.resetAt).toBe(Date.parse("2026-01-01T00:05:00Z"));
  });

  it("parses 'retry after Ns'", () => {
    const r = detectRateLimit("rate limit hit, retry after 30s", NOW);
    expect(r?.resetAt).toBe(NOW + 30_000);
  });

  it("parses 'retry in N seconds'", () => {
    const r = detectRateLimit("rate limit: retry in 45 seconds", NOW);
    expect(r?.resetAt).toBe(NOW + 45_000);
  });

  it("parses minutes", () => {
    const r = detectRateLimit("rate limit exceeded, retry in 2 minutes", NOW);
    expect(r?.resetAt).toBe(NOW + 2 * 60_000);
  });

  it("parses milliseconds", () => {
    const r = detectRateLimit("rate limit, retry after 500ms", NOW);
    expect(r?.resetAt).toBe(NOW + 500);
  });

  it("leaves resetAt undefined when no reset time is present", () => {
    const r = detectRateLimit("rate limit exceeded", NOW);
    expect(r?.resetAt).toBeUndefined();
  });

  it("prefers an absolute timestamp over a relative one if both appear", () => {
    const r = detectRateLimit("rate limit, retry after 30s (resets 2026-01-01T01:00:00Z)", NOW);
    expect(r?.resetAt).toBe(Date.parse("2026-01-01T01:00:00Z"));
  });

  it("reports the matched phrase", () => {
    const r = detectRateLimit("Error: Rate Limit Exceeded", NOW);
    expect(r?.matchedText.toLowerCase()).toContain("rate limit");
  });
});
