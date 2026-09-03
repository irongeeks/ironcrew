/**
 * Typed interface for the runtime context object assembled in server-main.ts.
 *
 * Module-level functions carry real signatures derived from their source
 * implementations; base-context helpers from server-main.ts carry full signatures.
 *
 * This file centralizes runtime wiring contracts used by workflow/routes
 * modules so strict type-check can validate cross-module integration.
 */

import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import type { WebSocket } from "ws";
import type { AdapterRegistry } from "../adapters/index.ts";
import type { PackRegistry } from "../packs/pack-registry.ts";
import type { GraphRunner } from "../modules/workflow/orchestration/graph-runner.ts";
import type { ConnectorRegistry } from "../connectors/registry.ts";
import type { McpManager } from "../connectors/built-in/mcp/mcp-manager.ts";
import type { Tracer } from "../observability/tracer.ts";
import type { MetricsCollector } from "../observability/metrics.ts";
import type { NodeTypeRegistry } from "../node-types/node-type-registry.ts";
import type {
  OAuthContext,
  MessagingContext,
  TaskExecutionContext,
  DelegationContext,
  MeetingContext,
  ReviewContext,
  ProjectContext,
  UtilContext,
} from "./runtime-context-domains.ts";
import type {
  AgentRow,
  Lang,
  OneShotRunResult,
  OneShotRunOptions,
  MeetingPromptOptions,
  MeetingTranscriptEntry,
  ReplyKind,
  MeetingReviewDecision,
  DecryptedOAuthToken,
  CliUsageEntry,
  DirectivePolicy,
  DelegationOptions,
  TaskExecutionSessionState,
} from "./workflow-types.ts";
import type { CliStatusResult, CliToolDef } from "../modules/workflow/agents/providers/types.ts";
import type { L10n } from "../modules/routes/collab/language-policy.ts";

// ---------------------------------------------------------------------------
// Helper types (mirrors of unexported types in server-main.ts)
// ---------------------------------------------------------------------------

export type MessageInsertInput = {
  senderType: string;
  senderId: string | null;
  receiverType: string;
  receiverId: string | null;
  content: string;
  messageType: string;
  taskId?: string | null;
  idempotencyKey?: string | null;
};

export type StoredMessage = {
  id: string;
  sender_type: string;
  sender_id: string | null;
  receiver_type: string;
  receiver_id: string | null;
  content: string;
  message_type: string;
  task_id: string | null;
  idempotency_key: string | null;
  created_at: number;
};

export type MessageIngressAuditOutcome =
  | "accepted"
  | "duplicate"
  | "idempotency_conflict"
  | "storage_busy"
  | "validation_error";

export type MessageIngressAuditInput = {
  endpoint: "/api/messages" | "/api/announcements" | "/api/directives" | "/api/inbox";
  req: {
    get(name: string): string | undefined;
    ip?: string;
    socket?: { remoteAddress?: string };
  };
  body: Record<string, unknown>;
  idempotencyKey: string | null;
  outcome: MessageIngressAuditOutcome;
  statusCode: number;
  messageId?: string | null;
  detail?: string | null;
};

export type TaskCreationAuditInput = {
  taskId: string;
  taskTitle: string;
  taskStatus?: string | null;
  departmentId?: string | null;
  assignedAgentId?: string | null;
  sourceTaskId?: string | null;
  taskType?: string | null;
  projectPath?: string | null;
  trigger: string;
  triggerDetail?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  req?: {
    get(name: string): string | undefined;
    ip?: string;
    socket?: { remoteAddress?: string };
  } | null;
  body?: Record<string, unknown> | null;
};

// ---------------------------------------------------------------------------
// BaseRuntimeContext — properties from the runtimeContext literal
// (server/server-main.ts)
// ---------------------------------------------------------------------------

export interface BaseRuntimeContext {
  app: Express;
  db: DatabaseSync;
  dbPath: string;
  logsDir: string;
  distDir: string;
  isProduction: boolean;

  // Helpers
  nowMs(): number;
  runInTransaction(fn: () => void): void;
  firstQueryValue(value: unknown): string | undefined;

