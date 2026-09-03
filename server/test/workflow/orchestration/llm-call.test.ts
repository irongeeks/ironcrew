import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger before importing code under test.
vi.mock("../../../observability/logger.ts", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    }),
  },
}));

// Mock decryptSecret so tests don't depend on OAUTH_ENCRYPTION_SECRET.
vi.mock("../../../oauth/helpers.ts", () => ({
  decryptSecret: (s: string) => s,
}));

// Bypass SSRF guard for fake test URLs.
vi.mock("../../../security/ssrf.ts", () => ({
  isBlockedSsrfTarget: () => false,
}));

import {
  getFirstEnabledProvider,
  resolveModel,
  callLlm,
  LlmResponseParseError,
} from "../../../modules/workflow/orchestration/llm-call.ts";
import type { ApiProviderRow } from "../../../modules/workflow/orchestration/llm-call.ts";

// ---------------------------------------------------------------------------
// Helpers — minimal DatabaseSync stub
// ---------------------------------------------------------------------------

function makeFakeDb(rows: ApiProviderRow[]) {
  return {
    prepare: (_sql: string) => ({
      get: () => rows[0] as ApiProviderRow | undefined,
      all: () => rows,
    }),
  };
}

// ---------------------------------------------------------------------------
// getFirstEnabledProvider
// ---------------------------------------------------------------------------

describe("getFirstEnabledProvider", () => {
  it("returns null when no providers exist", () => {
    const db = {
      prepare: () => ({ get: () => undefined }),
    };
    expect(getFirstEnabledProvider(db as any)).toBeNull();
  });

  it("returns the first enabled provider", () => {
    const provider: ApiProviderRow = {
      id: "p1",
      name: "TestProvider",
      type: "openai",
      base_url: "https://api.openai.com",
      api_key_enc: null,
      models_cache: null,
      enabled: 1,
    };
    const db = makeFakeDb([provider]);
    expect(getFirstEnabledProvider(db as any)).toEqual(provider);
  });
});

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  const baseProvider: ApiProviderRow = {
    id: "p1",
    name: "Test",
    type: "openai",
    base_url: "https://api.openai.com",
    api_key_enc: null,
    models_cache: null,
    enabled: 1,
  };

  it("returns settingModel when provided", () => {
    expect(resolveModel(baseProvider, "claude-3-opus")).toBe("claude-3-opus");
  });

  it("falls back to first model in models_cache", () => {
    const provider = { ...baseProvider, models_cache: JSON.stringify(["gpt-4", "gpt-3.5-turbo"]) };
    expect(resolveModel(provider, "")).toBe("gpt-4");
  });

  it("falls back to gpt-4o-mini when models_cache is empty array", () => {
    const provider = { ...baseProvider, models_cache: "[]" };
    expect(resolveModel(provider, "")).toBe("gpt-4o-mini");
  });

  it("falls back to gpt-4o-mini when models_cache is null", () => {
    expect(resolveModel(baseProvider, "")).toBe("gpt-4o-mini");
  });

  it("falls back to gpt-4o-mini when models_cache is invalid JSON", () => {
    const provider = { ...baseProvider, models_cache: "not-json" };
    expect(resolveModel(provider, "")).toBe("gpt-4o-mini");
  });
});

// ---------------------------------------------------------------------------
// callLlm — response schema validation
// ---------------------------------------------------------------------------

function makeProvider(type: string): ApiProviderRow {
  return {
    id: "p1",
    name: `Test-${type}`,
    type,
    base_url: "https://example.test/v1",
    api_key_enc: "fake-key",
    models_cache: null,
    enabled: 1,
  };
}

function mockFetchOnceJson(payload: unknown): void {
  (globalThis as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  ) as typeof fetch;
}

describe("callLlm response parsing", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Each test installs its own mock.
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---- Happy paths preserve previous behavior --------------------------------

  it("anthropic: concatenates text blocks, ignores non-text blocks", async () => {
    mockFetchOnceJson({
      content: [
        { type: "text", text: "Hello " },
        { type: "tool_use", id: "x", name: "y", input: {} },
        { type: "text", text: "world" },
      ],
    });
    const out = await callLlm(makeProvider("anthropic"), "claude-sonnet", "sys", "msg");
    expect(out).toBe("Hello world");
  });

  it("google: joins parts[].text from first candidate", async () => {
    mockFetchOnceJson({
      candidates: [{ content: { parts: [{ text: "foo" }, { text: "bar" }] } }],
    });
    const out = await callLlm(makeProvider("google"), "gemini-2.0", "sys", "msg");
    expect(out).toBe("foobar");
  });

  it("openai: returns choices[0].message.content", async () => {
    mockFetchOnceJson({ choices: [{ message: { content: "ok" } }] });
    const out = await callLlm(makeProvider("openai"), "gpt-4o-mini", "sys", "msg");
    expect(out).toBe("ok");
  });

  // ---- Malformed responses must throw LlmResponseParseError -----------------

  it("anthropic: malformed response throws LlmResponseParseError (not empty string)", async () => {
    mockFetchOnceJson({ unexpected: "shape" }); // missing `content`
    await expect(callLlm(makeProvider("anthropic"), "m", "sys", "msg")).rejects.toBeInstanceOf(LlmResponseParseError);
  });

  it("anthropic: text block missing `text` field throws", async () => {
    mockFetchOnceJson({ content: [{ type: "text" }] }); // text required
    await expect(callLlm(makeProvider("anthropic"), "m", "sys", "msg")).rejects.toBeInstanceOf(LlmResponseParseError);
  });

  it("google: missing candidates throws LlmResponseParseError", async () => {
    mockFetchOnceJson({ candidates: [] }); // min(1)
    await expect(callLlm(makeProvider("google"), "m", "sys", "msg")).rejects.toBeInstanceOf(LlmResponseParseError);
  });

  it("google: top-level shape mismatch throws", async () => {
    mockFetchOnceJson({ nope: true });
    await expect(callLlm(makeProvider("google"), "m", "sys", "msg")).rejects.toBeInstanceOf(LlmResponseParseError);
  });

  it("openai: missing choices throws LlmResponseParseError", async () => {
    mockFetchOnceJson({ id: "abc" });
    await expect(callLlm(makeProvider("openai"), "m", "sys", "msg")).rejects.toBeInstanceOf(LlmResponseParseError);
  });

  it("openai: choice missing message throws", async () => {
    mockFetchOnceJson({ choices: [{ finish_reason: "stop" }] });
    await expect(callLlm(makeProvider("openai"), "m", "sys", "msg")).rejects.toBeInstanceOf(LlmResponseParseError);
  });

  it("LlmResponseParseError carries providerType + zod issues", async () => {
    mockFetchOnceJson({ wrong: 1 });
    try {
      await callLlm(makeProvider("anthropic"), "m", "sys", "msg");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmResponseParseError);
      const e = err as LlmResponseParseError;
      expect(e.providerType).toBe("anthropic");
      expect(e.reason).toBe("parse_error");
      expect(Array.isArray(e.issues)).toBe(true);
      expect(e.issues.length).toBeGreaterThan(0);
    }
  });
});
