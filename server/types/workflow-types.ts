/**
 * Shared workflow types — single import point for RuntimeContext signatures.
 *
 * Re-exports types that are already exported from their source modules and
 * defines types that were previously module-private.
 */

// ── Language ────────────────────────────────────────────────────────────────
export type { Lang } from "./lang.ts";

// ── Core conversation / meeting types ───────────────────────────────────────
export type {
  AgentRow,
  MeetingPromptOptions,
  MeetingTranscriptEntry,
  OneShotRunOptions,
  OneShotRunResult,
  MeetingReviewDecision,
  ReplyKind,
} from "../modules/workflow/core/conversation-types.ts";

// ── Provider types ──────────────────────────────────────────────────────────
export type { DecryptedOAuthToken, CliUsageEntry, CliToolStatus } from "../modules/workflow/agents/providers/types.ts";

// ── Directive / language-policy ─────────────────────────────────────────────
export type { DirectivePolicy } from "../modules/routes/collab/language-policy.ts";

// ── Delegation ──────────────────────────────────────────────────────────────
export type { DelegationOptions } from "../modules/routes/collab/project-resolution.ts";

// ── Session tracking (not exported from source; defined inline in orchestration.ts) ─
export interface TaskExecutionSessionState {
  sessionId: string;
  taskId: string;
  agentId: string;
  provider: string;
  openedAt: number;
  lastTouchedAt: number;
}
