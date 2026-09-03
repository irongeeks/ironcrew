import type { UtilContext } from "../types/runtime-context-domains.ts";

/**
 * Dependencies for UtilContext — pass-through from runtimeContext.
 *
 * Functions originate from models-routes.ts, catalog-routes.ts,
 * worktrees-and-usage.ts, lang.ts, and various workflow/core files.
 * All are closures over runtimeContext in barrel modules.
 */
export interface UtilDeps {
  // Constants
  ANTIGRAVITY_DEFAULT_PROJECT: UtilContext["ANTIGRAVITY_DEFAULT_PROJECT"];
  ANTIGRAVITY_ENDPOINTS: UtilContext["ANTIGRAVITY_ENDPOINTS"];
  DEPT_KEYWORDS: UtilContext["DEPT_KEYWORDS"];
  SKILLS_CACHE_TTL: UtilContext["SKILLS_CACHE_TTL"];

  // Caches
  cachedCliModels: UtilContext["cachedCliModels"];
  cachedCliStatus: UtilContext["cachedCliStatus"];
  cachedModels: UtilContext["cachedModels"];
  cachedSkills: UtilContext["cachedSkills"];
  CLI_STATUS_TTL: UtilContext["CLI_STATUS_TTL"];
  CLI_TOOLS: UtilContext["CLI_TOOLS"];
  MODELS_CACHE_TTL: UtilContext["MODELS_CACHE_TTL"];

  // Functions
  appendTaskLog: UtilContext["appendTaskLog"];
  archivePlanningConsolidatedReport: UtilContext["archivePlanningConsolidatedReport"];
  chooseSafeReply: UtilContext["chooseSafeReply"];
  detectAllCli: UtilContext["detectAllCli"];
  detectCliTool: UtilContext["detectCliTool"];
  execWithTimeout: UtilContext["execWithTimeout"];
  fetchClaudeUsage: UtilContext["fetchClaudeUsage"];
  fetchCodexUsage: UtilContext["fetchCodexUsage"];
  fetchGeminiModels: UtilContext["fetchGeminiModels"];
  fetchGeminiUsage: UtilContext["fetchGeminiUsage"];
  fetchOpenCodeModels: UtilContext["fetchOpenCodeModels"];
  fetchSkillsFromSite: UtilContext["fetchSkillsFromSite"];
  findBestSubordinate: UtilContext["findBestSubordinate"];
  findTeamLeader: UtilContext["findTeamLeader"];
  getAgentDisplayName: UtilContext["getAgentDisplayName"];
  getDeptName: UtilContext["getDeptName"];
  getDeptRoleConstraint: UtilContext["getDeptRoleConstraint"];
  getProviderModelConfig: UtilContext["getProviderModelConfig"];
  getRecentConversationContext: UtilContext["getRecentConversationContext"];
  getTaskContinuationContext: UtilContext["getTaskContinuationContext"];
  hasStructuredJsonLines: UtilContext["hasStructuredJsonLines"];
  interruptPidTree: UtilContext["interruptPidTree"];
  isPidAlive: UtilContext["isPidAlive"];
  killPidTree: UtilContext["killPidTree"];
  notifyCeo: UtilContext["notifyCeo"];
  prettyStreamJson: UtilContext["prettyStreamJson"];
  randomDelay: UtilContext["randomDelay"];
  readCliUsageFromDb: UtilContext["readCliUsageFromDb"];
  readCodexModelsCache: UtilContext["readCodexModelsCache"];
  readSettingString: UtilContext["readSettingString"];
  readTimeoutMsEnv: UtilContext["readTimeoutMsEnv"];
  refreshCliUsageData: UtilContext["refreshCliUsageData"];
  toModelInfo: UtilContext["toModelInfo"];

  // Worktree management
  createWorktree: UtilContext["createWorktree"];
  ensureVideoTaskDirectory: UtilContext["ensureVideoTaskDirectory"];
  mergeWorktree: UtilContext["mergeWorktree"];
  mergeToDevAndCreatePR: UtilContext["mergeToDevAndCreatePR"];
  cleanupWorktree: UtilContext["cleanupWorktree"];
  rollbackTaskWorktree: UtilContext["rollbackTaskWorktree"];
  getWorktreeDiffSummary: UtilContext["getWorktreeDiffSummary"];

