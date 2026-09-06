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
    expect(result.headers["cache-control"]).toBe("no-store");
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
    now = 60_000;
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

  it("refreshes automatically after one minute while preserving cached responses before expiry", async () => {
    let now = 1_000;
    const newestModel = { id: "brand-new/provider-model" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(metadata))
      .mockResolvedValueOnce(reply([...metadata, newestModel]));
    const catalog = new OpenRouterModelCatalog(fetcher, () => now);
    const initial = await catalog.get();
    now += 59_999;
    expect(await catalog.get()).toEqual(initial);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 1;
    const fresh = await catalog.get();
    expect(fresh.models.map((model) => model.id)).toContain(newestModel.id);
    expect(fresh.fetchedAt).toBe(now);
    expect(fresh.stale).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("allows an explicit refresh to fetch newly available models before cache expiry", async () => {
    const newestModel = { id: "new-vendor/latest-audio", architecture: { output_modalities: ["audio"] } };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(metadata))
      .mockResolvedValueOnce(reply([...metadata, newestModel]));
    const app = express();
    registerOpenRouterModelRoutes(app, { catalog: new OpenRouterModelCatalog(fetcher) });
    await supertest(app).get("/api/crew/models/openrouter").expect(200);
    await supertest(app).get("/api/crew/models/openrouter?refresh=0").expect(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const result = await supertest(app).get("/api/crew/models/openrouter?refresh=1").expect(200);
    expect(result.body.models.map((model: { id: string }) => model.id)).toContain(newestModel.id);
    expect(result.body.stale).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coalesces forced and normal requests while a live refresh is pending", async () => {
    let finishRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(metadata)).mockReturnValueOnce(refreshResponse);
    const catalog = new OpenRouterModelCatalog(fetcher);
    await catalog.get();
    const forced = catalog.get({ forceRefresh: true });
    const concurrentForced = catalog.get({ forceRefresh: true });
    const concurrentNormal = catalog.get();
    finishRefresh(reply([...metadata, { id: "new-vendor/concurrent" }]));
    const results = await Promise.all([forced, concurrentForced, concurrentNormal]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(result.models).toHaveLength(4);
      expect(result.stale).toBe(false);
    }
  });

  it("keeps failed forced refreshes stale within the TTL and recovers after the failure backoff", async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(metadata))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(reply([...metadata, { id: "new-vendor/recovered" }]));
    const catalog = new OpenRouterModelCatalog(fetcher, () => now);
    await catalog.get();
    now = 1_000;
    const stale = await catalog.get({ forceRefresh: true });
    expect(stale).toMatchObject({ stale: true, fetchedAt: 0 });
    expect(await catalog.get()).toEqual(stale);
    now = 30_999;
    expect(await catalog.get({ forceRefresh: true })).toEqual(stale);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 31_000;
    const recovered = await catalog.get();
    expect(recovered).toMatchObject({ stale: false, fetchedAt: now });
    expect(recovered.models.map((model) => model.id)).toContain("new-vendor/recovered");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns 503 on initial malformed or unavailable catalog and backs off repeated failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"offline"}'));
    const app = express();
    registerOpenRouterModelRoutes(app, { catalog: new OpenRouterModelCatalog(fetcher) });
    const result = await supertest(app).get("/api/crew/models/openrouter").expect(503);
    expect(result.body.error).toBe("openrouter_catalog_unavailable");
    await supertest(app).get("/api/crew/models/openrouter").expect(503);
    await supertest(app).get("/api/crew/models/openrouter?refresh=1").expect(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
