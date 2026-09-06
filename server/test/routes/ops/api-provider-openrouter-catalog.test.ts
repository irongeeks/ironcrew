import { DatabaseSync } from "node:sqlite";
import express from "express";
import supertest from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApiProviderRoutes } from "../../../modules/routes/ops/api-providers.ts";
import { safeFetch } from "../../../security/safe-fetch.ts";

vi.mock("../../../security/safe-fetch.ts", () => ({ safeFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("legacy OpenRouter provider model discovery", () => {
  it("refreshes outdated text-only caches and requests all modalities", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE api_providers (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, base_url TEXT, api_key_enc TEXT,
        enabled INTEGER, allow_local INTEGER, models_cache TEXT, models_cached_at INTEGER,
        created_at INTEGER, updated_at INTEGER
      )`);
      db.prepare("INSERT INTO api_providers VALUES (?, ?, ?, ?, NULL, 1, 0, ?, 0, 0, 0)").run(
        "router",
        "OpenRouter",
        "openrouter",
        "https://openrouter.ai/api/v1",
        '["old/text-only"]',
      );
      const modelIds = ["unknown/paid", "unknown/free:free", "image-vendor/image"];
      vi.mocked(safeFetch).mockResolvedValue(new Response(JSON.stringify({ data: modelIds.map((id) => ({ id })) })));
      const app = express();
      registerApiProviderRoutes({ app, db, nowMs: () => 11 * 60_000 });
      const result = await supertest(app).get("/api/api-providers/router/models").expect(200);
      expect(result.body.models).toEqual([...modelIds].sort());
      expect(result.body.cached).toBe(false);
      expect(safeFetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/models?output_modalities=all",
        expect.any(Object),
      );
      const cached = await supertest(app).get("/api/api-providers/router/models").expect(200);
      expect(cached.body.models).toEqual([...modelIds].sort());
      expect(cached.body.cached).toBe(true);
      expect(safeFetch).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
