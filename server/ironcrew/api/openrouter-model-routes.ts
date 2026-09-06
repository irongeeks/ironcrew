import type { Express } from "express";
import type { OpenRouterCatalog, OpenRouterModel } from "../../../src/shared/openrouter-models.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";
const CACHE_TTL_MS = 10 * 60_000;
const RETRY_DELAY_MS = 30_000;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Public metadata only: no API key, inference requests, policy filters or model allowlist. */
export class OpenRouterModelCatalog {
  private cached: OpenRouterCatalog | null = null;
  private pending: Promise<OpenRouterCatalog> | null = null;
  private retryAfter = 0;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<OpenRouterCatalog> {
    if (this.cached && this.now() - this.cached.fetchedAt < CACHE_TTL_MS) return this.cached;
    if (this.pending) return this.pending;
    if (this.now() < this.retryAfter) {
      if (this.cached) return { ...this.cached, stale: true };
      throw new Error("OpenRouter model catalog unavailable");
    }
    this.pending = this.refresh();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async refresh(): Promise<OpenRouterCatalog> {
    try {
      const response = await this.fetcher(OPENROUTER_MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`OpenRouter catalog HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
        throw new Error("Invalid OpenRouter catalog");
      }
      const models: OpenRouterModel[] = [];
      const seen = new Set<string>();
      for (const item of body.data) {
        if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        models.push({
          id: item.id,
          name: typeof item.name === "string" ? item.name : item.id,
          contextLength: typeof item.context_length === "number" ? item.context_length : null,
          inputModalities: stringArray(item.architecture?.input_modalities),
          outputModalities: stringArray(item.architecture?.output_modalities),
          supportedParameters: stringArray(item.supported_parameters),
        });
      }
      if (models.length === 0) throw new Error("Empty OpenRouter catalog");
      models.sort((a, b) => a.id.localeCompare(b.id));
      this.cached = { models, fetchedAt: this.now(), stale: false };
      this.retryAfter = 0;
      return this.cached;
    } catch (error) {
      this.retryAfter = this.now() + RETRY_DELAY_MS;
      if (this.cached) return { ...this.cached, stale: true };
      throw error;
    }
  }
}

/** Mounted after the /api/crew authentication guards in routes.ts. */
export function registerOpenRouterModelRoutes(
  app: Express,
  options: { base?: string; catalog?: OpenRouterModelCatalog } = {},
): void {
  const catalog = options.catalog ?? new OpenRouterModelCatalog();
  app.get(`${options.base ?? "/api/crew"}/models/openrouter`, async (_req, res) => {
    try {
      res.json(await catalog.get());
    } catch {
      res.status(503).json({
        error: "openrouter_catalog_unavailable",
        message:
          "Der OpenRouter-Katalog ist gerade nicht erreichbar. Modell-IDs können weiterhin direkt eingegeben werden.",
      });
    }
  });
}
