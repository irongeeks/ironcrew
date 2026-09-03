/**
 * Domain-specific RuntimeContext interfaces — Phase 2 of RuntimeContext refactoring.
 *
 * These 8 interfaces regroup the ~150 properties from the existing export
 * interfaces (WorkflowCoreExports, WorkflowAgentExports, etc.) and
 * RuntimeContextAutoAugmented into semantically coherent domains.
 *
 * During the migration period (Phase 2–3) properties appear in BOTH their
 * original interface AND the new domain interface. Phase 4 will remove
 * the legacy groupings.
 */

import type { WriteStream } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
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
import type { CliStatusResult, CliToolDef, CliToolStatus } from "../modules/workflow/agents/providers/types.ts";
import type { L10n } from "../modules/routes/collab/language-policy.ts";
import type { AdapterStreamEvent } from "../adapters/adapter-interface.ts";

// ── Inline helper types (mirrors from runtime-context-auto-augmented.ts) ────

/** Subtask row as used by delegation/summary functions */
interface SubtaskRowDomain {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: number;
  target_department_id: string | null;
  delegated_task_id: string | null;
  blocked_reason: string | null;
}

/** Parent task row as used by delegation-batch */
interface ParentTaskRowDomain {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  project_path: string | null;
  department_id: string | null;
  workflow_pack_key?: string | null;
}

/** CLI model info returned by model routes */
interface CliModelInfoDomain {
  slug: string;
  displayName?: string;
  description?: string;
  reasoningLevels?: Array<{ effort: string; description: string }>;
  defaultReasoningLevel?: string;
}

/** Skill catalog entry */
interface SkillEntryDomain {
  rank: number;
  name: string;
  skillId: string;
  repo: string;
  installs: number;
}

/** Gemini credential shape */
interface GeminiCredsDomain {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  source: "keychain" | "file";
}

/** Planner subtask assignment from routing */
interface PlannerSubtaskAssignmentDomain {
  subtask_id: string;
  target_department_id: string | null;
  reason?: string;
  confidence?: number;
}

/** Task subtask progress summary */
interface TaskSubtaskProgressSummaryDomain {
  total: number;
  done: number;
  remediationTotal: number;
  remediationDone: number;
  collaborationTotal: number;
  collaborationDone: number;
}

/** Cross-dept cooperation context */
interface CrossDeptContextDomain {
  teamLeader: AgentRow;
  taskTitle: string;
  ceoMessage: string;
  leaderDeptId: string;
  leaderDeptName: string;
  leaderName: string;
  lang: Lang;
  taskId: string;
  projectId?: string | null;
  projectCandidateAgentIds?: string[] | null;
}

// =============================================================================
// 1. OAuthContext — Token management, OAuth accounts, credentials
// =============================================================================

export interface OAuthContext {
  // Constants
  GEMINI_OAUTH_CLIENT_ID: string;
  GEMINI_OAUTH_CLIENT_SECRET: string;
  GEMINI_PROJECT_TTL: number;

  // Caches
  antigravityProjectCache: { projectId: string; tokenHash: string } | null;
  copilotTokenCache: { token: string; baseUrl: string; expiresAt: number; sourceHash: string } | null;
  geminiProjectCache: { id: string; fetchedAt: number } | null;
  oauthDispatchCursor: Map<string, number>;

