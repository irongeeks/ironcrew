import type { RuntimeContext, WorkflowCoreExports } from "../../types/runtime-context.ts";
import type { ChildProcess } from "node:child_process";
import { CLI_OUTPUT_DEDUP_WINDOW_MS, readNonNegativeIntEnv } from "../../db/runtime.ts";
import { createWsHub } from "../../ws/hub.ts";
import { createProjectContextTools } from "./core/project-context-tools.ts";
import { createCliTools } from "./core/cli-tools.ts";
import { createConversationContextTools } from "./core/conversation-context-tools.ts";
import { createMeetingPromptTools } from "./core/meeting-prompt-tools.ts";
import { createOneShotRunner } from "./core/one-shot-runner.ts";
import { createReplyCoreTools } from "./core/reply-core-tools.ts";
import { createWorktreeLifecycleTools, rehydrateWorktrees, type WorktreeInfo } from "./core/worktree/lifecycle.ts";
import { createWorktreeMergeTools } from "./core/worktree/merge.ts";

export function initializeWorkflowPartA(ctx: RuntimeContext): WorkflowCoreExports {
  const __ctx: RuntimeContext = ctx;
  const db = __ctx.db;
  const logsDir = __ctx.logsDir;
  const nowMs = __ctx.nowMs;
  // Deferred proxies — __ctx fields may be populated after initialization
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _c = __ctx as any;
  const appendTaskLog = ((...a: any[]) => _c.appendTaskLog(...a)) as RuntimeContext["appendTaskLog"];
  const getProviderModelConfig = ((...a: any[]) =>
    _c.getProviderModelConfig(...a)) as RuntimeContext["getProviderModelConfig"];
  const killPidTree = ((...a: any[]) => _c.killPidTree(...a)) as RuntimeContext["killPidTree"];
  const executeApiProviderAgent = ((...a: any[]) =>
    _c.executeApiProviderAgent(...a)) as RuntimeContext["executeApiProviderAgent"];
  const executeCopilotAgent = ((...a: any[]) => _c.executeCopilotAgent(...a)) as RuntimeContext["executeCopilotAgent"];
  const executeAntigravityAgent = ((...a: any[]) =>
    _c.executeAntigravityAgent(...a)) as RuntimeContext["executeAntigravityAgent"];
  const detectLang = ((...a: any[]) => _c.detectLang(...a)) as RuntimeContext["detectLang"];
  const getDeptName = ((...a: any[]) => _c.getDeptName(...a)) as RuntimeContext["getDeptName"];
  const getDeptRoleConstraint = ((...a: any[]) =>
    _c.getDeptRoleConstraint(...a)) as RuntimeContext["getDeptRoleConstraint"];
  const getPreferredLanguage = ((...a: any[]) =>
    _c.getPreferredLanguage(...a)) as RuntimeContext["getPreferredLanguage"];
  const getRoleLabel = ((...a: any[]) => _c.getRoleLabel(...a)) as RuntimeContext["getRoleLabel"];
  const l = ((...a: any[]) => _c.l(...a)) as RuntimeContext["l"];
  const pickL = ((...a: any[]) => _c.pickL(...a)) as RuntimeContext["pickL"];
  const prettyStreamJson = ((...a: any[]) => _c.prettyStreamJson(...a)) as RuntimeContext["prettyStreamJson"];
  const resolveLang = ((...a: any[]) => _c.resolveLang(...a)) as RuntimeContext["resolveLang"];

  // ---------------------------------------------------------------------------
  // Track active child processes
  // ---------------------------------------------------------------------------
  const activeProcesses = new Map<string, ChildProcess>();
  const stopRequestedTasks = new Set<string>();
  const stopRequestModeByTask = new Map<string, "pause" | "cancel">();

  function readTimeoutMsEnv(name: string, fallbackMs: number): number {
    return readNonNegativeIntEnv(name, fallbackMs);
  }

  const TASK_RUN_IDLE_TIMEOUT_MS = readTimeoutMsEnv("TASK_RUN_IDLE_TIMEOUT_MS", 15 * 60_000);
  const TASK_RUN_HARD_TIMEOUT_MS = readTimeoutMsEnv("TASK_RUN_HARD_TIMEOUT_MS", 0);

  // ---------------------------------------------------------------------------
  // Git Worktree support — agent isolation per task
  // ---------------------------------------------------------------------------
  const taskWorktrees = new Map<string, WorktreeInfo>();
  // Rehydrate worktree info from disk for tasks that survived a server restart
  rehydrateWorktrees(db as any, taskWorktrees);

  const { isGitRepo, createWorktree, cleanupWorktree, ensureVideoTaskDirectory } = createWorktreeLifecycleTools({
    appendTaskLog,
    taskWorktrees,
  });

  const { mergeWorktree, mergeToDevAndCreatePR, rollbackTaskWorktree, getWorktreeDiffSummary, hasVisibleDiffSummary } =
    createWorktreeMergeTools({
      db: db as any,
      taskWorktrees,
      appendTaskLog,
      cleanupWorktree,
      resolveLang,
      l,
      pickL,
    });

  const {
    hasExplicitWarningFixRequest,
    buildTaskExecutionPrompt,
    buildAvailableSkillsPromptBlock,
    generateProjectContext,
    getRecentChanges,
    ensureClaudeMd,
  } = createProjectContextTools({
    db: db as any,
    isGitRepo,
    taskWorktrees,
  });

  // ---------------------------------------------------------------------------
  // WebSocket setup
  // ---------------------------------------------------------------------------
  const { wsClients, broadcast, handleClientMessage } = createWsHub(nowMs);

  // ---------------------------------------------------------------------------
  // CLI spawn helpers (ported from claw-kanban)
  // ---------------------------------------------------------------------------
  const {
    withCliPathFallback,
    buildAgentArgs,
    shouldSkipDuplicateCliOutput,
    clearCliOutputDedup,
    normalizeStreamChunk,
    hasStructuredJsonLines,
  } = createCliTools({
    nowMs,
    cliOutputDedupWindowMs: CLI_OUTPUT_DEDUP_WINDOW_MS,
  });

  const {
    normalizeMeetingLang,
    sleepMs,
    randomDelay,
    getAgentDisplayName,
    localeInstruction,
    normalizeConversationReply,
    chooseSafeReply,
    summarizeForMeetingBubble,
    isDeferrableReviewHold,
    classifyMeetingReviewDecision,
    wantsReviewRevision,
    findLatestTranscriptContentByAgent,
    compactTaskDescriptionForMeeting,
    formatMeetingTranscript,
  } = createReplyCoreTools({
    detectLang,
    getPreferredLanguage,
    pickL,
    prettyStreamJson,
  });

  const { getRecentConversationContext, getTaskContinuationContext } = createConversationContextTools({
    db: db as any,
    normalizeStreamChunk,
    summarizeForMeetingBubble,
  });

  const { buildMeetingPrompt, buildDirectReplyPrompt, buildCliFailureMessage } = createMeetingPromptTools({
    getDeptName,
    getDeptRoleConstraint,
    getRoleLabel,
    getRecentConversationContext,
    getAgentDisplayName,
    formatMeetingTranscript,
    compactTaskDescriptionForMeeting,
    normalizeMeetingLang,
    localeInstruction,
    resolveLang,
  });

  const { runAgentOneShot } = createOneShotRunner({
    logsDir,
    broadcast,
    getProviderModelConfig,
    executeApiProviderAgent,
    executeCopilotAgent,
    executeAntigravityAgent,
    killPidTree,
    prettyStreamJson,
    getPreferredLanguage,
    normalizeStreamChunk,
    hasStructuredJsonLines,
    normalizeConversationReply,
    buildAgentArgs,
    withCliPathFallback,
  });

  return {
    wsClients,
    broadcast,
    handleClientMessage,
    activeProcesses,
    stopRequestedTasks,
    stopRequestModeByTask,
    TASK_RUN_IDLE_TIMEOUT_MS,
    TASK_RUN_HARD_TIMEOUT_MS,
    taskWorktrees,
    createWorktree,
    ensureVideoTaskDirectory,
    mergeWorktree,
    mergeToDevAndCreatePR,
    cleanupWorktree,
    rollbackTaskWorktree,
    getWorktreeDiffSummary,
    hasExplicitWarningFixRequest,
    buildTaskExecutionPrompt,
    buildAvailableSkillsPromptBlock,
    generateProjectContext,
    getRecentChanges,
    ensureClaudeMd,
    buildAgentArgs,
    shouldSkipDuplicateCliOutput,
    clearCliOutputDedup,
    normalizeStreamChunk,
    hasStructuredJsonLines,
    getRecentConversationContext,
    getTaskContinuationContext,
    sleepMs,
    randomDelay,
    getAgentDisplayName,
    chooseSafeReply,
    summarizeForMeetingBubble,
    hasVisibleDiffSummary,
    isDeferrableReviewHold,
    classifyMeetingReviewDecision,
    wantsReviewRevision,
    findLatestTranscriptContentByAgent,
    buildMeetingPrompt,
    buildDirectReplyPrompt,
    buildCliFailureMessage,
    runAgentOneShot,
  };
}