  // Timing constants
  IN_PROGRESS_ORPHAN_GRACE_MS: number;
  IN_PROGRESS_ORPHAN_SWEEP_MS: number;
  SUBTASK_DELEGATION_SWEEP_MS: number;

  // OAuth
  ensureOAuthActiveAccount(provider: string): void;
  getActiveOAuthAccountIds(provider: string): string[];
  setActiveOAuthAccount(provider: string, accountId: string): void;
  setOAuthActiveAccounts(provider: string, accountIds: string[]): void;
  removeActiveOAuthAccount(provider: string, accountId: string): void;

  // Security
  isIncomingMessageAuthenticated(req: IncomingMessage): boolean;
  isIncomingMessageOriginTrusted(req: IncomingMessage): boolean;

  // Error classes (stored as constructors)
  IdempotencyConflictError: { new (key: string): Error & { readonly key: string } };
  StorageBusyError: {
    new (
      operation: string,
      attempts: number,
    ): Error & {
      readonly operation: string;
      readonly attempts: number;
    };
  };

  // Message idempotency
  insertMessageWithIdempotency(input: MessageInsertInput): Promise<{ message: StoredMessage; created: boolean }>;
  resolveMessageIdempotencyKey(
    req: { get(name: string): string | undefined },
    body: Record<string, unknown>,
    scope: string,
  ): string | null;
  withSqliteBusyRetry<T>(operation: string, fn: () => T): Promise<T>;

  // Audit
  recordMessageIngressAuditOr503(
    res: { status(code: number): { json(payload: unknown): unknown } },
    input: MessageIngressAuditInput,
  ): boolean;
  recordAcceptedIngressAuditOrRollback(
    res: { status(code: number): { json(payload: unknown): unknown } },
    input: Omit<MessageIngressAuditInput, "messageId">,
    messageId: string,
  ): Promise<boolean>;
  recordTaskCreationAudit(input: TaskCreationAuditInput): void;
  setTaskCreationAuditCompletion(taskId: string, completed: boolean): void;

  // Re-exported library constructors
  WebSocket: typeof import("ws").WebSocket;
  WebSocketServer: typeof import("ws").WebSocketServer;
  express: typeof import("express");

  // Adapter registry — initialized at startup
  adapterRegistry: AdapterRegistry;

  // Observability — initialized at startup
  tracer: Tracer;
  metrics: MetricsCollector;

  // Pack/connector registries — initialized at startup, optional since they may not exist in older setups
  packRegistry?: PackRegistry;
  graphRunner?: GraphRunner;
  connectorRegistry?: ConnectorRegistry;
  mcpManager?: McpManager;
  nodeTypeRegistry?: NodeTypeRegistry;

  // Mutable — starts empty, populated by routes
  DEPT_KEYWORDS: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// WorkflowCoreExports — returned from initializeWorkflowPartA
// (server/modules/workflow/core.ts)
// ---------------------------------------------------------------------------

export interface WorkflowCoreExports {
  // Data structures
  wsClients: Set<WebSocket>;
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, "pause" | "cancel">;
  taskWorktrees: Map<string, { worktreePath: string; branchName: string; projectPath: string }>;
  TASK_RUN_IDLE_TIMEOUT_MS: number;
  TASK_RUN_HARD_TIMEOUT_MS: number;

