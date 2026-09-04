/**
 * IronCrew — normalised run protocol.
 *
 * Every runtime (Claude Code, Codex, Antigravity, OpenRouter, Mock) is
 * normalised onto this one event model, so the control plane, the UI and the
 * audit trail never need to know which CLI produced a given event.
 *
 * Each event carries the full addressing tuple (company/project/task/run/agent)
 * plus a correlation id, because an event that cannot be attributed is an
 * event that cannot be audited.
 */

import { z } from "zod";

export const RUN_EVENT_TYPES = [
  "run.started",
  "message.delta",
  "message.completed",
  "tool.requested",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "subagent.spawned",
  "subagent.completed",
  "approval.required",
  "usage.updated",
  "artifact.created",
  "rate_limit.detected",
  "run.waiting",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** Events after which no further event may be emitted for a run. */
export const TERMINAL_RUN_EVENTS: readonly RunEventType[] = ["run.completed", "run.failed", "run.cancelled"];

export const redactionMetaSchema = z.object({
  redacted: z.boolean(),
  rules: z.array(z.string()),
});

export const runEventSchema = z.object({
  eventId: z.string().min(1),
  companyId: z.string().min(1),
  projectId: z.string().nullable().default(null),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().nullable().default(null),
  seq: z.number().int().nonnegative(),
  type: z.enum(RUN_EVENT_TYPES),
  timestamp: z.number().int().positive(),
  correlationId: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  redaction: redactionMetaSchema,
});

export type RunEvent = z.infer<typeof runEventSchema>;

export function isTerminalRunEvent(type: RunEventType): boolean {
  return TERMINAL_RUN_EVENTS.includes(type);
}

/** Map a normalised terminal event to the run status it implies. */
export function runStatusForEvent(type: RunEventType): string | null {
  switch (type) {
    case "run.started":
      return "running";
    case "run.waiting":
      return "waiting";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    case "rate_limit.detected":
      return "rate_limited";
    default:
      return null;
  }
}

// --- Runtime interface -----------------------------------------------------

export interface RuntimeCapabilities {
  /** Streaming incremental message deltas. */
  streaming: boolean;
  /** Resuming a previous session by id. */
  sessionResume: boolean;
  /** Reports token usage. */
  usageReporting: boolean;
  /** Reports monetary cost (subscription runtimes generally do not). */
  costReporting: boolean;
  toolCalls: boolean;
  subagents: boolean;
  /** Default number of concurrent runs this runtime should be given. */
  defaultConcurrency: number;
  /** Detected CLI/API version, when determinable. */
  version?: string;
}

export interface RuntimeHealth {
  healthy: boolean;
  /** installed | not_installed | unknown */
  installed: boolean;
  detail: string;
  checkedAt: number;
}

export interface AuthStatus {
  /** Never carries a token, only whether one is present and usable. */
  authenticated: boolean;
  method: "subscription-cli" | "oauth-cli" | "api-key" | "none";
  /** Non-identifying hint, e.g. a plan name. Never an email or a token. */
  accountHint?: string;
  detail: string;
  /** Shown in the UI when not authenticated. */
  setupHint?: string;
}

export interface RunInput {
  prompt: string;
  model?: string;
  /** Abstract routing profile; the admin maps it to a concrete model. */
  modelProfile?: string;
  maxTurns?: number;
  sessionRef?: string;
}

export interface RunContext {
  companyId: string;
  projectId: string | null;
  taskId: string;
  runId: string;
  agentId: string | null;
  correlationId: string;
  workspacePath: string;
  permissionMode: "restricted" | "workspace_write" | "elevated";
  /** Literal secret values to redact from this run's output, if any. */
  redactValues?: readonly string[];
  signal?: AbortSignal;
}

export interface AgentRuntime {
  readonly id: string;
  readonly type: string;
  capabilities(): Promise<RuntimeCapabilities>;
  healthCheck(): Promise<RuntimeHealth>;
  authStatus(): Promise<AuthStatus>;
  startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent>;
  resumeRun?(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent>;
  cancelRun(runId: string): Promise<void>;
}
