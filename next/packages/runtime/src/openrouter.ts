import { z } from "zod";
import { DomainError } from "../../domain/src/index.ts";
// Provider extensions (for example tiered-pricing overrides) are not necessarily strings.
// Keep the rates used for budgeting typed while retaining new catalog metadata.
export const pricingSchema = z
  .object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    request: z.string().optional(),
    image: z.string().optional(),
    web_search: z.string().optional(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  })
  .passthrough();
export const modelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    context_length: z.number().nullable().optional(),
    supported_parameters: z.array(z.string()).default([]),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).default([]),
        output_modalities: z.array(z.string()).default([]),
      })
      .passthrough()
      .optional(),
    pricing: pricingSchema.default({}),
  })
  .passthrough();
export type Model = z.infer<typeof modelSchema>;
export type CatalogDiagnostics = {
  received: number;
  accepted: number;
  rejected: number;
  duplicates?: number;
  // Do not retain provider payloads or arbitrary validation error messages.
  issues: { index: number; fields: string[] }[];
};
export type CatalogFailure = {
  reason: "http" | "schema" | "invalid_json" | "timeout" | "transport";
  status?: number;
};
export const callSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});
export const assistantSchema = z.object({
  role: z.literal("assistant").default("assistant"),
  content: z.string().nullable().optional(),
  tool_calls: z.array(callSchema).optional(),
});
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: z.infer<typeof callSchema>[];
  tool_call_id?: string;
};
export type ModelRequest = {
  model: string;
  messages: Message[];
  tools: unknown[];
  max_tokens: number;
};
export type ModelResponse = {
  id: string;
  message: Message;
  costUsdMicros?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
};
export type GenerationUsage = {
  id: string;
  modelId: string;
  costUsdMicros: string;
  createdAt?: string;
};
export interface GenerationClient {
  generation(id: string, options?: { beforeDispatch?: () => Promise<void> }): Promise<GenerationUsage>;
}
export interface ModelClient {
  complete(request: ModelRequest, options?: { beforeDispatch?: () => Promise<void> }): Promise<ModelResponse>;
}
/** Decimal USD -> integer micros, round up; no floating point ledger math. */
export function usdMicros(value: string): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new DomainError("unknown_pricing");
  const [whole, decimal = ""] = value.split(".");
  return (
    BigInt(whole!) * 1_000_000n + BigInt((decimal + "000000").slice(0, 6)) + (/[1-9]/.test(decimal.slice(6)) ? 1n : 0n)
  );
}
function pricedTokens(rate: string, count: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(rate)) throw new DomainError("unknown_pricing");
  const [a, b = ""] = rate.split(".");
  const scale = 10n ** BigInt(b.length);
  const amount = BigInt(a! + b) * BigInt(count) * 1_000_000n;
  return (amount + scale - 1n) / scale;
}
export function estimate(model: Model, request: ModelRequest): string {
  const bytes = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })) + 1024;
  if (!model.pricing.prompt || !model.pricing.completion) throw new DomainError("unknown_pricing");
  const extras = Object.entries(model.pricing).filter(
    ([k, v]) =>
      !["prompt", "completion", "input_cache_read", "input_cache_write", "discount"].includes(k) &&
      !(typeof v === "string" && /^0(?:\.0+)?$/.test(v)) &&
      !(k === "overrides" && Array.isArray(v) && v.length === 0),
  );
  if (extras.some(([k]) => k !== "request")) throw new DomainError("unsupported_pricing");
  return (
    pricedTokens(model.pricing.prompt, bytes) +
    pricedTokens(model.pricing.completion, request.max_tokens) +
    usdMicros(model.pricing.request ?? "0")
  ).toString();
}
export function route(
  models: Model[],
  request: Omit<ModelRequest, "model">,
  budget: string,
  override?: string,
  stats: Record<string, { quality: number; latencyMs?: number; samples: number }> = {},
) {
  const candidates = models.map((model) => {
    let reason: string | undefined;
    let cost: string | undefined;
    if (!model.supported_parameters.includes("tools")) reason = "tools_not_supported";
    else if ((model.context_length ?? 0) < Buffer.byteLength(JSON.stringify(request)) + request.max_tokens + 1024)
      reason = "context_too_small";
    else
      try {
        cost = estimate(model, { ...request, model: model.id });
        if (BigInt(cost) > BigInt(budget)) reason = "budget_exceeded";
      } catch {
        reason = "unknown_pricing";
      }
    const s = stats[model.id];
    return {
      model,
      reason,
      cost,
      samples: s?.samples ?? 0,
      quality: s?.quality ?? 3,
      latency: s?.latencyMs ?? 1000,
      score: 0,
    };
  });
  const usable = candidates.filter((c) => !c.reason);
  const maxCost = Math.max(1, ...usable.map((c) => Number(c.cost)));
  const maxLatency = Math.max(1, ...usable.map((c) => c.latency));
  usable.forEach(
    (c) =>
      (c.score =
        (0.5 * (c.quality - 1)) / 4 + 0.3 * (1 - Number(c.cost) / maxCost) + 0.2 * (1 - c.latency / maxLatency)),
  );
  const selected = override
    ? usable.find((c) => c.model.id === override)
    : usable.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id))[0];
  return { selected, candidates };
}
/** An HTTP rejection before generation; never inferred from a transport exception. */
export class ModelRequestRejected extends DomainError {}
function safeModelId(id: string, secret?: string) {
  return /^[A-Za-z0-9_./:-]{1,300}$/.test(id) && !(secret && id.includes(secret)) ? id : "invalid_model_id";
}
export class OpenRouterClient implements ModelClient {
  baseUrl: string;
  secret: () => Promise<string>;
  timeoutMs: number;
  catalogDiagnostics: CatalogDiagnostics | undefined;
  catalogFailure: CatalogFailure | undefined;
  private calls = 0;
  private readonly pending: (() => void)[] = [];
  private readonly maxConcurrent: number;
  constructor(options: {
    secret: () => Promise<string>;
    baseUrl?: string;
    testServer?: boolean;
    timeoutMs?: number;
    maxConcurrent?: number;
  }) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 16)
      throw new DomainError("invalid_model_concurrency");
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (
      new URL(this.baseUrl).protocol !== "https:" &&
      !(options.testServer && ["127.0.0.1", "localhost"].includes(new URL(this.baseUrl).hostname))
    )
      throw new DomainError("tls_required");
  }
  async catalog(): Promise<Model[]> {
    this.catalogDiagnostics = undefined;
    this.catalogFailure = undefined;
    const signal = AbortSignal.timeout(30_000);
    let payload: unknown;
    try {
      const response = await fetch(this.baseUrl + "/models?output_modalities=all", {
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        this.catalogFailure = { reason: "http", status: response.status };
        await response.body?.cancel().catch(() => {});
        throw new DomainError("catalog_unavailable");
      }
      payload = await response.json();
    } catch (error) {
      this.catalogFailure ??= {
        reason:
          signal.aborted || (error instanceof Error && error.name === "TimeoutError")
            ? "timeout"
            : error instanceof SyntaxError
              ? "invalid_json"
              : "transport",
      };
      throw new DomainError("catalog_unavailable");
    }
    const envelope = z.object({ data: z.array(z.unknown()) }).safeParse(payload);
    if (!envelope.success) {
      this.catalogFailure = { reason: "schema" };
      throw new DomainError("catalog_unavailable");
    }
    const models: Model[] = [];
    const issues: CatalogDiagnostics["issues"] = [];
    for (const [index, entry] of envelope.data.data.entries()) {
      const parsed = modelSchema.safeParse(entry);
      if (parsed.success) models.push(parsed.data);
      else
        issues.push({
          index,
          fields: [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))],
        });
    }
    this.catalogDiagnostics = {
      received: envelope.data.data.length,
      accepted: models.length,
      rejected: issues.length,
      issues,
    };
    // A genuinely empty catalog is valid; a wholly unreadable one must not replace cached models.
    if (envelope.data.data.length > 0 && models.length === 0) {
      this.catalogFailure = { reason: "schema" };
      throw new DomainError("catalog_unavailable");
    }
    return models;
  }
  async generation(id: string, options?: { beforeDispatch?: () => Promise<void> }): Promise<GenerationUsage> {
    z.string()
      .min(1)
      .max(300)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .parse(id);
    const token = await this.secret();
    await options?.beforeDispatch?.();
    try {
      const response = await fetch(this.baseUrl + "/generation?id=" + encodeURIComponent(id), {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("unavailable");
      }
      if (!response.body) throw new Error("empty");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 128 * 1024) throw new Error("limit");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const data = z
        .object({
          data: z.object({
            id: z.string().min(1).max(300),
            model: z.string().min(1).max(300),
            total_cost: z.number().finite().nonnegative(),
            created_at: z.iso.datetime({ offset: true }).optional(),
          }),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data;
      if (data.id !== id || data.model.includes(token) || data.id.includes(token)) throw new Error("binding");
      // Expand exponent notation for sub-micro provider charges before conservative integer rounding.
      const decimal = String(data.total_cost).replace(
        /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/,
        (_all, whole: string, fraction: string | undefined, exponent: string) => {
          const digits = whole + (fraction ?? ""),
            point = whole.length + Number(exponent);
          return point <= 0
            ? "0." + "0".repeat(-point) + digits
            : point >= digits.length
              ? digits + "0".repeat(point - digits.length)
              : digits.slice(0, point) + "." + digits.slice(point);
        },
      );
      const costUsdMicros = usdMicros(decimal).toString();
      if (costUsdMicros.length > 24) throw new Error("limit");
      return {
        id: data.id,
        modelId: data.model,
        costUsdMicros,
        ...(data.created_at ? { createdAt: data.created_at } : {}),
      };
    } catch {
      throw new DomainError("usage_unavailable", "Provider-Abrechnung ist nicht sicher verfügbar.");
    }
  }
  async complete(request: ModelRequest, options?: { beforeDispatch?: () => Promise<void> }): Promise<ModelResponse> {
    if (this.calls >= this.maxConcurrent) await new Promise<void>((resolve) => this.pending.push(resolve));
    else this.calls++;
    try {
      const started = performance.now();
      const result = await this.performComplete(request, options);
      return {
        ...result,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
      };
    } finally {
      const next = this.pending.shift();
      if (next) next();
      else this.calls--;
    }
  }
  private async performComplete(
    request: ModelRequest,
    options?: { beforeDispatch?: () => Promise<void> },
  ): Promise<ModelResponse> {
    let outgoing: Request;
    let body: string;
    let secret = "";
    try {
      secret = await this.secret();
      body = JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } });
      outgoing = new Request(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      // Final authorization follows queue waiting AND potentially remote credential resolution.
      await options?.beforeDispatch?.();
      outgoing.signal.throwIfAborted();
    } catch (error) {
      console.warn("IronCrew model call failed", {
        phase: "preparation",
        code: "model_dispatch_denied",
        modelId: safeModelId(request.model, secret),
      });
      throw new DomainError(
        "model_dispatch_denied",
        error instanceof DomainError ? error.code : "dispatch_preparation_failed",
      );
    }
    let r: Response;
    try {
      r = await fetch(outgoing.url, {
        method: outgoing.method,
        headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
        body,
        signal: outgoing.signal,
        redirect: "error",
      });
    } catch {
      console.warn("IronCrew model call failed", { phase: "transport", modelId: safeModelId(request.model, secret) });
      throw new DomainError("model_interrupted");
    }
    if (!r.ok || !r.body) {
      const code =
        r.status === 429
          ? "model_rate_limited"
          : r.status === 404 && request.model.endsWith(":free")
            ? "model_free_endpoint_unavailable"
            : "model_unavailable";
      console.warn("IronCrew model call failed", {
        phase: "http",
        status: r.status,
        modelId: safeModelId(request.model, secret),
        ...(code === "model_free_endpoint_unavailable"
          ? { hint: "Select openrouter/free explicitly; no automatic fallback." }
          : {}),
      });
      await r.body?.cancel().catch(() => undefined);
      if ([400, 401, 402, 403, 404, 422, 429].includes(r.status)) throw new ModelRequestRejected(code);
      throw new DomainError(code);
    }
    if (!r.headers.get("content-type")?.includes("text/event-stream")) {
      const data = z
        .object({
          id: z.string(),
          choices: z.array(z.object({ message: assistantSchema })).min(1),
          usage: z
            .object({
              cost: z.number().nonnegative().optional(),
              prompt_tokens: z.number().optional(),
              completion_tokens: z.number().optional(),
            })
            .optional(),
        })
        .parse(await r.json());
      if (!/^[A-Za-z0-9_.:-]{1,300}$/.test(data.id) || (secret && data.id.includes(secret)))
        throw new DomainError("model_response_id_invalid");
      return {
        id: data.id,
        message: data.choices[0]!.message,
        ...usageFields(data.usage),
      };
    }
    let buffer = "",
      id = "",
      content = "",
      done = false,
      bytes = 0;
    const calls = new Map<
      number,
      {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }
    >();
    let usage: unknown;
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 8_000_000) throw new Error("limit");
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") {
            done = true;
            continue;
          }
          const event = z
            .object({
              id: z.string().optional(),
              choices: z
                .array(
                  z.object({
                    delta: z
                      .object({
                        content: z.string().nullable().optional(),
                        tool_calls: z
                          .array(
                            z.object({
                              index: z.number().int().nonnegative(),
                              id: z.string().optional(),
                              function: z
                                .object({
                                  name: z.string().optional(),
                                  arguments: z.string().optional(),
                                })
                                .optional(),
                            }),
                          )
                          .optional(),
                      })
                      .optional(),
                  }),
                )
                .optional(),
              usage: z.unknown().optional(),
              error: z.unknown().optional(),
            })
            .parse(JSON.parse(raw));
          if (event.error) throw new Error("provider_error");
          if (event.id) id = event.id;
          if (event.usage) usage = event.usage;
          for (const choice of event.choices ?? []) {
            content += choice.delta?.content ?? "";
            for (const part of choice.delta?.tool_calls ?? []) {
              const call = calls.get(part.index) ?? {
                id: "",
                type: "function",
                function: { name: "", arguments: "" },
              };
              if (part.id) call.id = part.id;
              call.function.name += part.function?.name ?? "";
              call.function.arguments += part.function?.arguments ?? "";
              calls.set(part.index, call);
            }
          }
        }
      }
    } catch {
      throw new DomainError("model_interrupted");
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!done || !/^[A-Za-z0-9_.:-]{1,300}$/.test(id) || (secret && id.includes(secret)))
      throw new DomainError("model_interrupted");
    const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, v]) => callSchema.parse(v));
    for (const call of tool_calls) {
      try {
        z.record(z.string(), z.unknown()).parse(JSON.parse(call.function.arguments));
      } catch {
        throw new DomainError("incomplete_tool_arguments");
      }
    }
    return {
      id,
      message: {
        role: "assistant",
        content,
        ...(tool_calls.length ? { tool_calls } : {}),
      },
      ...usageFields(usage),
    };
  }
}
function usageFields(input: unknown): Pick<ModelResponse, "costUsdMicros" | "inputTokens" | "outputTokens"> {
  const u = z
    .object({
      cost: z.number().nonnegative().optional(),
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .safeParse(input);
  return u.success
    ? {
        costUsdMicros: u.data.cost === undefined ? undefined : usdMicros(String(u.data.cost)).toString(),
        inputTokens: u.data.prompt_tokens,
        outputTokens: u.data.completion_tokens,
      }
    : {};
}