  // Functions
  consumeOAuthState: (stateId: string, provider: string) => { verifier_enc: string; redirect_to: string | null } | null;
  exchangeCopilotToken: (githubToken: string) => Promise<{ token: string; baseUrl: string; expiresAt: number }>;
  freshGeminiToken: () => Promise<string | null>;
  getGeminiProjectId: (token: string) => Promise<string | null>;
  getOAuthAccountDisplayName: (account: DecryptedOAuthToken) => string;
  getOAuthAutoSwapEnabled: () => boolean;
  handleGitHubCallback: (code: string, stateId: string, callbackPath: string) => Promise<{ redirectTo: string }>;
  handleGoogleAntigravityCallback: (
    code: string,
    stateId: string,
    callbackPath: string,
  ) => Promise<{ redirectTo: string }>;
  loadCodeAssistProject: (accessToken: string, signal?: AbortSignal) => Promise<string>;
  markOAuthAccountFailure: (accountId: string, message: string) => void;
  markOAuthAccountSuccess: (accountId: string) => void;
  normalizeOAuthProvider: (provider: string) => "github" | "google_antigravity" | null;
  getNextOAuthLabel: (provider: string) => string;
  getOAuthAccounts: (provider: string, includeDisabled?: boolean) => DecryptedOAuthToken[];
  getPreferredOAuthAccounts: (provider: string, opts?: { includeStandby?: boolean }) => DecryptedOAuthToken[];
  getDecryptedOAuthToken: (provider: string) => DecryptedOAuthToken | null;
  oauthProviderPrefix: (provider: string) => string;
  prioritizeOAuthAccount: (
    accounts: DecryptedOAuthToken[],
    preferredAccountId?: string | null,
  ) => DecryptedOAuthToken[];
  refreshGoogleToken: (credential: DecryptedOAuthToken) => Promise<string>;
  rotateOAuthAccounts: (provider: string, accounts: DecryptedOAuthToken[]) => DecryptedOAuthToken[];
  startGitHubOAuth: (redirectTo: string | undefined, callbackPath: string) => string;
  startGoogleAntigravityOAuth: (redirectTo: string | undefined, callbackPath: string) => string;
  upsertOAuthCredential: (input: {
    provider: string;
    source: string;
    email: string | null;
    scope: string | null;
    access_token: string;
    refresh_token: string | null;
    expires_at: number | null;
    label?: string | null;
    model_override?: string | null;
    make_active?: boolean;
  }) => string;
  buildOAuthStatus: () => Promise<Record<string, unknown>>;

  // Credential-reading functions
  fileExistsNonEmpty: (filePath: string) => boolean;
  jsonHasKey: (filePath: string, key: string) => boolean;
  readClaudeToken: () => string | null;
  readCodexTokens: () => { access_token: string; account_id: string } | null;
  readGeminiCreds: () => GeminiCredsDomain | null;
  readGeminiCredsFromFile: () => GeminiCredsDomain | null;
  readGeminiCredsFromKeychain: () => GeminiCredsDomain | null;
}

// =============================================================================
// 2. MessagingContext — Chat, announcements, language, direct replies
// =============================================================================

export interface MessagingContext {
  // Constants
  ROLE_LABEL: Record<string, string>;
  ROLE_LABEL_L10N: Record<string, Record<Lang, string>>;
  SUPPORTED_LANGS: readonly Lang[];

  // Functions
  classifyIntent: (msg: string, lang: Lang) => Record<string, boolean>;
  createDirectAgentTaskAndRun: (agent: AgentRow, ceoMessage: string, options?: DelegationOptions) => void;
  detectLang: (text: string) => Lang;
  fallbackTurnReply: (kind: ReplyKind, lang: string, agent?: AgentRow, reason?: string) => string;
  generateAnnouncementReply: (agent: AgentRow, announcement: string, lang: Lang) => string;
  generateChatReply: (agent: AgentRow, ceoMessage: string) => string;
  getFlairs: (agentName: string, lang: Lang) => string[];
  getPreferredLanguage: () => Lang;
  getRoleLabel: (role: string, lang: Lang) => string;
  isLang: (value: unknown) => value is Lang;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]) => L10n;
  localeInstruction: (lang: string) => string;
  normalizeConversationReply: (raw: string, maxChars?: number, opts?: { maxSentences?: number }) => string;
  normalizeTextField: (value: unknown) => string | null;
  pickL: (pool: L10n, lang: Lang) => string;
  pickRandom: <T>(arr: T[]) => T;
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  scheduleAgentReply: (agentId: string, ceoMessage: string, messageType: string, options?: DelegationOptions) => void;
  scheduleAnnouncementReplies: (announcement: string) => void;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
  shouldTreatDirectChatAsTask: (ceoMessage: string, messageType: string) => boolean;
  resetDirectChatState: (agentId: string) => { clearedPendingProjectBinding: boolean };
}

// =============================================================================
// 3. TaskExecutionContext — Prompt building, CLI tools, agent spawning, project context
// =============================================================================

export interface TaskExecutionContext {
  // Constants
  ANSI_ESCAPE_REGEX: RegExp;
  CLI_SPINNER_LINE_REGEX: RegExp;
  CONTEXT_IGNORE_DIRS: Set<string>;
  CONTEXT_IGNORE_FILES: Set<string>;
  EXECUTION_CONTINUITY_POLICY_LINES: string[];
  MVP_CODE_REVIEW_POLICY_BASE_LINES: string[];
  WARNING_FIX_OVERRIDE_LINE: string;

  // Caches
  cliOutputDedupCache: Map<string, { normalized: string; ts: number }>;