  // Functions (broadcast + handleClientMessage have known signatures from ws/hub.ts)
  broadcast(type: string, payload: unknown): void;
  handleClientMessage(ws: WebSocket, rawMessage: string): void;
  createWorktree: (projectPath: string, taskId: string, agentName: string, baseBranch?: string) => string | null;
  ensureVideoTaskDirectory: (projectPath: string, taskId: string) => string;
  mergeWorktree: (projectPath: string, taskId: string) => { success: boolean; message: string; conflicts?: string[] };
  mergeToDevAndCreatePR: (
    projectPath: string,
    taskId: string,
    githubRepo: string,
  ) => { success: boolean; message: string; conflicts?: string[]; prUrl?: string };
  cleanupWorktree: (projectPath: string, taskId: string) => void;
  rollbackTaskWorktree: (taskId: string, reason: string) => boolean;
  getWorktreeDiffSummary: (projectPath: string, taskId: string) => string;
  hasExplicitWarningFixRequest: (...textParts: Array<string | null | undefined>) => boolean;
  buildTaskExecutionPrompt: (parts: Array<string | null | undefined>, opts?: { allowWarningFix?: boolean }) => string;
  buildAvailableSkillsPromptBlock: (provider: string) => string;
  generateProjectContext: (projectPath: string) => string;
  getRecentChanges: (projectPath: string, taskId: string) => string;
  ensureClaudeMd: (projectPath: string, worktreePath: string) => void;
  buildAgentArgs: (
    provider: string,
    model?: string,
    reasoningLevel?: string,
    opts?: { noTools?: boolean; profile?: string },
  ) => string[];
  shouldSkipDuplicateCliOutput: (taskId: string, stream: "stdout" | "stderr", text: string) => boolean;
  clearCliOutputDedup: (taskId: string) => void;
  normalizeStreamChunk: (raw: Buffer | string, opts?: { dropCliNoise?: boolean }) => string;
  hasStructuredJsonLines: (raw: string) => boolean;
  getRecentConversationContext: (agentId: string, limit?: number) => string;
  getTaskContinuationContext: (taskId: string) => string;
  sleepMs(ms: number): Promise<void>;
  randomDelay: (minMs: number, maxMs: number) => number;
  getAgentDisplayName: (agent: AgentRow, lang: string) => string;
  chooseSafeReply: (run: OneShotRunResult, lang: string, kind: ReplyKind, agent?: AgentRow) => string;
  summarizeForMeetingBubble: (text: string, maxChars?: number, lang?: Lang) => string;
  hasVisibleDiffSummary: (summary: string) => boolean;
  isDeferrableReviewHold: (text: string) => boolean;
  classifyMeetingReviewDecision: (text: string) => MeetingReviewDecision;
  wantsReviewRevision: (content: string) => boolean;
  findLatestTranscriptContentByAgent: (transcript: MeetingTranscriptEntry[], agentId: string) => string;
  buildMeetingPrompt: (agent: AgentRow, opts: MeetingPromptOptions) => string;
  buildDirectReplyPrompt: (
    agent: AgentRow,
    ceoMessage: string,
    messageType: string,
  ) => { prompt: string; lang: string };
  buildCliFailureMessage: (agent: AgentRow, lang: string, error?: string) => string;
  runAgentOneShot: (agent: AgentRow, prompt: string, opts?: OneShotRunOptions) => Promise<OneShotRunResult>;
}

// ---------------------------------------------------------------------------
// WorkflowAgentExports — returned from initializeWorkflowPartB
// (server/modules/workflow/agents.ts)
// ---------------------------------------------------------------------------

export interface WorkflowAgentExports {
  // Data structures
  httpAgentCounter: number;
  getNextHttpAgentPid: () => number;
  cachedModels: { data: Record<string, string[]>; loadedAt: number } | null;
  MODELS_CACHE_TTL: number;
  cachedCliStatus: { data: CliStatusResult; loadedAt: number } | null;
  CLI_STATUS_TTL: number;
  CLI_TOOLS: CliToolDef[];

