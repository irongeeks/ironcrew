import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_MODELS_URL,
  OpenRouterModelCatalog,
  registerOpenRouterModelRoutes,
} from "./openrouter-model-routes.ts";

const metadata = [
  { id: "unknown-vendor/new-model", name: "New vendor", pricing: { prompt: "0.001" } },
  { id: "meta-llama/community:free", name: "Free model", pricing: { prompt: "0" } },
  { id: "image-vendor/image", architecture: { output_modalities: ["image"] } },
];
function reply(data: unknown) {
  return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
}

describe("OpenRouter public model catalog", () => {
  it("returns every vendor, price tier and modality without an API key or inference call", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(metadata));
    const catalog = new OpenRouterModelCatalog(fetcher);
    const app = express();
    registerOpenRouterModelRoutes(app, { catalog });
    const result = await supertest(app).get("/api/crew/models/openrouter").expect(200);
    expect(result.body.models.map((model: { id: string }) => model.id)).toEqual(
      metadata.map((model) => model.id).sort(),
    );
    expect(result.body.models[0].outputModalities).toEqual(["image"]);
    expect(fetcher).toHaveBeenCalledWith(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
      redirect: "error",
    });
  });

  it("coalesces simultaneous requests, caches, and clearly marks stale data after refresh failure", async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(metadata))
      .mockRejectedValue(new Error("offline"));
    const catalog = new OpenRouterModelCatalog(fetcher, () => now);
    const initial = await Promise.all([catalog.get(), catalog.get()]);
    expect(initial[0]).toEqual(initial[1]);
    await catalog.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 11 * 60_000;
    const stale = await catalog.get();
    expect(stale.stale).toBe(true);
    expect(stale.fetchedAt).toBe(0);
    expect(stale.models).toHaveLength(3);
    await catalog.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 31_000;
    await catalog.get();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns 503 on initial malformed or unavailable catalog and backs off repeated failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"offline"}'));
    const app = express();
    registerOpenRouterModelRoutes(app, { catalog: new OpenRouterModelCatalog(fetcher) });
    const result = await supertest(app).get("/api/crew/models/openrouter").expect(503);
    expect(result.body.error).toBe("openrouter_catalog_unavailable");
    await supertest(app).get("/api/crew/models/openrouter").expect(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