  // Functions
  buildAgentArgs: (
    provider: string,
    model?: string,
    reasoningLevel?: string,
    opts?: { noTools?: boolean; profile?: string },
  ) => string[];
  buildAvailableSkillsPromptBlock: (provider: string) => string;
  buildCliFailureMessage: (agent: AgentRow, lang: string, error?: string) => string;
  buildDirectReplyPrompt: (
    agent: AgentRow,
    ceoMessage: string,
    messageType: string,
  ) => { prompt: string; lang: string };
  buildFileTree: (dir: string, prefix?: string, depth?: number, maxDepth?: number) => string[];
  buildHealthPayload: () => { ok: true; version: string; app: string; dbPath: string };
  buildMvpCodeReviewPolicyBlock: (allowWarningFix: boolean) => string;
  buildProjectContextContent: (projectPath: string) => string;
  buildSubtaskDelegationPrompt: (
    parentTask: ParentTaskRowDomain,
    assignedSubtasks: SubtaskRowDomain[],
    execAgent: AgentRow,
    targetDeptId: string,
    targetDeptName: string,
  ) => string;
  buildTaskExecutionPrompt: (parts: Array<string | null | undefined>, opts?: { allowWarningFix?: boolean }) => string;
  completeSubtaskFromCli: (toolUseId: string) => void;
  createSubtaskFromCli: (taskId: string, toolUseId: string, title: string) => void;
  ensureClaudeMd: (projectPath: string, worktreePath: string) => void;
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
  generateProjectContext: (projectPath: string) => string;
  getRecentChanges: (projectPath: string, taskId: string) => string;
  hasExplicitWarningFixRequest: (...textParts: Array<string | null | undefined>) => boolean;
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
  normalizeStreamChunk: (raw: Buffer | string, opts?: { dropCliNoise?: boolean }) => string;
  parseAndCreateSubtasks: (
    taskId: string,
    provider: string,
    data: string,
    preParsedEvents?: AdapterStreamEvent[],
  ) => void;
  parseGeminiSSEStream: (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
  ) => Promise<void>;
  parseHttpAgentSubtasks: (taskId: string, textChunk: string, accum: { buf: string }) => void;
  parseSSEStream: (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
  ) => Promise<void>;
  resolveAntigravityModel: (rawModel: string) => string;
  resolveCopilotModel: (rawModel: string) => string;
  runAgentOneShot: (agent: AgentRow, prompt: string, opts?: OneShotRunOptions) => Promise<OneShotRunResult>;
  shouldSkipDuplicateCliOutput: (taskId: string, stream: "stdout" | "stderr", text: string) => boolean;
  clearCliOutputDedup: (taskId: string) => void;
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
}

// =============================================================================
// 4. DelegationContext — Subtask routing, delegation, cross-dept cooperation
// =============================================================================

export interface DelegationContext {
  // Constants
  COLLABORATION_SUBTASK_PREFIXES: string[];
  REMEDIATION_SUBTASK_PREFIXES: string[];

  // Caches
  plannerSubtaskRoutingInFlight: Set<string>;