  // Functions
  analyzeSubtaskDepartment: (subtaskTitle: string, parentDeptId: string | null) => string | null;
  seedApprovedPlanSubtasks: (taskId: string, ownerDeptId: string | null, planningNotes?: string[]) => void;
  seedReviewRevisionSubtasks: (taskId: string, ownerDeptId: string | null, revisionNotes?: string[]) => number;
  codexThreadToSubtask: Map<string, string>;
  spawnCliAgent: (
    taskId: string,
    provider: string,
    prompt: string,
    projectPath: string,
    logPath: string,
    model?: string,
    reasoningLevel?: string,
    profile?: string,
  ) => ChildProcess;
  normalizeOAuthProvider: (provider: string) => "github" | "google_antigravity" | null;
  getNextOAuthLabel: (provider: string) => string;
  getOAuthAccounts: (provider: string, includeDisabled?: boolean) => DecryptedOAuthToken[];
  getPreferredOAuthAccounts: (provider: string, opts?: { includeStandby?: boolean }) => DecryptedOAuthToken[];
  getDecryptedOAuthToken: (provider: string) => DecryptedOAuthToken | null;
  getProviderModelConfig: () => Record<
    string,
    { model: string; subModel?: string; reasoningLevel?: string; subModelReasoningLevel?: string }
  >;
  refreshGoogleToken: (credential: DecryptedOAuthToken) => Promise<string>;
  exchangeCopilotToken: (githubToken: string) => Promise<{ token: string; baseUrl: string; expiresAt: number }>;
  executeCopilotAgent: (
    prompt: string,
    projectPath: string,
    logStream: WriteStream,
    signal: AbortSignal,
    taskId?: string,
    preferredAccountId?: string | null,
    safeWriteOverride?: (text: string) => boolean,
  ) => Promise<void>;
  executeAntigravityAgent: (
    prompt: string,
    logStream: WriteStream,
    signal: AbortSignal,
    taskId?: string,
    preferredAccountId?: string | null,
    safeWriteOverride?: (text: string) => boolean,
  ) => Promise<void>;
  executeApiProviderAgent: (
    prompt: string,
    projectPath: string,
    logStream: WriteStream,
    signal: AbortSignal,
    taskId?: string,
    apiProviderId?: string | null,
    apiModel?: string | null,
    safeWriteOverride?: (text: string) => boolean,
  ) => Promise<void>;
  launchApiProviderAgent: (
    taskId: string,
    apiProviderId: string | null,
    apiModel: string | null,
    prompt: string,
    projectPath: string,
    logPath: string,
    controller: AbortController,
    fakePid: number,
  ) => void;
  launchHttpAgent: (
    taskId: string,
    agent: "copilot" | "antigravity",
    prompt: string,
    projectPath: string,
    logPath: string,
    controller: AbortController,
    fakePid: number,
    preferredOAuthAccountId?: string | null,
  ) => void;
  killPidTree: (pid: number) => void;
  isPidAlive: (pid: number) => boolean;
  interruptPidTree: (pid: number) => void;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  fetchClaudeUsage: () => Promise<CliUsageEntry>;
  fetchCodexUsage: () => Promise<CliUsageEntry>;
  fetchGeminiUsage: () => Promise<CliUsageEntry>;
  execWithTimeout: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
  detectAllCli: () => Promise<CliStatusResult>;
}

// ---------------------------------------------------------------------------
// WorkflowOrchestrationExports — returned from initializeWorkflowPartC
// (server/modules/workflow/orchestration.ts)
// ---------------------------------------------------------------------------

export interface WorkflowOrchestrationExports {
  // Data structures
  crossDeptNextCallbacks: Map<string, () => void>;
  subtaskDelegationCallbacks: Map<string, () => void>;
  subtaskDelegationDispatchInFlight: Set<string>;
  delegatedTaskToSubtask: Map<string, string>;
  subtaskDelegationCompletionNoticeSent: Set<string>;
  meetingPresenceUntil: Map<string, number>;
  meetingSeatIndexByAgent: Map<string, number>;
  meetingPhaseByAgent: Map<string, "kickoff" | "review">;
  meetingTaskIdByAgent: Map<string, string>;
  meetingReviewDecisionByAgent: Map<string, "reviewing" | "approved" | "hold">;
  taskExecutionSessions: Map<string, TaskExecutionSessionState>;

