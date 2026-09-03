/**
 * Shared LLM call utilities — provider resolution, model selection, and
 * multi-provider HTTP call (OpenAI-compatible, Anthropic, Google).
 *
 * Extracted from ceo-orchestrator so that any module needing a one-shot LLM
 * call can reuse the same logic.
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decryptSecret } from "../../../oauth/helpers.ts";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "llm-call" });

// ---------------------------------------------------------------------------
// Provider response schemas
//
// Each schema validates only the fields we actually read. Unknown fields are
// tolerated so this stays forward-compatible with non-breaking provider
// additions. On `safeParse` failure we throw a `LlmResponseParseError`, which
// existing callers already handle via their try/catch around `callLlm`.
// ---------------------------------------------------------------------------

// Anthropic Messages API: `content` is an array of typed blocks. We only read
// `text` blocks; non-text blocks (e.g. `tool_use`) are tolerated and ignored.
const AnthropicTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
const AnthropicNonTextBlockSchema = z
  .object({ type: z.string().refine((t) => t !== "text", { message: "non-text block must not have type='text'" }) })
  .passthrough();
const AnthropicBlockSchema = z.union([AnthropicTextBlockSchema, AnthropicNonTextBlockSchema]);
const AnthropicResponseSchema = z.object({
  content: z.array(AnthropicBlockSchema),
});
type AnthropicBlock = z.infer<typeof AnthropicBlockSchema>;

// Google Gemini generateContent: candidates[0].content.parts[].text
const GooglePartSchema = z.object({ text: z.string().optional() }).passthrough();
const GoogleCandidateSchema = z.object({
  content: z
    .object({
      parts: z.array(GooglePartSchema).optional(),
    })
    .optional(),
});
const GoogleResponseSchema = z.object({
  candidates: z.array(GoogleCandidateSchema).min(1),
});

// OpenAI-compatible chat/completions: choices[0].message.content
const OpenAiChoiceSchema = z.object({
  message: z.object({
    content: z.string().nullable().optional(),
  }),
});
const OpenAiResponseSchema = z.object({
  choices: z.array(OpenAiChoiceSchema).min(1),
});

export class LlmResponseParseError extends Error {
  readonly reason = "parse_error" as const;
  readonly providerType: string;
  readonly issues: z.ZodIssue[];
  constructor(providerType: string, issues: z.ZodIssue[]) {
    super(`LLM response from provider type '${providerType}' failed schema validation`);
    this.name = "LlmResponseParseError";
    this.providerType = providerType;
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiProviderRow = {
  id: string;
  name: string;
  type: string;
  base_url: string;
  api_key_enc: string | null;
  models_cache: string | null;
  enabled: number;
};

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

export function getFirstEnabledProvider(db: Pick<DatabaseSync, "prepare">): ApiProviderRow | null {
  return (
    (db.prepare("SELECT * FROM api_providers WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1").get() as
      | ApiProviderRow
      | undefined) ?? null
  );
}

export function resolveModel(provider: ApiProviderRow, settingModel: string): string {
  if (settingModel) return settingModel;
  if (provider.models_cache) {
    try {
      const models = JSON.parse(provider.models_cache) as string[];
      if (models.length > 0) return models[0];
    } catch {
      /* ignore */
    }
  }
  return "gpt-4o-mini"; // fallback
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export async function callLlm(
  provider: ApiProviderRow,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : "";
  let baseUrl = provider.base_url.replace(/\/+$/, "");
  baseUrl = baseUrl.replace(/\/(v\d+)\/(chat\/completions|models|messages)$/i, "/$1");

  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (provider.type === "anthropic") {
    url = baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
    headers = {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    body = JSON.stringify({
      model,
      max_tokens: 2000,
      stream: false,
      messages: [{ role: "user", content: userMessage }],
      system: systemPrompt,
    });
  } else if (provider.type === "google") {
    const googleBase = baseUrl.endsWith("/v1beta") ? baseUrl : `${baseUrl}/v1beta`;
    url = `${googleBase}/models/${model}:generateContent`;
    headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey };
    body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
    });
  } else {
    // OpenAI-compatible
    url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: false,
      max_tokens: 2000,
    });
  }

  if (isBlockedSsrfTarget(url, { allowLocal: true })) {
    throw new Error(`LLM provider '${provider.name}' base_url targets a blocked address range`);
  }

  log.debug({ provider: provider.name, model, url }, "calling LLM");

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`LLM call failed: ${resp.status} ${errText.slice(0, 200)}`);
  }

  const data: unknown = await resp.json();

  // Parse response based on provider type. On schema mismatch we throw
  // `LlmResponseParseError` rather than silently returning "" — callers
  // already wrap `callLlm` in try/catch and treat thrown errors uniformly.
  if (provider.type === "anthropic") {
    const result = AnthropicResponseSchema.safeParse(data);
    if (!result.success) {
      log.warn({ provider: provider.name, issues: result.error.issues }, "anthropic response failed schema validation");
      throw new LlmResponseParseError("anthropic", result.error.issues);
    }
    return result.data.content
      .filter((b: AnthropicBlock): b is z.infer<typeof AnthropicTextBlockSchema> => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  if (provider.type === "google") {
    const result = GoogleResponseSchema.safeParse(data);
    if (!result.success) {
      log.warn({ provider: provider.name, issues: result.error.issues }, "google response failed schema validation");
      throw new LlmResponseParseError("google", result.error.issues);
    }
    const parts = result.data.candidates[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? "").join("");
  }

  // OpenAI-compatible
  const result = OpenAiResponseSchema.safeParse(data);
  if (!result.success) {
    log.warn({ provider: provider.name, issues: result.error.issues }, "openai response failed schema validation");
    throw new LlmResponseParseError("openai", result.error.issues);
  }
  return String(result.data.choices[0]?.message?.content ?? "");
}