  // Functions
  analyzeDirectivePolicy: (content: string) => DirectivePolicy;
  analyzeSubtaskDepartment: (subtaskTitle: string, parentDeptId: string | null) => string | null;
  delegateSubtaskBatch: (
    subtasks: SubtaskRowDomain[],
    queueIndex: number,
    queueTotal: number,
    parentTask: ParentTaskRowDomain,
    onBatchDone?: () => void,
  ) => void;
  deriveSubtaskStateFromDelegatedTask: (
    taskStatus: string,
    taskCompletedAt: number | null,
  ) => { status: "done" | "in_progress" | "blocked"; blockedReason: string | null; completedAt: number | null };
  detectMentions: (message: string) => { deptIds: string[]; agentIds: string[] };
  detectTargetDepartments: (message: string) => string[];
  finalizeDelegatedSubtasks: (delegatedTaskId: string, subtaskIds: string[], exitCode: number) => void;
  findExplicitDepartmentByMention: (text: string, parentDeptId: string | null) => string | null;
  formatTaskSubtaskProgressSummary: (taskId: string, lang: Lang) => string;
  getSubtaskDeptExecutionPriority: (deptId: string | null) => number;
  getTaskSubtaskProgressSummary: (taskId: string) => TaskSubtaskProgressSummaryDomain;
  groupSubtasksByTargetDepartment: (subtasks: SubtaskRowDomain[]) => SubtaskRowDomain[][];
  handleMentionDelegation: (originLeader: AgentRow, targetDeptId: string, ceoMessage: string, lang: Lang) => void;
  handleSubtaskDelegationComplete: (taskId: string, subtaskId: string, exitCode: number) => void;
  handleTaskDelegation: (
    teamLeader: AgentRow,
    ceoMessage: string,
    ceoMsgId: string,
    options?: DelegationOptions,
  ) => void;
  hasAnyPrefix: (title: string, prefixes: string[]) => boolean;
  hasOpenForeignSubtasks: (taskId: string, targetDeptIds?: string[]) => boolean;
  linkCrossDeptTaskToParentSubtask: (
    parentTaskId: string,
    targetDeptId: string,
    delegatedTaskId: string,
  ) => string | null;
  maybeNotifyAllSubtasksComplete: (parentTaskId: string) => void;
  normalizeDeptAliasToken: (input: string) => string;
  normalizePlannerTargetDeptId: (
    rawTarget: unknown,
    ownerDeptId: string | null,
    deptRows: Array<{ id: string; name: string; name_ko: string }>,
  ) => string | null;
  orderSubtaskQueuesByDepartment: (queues: SubtaskRowDomain[][]) => SubtaskRowDomain[][];
  parsePlannerSubtaskAssignments: (rawText: string) => PlannerSubtaskAssignmentDomain[];
  pickUnlinkedTargetSubtask: (parentTaskId: string, targetDeptId: string) => { id: string } | undefined;
  processSubtaskDelegations: (taskId: string, opts?: { includeRender?: boolean }) => void;
  reconcileCrossDeptSubtasks: (parentTaskId?: string) => void;
  recoverCrossDeptQueueAfterMissingCallback: (completedChildTaskId: string) => void;
  rerouteSubtasksByPlanningLeader: (
    taskId: string,
    ownerDeptId: string | null,
    phase: "planned" | "review",
  ) => Promise<void>;
  seedApprovedPlanSubtasks: (taskId: string, ownerDeptId: string | null, planningNotes?: string[]) => void;
  seedReviewRevisionSubtasks: (taskId: string, ownerDeptId: string | null, revisionNotes?: string[]) => number;
  shouldExecuteDirectiveDelegation: (policy: DirectivePolicy, explicitSkipPlannedMeeting: boolean) => boolean;
  startCrossDeptCooperation: (
    deptIds: string[],
    index: number,
    ctx: CrossDeptContextDomain,
    onAllDone?: () => void,
  ) => void;
  syncSubtaskWithDelegatedTask: (
    subtaskId: string,
    delegatedTaskId: string,
    delegatedTaskStatus: string,
    delegatedTaskCompletedAt: number | null,
  ) => void;
}

// =============================================================================
// 5. MeetingContext — Meeting minutes, presence, leader selection
// =============================================================================