  // Functions
  ensureTaskExecutionSession: (taskId: string, agentId: string, provider: string) => TaskExecutionSessionState;
  endTaskExecutionSession: (taskId: string, reason: string) => void;
  isTaskWorkflowInterrupted: (taskId: string) => boolean;
  clearTaskWorkflowState: (taskId: string) => void;
  startProgressTimer: (taskId: string, taskTitle: string, departmentId: string | null) => void;
  stopProgressTimer: (taskId: string) => void;
  scheduleNextReviewRound: (taskId: string, taskTitle: string, currentRound: number, lang: Lang) => void;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  archivePlanningConsolidatedReport: (rootTaskId: string) => Promise<void>;
  isAgentInMeeting: (agentId: string) => boolean;
  startTaskExecutionForAgent: (taskId: string, execAgent: AgentRow, deptId: string | null, deptName: string) => void;
  startPlannedApprovalMeeting: (
    taskId: string,
    taskTitle: string,
    departmentId: string | null,
    onApproved: (planningNotes?: string[]) => void,
  ) => void;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
  cancelPendingReRuns: () => void;
  runTask: (taskId: string) => Promise<void>;
  finishReview: (
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ) => void;
}

// ---------------------------------------------------------------------------
// RouteCollabExports — returned from registerRoutesPartB
// (server/modules/routes/collab.ts)
// ---------------------------------------------------------------------------

export interface RouteCollabExports {
  DEPT_KEYWORDS: Record<string, string[]>;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
  getPreferredLanguage: () => Lang;
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  detectLang: (text: string) => Lang;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  getRoleLabel: (role: string, lang: Lang) => string;
  scheduleAnnouncementReplies: (announcement: string) => void;
  normalizeTextField: (value: unknown) => string | null;
  analyzeDirectivePolicy: (content: string) => DirectivePolicy;
  shouldExecuteDirectiveDelegation: (policy: DirectivePolicy, explicitSkipPlannedMeeting: boolean) => boolean;
  detectTargetDepartments: (message: string) => string[];
  detectMentions: (message: string) => { deptIds: string[]; agentIds: string[] };
  handleMentionDelegation: (originLeader: AgentRow, targetDeptId: string, ceoMessage: string, lang: Lang) => void;
  findTeamLeader: (deptId: string | null, candidateAgentIds?: string[] | null) => AgentRow | null;
  getDeptName: (deptId: string, workflowPackKey?: string | null) => string;
  getDeptRoleConstraint: (deptId: string, deptName: string) => string;
  formatTaskSubtaskProgressSummary: (taskId: string, lang: Lang) => string;
  processSubtaskDelegations: (taskId: string, opts?: { includeRender?: boolean }) => void;
  maybeNotifyAllSubtasksComplete: (parentTaskId: string) => void;
  reconcileCrossDeptSubtasks: (parentTaskId?: string) => void;
  recoverCrossDeptQueueAfterMissingCallback: (completedChildTaskId: string) => void;
  resolveProjectPath: (task: {
    project_id?: string | null;
    project_path?: string | null;
    description?: string | null;
    title?: string | null;
  }) => string | null;
  handleReportRequest: (targetAgentId: string, ceoMessage: string) => boolean;
  handleTaskDelegation: (
    teamLeader: AgentRow,
    ceoMessage: string,
    ceoMsgId: string,
    options?: DelegationOptions,
  ) => void;
  scheduleAgentReply: (agentId: string, ceoMessage: string, messageType: string, options?: DelegationOptions) => void;
  resetDirectChatState: (agentId: string) => { clearedPendingProjectBinding: boolean };
}

// ---------------------------------------------------------------------------
// RouteOpsExports — returned from registerRoutesPartC
// (server/modules/routes/ops.ts)
// ---------------------------------------------------------------------------

export interface RouteOpsExports {
  prettyStreamJson: (raw: string, opts?: { includeReasoning?: boolean }) => string;
  refreshCliUsageData: () => Promise<Record<string, CliUsageEntry>>;
}

// ---------------------------------------------------------------------------
// Composite type — the fully-assembled runtime context
// ---------------------------------------------------------------------------

export type RuntimeContext = BaseRuntimeContext &
  OAuthContext &
  MessagingContext &
  TaskExecutionContext &
  DelegationContext &
  MeetingContext &
  ReviewContext &
  ProjectContext &
  UtilContext;
