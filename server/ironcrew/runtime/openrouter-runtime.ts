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
import { redact } from "../security/redaction.ts";
import { buildOpenRouterProviderPolicy, evaluateModel, getVendorPolicy } from "../policy/vendor-policy.ts";
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
}

interface OpenRouterChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

interface OpenRouterUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  /** OpenRouter's own charge for the call, in credits (USD). */
  cost?: unknown;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  error?: { message?: unknown };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class OpenRouterRuntime implements AgentRuntime {
  readonly id = "openrouter";
  readonly type = "openrouter";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cancelled = new Set<string>();
  private readonly active = new Map<string, AbortController>();

  constructor(opts: OpenRouterRuntimeOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: false,
      sessionResume: false,
      usageReporting: true,
      // See the header: OpenRouter reports the real charge, so the budget
      // engine gets money rather than an estimate from a stale price table.
      costReporting: true,
      toolCalls: false,
      subagents: false,
      defaultConcurrency: 4,
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
      const probe = redact(JSON.stringify(payload), context.redactValues ?? []);
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
        redaction: { redacted: probe.redacted, rules: probe.matchedRules },
      };
    };

    const model = (input.model ?? "").trim() || this.defaultModel;

    // Before anything is sent. One key here reaches hundreds of models from
    // dozens of vendors, so a run could otherwise arrive at a blocked one
    // without anybody having chosen it — and a policy checked after the
    // answer comes back is a policy that has already been broken.
    const policy = getVendorPolicy();
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
    const provider = buildOpenRouterProviderPolicy(policy, { sensitive: context.sensitive !== false });

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
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: abort.signal,
        body: JSON.stringify({
          model,
          provider,
          messages: [{ role: "user", content: input.prompt }],
          ...(input.maxTurns ? { max_tokens: input.maxTurns } : {}),
        }),
      });
      if (response.status === 429) {
        // Reported as its own event rather than a generic failure: the control
        // plane treats a rate limit as "try later", not as "this task is bad".
        yield emit("rate_limit.detected", { provider: "openrouter", status: 429 });
        yield emit("run.waiting", { reason: "rate_limited" });
        return;
      }

      if (!response.ok) {
        yield emit("run.failed", { message: `OpenRouter antwortete mit HTTP ${response.status}.` });
        return;
      }

      let data: OpenRouterResponse;
      try {
        data = (await response.json()) as OpenRouterResponse;
      } catch (err) {
        if (abort.signal.aborted) throw err;
        yield emit("run.failed", { message: "OpenRouter lieferte kein gültiges JSON." });
        return;
      }

      // Cancellation also wins when an injected transport finishes its body
      // despite the signal. Never publish a result after the owner cancelled.
      if (abort.signal.aborted) throw abort.signal.reason;

      if (data.error) {
        yield emit("run.failed", { message: String(data.error.message ?? "OpenRouter meldete einen Fehler.") });
        return;
      }

      const usage = data.usage ?? {};
      const inputTokens = numberOr(usage.prompt_tokens, 0);
      const outputTokens = numberOr(usage.completion_tokens, 0);
      yield emit("usage.updated", {
        inputTokens,
        outputTokens,
        // Credits are USD; the budget engine counts micros.
        costMicros: Math.round(numberOr(usage.cost, 0) * 1_000_000),
      });

      const content = data.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : "";
      if (text === "") {
        // An empty completion is a failure, not a silent success: a task moved
        // to review with no result wastes a human's attention.
        yield emit("run.failed", { message: "OpenRouter lieferte eine leere Antwort." });
        return;
      }

      yield emit("message.completed", { text });
      yield emit("run.completed", { finishReason: String(data.choices?.[0]?.finish_reason ?? "stop") });
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
