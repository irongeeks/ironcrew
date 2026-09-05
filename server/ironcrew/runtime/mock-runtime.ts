import { leadRoutingOutputSchema, leadReviewOutputSchema } from "../../../src/shared/career.ts";
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
  private readonly customResponse: boolean;
  private readonly cancelled = new Set<string>();

  constructor(options: MockRuntimeOptions = {}) {
    this.customResponse = options.responseText !== undefined;
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
      workspaceRequired: false,
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

    let responseText = this.options.responseText;
    // Explicitly labeled deterministic fixtures; never evidence of a real lead's judgement.
    if (!this.customResponse && input.prompt.includes("IRONCREW_DEPARTMENT_ROUTING_V1")) {
      const match = input.prompt.match(/Routing-Kandidaten: (\[[^\n]+\])/);
      const candidates = match ? (JSON.parse(match[1]) as Array<{ agentId: string; level: string }>) : [];
      const selected = candidates.find((a) => a.level === "senior") ?? candidates.find((a) => a.level === "lead");
      if (!selected) throw new Error("Mock-Routingfixture benötigt einen Senior oder Lead.");
      responseText = JSON.stringify(
        leadRoutingOutputSchema.parse({
          version: 1,
          assignedAgentId: selected.agentId,
          difficulty: "normal",
          rationale:
            "MockRuntime-Testfixture: deterministische Auswahl für den Integrationstest, keine reale fachliche Lead-Entscheidung.",
        }),
      );
    }
    if (!this.customResponse && input.prompt.includes("IRONCREW_LEAD_REVIEW_V1")) {
      responseText = JSON.stringify(
        leadReviewOutputSchema.parse({
          version: 1,
          score: 3,
          rationale: "MockRuntime-Testfixture: festes Testurteil, keine reale fachliche Qualitätsbewertung.",
          rubricDimensions: { correctness: 3, completeness: 3, quality: 3 },
          evidence: ["MockRuntime: ausschließlich synthetische Testdaten"],
        }),
      );
    }

    if (!this.customResponse && input.prompt.includes("IRONCREW_PROJECT_PLAN_V1")) {
      const match = input.prompt.match(/Verfügbare Agenten: (\[[^\n]+\])/);
      const agents = match ? (JSON.parse(match[1]) as Array<{ key: string }>) : [];
      responseText = JSON.stringify({
        version: 1,
        goal: "Mock-Projekt zur Prüfung des CEO-Ablaufs",
        scope: ["Deterministischer Testablauf"],
        nonGoals: ["Keine reale Projektarbeit"],
        assumptions: ["MockRuntime: alle Inhalte sind Testdaten"],
        risks: ["Reale Runtime separat nachweisen"],
        deliverables: ["Prüfbares Mock-Ergebnis"],
        approvalPoints: ["CEO prüft diesen Testplan"],
        budgetMicros: 1000000,
        tasks: [
          {
            key: "analyse",
            title: "Mock-Analyse",
            description: "Erstelle ein nachvollziehbares Testresultat ohne externe Aktion.",
            agentKey: agents.find((a) => a.key === "cto")?.key ?? agents[0]?.key ?? "ea",
            dependsOn: [],
            acceptanceCriteria: ["Mock-Ergebnis liegt im Review"],
            riskLevel: "low",
          },
          {
            key: "review",
            title: "Mock-Qualitätsprüfung",
            description: "Prüfe das Testresultat.",
            agentKey: agents.find((a) => a.key === "qa")?.key ?? agents[0]?.key ?? "ea",
            dependsOn: ["analyse"],
            acceptanceCriteria: ["Prüfbericht liegt vor"],
            riskLevel: "low",
          },
        ],
      });
    }
    const words = responseText.split(" ");
    for (const word of words) {
      if (isCancelled()) {
        yield emit("run.cancelled", { reason: "cancelled during generation" });
        return;
      }
      await pause();
      yield emit("message.delta", { text: `${word} ` });
    }

    yield emit("message.completed", { text: responseText });
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
      body: responseText,
    });
    yield emit("run.completed", { summary: responseText });
  }

  async *resumeRun(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    yield* this.startRun({ ...input, sessionRef }, context);
  }
}
