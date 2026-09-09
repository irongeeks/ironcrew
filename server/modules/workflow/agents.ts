import type { RuntimeContext, WorkflowAgentExports } from "../../types/runtime-context.ts";
import { initializeWorkflowAgentProviders } from "./agents/providers.ts";
import { createSubtaskRoutingTools } from "./agents/subtask-routing.ts";
import { createSubtaskSeedingTools } from "./agents/subtask-seeding.ts";
import { createCliRuntimeTools } from "./agents/cli-runtime.ts";
import { createCredentialTools } from "./agents/providers/credential-tools.ts";
import { createUsageCliTools } from "./agents/providers/usage-cli-tools.ts";

export function initializeWorkflowPartB(ctx: RuntimeContext): WorkflowAgentExports {
  const __ctx: RuntimeContext = ctx;

  const db = __ctx.db;
  const nowMs = __ctx.nowMs;
  const logsDir = __ctx.logsDir;
  const activeProcesses = __ctx.activeProcesses;
  const appendTaskLog = __ctx.appendTaskLog;
  const broadcast = __ctx.broadcast;
  const runAgentOneShot = __ctx.runAgentOneShot;
  const resolveProjectPath: RuntimeContext["resolveProjectPath"] = (...args) => __ctx.resolveProjectPath(...args);
  const resolveLang: RuntimeContext["resolveLang"] = (...args) => __ctx.resolveLang(...args);
  const findTeamLeader: RuntimeContext["findTeamLeader"] = (...args) => __ctx.findTeamLeader(...args);
  const getDeptName: RuntimeContext["getDeptName"] = (...args) => __ctx.getDeptName(...args);
  const getPreferredLanguage: RuntimeContext["getPreferredLanguage"] = (...args) => __ctx.getPreferredLanguage(...args);
  const l: RuntimeContext["l"] = (...args) => __ctx.l(...args);
  const pickL: RuntimeContext["pickL"] = (...args) => __ctx.pickL(...args);
  const notifyCeo: RuntimeContext["notifyCeo"] = (...args) => __ctx.notifyCeo(...args);
  const detectTargetDepartments: RuntimeContext["detectTargetDepartments"] = (...args) =>
    __ctx.detectTargetDepartments(...args);
  const DEPT_KEYWORDS = __ctx.DEPT_KEYWORDS;
  const clearCliOutputDedup = __ctx.clearCliOutputDedup;
  const normalizeStreamChunk = __ctx.normalizeStreamChunk;
  const shouldSkipDuplicateCliOutput = __ctx.shouldSkipDuplicateCliOutput;
  const TASK_RUN_IDLE_TIMEOUT_MS = __ctx.TASK_RUN_IDLE_TIMEOUT_MS;
  const TASK_RUN_HARD_TIMEOUT_MS = __ctx.TASK_RUN_HARD_TIMEOUT_MS;
  const killPidTree = __ctx.killPidTree;
  const adapterRegistry = __ctx.adapterRegistry;

  const { analyzeSubtaskDepartment, rerouteSubtasksByPlanningLeader } = createSubtaskRoutingTools({
    db,
    DEPT_KEYWORDS,
    detectTargetDepartments,
    runAgentOneShot,
    resolveProjectPath,
    resolveLang,
    findTeamLeader,
    getDeptName,
    pickL,
    l,
    broadcast,
    appendTaskLog,
    notifyCeo,
  });

  const { createSubtaskFromCli, completeSubtaskFromCli, seedApprovedPlanSubtasks, seedReviewRevisionSubtasks } =
    createSubtaskSeedingTools({
      db,
      nowMs,
      broadcast,
      analyzeSubtaskDepartment,
      rerouteSubtasksByPlanningLeader,
      findTeamLeader,
      getDeptName,
      getPreferredLanguage,
      resolveLang,
      l,
      pickL,
      appendTaskLog,
      notifyCeo,
    });

  const { checkTokenFreshness } = createUsageCliTools(createCredentialTools());

  const { codexThreadToSubtask, spawnCliAgent } = createCliRuntimeTools({
    db,
    logsDir,
    adapterRegistry,
    clearCliOutputDedup,
    normalizeStreamChunk,
    shouldSkipDuplicateCliOutput,
    broadcast,
    TASK_RUN_IDLE_TIMEOUT_MS,
    TASK_RUN_HARD_TIMEOUT_MS,
    killPidTree,
    appendTaskLog,
    activeProcesses,
    stopRequestedTasks: __ctx.stopRequestedTasks,
    stopRequestModeByTask: __ctx.stopRequestModeByTask,
    createSubtaskFromCli,
    completeSubtaskFromCli,
    metrics: __ctx.metrics,
    nowMs,
    checkTokenFreshness,
  });

  const workflowAgentProviders = initializeWorkflowAgentProviders({
    db,
    nowMs,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    createSubtaskFromCli,
    completeSubtaskFromCli,
    handleTaskRunComplete: (...args) => __ctx.handleTaskRunComplete(...args),
    ensureOAuthActiveAccount: __ctx.ensureOAuthActiveAccount,
    getActiveOAuthAccountIds: __ctx.getActiveOAuthAccountIds,
    setActiveOAuthAccount: __ctx.setActiveOAuthAccount,
  });
  const {
    httpAgentCounter,
    getNextHttpAgentPid,
    cachedModels,
    MODELS_CACHE_TTL,
    normalizeOAuthProvider,
    getNextOAuthLabel,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    executeCopilotAgent,
    executeAntigravityAgent,
    executeApiProviderAgent,
    launchApiProviderAgent,
    launchHttpAgent,
    killPidTree: killPidTreeFromProvider,
    isPidAlive,
    interruptPidTree,
    appendTaskLog: appendTaskLogFromProvider,
    cachedCliStatus,
    CLI_STATUS_TTL,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    execWithTimeout,
    detectAllCli,
  } = workflowAgentProviders;

  Object.assign(__ctx, {
    rerouteSubtasksByPlanningLeader,
    createSubtaskFromCli,
    completeSubtaskFromCli,
  });

  return {
    analyzeSubtaskDepartment,
    seedApprovedPlanSubtasks,
    seedReviewRevisionSubtasks,
    codexThreadToSubtask,
    spawnCliAgent,
    httpAgentCounter,
    getNextHttpAgentPid,
    cachedModels,
    MODELS_CACHE_TTL,
    normalizeOAuthProvider,
    getNextOAuthLabel,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    executeCopilotAgent,
    executeAntigravityAgent,
    executeApiProviderAgent,
    launchApiProviderAgent,
    launchHttpAgent,
    killPidTree: killPidTreeFromProvider,
    isPidAlive,
    interruptPidTree,
    appendTaskLog: appendTaskLogFromProvider,
    cachedCliStatus,
    CLI_STATUS_TTL,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    execWithTimeout,
    detectAllCli,
  };
}