  // Workflow state (shared infrastructure)
  wsClients: UtilContext["wsClients"];
  activeProcesses: UtilContext["activeProcesses"];
  stopRequestedTasks: UtilContext["stopRequestedTasks"];
  stopRequestModeByTask: UtilContext["stopRequestModeByTask"];
  taskWorktrees: UtilContext["taskWorktrees"];
  TASK_RUN_IDLE_TIMEOUT_MS: UtilContext["TASK_RUN_IDLE_TIMEOUT_MS"];
  TASK_RUN_HARD_TIMEOUT_MS: UtilContext["TASK_RUN_HARD_TIMEOUT_MS"];
  broadcast: UtilContext["broadcast"];
  handleClientMessage: UtilContext["handleClientMessage"];
  sleepMs: UtilContext["sleepMs"];
  httpAgentCounter: UtilContext["httpAgentCounter"];
  getNextHttpAgentPid: UtilContext["getNextHttpAgentPid"];
  codexThreadToSubtask: UtilContext["codexThreadToSubtask"];
  crossDeptNextCallbacks: UtilContext["crossDeptNextCallbacks"];
  subtaskDelegationCallbacks: UtilContext["subtaskDelegationCallbacks"];
  subtaskDelegationDispatchInFlight: UtilContext["subtaskDelegationDispatchInFlight"];
  delegatedTaskToSubtask: UtilContext["delegatedTaskToSubtask"];
  subtaskDelegationCompletionNoticeSent: UtilContext["subtaskDelegationCompletionNoticeSent"];
  meetingPresenceUntil: UtilContext["meetingPresenceUntil"];
  meetingSeatIndexByAgent: UtilContext["meetingSeatIndexByAgent"];
  meetingPhaseByAgent: UtilContext["meetingPhaseByAgent"];
  meetingTaskIdByAgent: UtilContext["meetingTaskIdByAgent"];
  meetingReviewDecisionByAgent: UtilContext["meetingReviewDecisionByAgent"];
  taskExecutionSessions: UtilContext["taskExecutionSessions"];
  ensureTaskExecutionSession: UtilContext["ensureTaskExecutionSession"];
  endTaskExecutionSession: UtilContext["endTaskExecutionSession"];
  isTaskWorkflowInterrupted: UtilContext["isTaskWorkflowInterrupted"];
  clearTaskWorkflowState: UtilContext["clearTaskWorkflowState"];
  cancelPendingReRuns: UtilContext["cancelPendingReRuns"];
  runTask: UtilContext["runTask"];
  startTaskExecutionForAgent: UtilContext["startTaskExecutionForAgent"];
  handleTaskRunComplete: UtilContext["handleTaskRunComplete"];
}

/**
 * Creates a UtilContext by forwarding all properties from deps.
 *
 * Transitional pass-through factory. Future work will refactor source
 * modules to accept narrow deps so their functions can be composed here.
 */