export interface MeetingContext {
  // Functions
  appendMeetingMinuteEntry: (
    meetingId: string,
    seq: number,
    agent: AgentRow,
    lang: string,
    messageType: string,
    content: string,
    workflowPackKey?: string | null,
  ) => void;
  appendTaskProjectMemo: (
    taskId: string,
    phase: "planned" | "review",
    round: number,
    notes: string[],
    lang: string,
  ) => void;
  appendTaskReviewFinalMemo: (
    taskId: string,
    round: number,
    transcript: MeetingTranscriptEntry[],
    lang: string,
    hasResidualRisk: boolean,
  ) => void;
  beginMeetingMinutes: (taskId: string, meetingType: "planned" | "review", round: number, title: string) => string;
  buildMeetingPrompt: (agent: AgentRow, opts: MeetingPromptOptions) => string;
  callLeadersToCeoOffice: (taskId: string, leaders: AgentRow[], phase: "kickoff" | "review") => void;
  collectPlannedActionItems: (transcript: MeetingTranscriptEntry[], maxItems?: number) => string[];
  collectRevisionMemoItems: (
    transcript: MeetingTranscriptEntry[],
    maxItems?: number,
    maxPerDepartment?: number,
  ) => string[];
  dismissLeadersFromCeoOffice: (taskId: string, leaders: AgentRow[]) => void;
  emitMeetingSpeech: (
    agentId: string,
    seatIndex: number,
    phase: "kickoff" | "review",
    taskId: string,
    line: string,
    lang?: string,
  ) => void;
  finishMeetingMinutes: (meetingId: string, status: "completed" | "revision_requested" | "failed") => void;
  formatMeetingTranscript: (transcript: MeetingTranscriptEntry[], lang?: Lang) => string;
  getAllActiveTeamLeaders: (candidateAgentIds?: string[] | null) => AgentRow[];
  getLeadersByDepartmentIds: (deptIds: string[], candidateAgentIds?: string[] | null) => AgentRow[];
  getTaskRelatedDepartmentIds: (
    taskId: string,
    fallbackDeptId: string | null,
    preloadedTask?: { title: string; description: string | null; department_id: string | null } | null,
  ) => string[];
  getTaskReviewLeaders: (
    taskId: string,
    fallbackDeptId: string | null,
    opts?: { minLeaders?: number; includePlanning?: boolean; fallbackAll?: boolean },
  ) => AgentRow[];
  isAgentInMeeting: (agentId: string) => boolean;
  loadRecentReviewRevisionMemoItems: (taskId: string, maxItems?: number) => string[];
  markAgentInMeeting: (
    agentId: string,
    holdMs?: number,
    seatIndex?: number,
    phase?: "kickoff" | "review",
    taskId?: string,
  ) => void;
  normalizeRevisionMemoNote: (note: string) => string;
  reserveReviewRevisionMemoItems: (
    taskId: string,
    round: number,
    memoItems: string[],
  ) => { freshItems: string[]; duplicateCount: number };
  startPlannedApprovalMeeting: (
    taskId: string,
    taskTitle: string,
    departmentId: string | null,
    onApproved: (planningNotes?: string[]) => void,
  ) => void;
  startReviewConsensusMeeting: (
    taskId: string,
    taskTitle: string,
    departmentId: string | null,
    onApproved: () => void,
  ) => void;
  summarizeForMeetingBubble: (text: string, maxChars?: number, lang?: Lang) => string;
}

// =============================================================================
// 6. ReviewContext — Review rounds, session tracking, review decisions
// =============================================================================

export interface ReviewContext {
  // Caches / state
  progressTimers: Map<string, ReturnType<typeof setInterval>>;
  reviewInFlight: Set<string>;
  reviewRoundState: Map<string, number>;

  // Functions
  classifyMeetingReviewDecision: (text: string) => MeetingReviewDecision;
  findLatestTranscriptContentByAgent: (transcript: MeetingTranscriptEntry[], agentId: string) => string;
  finishReview: (
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ) => void;
  getReviewRoundMode: (round: number) => "parallel_remediation" | "merge_synthesis" | "final_decision";
  getTaskStatusById: (taskId: string) => string | null;
  hasApprovalAgreementSignal: (text: string) => boolean;
  hasVisibleDiffSummary: (summary: string) => boolean;
  isDeferrableReviewHold: (text: string) => boolean;
  isHardBlockSignal: (text: string) => boolean;
  isInternalWorkNarration: (text: string) => boolean;
  isMvpDeferralSignal: (text: string) => boolean;
  scheduleNextReviewRound: (taskId: string, taskTitle: string, currentRound: number, lang: Lang) => void;
  startProgressTimer: (taskId: string, taskTitle: string, departmentId: string | null) => void;
  stopProgressTimer: (taskId: string) => void;
  wantsReviewRevision: (content: string) => boolean;
}

// =============================================================================
// 7. ProjectContext — Project paths, tech stack detection, report routing
// =============================================================================

export interface ProjectContext {
  // Functions
  detectProjectPath: (message: string) => string | null;
  detectReportOutputFormat: (requestText: string) => "md";
  detectTechStack: (projectPath: string) => string[];
  extractLatestProjectMemoBlock: (description: string, maxChars?: number) => string;
  getDefaultProjectRoot: () => string;
  getKeyFiles: (projectPath: string) => string[];
  getLatestKnownProjectPath: () => string | null;
  handleReportRequest: (targetAgentId: string, ceoMessage: string) => boolean;
  isGitRepo: (dir: string) => boolean;
  pickPlanningReportAssignee: (preferredAgentId: string | null) => AgentRow | null;
  resolveDirectiveProjectPath: (
    ceoMessage: string,
    options?: DelegationOptions,
  ) => { projectPath: string | null; source: string };
  resolveProjectPath: (task: {
    project_id?: string | null;
    project_path?: string | null;
    description?: string | null;
    title?: string;
  }) => string | null;
  stripReportRequestPrefix: (content: string) => string;
}

// =============================================================================
// 8. UtilContext — Models, skills, CLI status, settings, misc utilities
// =============================================================================

