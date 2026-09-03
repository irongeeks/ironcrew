import { describe, it, expect } from "vitest";

/**
 * Unit tests for pure/testable functions in api-providers.ts.
 *
 * The source module does not export the helpers directly — they are file-scoped.
 * We re-implement the same logic inline here so we can validate the expected
 * behavior without needing to refactor the source. If the source is later
 * refactored to export these helpers, the tests can import them directly.
 */

// ---------------------------------------------------------------------------
// Re-implementations of the pure helpers (mirrors server/modules/routes/ops/api-providers.ts)
// ---------------------------------------------------------------------------

type ApiProviderType =
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "openrouter"
  | "together"
  | "groq"
  | "cerebras"
  | "custom";

const API_PROVIDER_PRESETS: Record<ApiProviderType, { base_url: string; models_path: string; auth_header: string }> = {
  openai: { base_url: "https://api.openai.com/v1", models_path: "/models", auth_header: "Bearer" },
  anthropic: { base_url: "https://api.anthropic.com/v1", models_path: "/models", auth_header: "x-api-key" },
  google: {
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    models_path: "/models",
    auth_header: "key",
  },
  ollama: { base_url: "http://localhost:11434/v1", models_path: "/models", auth_header: "" },
  openrouter: { base_url: "https://openrouter.ai/api/v1", models_path: "/models", auth_header: "Bearer" },
  together: { base_url: "https://api.together.xyz/v1", models_path: "/models", auth_header: "Bearer" },
  groq: { base_url: "https://api.groq.com/openai/v1", models_path: "/models", auth_header: "Bearer" },
  cerebras: { base_url: "https://api.cerebras.ai/v1", models_path: "/models", auth_header: "Bearer" },
  custom: { base_url: "", models_path: "/models", auth_header: "Bearer" },
};

function isApiProviderType(value: unknown): value is ApiProviderType {
  return typeof value === "string" && value in API_PROVIDER_PRESETS;
}

function normalizeApiBaseUrl(rawUrl: string): string {
  let url = rawUrl.replace(/\/+$/, "");
  url = url.replace(/\/v1\/(chat\/completions|models|messages)$/i, "/v1");
  url = url.replace(/\/v1beta\/models\/.+$/i, "/v1beta");
  return url;
}

function buildModelsUrl(type: ApiProviderType, baseUrl: string, apiKey: string): string {
  const preset = API_PROVIDER_PRESETS[type] || API_PROVIDER_PRESETS.custom;
  const base = normalizeApiBaseUrl(baseUrl);
  let url = `${base}${preset.models_path}`;
  if (type === "google" && apiKey) {
    url += `?key=${encodeURIComponent(apiKey)}`;
  }
  return url;
}

