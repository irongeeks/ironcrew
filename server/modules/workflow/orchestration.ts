import type { RuntimeContext, WorkflowOrchestrationExports } from "../../types/runtime-context.ts";
import type { Lang } from "../../types/lang.ts";
import { randomUUID } from "node:crypto";
import { notifyTaskStatus } from "../../gateway/client.ts";

import { initializeWorkflowMeetingTools } from "./orchestration/meetings.ts";
import { createExecutionStartTaskTools } from "./orchestration/execution-start-task.ts";
import { createPlannedApprovalTools } from "./orchestration/planned-approval.ts";
import { createPlanningArchiveTools } from "./orchestration/planning-archive-tools.ts";
import { createProgressNotifyTools } from "./orchestration/progress-notify-tools.ts";
import { createReviewFinalizeTools } from "./orchestration/review-finalize-tools.ts";
import { createRunCompleteHandler } from "./orchestration/run-complete-handler.ts";
import { createReportWorkflowTools } from "./orchestration/report-workflow-tools.ts";
import { createSessionReviewTools } from "./orchestration/session-review-tools.ts";
import { isReportRequestTask } from "./orchestration/report-flow-helpers.ts";
import { logger } from "../../observability/logger.ts";
import { SESSION_AUTH_TOKEN } from "../../config/runtime.ts";

const log = logger.child({ module: "orchestration" });

