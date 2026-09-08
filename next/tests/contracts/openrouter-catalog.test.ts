import { afterEach, describe, expect, it, vi } from "vitest";
import { estimate, modelSchema, OpenRouterClient, route } from "../../packages/runtime/src/openrouter.ts";

const freeModel = {
  id: "provider/model:free",
  name: "Free model",
  context_length: 128_000,
  supported_parameters: ["tools"],
  pricing: { prompt: "0", completion: "0", request: "0", overrides: [] },
};
const request = {
  messages: [{ role: "user" as const, content: "Hello" }],
  tools: [],
  max_tokens: 100,
};

function catalogClient(data: unknown) {
  const secret = vi.fn(async () => "catalog-must-not-read-this");
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json(data));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new OpenRouterClient({ secret }), fetchMock, secret };
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter catalog schema evolution", () => {
  it("retains structured pricing extensions without discarding free or paid models", async () => {
    const overrides = [{ context_length: 200_000, prompt: "0.000005", completion: "0.00002" }];
    const paid = {
      ...freeModel,
      id: "provider/paid",
      pricing: {
        prompt: "0.000001",
        completion: "0.000002",
        overrides,
        future_metadata: { enabled: true },
      },
    };
    const { client, secret, fetchMock } = catalogClient({
      data: [freeModel, paid],
    });
    const models = await client.catalog();

    expect(models.map((model) => model.id)).toEqual([freeModel.id, paid.id]);
    expect(models[1]!.pricing.overrides).toEqual(overrides);
    expect(models[1]!.pricing.future_metadata).toEqual({ enabled: true });
    expect(client.catalogDiagnostics).toEqual({
      received: 2,
      accepted: 2,
      rejected: 0,
      issues: [],
    });
    expect(client.catalogFailure).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/models?output_modalities=all");
  });

  it("validates entries independently and reports field paths without provider values", async () => {
    const { client } = catalogClient({
      data: [
        freeModel,
        {
          ...freeModel,
          id: "invalid",
          pricing: { prompt: { sensitive: "do-not-log" } },
        },
        null,
      ],
    });
    expect((await client.catalog()).map((model) => model.id)).toEqual([freeModel.id]);
    expect(client.catalogDiagnostics).toEqual({
      received: 3,
      accepted: 1,
      rejected: 2,
      issues: [
        { index: 1, fields: ["pricing.prompt"] },
        { index: 2, fields: [""] },
      ],
    });
    expect(JSON.stringify(client.catalogDiagnostics)).not.toContain("do-not-log");
  });

  it("rejects an entirely invalid catalog so a refresh can retain cached models", async () => {
    const { client } = catalogClient({ data: [{ id: "missing-name" }, null] });
    await expect(client.catalog()).rejects.toMatchObject({
      code: "catalog_unavailable",
    });
    expect(client.catalogDiagnostics).toMatchObject({
      received: 2,
      accepted: 0,
      rejected: 2,
    });
    expect(client.catalogFailure).toEqual({ reason: "schema" });
  });

  it("accepts an explicitly empty catalog and resets diagnostics on a later invalid envelope", async () => {
    const { client, fetchMock } = catalogClient({ data: [] });
    await expect(client.catalog()).resolves.toEqual([]);
    expect(client.catalogDiagnostics).toEqual({
      received: 0,
      accepted: 0,
      rejected: 0,
      issues: [],
    });
    fetchMock.mockResolvedValueOnce(Response.json({ data: {} }));
    await expect(client.catalog()).rejects.toMatchObject({
      code: "catalog_unavailable",
    });
    expect(client.catalogDiagnostics).toBeUndefined();
    expect(client.catalogFailure).toEqual({ reason: "schema" });
  });

  it("reports an HTTP status without reading or retaining provider error text, then clears the failure", async () => {
    const { client, fetchMock, secret } = catalogClient({ data: [freeModel] });
    const response = new Response("sensitive-provider-error", { status: 503 });
    const json = vi.spyOn(response, "json");
    fetchMock.mockResolvedValueOnce(response);
    await expect(client.catalog()).rejects.toMatchObject({
      code: "catalog_unavailable",
    });
    expect(client.catalogFailure).toEqual({ reason: "http", status: 503 });
    expect(client.catalogDiagnostics).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    await expect(client.catalog()).resolves.toHaveLength(1);
    expect(client.catalogFailure).toBeUndefined();
  });

  it("distinguishes invalid JSON without exposing the parser error or body", async () => {
    const { client, fetchMock, secret } = catalogClient({ data: [] });
    fetchMock.mockResolvedValueOnce(new Response("sensitive-provider-body"));
    await expect(client.catalog()).rejects.toMatchObject({
      code: "catalog_unavailable",
      message: "catalog_unavailable",
    });
    expect(client.catalogFailure).toEqual({ reason: "invalid_json" });
    expect(client.catalogDiagnostics).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
  });

  it.each([
    ["TimeoutError", "timeout"],
    ["TypeError", "transport"],
  ])("classifies %s without exposing transport details", async (name, reason) => {
    const { client, fetchMock, secret } = catalogClient({ data: [] });
    const error = new Error("sensitive-network-details");
    error.name = name;
    fetchMock.mockRejectedValueOnce(error);
    await expect(client.catalog()).rejects.toMatchObject({
      code: "catalog_unavailable",
      message: "catalog_unavailable",
    });
    expect(client.catalogFailure).toEqual({ reason });
    expect(client.catalogDiagnostics).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
  });

  it("keeps zero-price models with empty overrides eligible for routing", () => {
    const model = modelSchema.parse({
      ...freeModel,
      pricing: { ...freeModel.pricing, image: "0.000" },
    });
    expect(estimate(model, { ...request, model: model.id })).toBe("0");
    expect(route([model], request, "0").selected?.model.id).toBe(model.id);
  });

  it("retains but does not underestimate unsupported pricing extensions", () => {
    for (const extension of [{ overrides: [{ prompt: "0.1" }] }, { future_fee: { rate: "0.1" } }, { image: "0.001" }]) {
      const model = modelSchema.parse({
        ...freeModel,
        pricing: { ...freeModel.pricing, ...extension },
      });
      expect(() => estimate(model, { ...request, model: model.id })).toThrow();
      expect(route([model], request, "1000000000").selected).toBeUndefined();
    }
  });
});