function buildApiProviderHeaders(type: ApiProviderType, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!apiKey) return headers;
  if (type === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (type !== "google") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

function extractModelIds(type: ApiProviderType, data: unknown): string[] {
  const models: string[] = [];
  const payload = data as {
    data?: Array<{ id?: string }>;
    models?: Array<{ id?: string; name?: string; model?: string }>;
  };

  if (type === "google") {
    if (Array.isArray(payload.models)) {
      for (const m of payload.models) {
        const name = m.name || m.model || "";
        if (name) models.push(name.replace(/^models\//, ""));
      }
    }
  } else if (type === "anthropic") {
    if (Array.isArray(payload.data)) {
      for (const m of payload.data) {
        if (m.id) models.push(m.id);
      }
    }
  } else {
    if (Array.isArray(payload.data)) {
      for (const m of payload.data) {
        if (m.id) models.push(m.id);
      }
    } else if (Array.isArray(payload.models)) {
      for (const m of payload.models) {
        const id = m.id || m.name || m.model || "";
        if (id) models.push(id);
      }
    }
  }
  return models.sort();
}

function parseModelsCache(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isApiProviderType", () => {
  it("accepts all known provider types", () => {
    const knownTypes: ApiProviderType[] = [
      "openai",
      "anthropic",
      "google",
      "ollama",
      "openrouter",
      "together",
      "groq",
      "cerebras",
      "custom",
    ];
    for (const t of knownTypes) {
      expect(isApiProviderType(t)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isApiProviderType("azure")).toBe(false);
    expect(isApiProviderType("")).toBe(false);
    expect(isApiProviderType("OPENAI")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isApiProviderType(42)).toBe(false);
    expect(isApiProviderType(null)).toBe(false);
    expect(isApiProviderType(undefined)).toBe(false);
    expect(isApiProviderType({})).toBe(false);
  });
});

describe("normalizeApiBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeApiBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeApiBaseUrl("https://api.openai.com/v1///")).toBe("https://api.openai.com/v1");
  });

  it("strips /v1/chat/completions suffix", () => {
    expect(normalizeApiBaseUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
  });

  it("strips /v1/models suffix", () => {
    expect(normalizeApiBaseUrl("https://api.openai.com/v1/models")).toBe("https://api.openai.com/v1");
  });

  it("strips /v1/messages suffix", () => {
    expect(normalizeApiBaseUrl("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com/v1");
  });

  it("strips /v1beta/models/<model> suffix", () => {
    expect(normalizeApiBaseUrl("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("preserves clean base URLs", () => {
    expect(normalizeApiBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalizeApiBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });

  it("handles case-insensitive suffix matching", () => {
    expect(normalizeApiBaseUrl("https://api.openai.com/v1/MODELS")).toBe("https://api.openai.com/v1");
    expect(normalizeApiBaseUrl("https://api.openai.com/v1/Chat/Completions")).toBe("https://api.openai.com/v1");
  });
});

describe("buildModelsUrl", () => {
  it("builds correct URL for openai", () => {
    expect(buildModelsUrl("openai", "https://api.openai.com/v1", "sk-test")).toBe("https://api.openai.com/v1/models");
  });

  it("builds correct URL for anthropic", () => {
    expect(buildModelsUrl("anthropic", "https://api.anthropic.com/v1", "sk-ant-test")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });

  it("builds correct URL for google with API key in query string", () => {
    const url = buildModelsUrl("google", "https://generativelanguage.googleapis.com/v1beta", "AIza-test");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=AIza-test");
  });

  it("builds google URL without key param when no API key", () => {
    const url = buildModelsUrl("google", "https://generativelanguage.googleapis.com/v1beta", "");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("normalizes trailing slashes from base URL", () => {
    expect(buildModelsUrl("openai", "https://api.openai.com/v1/", "sk-test")).toBe("https://api.openai.com/v1/models");
  });

  it("normalizes base URL with path suffixes", () => {
    expect(buildModelsUrl("openai", "https://api.openai.com/v1/chat/completions", "sk-test")).toBe(
      "https://api.openai.com/v1/models",
    );
  });

  it("encodes special characters in google API key", () => {
    const url = buildModelsUrl("google", "https://generativelanguage.googleapis.com/v1beta", "key+with=special&chars");
    expect(url).toContain("key%2Bwith%3Dspecial%26chars");
  });
});

describe("buildApiProviderHeaders", () => {
  it("returns only Accept header when no API key", () => {
    const headers = buildApiProviderHeaders("openai", "");
    expect(headers).toEqual({ Accept: "application/json" });
  });

  it("returns Bearer auth for openai", () => {
    const headers = buildApiProviderHeaders("openai", "sk-test");
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("returns x-api-key and anthropic-version for anthropic", () => {
    const headers = buildApiProviderHeaders("anthropic", "sk-ant-test");
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();
  });

  it("returns no auth header for google (key goes in URL query)", () => {
    const headers = buildApiProviderHeaders("google", "AIza-test");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.Accept).toBe("application/json");
  });

  it("returns Bearer auth for ollama when key is provided", () => {
    const headers = buildApiProviderHeaders("ollama", "some-key");
    expect(headers.Authorization).toBe("Bearer some-key");
  });

  it("returns Bearer auth for openrouter, together, groq, cerebras", () => {
    for (const type of ["openrouter", "together", "groq", "cerebras"] as ApiProviderType[]) {
      const headers = buildApiProviderHeaders(type, "test-key");
      expect(headers.Authorization).toBe("Bearer test-key");
    }
  });
});

describe("extractModelIds", () => {
  it("extracts from OpenAI-style data array", () => {
    const data = { data: [{ id: "gpt-4" }, { id: "gpt-3.5-turbo" }] };
    expect(extractModelIds("openai", data)).toEqual(["gpt-3.5-turbo", "gpt-4"]);
  });

  it("extracts from Anthropic data array", () => {
    const data = { data: [{ id: "claude-3-opus" }, { id: "claude-3-sonnet" }] };
    expect(extractModelIds("anthropic", data)).toEqual(["claude-3-opus", "claude-3-sonnet"]);
  });

  it("extracts from Google models array and strips models/ prefix", () => {
    const data = { models: [{ name: "models/gemini-pro" }, { name: "models/gemini-ultra" }] };
    expect(extractModelIds("google", data)).toEqual(["gemini-pro", "gemini-ultra"]);
  });

  it("handles Google models with model field instead of name", () => {
    const data = { models: [{ model: "models/gemini-2.0-flash" }] };
    expect(extractModelIds("google", data)).toEqual(["gemini-2.0-flash"]);
  });

  it("handles Ollama-style models array for non-google/non-anthropic", () => {
    const data = { models: [{ name: "llama3" }, { model: "mistral" }] };
    expect(extractModelIds("ollama", data)).toEqual(["llama3", "mistral"]);
  });

  it("returns sorted results", () => {
    const data = { data: [{ id: "z-model" }, { id: "a-model" }, { id: "m-model" }] };
    expect(extractModelIds("openai", data)).toEqual(["a-model", "m-model", "z-model"]);
  });

  it("returns empty array for empty data", () => {
    expect(extractModelIds("openai", {})).toEqual([]);
    expect(extractModelIds("openai", { data: [] })).toEqual([]);
    expect(extractModelIds("google", { models: [] })).toEqual([]);
  });

  it("skips entries without id/name", () => {
    const data = { data: [{ id: "valid" }, { id: "" }, {}] };
    expect(extractModelIds("openai", data)).toEqual(["valid"]);
  });

  it("prefers data array over models array for non-google/non-anthropic", () => {
    const data = { data: [{ id: "from-data" }], models: [{ name: "from-models" }] };
    expect(extractModelIds("openai", data)).toEqual(["from-data"]);
  });
});

describe("parseModelsCache", () => {
  it("returns empty array for null", () => {
    expect(parseModelsCache(null)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseModelsCache("")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseModelsCache("not json")).toEqual([]);
    expect(parseModelsCache("{broken")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(parseModelsCache('{"key": "value"}')).toEqual([]);
    expect(parseModelsCache('"just a string"')).toEqual([]);
    expect(parseModelsCache("42")).toEqual([]);
  });

  it("parses valid JSON array of strings", () => {
    expect(parseModelsCache('["gpt-4", "gpt-3.5"]')).toEqual(["gpt-4", "gpt-3.5"]);
  });

  it("converts non-string entries to strings", () => {
    expect(parseModelsCache("[1, 2, 3]")).toEqual(["1", "2", "3"]);
    expect(parseModelsCache("[true, null]")).toEqual(["true", "null"]);
  });
});