export function initializeWorkflowPartC(ctx: RuntimeContext): WorkflowOrchestrationExports {
  const __ctx: RuntimeContext = ctx;
  const db = __ctx.db;
  const logsDir = __ctx.logsDir;
  const nowMs = __ctx.nowMs;
  const activeProcesses = __ctx.activeProcesses;
  const appendTaskLog = __ctx.appendTaskLog;
  const broadcast = __ctx.broadcast;
  const buildTaskExecutionPrompt = __ctx.buildTaskExecutionPrompt;
  const buildAvailableSkillsPromptBlock =
    __ctx.buildAvailableSkillsPromptBlock ||
    ((provider: string) => `[Available Skills][provider=${provider || "unknown"}][unavailable]`);
  const chooseSafeReply = __ctx.chooseSafeReply;
  const cleanupWorktree = __ctx.cleanupWorktree;
  const createWorktree = __ctx.createWorktree;
  const ensureClaudeMd = __ctx.ensureClaudeMd;
  const getAgentDisplayName = __ctx.getAgentDisplayName;
  const getProviderModelConfig = __ctx.getProviderModelConfig;
  const getRecentChanges = __ctx.getRecentChanges;
  const getRecentConversationContext = __ctx.getRecentConversationContext;
  const getTaskContinuationContext = __ctx.getTaskContinuationContext;
  const hasExplicitWarningFixRequest = __ctx.hasExplicitWarningFixRequest;
  const getNextHttpAgentPid = __ctx.getNextHttpAgentPid;
  const launchHttpAgent = __ctx.launchHttpAgent;
  const launchApiProviderAgent = __ctx.launchApiProviderAgent;
  const mergeWorktree = __ctx.mergeWorktree;
  const mergeToDevAndCreatePR = __ctx.mergeToDevAndCreatePR;
  const randomDelay = __ctx.randomDelay;
  const setTaskCreationAuditCompletion = __ctx.setTaskCreationAuditCompletion;
  const runAgentOneShot = __ctx.runAgentOneShot;
  const spawnCliAgent = __ctx.spawnCliAgent;
  const stopRequestModeByTask = __ctx.stopRequestModeByTask;
  const stopRequestedTasks = __ctx.stopRequestedTasks;
  const taskWorktrees = __ctx.taskWorktrees;
  const getWorktreeDiffSummary = __ctx.getWorktreeDiffSummary;
  const hasVisibleDiffSummary = __ctx.hasVisibleDiffSummary;
  const clearCliOutputDedup = __ctx.clearCliOutputDedup;
  const sleepMs = __ctx.sleepMs;
  const normalizeConversationReply = __ctx.normalizeConversationReply;
  const buildMeetingPrompt = __ctx.buildMeetingPrompt;
  const codexThreadToSubtask = __ctx.codexThreadToSubtask;
  // Deferred proxies — __ctx fields may be populated after initialization
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _c = __ctx as any;
  const findTeamLeader = ((...a: any[]) => _c.findTeamLeader(...a)) as RuntimeContext["findTeamLeader"];
  const formatTaskSubtaskProgressSummary = ((...a: any[]) =>
    _c.formatTaskSubtaskProgressSummary(...a)) as RuntimeContext["formatTaskSubtaskProgressSummary"];
  const getDeptName = ((...a: any[]) => _c.getDeptName(...a)) as RuntimeContext["getDeptName"];
  const getDeptRoleConstraint = ((...a: any[]) =>
    _c.getDeptRoleConstraint(...a)) as RuntimeContext["getDeptRoleConstraint"];
  const getPreferredLanguage = ((...a: any[]) =>
    _c.getPreferredLanguage(...a)) as RuntimeContext["getPreferredLanguage"];
  const getRoleLabel = ((...a: any[]) => _c.getRoleLabel(...a)) as RuntimeContext["getRoleLabel"];
  const l = ((...a: any[]) => _c.l(...a)) as RuntimeContext["l"];
  const pickL = ((...a: any[]) => _c.pickL(...a)) as RuntimeContext["pickL"];
  const prettyStreamJson = ((...a: any[]) => _c.prettyStreamJson(...a)) as RuntimeContext["prettyStreamJson"];
  const processSubtaskDelegations = ((...a: any[]) =>
    _c.processSubtaskDelegations(...a)) as RuntimeContext["processSubtaskDelegations"];
  const recoverCrossDeptQueueAfterMissingCallback = ((...a: any[]) =>
    _c.recoverCrossDeptQueueAfterMissingCallback(...a)) as RuntimeContext["recoverCrossDeptQueueAfterMissingCallback"];
  const refreshCliUsageData = ((...a: any[]) => _c.refreshCliUsageData(...a)) as RuntimeContext["refreshCliUsageData"];
  const resolveLang = ((...a: any[]) => _c.resolveLang(...a)) as RuntimeContext["resolveLang"];
  const resolveProjectPath = ((...a: any[]) => _c.resolveProjectPath(...a)) as RuntimeContext["resolveProjectPath"];
  const sendAgentMessage = ((...a: any[]) => _c.sendAgentMessage(...a)) as RuntimeContext["sendAgentMessage"];

  // ---------------------------------------------------------------------------
  // Helpers: progress timers, CEO notifications
  // ---------------------------------------------------------------------------

  // Track progress report timers so we can cancel them when tasks finish
  const progressTimers = new Map<string, ReturnType<typeof setInterval>>();

  // Cross-department sequential queue: when a cross-dept task finishes,
  // trigger the next department in line (instead of spawning all simultaneously).
  // Key: cross-dept task ID → callback to start next department
  const crossDeptNextCallbacks = new Map<string, () => void>();

  // Subtask delegation sequential queue: delegated task ID → callback to start next delegation
  const subtaskDelegationCallbacks = new Map<string, () => void>();
  const subtaskDelegationDispatchInFlight = new Set<string>();

  // Map delegated task ID → original subtask ID for completion tracking
  const delegatedTaskToSubtask = new Map<string, string>();
  const subtaskDelegationCompletionNoticeSent = new Set<string>();

  // Review consensus workflow state: task_id → current review round
  const reviewRoundState = new Map<string, number>();
  const reviewInFlight = new Set<string>();
  const meetingPresenceUntil = new Map<string, number>();
  const meetingSeatIndexByAgent = new Map<string, number>();
  const meetingPhaseByAgent = new Map<string, "kickoff" | "review">();
  const meetingTaskIdByAgent = new Map<string, string>();
  type MeetingReviewDecision = "reviewing" | "approved" | "hold";
  const meetingReviewDecisionByAgent = new Map<string, MeetingReviewDecision>();
  const projectReviewGateNotifiedAt = new Map<string, number>();
  const REVIEW_MEETING_ONESHOT_TIMEOUT_MS = (() => {
    const raw = process.env.REVIEW_MEETING_ONESHOT_TIMEOUT_MS?.trim();
    if (!raw) return 65_000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 65_000;
    // Primary unit is milliseconds.
    // Backward compatibility:
    // - 65 -> 65 seconds
    // - 65000 -> 65000 ms
    const interpreted = parsed <= 600 ? parsed * 1000 : parsed;
    return Math.max(5_000, Math.round(interpreted));
  })();

  interface TaskExecutionSessionState {
    sessionId: string;
    taskId: string;
    agentId: string;
    provider: string;
    openedAt: number;
    lastTouchedAt: number;
  }

  const taskExecutionSessions = new Map<string, TaskExecutionSessionState>();

  type ReviewRoundMode = "parallel_remediation" | "merge_synthesis" | "final_decision";

  function ensureTaskExecutionSession(taskId: string, agentId: string, provider: string): TaskExecutionSessionState {
    return sessionReviewTools.ensureTaskExecutionSession(taskId, agentId, provider);
  }

  function endTaskExecutionSession(taskId: string, reason: string): void {
    sessionReviewTools.endTaskExecutionSession(taskId, reason);
  }

  function getTaskStatusById(taskId: string): string | null {
    return sessionReviewTools.getTaskStatusById(taskId);
  }

  function isTaskWorkflowInterrupted(taskId: string): boolean {
    return sessionReviewTools.isTaskWorkflowInterrupted(taskId);
  }

  function clearTaskWorkflowState(taskId: string): void {
    sessionReviewTools.clearTaskWorkflowState(taskId);
  }

  function getReviewRoundMode(round: number): ReviewRoundMode {
    return sessionReviewTools.getReviewRoundMode(round);
  }

  function scheduleNextReviewRound(taskId: string, taskTitle: string, currentRound: number, lang: Lang): void {
    sessionReviewTools.scheduleNextReviewRound(taskId, taskTitle, currentRound, lang);
  }

  function getProjectReviewGateSnapshot(projectId: string): {
    activeTotal: number;
    activeReview: number;
    rootReviewTotal: number;
    ready: boolean;
  } {
    return sessionReviewTools.getProjectReviewGateSnapshot(projectId);
  }

  const progressNotifyTools = createProgressNotifyTools({
    db,
    progressTimers,
    findTeamLeader,
    resolveLang,
    sendAgentMessage,
    pickL,
    l,
    randomUUID,
    nowMs,
    broadcast,
  });

  const planningArchiveTools = createPlanningArchiveTools({
    db,
    nowMs,
    randomUUID,
    appendTaskLog,
    sendAgentMessage,
    broadcast,
    pickL,
    l,
    resolveLang,
    runAgentOneShot,
    normalizeConversationReply,
    findTeamLeader,
    getDeptName,
    getAgentDisplayName,
  });

  function emitTaskReportEvent(taskId: string): void {
    reportWorkflowTools.emitTaskReportEvent(taskId);
  }

  function shouldDeferTaskReportUntilPlanningArchive(task: {
    source_task_id?: string | null;
    department_id?: string | null;
  }): boolean {
    return reportWorkflowTools.shouldDeferTaskReportUntilPlanningArchive(task);
  }

  function completeTaskWithoutReview(
    task: {
      id: string;
      title: string;
      description: string | null;
      department_id: string | null;
      source_task_id: string | null;
      assigned_agent_id: string | null;
    },
    note: string,
  ): void {
    reportWorkflowTools.completeTaskWithoutReview(task, note);
  }

  function startProgressTimer(taskId: string, taskTitle: string, departmentId: string | null): void {
    progressNotifyTools.startProgressTimer(taskId, taskTitle, departmentId);
  }

  function stopProgressTimer(taskId: string): void {
    progressNotifyTools.stopProgressTimer(taskId);
  }

  // ---------------------------------------------------------------------------
  // Send CEO notification for all significant workflow events (B4)
  // ---------------------------------------------------------------------------
  function notifyCeo(content: string, taskId: string | null = null, messageType: string = "status_update"): void {
    progressNotifyTools.notifyCeo(content, taskId, messageType);
  }

  async function archivePlanningConsolidatedReport(rootTaskId: string): Promise<void> {
    await planningArchiveTools.archivePlanningConsolidatedReport(rootTaskId);
  }

  const { startTaskExecutionForAgent } = createExecutionStartTaskTools({
    nowMs,
    db,
    logsDir,
    appendTaskLog,
    broadcast,
    ensureTaskExecutionSession,
    resolveLang,
    notifyTaskStatus,
    resolveProjectPath,
    createWorktree,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getTaskContinuationContext,
    getRecentChanges,
    ensureClaudeMd,
    pickL,
    l,
    buildAvailableSkillsPromptBlock,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    getProviderModelConfig,
    spawnCliAgent,
    handleTaskRunComplete,
    notifyCeo,
    startProgressTimer,
  });

  const workflowMeetingTools = initializeWorkflowMeetingTools(
    Object.assign(Object.create(__ctx), {
      progressTimers,
      reviewRoundState,
      reviewInFlight,
      meetingPresenceUntil,
      meetingSeatIndexByAgent,
      meetingPhaseByAgent,
      meetingTaskIdByAgent,
      meetingReviewDecisionByAgent,
      getTaskStatusById,
      getReviewRoundMode,
      scheduleNextReviewRound,
      startTaskExecutionForAgent,
      startProgressTimer,
      stopProgressTimer,
      notifyCeo,
      reviewMeetingOneShotTimeoutMs: REVIEW_MEETING_ONESHOT_TIMEOUT_MS,
    }),
  );
  const {
    getTaskReviewLeaders,
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    isAgentInMeeting,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    emitMeetingSpeech,
    startReviewConsensusMeeting,
  } = workflowMeetingTools;

  const { startPlannedApprovalMeeting } = createPlannedApprovalTools({
    reviewInFlight,
    reviewRoundState,
    db,
    getTaskReviewLeaders,
    resolveProjectPath,
    resolveLang,
    beginMeetingMinutes,
    isTaskWorkflowInterrupted,
    getTaskStatusById,
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice,
    clearTaskWorkflowState,
    getAgentDisplayName,
    getDeptName,
    getRoleLabel,
    sendAgentMessage,
    emitMeetingSpeech,
    appendMeetingMinuteEntry,
    callLeadersToCeoOffice,
    notifyCeo,
    pickL,
    l,
    buildMeetingPrompt,
    runAgentOneShot,
    chooseSafeReply,
    sleepMs,
    randomDelay,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskLog,
    reviewMeetingOneShotTimeoutMs: REVIEW_MEETING_ONESHOT_TIMEOUT_MS,
  });

  const sessionReviewTools = createSessionReviewTools({
    taskExecutionSessions,
    nowMs,
    randomUUID,
    stopRequestedTasks,
    stopRequestModeByTask,
    clearCliOutputDedup,
    crossDeptNextCallbacks,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    delegatedTaskToSubtask,
    subtaskDelegationCompletionNoticeSent,
    reviewRoundState,
    reviewInFlight,
    appendTaskLog,
    notifyCeo,
    pickL,
    l,
    db,
    finishReview: (...args: any[]) => (finishReview as any)(...args),
    randomDelay,
    startPlannedApprovalMeeting: (...args: any[]) => (startPlannedApprovalMeeting as any)(...args),
  });

  const reportWorkflowTools = createReportWorkflowTools({
    db,
    broadcast,
    appendTaskLog,
    nowMs,
    resolveLang,
    pickL,
    l,
    sendAgentMessage,
    findTeamLeader,
    getAgentDisplayName,
    setTaskCreationAuditCompletion,
    reviewRoundState,
    reviewInFlight,
    endTaskExecutionSession,
    notifyTaskStatus,
    refreshCliUsageData,
    archivePlanningConsolidatedReport,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    notifyCeo,
  });

  // ---------------------------------------------------------------------------
  // runTask: programmatic task re-run via local Express route.
  // Encapsulates the HTTP self-call so run-complete-handler stays free of
  // auth-token imports and fetch logic.
  // ---------------------------------------------------------------------------
  async function runTask(taskId: string): Promise<void> {
    const port = (__ctx.app?.get?.("port") as number) || 8790;
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SESSION_AUTH_TOKEN}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`runTask HTTP ${res.status}: ${body}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Run completion handler — enhanced with review flow + CEO reporting
  // ---------------------------------------------------------------------------
  const runCompleteHandler = createRunCompleteHandler({
    activeProcesses,
    stopProgressTimer,
    db,
    stopRequestedTasks,
    stopRequestModeByTask,
    appendTaskLog,
    clearTaskWorkflowState,
    codexThreadToSubtask,
    nowMs,
    logsDir,
    broadcast,
    processSubtaskDelegations,
    taskWorktrees,
    cleanupWorktree,
    findTeamLeader: findTeamLeader as any,
    getAgentDisplayName: getAgentDisplayName as any,
    pickL: pickL as any,
    l: l as any,
    notifyCeo,
    sendAgentMessage: sendAgentMessage as any,
    resolveLang: resolveLang as any,
    formatTaskSubtaskProgressSummary: formatTaskSubtaskProgressSummary as any,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    finishReview,
    reconcileDelegatedSubtasksAfterRun,
    completeTaskWithoutReview,
    isReportRequestTask,
    notifyTaskStatus,
    prettyStreamJson,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
    packRegistry: __ctx.packRegistry,
    graphRunner: __ctx.graphRunner,
    metrics: __ctx.metrics,
    runTask,
  });

  function cancelPendingReRuns(): void {
    runCompleteHandler.cancelPendingReRuns();
  }

  function handleTaskRunComplete(taskId: string, exitCode: number): void {
    runCompleteHandler.handleTaskRunComplete(taskId, exitCode).catch((err: unknown) => {
      log.error({ err, taskId }, "handleTaskRunComplete unhandled error");
    });
  }

  const reviewFinalizeTools = createReviewFinalizeTools({
    db,
    nowMs,
    logsDir,
    broadcast,
    appendTaskLog,
    getPreferredLanguage,
    pickL,
    l,
    resolveLang,
    getProjectReviewGateSnapshot,
    projectReviewGateNotifiedAt,
    notifyCeo,
    taskWorktrees,
    mergeToDevAndCreatePR,
    mergeWorktree,
    cleanupWorktree,
    findTeamLeader,
    getAgentDisplayName,
    setTaskCreationAuditCompletion,
    endTaskExecutionSession,
    notifyTaskStatus,
    refreshCliUsageData,
    shouldDeferTaskReportUntilPlanningArchive,
    emitTaskReportEvent,
    formatTaskSubtaskProgressSummary,
    reviewRoundState,
    reviewInFlight,
    archivePlanningConsolidatedReport,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    startReviewConsensusMeeting,
    processSubtaskDelegations,
  });

  function reconcileDelegatedSubtasksAfterRun(taskId: string, exitCode: number): void {
    reviewFinalizeTools.reconcileDelegatedSubtasksAfterRun(taskId, exitCode);
  }

  function finishReview(
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ): void {
    reviewFinalizeTools.finishReview(taskId, taskTitle, options);
  }

  return {
    crossDeptNextCallbacks,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    delegatedTaskToSubtask,
    subtaskDelegationCompletionNoticeSent,
    meetingPresenceUntil,
    meetingSeatIndexByAgent,
    meetingPhaseByAgent,
    meetingTaskIdByAgent,
    meetingReviewDecisionByAgent,
    taskExecutionSessions,
    ensureTaskExecutionSession,
    endTaskExecutionSession,
    isTaskWorkflowInterrupted,
    clearTaskWorkflowState,
    startProgressTimer,
    stopProgressTimer,
    notifyCeo,
    archivePlanningConsolidatedReport,
    isAgentInMeeting,
    startTaskExecutionForAgent,
    startPlannedApprovalMeeting,
    scheduleNextReviewRound,
    handleTaskRunComplete,
    cancelPendingReRuns,
    runTask,
    finishReview,
  };
}