export function createUtilContext(deps: UtilDeps): UtilContext {
  return {
    ANTIGRAVITY_DEFAULT_PROJECT: deps.ANTIGRAVITY_DEFAULT_PROJECT,
    ANTIGRAVITY_ENDPOINTS: deps.ANTIGRAVITY_ENDPOINTS,
    DEPT_KEYWORDS: deps.DEPT_KEYWORDS,
    SKILLS_CACHE_TTL: deps.SKILLS_CACHE_TTL,

    cachedCliModels: deps.cachedCliModels,
    cachedCliStatus: deps.cachedCliStatus,
    cachedModels: deps.cachedModels,
    cachedSkills: deps.cachedSkills,
    CLI_STATUS_TTL: deps.CLI_STATUS_TTL,
    CLI_TOOLS: deps.CLI_TOOLS,
    MODELS_CACHE_TTL: deps.MODELS_CACHE_TTL,

    appendTaskLog: deps.appendTaskLog,
    archivePlanningConsolidatedReport: deps.archivePlanningConsolidatedReport,
    chooseSafeReply: deps.chooseSafeReply,
    detectAllCli: deps.detectAllCli,
    detectCliTool: deps.detectCliTool,
    execWithTimeout: deps.execWithTimeout,
    fetchClaudeUsage: deps.fetchClaudeUsage,
    fetchCodexUsage: deps.fetchCodexUsage,
    fetchGeminiModels: deps.fetchGeminiModels,
    fetchGeminiUsage: deps.fetchGeminiUsage,
    fetchOpenCodeModels: deps.fetchOpenCodeModels,
    fetchSkillsFromSite: deps.fetchSkillsFromSite,
    findBestSubordinate: deps.findBestSubordinate,
    findTeamLeader: deps.findTeamLeader,
    getAgentDisplayName: deps.getAgentDisplayName,
    getDeptName: deps.getDeptName,
    getDeptRoleConstraint: deps.getDeptRoleConstraint,
    getProviderModelConfig: deps.getProviderModelConfig,
    getRecentConversationContext: deps.getRecentConversationContext,
    getTaskContinuationContext: deps.getTaskContinuationContext,
    hasStructuredJsonLines: deps.hasStructuredJsonLines,
    interruptPidTree: deps.interruptPidTree,
    isPidAlive: deps.isPidAlive,
    killPidTree: deps.killPidTree,
    notifyCeo: deps.notifyCeo,
    prettyStreamJson: deps.prettyStreamJson,
    randomDelay: deps.randomDelay,
    readCliUsageFromDb: deps.readCliUsageFromDb,
    readCodexModelsCache: deps.readCodexModelsCache,
    readSettingString: deps.readSettingString,
    readTimeoutMsEnv: deps.readTimeoutMsEnv,
    refreshCliUsageData: deps.refreshCliUsageData,
    toModelInfo: deps.toModelInfo,

    createWorktree: deps.createWorktree,
    ensureVideoTaskDirectory: deps.ensureVideoTaskDirectory,
    mergeWorktree: deps.mergeWorktree,
    mergeToDevAndCreatePR: deps.mergeToDevAndCreatePR,
    cleanupWorktree: deps.cleanupWorktree,
    rollbackTaskWorktree: deps.rollbackTaskWorktree,
    getWorktreeDiffSummary: deps.getWorktreeDiffSummary,

    wsClients: deps.wsClients,
    activeProcesses: deps.activeProcesses,
    stopRequestedTasks: deps.stopRequestedTasks,
    stopRequestModeByTask: deps.stopRequestModeByTask,
    taskWorktrees: deps.taskWorktrees,
    TASK_RUN_IDLE_TIMEOUT_MS: deps.TASK_RUN_IDLE_TIMEOUT_MS,
    TASK_RUN_HARD_TIMEOUT_MS: deps.TASK_RUN_HARD_TIMEOUT_MS,
    broadcast: deps.broadcast,
    handleClientMessage: deps.handleClientMessage,
    sleepMs: deps.sleepMs,
    httpAgentCounter: deps.httpAgentCounter,
    getNextHttpAgentPid: deps.getNextHttpAgentPid,
    codexThreadToSubtask: deps.codexThreadToSubtask,
    crossDeptNextCallbacks: deps.crossDeptNextCallbacks,
    subtaskDelegationCallbacks: deps.subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight: deps.subtaskDelegationDispatchInFlight,
    delegatedTaskToSubtask: deps.delegatedTaskToSubtask,
    subtaskDelegationCompletionNoticeSent: deps.subtaskDelegationCompletionNoticeSent,
    meetingPresenceUntil: deps.meetingPresenceUntil,
    meetingSeatIndexByAgent: deps.meetingSeatIndexByAgent,
    meetingPhaseByAgent: deps.meetingPhaseByAgent,
    meetingTaskIdByAgent: deps.meetingTaskIdByAgent,
    meetingReviewDecisionByAgent: deps.meetingReviewDecisionByAgent,
    taskExecutionSessions: deps.taskExecutionSessions,
    ensureTaskExecutionSession: deps.ensureTaskExecutionSession,
    endTaskExecutionSession: deps.endTaskExecutionSession,
    isTaskWorkflowInterrupted: deps.isTaskWorkflowInterrupted,
    clearTaskWorkflowState: deps.clearTaskWorkflowState,
    cancelPendingReRuns: deps.cancelPendingReRuns,
    runTask: deps.runTask,
    startTaskExecutionForAgent: deps.startTaskExecutionForAgent,
    handleTaskRunComplete: deps.handleTaskRunComplete,
  };
}
