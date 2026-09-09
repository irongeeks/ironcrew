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
  const appendTaskLog: RuntimeContext["appendTaskLog"] = (...a) => __ctx.appendTaskLog(...a);
  const getProviderModelConfig: RuntimeContext["getProviderModelConfig"] = (...a) => __ctx.getProviderModelConfig(...a);
  const killPidTree: RuntimeContext["killPidTree"] = (...a) => __ctx.killPidTree(...a);
  const executeApiProviderAgent: RuntimeContext["executeApiProviderAgent"] = (...a) =>
    __ctx.executeApiProviderAgent(...a);
  const executeCopilotAgent: RuntimeContext["executeCopilotAgent"] = (...a) => __ctx.executeCopilotAgent(...a);
  const executeAntigravityAgent: RuntimeContext["executeAntigravityAgent"] = (...a) =>
    __ctx.executeAntigravityAgent(...a);
  const detectLang: RuntimeContext["detectLang"] = (...a) => __ctx.detectLang(...a);
  const getDeptName: RuntimeContext["getDeptName"] = (...a) => __ctx.getDeptName(...a);
  const getDeptRoleConstraint: RuntimeContext["getDeptRoleConstraint"] = (...a) => __ctx.getDeptRoleConstraint(...a);
  const getPreferredLanguage: RuntimeContext["getPreferredLanguage"] = (...a) => __ctx.getPreferredLanguage(...a);
  const getRoleLabel: RuntimeContext["getRoleLabel"] = (...a) => __ctx.getRoleLabel(...a);
  const l: RuntimeContext["l"] = (...a) => __ctx.l(...a);
  const pickL: RuntimeContext["pickL"] = (...a) => __ctx.pickL(...a);
  const prettyStreamJson: RuntimeContext["prettyStreamJson"] = (...a) => __ctx.prettyStreamJson(...a);
  const resolveLang: RuntimeContext["resolveLang"] = (...a) => __ctx.resolveLang(...a);

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
  rehydrateWorktrees(db, taskWorktrees);

  const { isGitRepo, createWorktree, cleanupWorktree, ensureVideoTaskDirectory } = createWorktreeLifecycleTools({
    appendTaskLog,
    taskWorktrees,
  });

  const { mergeWorktree, mergeToDevAndCreatePR, rollbackTaskWorktree, getWorktreeDiffSummary, hasVisibleDiffSummary } =
    createWorktreeMergeTools({
      db: db,
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
    db: db,
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
    db: db,
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
