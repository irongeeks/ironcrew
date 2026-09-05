/**
 * IronCrew — OpenRouter as an AgentRuntime.
 *
 * The first runtime that is not a CLI. Every other one wraps a tool the
 * operator logged into (`docs/PROVIDER_AUTH.md`); this one holds an API key
 * and speaks HTTP, which changes two things and nothing else.
 *
 * WHAT CHANGES: VENDOR POLICY IS THIS MODULE'S PROBLEM
 *
 * A CLI runtime runs whatever model its vendor gives it, and the policy engine
 * checks the model an operator selected. OpenRouter is a *router*: one key
 * reaches hundreds of models from dozens of vendors, including ones this
 * project refuses on principle (docs/ROADMAP.md, "Deliberately not planned").
 * A run here could therefore reach a blocked vendor without anyone choosing
 * it, so `evaluateModel()` is enforced inside `startRun` — before the request
 * is built, not after the answer comes back. A policy checked after the fact
 * is a policy that has already been broken.
 *
 * WHAT DOES NOT CHANGE
 *
 * The contract. It emits the same normalised events, honours the same
 * cancellation signal, reports usage and cost the same way, and is testable
 * through an injected `fetchImpl` — so the control plane cannot tell an HTTP
 * runtime from a CLI one, which is the point of having a contract.
 *
 * COST IS REPORTED, NOT ESTIMATED
 *
 * OpenRouter returns the actual charge for a completion, so `costReporting`
 * is true and the budget engine sees real money rather than a guess derived
 * from a price table that will be out of date by next month.
 */

import { newId } from "../domain/ids.ts";
import { z } from "zod";
import { REDACTED, redact, redactValue, StreamRedactor } from "../security/redaction.ts";
import { readOpenRouterStream } from "./openrouter-stream.ts";
import type { OpenRouterTool, OpenRouterToolCall, OpenRouterToolExecutor } from "./openrouter-tools.ts";
import {
  buildOpenRouterProviderPolicy,
  evaluateModel,
  getVendorPolicy,
  restrictVendorPolicy,
  type VendorPolicy,
} from "../policy/vendor-policy.ts";
import type {
  AgentRuntime,
  AuthStatus,
  RunContext,
  RunEvent,
  RunEventType,
  RunInput,
  RuntimeCapabilities,
  RuntimeHealth,
} from "./run-events.ts";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface OpenRouterRuntimeOptions {
  apiKey: string;
  baseUrl?: string;
  /** Used when neither the vessel nor the caller names one. */
  defaultModel?: string;
  timeoutMs?: number;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  toolExecutor?: OpenRouterToolExecutor;
  /** Trusted composition-root resolver. Run input cannot replace the baseline. */
  vendorPolicy?: (companyId: string) => VendorPolicy;
  /** Response-token cap, separate from RunInput.maxTurns (agent loop rounds). */
  maxOutputTokens?: number;
}

const toolDeltaSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});
const messageSchema = z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.array(toolDeltaSchema).max(64).optional(),
});
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative().optional(),
        delta: messageSchema.optional(),
        message: messageSchema.optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().finite().nonnegative().optional(),
      completion_tokens: z.number().finite().nonnegative().optional(),
      cost: z.number().finite().nonnegative().optional(),
    })
    .optional(),
  error: z.object({ message: z.string(), code: z.union([z.string(), z.number()]).optional() }).optional(),
});
type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Bound callbacks as well as fetch; executors also receive the same signal
 * and must cancel their own underlying operation when it aborts. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class OpenRouterRuntime implements AgentRuntime {
  readonly id = "openrouter";
  readonly type = "openrouter";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly toolExecutor?: OpenRouterToolExecutor;
  private readonly maxOutputTokens: number;
  private readonly vendorPolicy: (companyId: string) => VendorPolicy;
  private readonly cancelled = new Set<string>();
  private readonly active = new Map<string, AbortController>();

  constructor(opts: OpenRouterRuntimeOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.toolExecutor = opts.toolExecutor;
    this.vendorPolicy = opts.vendorPolicy ?? getVendorPolicy;
    this.maxOutputTokens = z
      .number()
      .int()
      .positive()
      .max(128_000)
      .parse(opts.maxOutputTokens ?? 4096);
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      sessionResume: false,
      usageReporting: true,
      // See the header: OpenRouter reports the real charge, so the budget
      // engine gets money rather than an estimate from a stale price table.
      costReporting: true,
      toolCalls: this.toolExecutor !== undefined,
      subagents: false,
      defaultConcurrency: 6,
      workspaceRequired: this.toolExecutor?.workspaceRequired ?? false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    const checkedAt = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers() });
      return {
        healthy: res.ok,
        installed: true,
        detail: res.ok ? "OpenRouter erreichbar." : `OpenRouter antwortete mit HTTP ${res.status}.`,
        checkedAt,
      };
    } catch (err) {
      return {
        healthy: false,
        // "installed" is meaningless for an HTTP runtime — there is nothing to
        // install — so it is true and `healthy` carries the real answer.
        installed: true,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt,
      };
    }
  }

  async authStatus(): Promise<AuthStatus> {
    if (!this.apiKey) {
      return {
        authenticated: false,
        method: "api-key",
        detail: "Kein OpenRouter-Schlüssel konfiguriert.",
        setupHint: "OPENROUTER_API_KEY setzen — oder besser: als SecretRef hinterlegen.",
      };
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/auth/key`, { headers: this.headers() });
      return {
        authenticated: res.ok,
        method: "api-key",
        detail: res.ok ? "Schlüssel gültig." : `Schlüssel abgelehnt (HTTP ${res.status}).`,
      };
    } catch (err) {
      return {
        authenticated: false,
        method: "api-key",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelled.add(runId);
    this.active.get(runId)?.abort();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter asks callers to identify themselves; neither header
      // carries anything about the company or the operator.
      "HTTP-Referer": "https://github.com/irongeeks/ironcrew",
      "X-Title": "IronCrew",
    };
  }

  async *startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    let seq = 0;
    const emit = (type: RunEventType, payload: Record<string, unknown> = {}): RunEvent => {
      const probe = redact(JSON.stringify(payload), [this.apiKey, ...(context.redactValues ?? [])]);
      return {
        eventId: newId("evt"),
        companyId: context.companyId,
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        seq: seq++,
        type,
        timestamp: Date.now(),
        correlationId: context.correlationId,
        payload: JSON.parse(probe.text) as Record<string, unknown>,
        redaction: {
          redacted: probe.redacted || JSON.stringify(payload).includes(REDACTED),
          rules: probe.matchedRules.length
            ? probe.matchedRules
            : JSON.stringify(payload).includes(REDACTED)
              ? ["stream_redaction"]
              : [],
        },
      };
    };

    const model = (input.model ?? "").trim() || this.defaultModel;

    // Before anything is sent. One key here reaches hundreds of models from
    // dozens of vendors, so a run could otherwise arrive at a blocked one
    // without anybody having chosen it — and a policy checked after the
    // answer comes back is a policy that has already been broken.
    const policy = restrictVendorPolicy(this.vendorPolicy(context.companyId), context.vendorRestrictions);
    const decision = evaluateModel(policy, model, "openrouter");
    if (!decision.allowed) {
      yield emit("run.failed", {
        message: `Vendor-Policy verbietet "${model}": ${decision.reason}`,
        code: decision.code,
      });
      return;
    }

    // A permitted model family does not constrain its hosting provider.
    // An empty allowlist must never become an unconstrained router request.
    if (policy.openrouter.allowed_providers.length === 0) {
      yield emit("run.failed", {
        message: "Vendor-Policy erlaubt keinen OpenRouter-Provider.",
        code: "no_allowed_providers",
      });
      return;
    }

    yield emit("run.started", { model, runtime: this.type });

    if (this.cancelled.has(context.runId) || context.signal?.aborted) {
      this.cancelled.delete(context.runId);
      yield emit("run.cancelled", { reason: "cancelled before the request was sent" });
      return;
    }

    // The caller's signal and this runtime's own timeout, as one signal: a
    // vessel's timeout and an operator's cancel should both stop the request
    // itself, not just stop us listening to it.
    const abort = new AbortController();
    this.active.set(context.runId, abort);
    const onAbort = () => abort.abort();
    context.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    timer.unref?.();

    try {
      const rounds = z
        .number()
        .int()
        .min(1)
        .max(32)
        .parse(input.maxTurns ?? 8);
      const knownSecrets = [this.apiKey, ...(context.redactValues ?? [])];
      const toolContext = { ...context, signal: abort.signal };
      const definitions = this.toolExecutor
        ? await abortable(this.toolExecutor.listTools(toolContext), abort.signal)
        : [];
      if (definitions.length > 64) throw new Error("Zu viele freigegebene Tools.");
      const permitted = new Map<string, OpenRouterTool>();
      const tools = definitions.map((tool) => {
        z.string()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/)
          .parse(tool.name);
        if (permitted.has(tool.name)) throw new Error("Doppelter Toolname in der Freigabeliste.");
        permitted.set(tool.name, tool);
        return {
          type: "function",
          function: {
            name: tool.name,
            description: z.string().min(1).max(4096).parse(tool.description),
            parameters: z.toJSONSchema(tool.inputSchema),
          },
        };
      });
      const messages: ChatMessage[] = [{ role: "user", content: redact(input.prompt, knownSecrets).text }];
      for (let round = 0; round < rounds; round++) {
        abort.signal.throwIfAborted();
        // Tool discovery/execution may have yielded while an owner tightened
        // policy. Re-read immediately before each external model request.
        const requestPolicy = restrictVendorPolicy(this.vendorPolicy(context.companyId), context.vendorRestrictions);
        const requestDecision = evaluateModel(requestPolicy, model, "openrouter");
        if (!requestDecision.allowed)
          throw new Error(`Vendor-Policy verweigert den Request: ${requestDecision.reason}`);
        if (requestPolicy.openrouter.allowed_providers.length === 0)
          throw new Error("Vendor-Policy erlaubt keinen OpenRouter-Provider.");
        const provider = buildOpenRouterProviderPolicy(requestPolicy, { sensitive: context.sensitive !== false });
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          signal: abort.signal,
          body: JSON.stringify({
            model,
            provider: tools.length ? { ...provider, require_parameters: true } : provider,
            messages,
            stream: true,
            max_tokens: this.maxOutputTokens,
            ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
          }),
        });
        if (response.status === 429) {
          const retryAfter = response.headers?.get("retry-after");
          const delay = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
          const resetAt = delay !== null ? Date.now() + delay : retryAfter ? Date.parse(retryAfter) : NaN;
          yield emit("rate_limit.detected", {
            provider: "openrouter",
            status: 429,
            ...(Number.isFinite(resetAt) ? { resetAt } : {}),
          });
          yield emit("run.waiting", { reason: "rate_limited" });
          return;
        }
        if (!response.ok) throw new Error(`OpenRouter antwortete mit HTTP ${response.status}.`);
        const streaming = response.headers?.get("content-type")?.includes("text/event-stream") ?? false;
        if (streaming && !response.body) throw new Error("OpenRouter lieferte keinen Stream.");
        const frames = streaming
          ? readOpenRouterStream(response.body!, abort.signal)
          : (async function* () {
              yield (await response.json()) as unknown;
            })();
        let content = "";
        let finishReason: string | null = null;
        let usage: z.infer<typeof responseSchema>["usage"];
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        const redactor = new StreamRedactor(knownSecrets);
        for await (const raw of frames) {
          abort.signal.throwIfAborted();
          const data = responseSchema.parse(raw);
          if (data.error) {
            if (String(data.error.code) === "429") {
              yield emit("rate_limit.detected", { provider: "openrouter", status: 429 });
              yield emit("run.waiting", { reason: "rate_limited" });
              return;
            }
            throw new Error(data.error.message);
          }
          if (data.usage) usage = data.usage;
          if (data.choices && data.choices.length > 1) throw new Error("Mehrdeutige OpenRouter-Antwort.");
          const choice = data.choices?.[0];
          if (!choice) continue; // OpenAI-compatible empty usage choice
          if (choice.index !== undefined && choice.index !== 0) throw new Error("Unerwarteter Antwortindex.");
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const message = streaming ? choice.delta : choice.message;
          if (message?.content) {
            content += message.content;
            if (content.length > 4 * 1024 * 1024) throw new Error("OpenRouter-Text überschreitet das Größenlimit.");
            if (streaming) {
              const safeDelta = redactor.push(message.content);
              if (safeDelta) yield emit("message.delta", { text: safeDelta });
            }
          }
          for (const [position, tool] of (message?.tool_calls ?? []).entries()) {
            if (streaming && tool.index === undefined) throw new Error("Tool-Fragment ohne Index.");
            const index = tool.index ?? position;
            const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
            if (tool.id) {
              if (call.id && call.id !== tool.id) throw new Error("Widersprüchliche Tool-Call-ID.");
              call.id = tool.id;
            }
            call.name += tool.function?.name ?? "";
            call.arguments += tool.function?.arguments ?? "";
            if (call.arguments.length > 1024 * 1024 || call.name.length > 64 || calls.size > 64) {
              throw new Error("OpenRouter-Toolaufruf überschreitet das Größenlimit.");
            }
            calls.set(index, call);
          }
        }
        abort.signal.throwIfAborted();
        if (streaming && !finishReason) throw new Error("OpenRouter-Stream ohne Abschlussgrund.");
        if (finishReason === "error" || finishReason === "length" || finishReason === "content_filter") {
          throw new Error(`OpenRouter-Antwort unvollständig: ${finishReason}.`);
        }
        if (streaming) {
          const tail = redactor.flush();
          if (tail) yield emit("message.delta", { text: tail });
        }
        yield emit("usage.updated", {
          inputTokens: numberOr(usage?.prompt_tokens, 0),
          outputTokens: numberOr(usage?.completion_tokens, 0),
          costMicros: Math.round(numberOr(usage?.cost, 0) * 1_000_000),
        });
        if (calls.size === 0) {
          if (!content || finishReason === "tool_calls") throw new Error("OpenRouter lieferte eine leere Antwort.");
          yield emit("message.completed", { text: content });
          yield emit("run.completed", { finishReason: finishReason ?? "stop" });
          return;
        }
        if (finishReason !== "tool_calls") throw new Error("Toolaufruf ohne vollständigen Tool-Abschluss.");
        if (!this.toolExecutor) throw new Error("OpenRouter forderte Tools ohne freigegebenen Executor an.");
        const validated: OpenRouterToolCall[] = [];
        const ids = new Set<string>();
        for (const call of calls.values()) {
          if (!call.id || ids.has(call.id)) throw new Error("Fehlende oder doppelte Tool-Call-ID.");
          ids.add(call.id);
          const definition = permitted.get(call.name);
          if (!definition) throw new Error(`Tool nicht freigegeben: ${call.name}`);
          const args = definition.inputSchema.parse(JSON.parse(call.arguments) as unknown);
          validated.push({ id: call.id, name: call.name, arguments: z.record(z.string(), z.unknown()).parse(args) });
        }
        messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: [...calls.values()].map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        });
        for (const call of validated) {
          abort.signal.throwIfAborted();
          const safeCall = redactValue(call, knownSecrets);
          await abortable(this.toolExecutor.audit("requested", safeCall, toolContext), abort.signal);
          yield emit("tool.requested", { toolCallId: call.id, tool: call.name, arguments: safeCall.arguments });
          const authorization = await abortable(this.toolExecutor.authorize(call, toolContext), abort.signal);
          if (authorization.status === "denied") {
            await abortable(
              this.toolExecutor.audit("denied", safeCall, toolContext, redact(authorization.reason, knownSecrets).text),
              abort.signal,
            );
            yield emit("tool.failed", { toolCallId: call.id, tool: call.name, message: authorization.reason });
            throw new Error(`Tool-Policy verweigert ${call.name}: ${authorization.reason}`);
          }
          if (authorization.status === "approval_required") {
            await abortable(this.toolExecutor.audit("approval_required", safeCall, toolContext), abort.signal);
            yield emit("approval.required", { ...authorization, toolCallId: call.id, tool: call.name });
            yield emit("run.waiting", { reason: "approval_required" });
            return;
          }
          await abortable(
            this.toolExecutor.audit("started", safeCall, toolContext, { approvalId: authorization.approvalId }),
            abort.signal,
          );
          yield emit("tool.started", { toolCallId: call.id, tool: call.name, approvalId: authorization.approvalId });
          abort.signal.throwIfAborted();
          let output: unknown;
          try {
            output = redactValue(
              await abortable(this.toolExecutor.execute(call, toolContext), abort.signal),
              knownSecrets,
            );
            abort.signal.throwIfAborted();
            const encoded = JSON.stringify(output) ?? "null";
            if (encoded.length > 1024 * 1024) throw new Error("Tool-Ergebnis überschreitet das Größenlimit.");
            await abortable(this.toolExecutor.audit("completed", safeCall, toolContext, output), abort.signal);
            yield emit("tool.completed", { toolCallId: call.id, tool: call.name, result: output });
            messages.push({ role: "tool", tool_call_id: call.id, content: encoded });
          } catch (err) {
            const error = redact(err instanceof Error ? err.message : String(err), knownSecrets).text;
            if (!abort.signal.aborted)
              await abortable(this.toolExecutor.audit("failed", safeCall, toolContext, error), abort.signal);
            yield emit("tool.failed", { toolCallId: call.id, tool: call.name, message: error });
            throw err;
          }
        }
      }
      throw new Error("Maximale Anzahl der OpenRouter-Toolrunden erreicht.");
    } catch (err) {
      if (context.signal?.aborted || this.cancelled.has(context.runId)) {
        yield emit("run.cancelled", { reason: "abgebrochen" });
      } else if (timedOut) {
        yield emit("run.failed", { code: "timeout", message: "OpenRouter-Anfrage hat das Zeitlimit überschritten." });
      } else {
        yield emit("run.failed", { message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
      this.active.delete(context.runId);
      this.cancelled.delete(context.runId);
    }
  }
}
