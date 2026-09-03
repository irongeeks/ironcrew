import type { RuntimeContext, WorkflowAgentExports } from "../../types/runtime-context.ts";
import { initializeWorkflowAgentProviders } from "./agents/providers.ts";
import { createSubtaskRoutingTools } from "./agents/subtask-routing.ts";
import { createSubtaskSeedingTools } from "./agents/subtask-seeding.ts";
import { createCliRuntimeTools } from "./agents/cli-runtime.ts";
import { createCredentialTools } from "./agents/providers/credential-tools.ts";
import { createUsageCliTools } from "./agents/providers/usage-cli-tools.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _ctx = (c: RuntimeContext) => c as any;

export function initializeWorkflowPartB(ctx: RuntimeContext): WorkflowAgentExports {
  const __ctx: RuntimeContext = ctx;

  const db = __ctx.db;
  const nowMs = __ctx.nowMs;
  const logsDir = __ctx.logsDir;
  const activeProcesses = __ctx.activeProcesses;
  const appendTaskLog = __ctx.appendTaskLog;
  const broadcast = __ctx.broadcast;
  const runAgentOneShot = __ctx.runAgentOneShot;
  const resolveProjectPath = ((...args: any[]) =>
    _ctx(__ctx).resolveProjectPath(...args)) as RuntimeContext["resolveProjectPath"];
  const resolveLang = ((...args: any[]) => _ctx(__ctx).resolveLang(...args)) as RuntimeContext["resolveLang"];
  const findTeamLeader = ((...args: any[]) => _ctx(__ctx).findTeamLeader(...args)) as RuntimeContext["findTeamLeader"];
  const getDeptName = ((...args: any[]) => _ctx(__ctx).getDeptName(...args)) as RuntimeContext["getDeptName"];
  const getPreferredLanguage = ((...args: any[]) =>
    _ctx(__ctx).getPreferredLanguage(...args)) as RuntimeContext["getPreferredLanguage"];
  const l = ((...args: any[]) => _ctx(__ctx).l(...args)) as RuntimeContext["l"];
  const pickL = ((...args: any[]) => _ctx(__ctx).pickL(...args)) as RuntimeContext["pickL"];
  const notifyCeo = ((...args: any[]) => _ctx(__ctx).notifyCeo(...args)) as RuntimeContext["notifyCeo"];
  const detectTargetDepartments = ((...args: any[]) =>
    _ctx(__ctx).detectTargetDepartments(...args)) as RuntimeContext["detectTargetDepartments"];
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
    handleTaskRunComplete: ((...args: any[]) =>
      _ctx(__ctx).handleTaskRunComplete(...args)) as RuntimeContext["handleTaskRunComplete"],
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