export interface UtilContext {
  // Constants
  ANTIGRAVITY_DEFAULT_PROJECT: string;
  ANTIGRAVITY_ENDPOINTS: string[];
  DEPT_KEYWORDS: Record<string, string[]>;
  SKILLS_CACHE_TTL: number;

  // Caches
  cachedCliModels: { data: Record<string, CliModelInfoDomain[]>; loadedAt: number } | null;
  cachedCliStatus: { data: CliStatusResult; loadedAt: number } | null;
  cachedModels: { data: Record<string, string[]>; loadedAt: number } | null;
  cachedSkills: { data: SkillEntryDomain[]; loadedAt: number } | null;
  CLI_STATUS_TTL: number;
  CLI_TOOLS: CliToolDef[];
  MODELS_CACHE_TTL: number;

  // Functions
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  archivePlanningConsolidatedReport: (rootTaskId: string) => Promise<void>;
  chooseSafeReply: (run: OneShotRunResult, lang: string, kind: ReplyKind, agent?: AgentRow) => string;
  detectAllCli: () => Promise<CliStatusResult>;
  detectCliTool: (tool: CliToolDef) => Promise<CliToolStatus>;
  execWithTimeout: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
  fetchClaudeUsage: () => Promise<CliUsageEntry>;
  fetchCodexUsage: () => Promise<CliUsageEntry>;
  fetchGeminiModels: () => CliModelInfoDomain[];
  fetchGeminiUsage: () => Promise<CliUsageEntry>;
  fetchOpenCodeModels: () => Promise<Record<string, string[]>>;
  fetchSkillsFromSite: () => Promise<SkillEntryDomain[]>;
  findBestSubordinate: (deptId: string, excludeId: string, candidateAgentIds?: string[] | null) => AgentRow | null;
  findTeamLeader: (deptId: string | null, candidateAgentIds?: string[] | null) => AgentRow | null;
  getAgentDisplayName: (agent: AgentRow, lang: string) => string;
  getDeptName: (deptId: string, workflowPackKey?: string | null) => string;
  getDeptRoleConstraint: (deptId: string, deptName: string) => string;
  getProviderModelConfig: () => Record<
    string,
    { model: string; subModel?: string; reasoningLevel?: string; subModelReasoningLevel?: string }
  >;
  getRecentConversationContext: (agentId: string, limit?: number) => string;
  getTaskContinuationContext: (taskId: string) => string;
  hasStructuredJsonLines: (raw: string) => boolean;
  interruptPidTree: (pid: number) => void;
  isPidAlive: (pid: number) => boolean;
  killPidTree: (pid: number) => void;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  prettyStreamJson: (raw: string, opts?: { includeReasoning?: boolean }) => string;
  randomDelay: (minMs: number, maxMs: number) => number;
  readCliUsageFromDb: () => Record<string, CliUsageEntry>;
  readCodexModelsCache: () => CliModelInfoDomain[];
  readSettingString: (key: string) => string | undefined;
  readTimeoutMsEnv: (name: string, fallbackMs: number) => number;
  refreshCliUsageData: () => Promise<Record<string, CliUsageEntry>>;
  toModelInfo: (slug: string) => CliModelInfoDomain;

  // Worktree management
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

  // Workflow state (shared infrastructure)
  wsClients: Set<WebSocket>;
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, "pause" | "cancel">;
  taskWorktrees: Map<string, { worktreePath: string; branchName: string; projectPath: string }>;
  TASK_RUN_IDLE_TIMEOUT_MS: number;
  TASK_RUN_HARD_TIMEOUT_MS: number;
  broadcast(type: string, payload: unknown): void;
  handleClientMessage(ws: WebSocket, rawMessage: string): void;
  sleepMs(ms: number): Promise<void>;
  httpAgentCounter: number;
  getNextHttpAgentPid: () => number;
  codexThreadToSubtask: Map<string, string>;
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
  ensureTaskExecutionSession: (taskId: string, agentId: string, provider: string) => TaskExecutionSessionState;
  endTaskExecutionSession: (taskId: string, reason: string) => void;
  isTaskWorkflowInterrupted: (taskId: string) => boolean;
  clearTaskWorkflowState: (taskId: string) => void;
  cancelPendingReRuns: () => void;
  runTask: (taskId: string) => Promise<void>;
  startTaskExecutionForAgent: (taskId: string, execAgent: AgentRow, deptId: string | null, deptName: string) => void;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
}
