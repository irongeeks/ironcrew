/**
 * IronCrew — MockRuntime.
 *
 * A first-class runtime, not a test stub. It exists so the entire vertical
 * slice (CEO -> EA -> task -> delegation -> run -> review) is exercisable and
 * testable on a machine with no CLI logins at all, which is the normal state
 * of CI and of a fresh checkout.
 *
 * It emits the same normalised events, honours cancellation, and can be told
 * to simulate failure, rate limiting, approval requests and token usage, so
 * the control plane's handling of those paths is genuinely covered rather
 * than assumed.
 */

import { newId } from "../domain/ids.ts";
import { redact } from "../security/redaction.ts";
import type {
  AgentRuntime,
  AuthStatus,
  RunContext,
  RunEvent,
  RunInput,
  RuntimeCapabilities,
  RuntimeHealth,
  RunEventType,
} from "./run-events.ts";

export type MockScenario = "success" | "failure" | "rate_limit" | "approval_required" | "slow" | "cancelled";

export interface MockRuntimeOptions {
  scenario?: MockScenario;
  /** Text the mock "produces" as its answer. */
  responseText?: string;
  /** Delay between emitted events, in ms. Keep at 0 in tests. */
  stepDelayMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Reset time reported with a rate_limit.detected event. */
  rateLimitResetAt?: number;
}

export class MockRuntime implements AgentRuntime {
  readonly id = "mock";
  readonly type = "mock";

  private readonly options: Required<Omit<MockRuntimeOptions, "rateLimitResetAt">> & {
    rateLimitResetAt?: number;
  };
  private readonly cancelled = new Set<string>();

  constructor(options: MockRuntimeOptions = {}) {
    this.options = {
      scenario: options.scenario ?? "success",
      responseText: options.responseText ?? "Aufgabe abgeschlossen.",
      stepDelayMs: options.stepDelayMs ?? 0,
      inputTokens: options.inputTokens ?? 1200,
      outputTokens: options.outputTokens ?? 340,
      rateLimitResetAt: options.rateLimitResetAt,
    };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      sessionResume: true,
      usageReporting: true,
      costReporting: false,
      toolCalls: true,
      subagents: true,
      defaultConcurrency: 4,
      version: "mock-1.0.0",
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return {
      healthy: true,
      installed: true,
      detail: "MockRuntime is always available; it performs no external calls.",
      checkedAt: Date.now(),
    };
  }

  async authStatus(): Promise<AuthStatus> {
    return {
      authenticated: true,
      method: "none",
      detail: "MockRuntime requires no authentication.",
    };
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelled.add(runId);
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

    const pause = async () => {
      if (this.options.stepDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.options.stepDelayMs));
      }
    };

    const isCancelled = () => this.cancelled.has(context.runId) || context.signal?.aborted === true;

    yield emit("run.started", {
      runtime: this.type,
      model: input.model ?? "mock-model",
      permissionMode: context.permissionMode,
      workspace: context.workspacePath,
    });

    if (isCancelled()) {
      yield emit("run.cancelled", { reason: "cancelled before work began" });
      return;
    }

    if (this.options.scenario === "rate_limit") {
      yield emit("rate_limit.detected", {
        runtime: this.type,
        resetAt: this.options.rateLimitResetAt ?? Date.now() + 60_000,
        message: "Simulated rate limit",
      });
      yield emit("run.waiting", { reason: "rate_limited" });
      return;
    }

    if (this.options.scenario === "approval_required") {
      yield emit("approval.required", {
        approvalType: "production_change",
        summary: "Simulated high-risk action requiring CEO approval",
        riskLevel: "high",
      });
      yield emit("run.waiting", { reason: "approval_required" });
      return;
    }

    await pause();
    yield emit("tool.requested", { tool: "read_file", args: { path: "README.md" } });
    if (isCancelled()) {
      yield emit("run.cancelled", { reason: "cancelled during tool use" });
      return;
    }
    yield emit("tool.started", { tool: "read_file" });
    await pause();
    yield emit("tool.completed", { tool: "read_file", bytes: 2048 });

    const words = this.options.responseText.split(" ");
    for (const word of words) {
      if (isCancelled()) {
        yield emit("run.cancelled", { reason: "cancelled during generation" });
        return;
      }
      await pause();
      yield emit("message.delta", { text: `${word} ` });
    }

    yield emit("message.completed", { text: this.options.responseText });
    yield emit("usage.updated", {
      inputTokens: this.options.inputTokens,
      outputTokens: this.options.outputTokens,
      // A subscription-style runtime reports no monetary cost.
      costMicros: 0,
    });

    if (this.options.scenario === "failure") {
      yield emit("run.failed", { message: "Simulated runtime failure" });
      return;
    }

    yield emit("artifact.created", {
      kind: "work_product",
      title: "Ergebnisbericht",
      body: this.options.responseText,
    });
    yield emit("run.completed", { summary: this.options.responseText });
  }

  async *resumeRun(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    yield* this.startRun({ ...input, sessionRef }, context);
  }
}
