import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { createOAuthTools } from "./providers/oauth-tools.ts";
import { createProcessTools } from "./providers/process-tools.ts";
import { createCredentialTools } from "./providers/credential-tools.ts";
import { createUsageCliTools } from "./providers/usage-cli-tools.ts";
import { createHttpAgentTools } from "./providers/http-agent-tools.ts";
import { createApiProviderTools } from "./providers/api-provider-tools.ts";

export type WorkflowAgentProviderDeps = Pick<
  RuntimeContext,
  | "db"
  | "nowMs"
  | "logsDir"
  | "activeProcesses"
  | "broadcast"
  | "normalizeStreamChunk"
  | "createSubtaskFromCli"
  | "completeSubtaskFromCli"
  | "handleTaskRunComplete"
  | "ensureOAuthActiveAccount"
  | "getActiveOAuthAccountIds"
  | "setActiveOAuthAccount"
>;

export function initializeWorkflowAgentProviders(deps: WorkflowAgentProviderDeps): any {
  const {
    db,
    nowMs,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    createSubtaskFromCli,
    completeSubtaskFromCli,
    ensureOAuthActiveAccount,
    getActiveOAuthAccountIds,
    setActiveOAuthAccount,
  } = deps;
  const handleTaskRunComplete = (...args: Parameters<WorkflowAgentProviderDeps["handleTaskRunComplete"]>) =>
    deps.handleTaskRunComplete(...args);

  const processTools = createProcessTools({
    db,
    nowMs,
  });
  const { killPidTree, isPidAlive, interruptPidTree, appendTaskLog } = processTools;

  const oauthTools = createOAuthTools({
    db,
    nowMs,
    ensureOAuthActiveAccount,
    getActiveOAuthAccountIds,
  });
  const {
    ANTIGRAVITY_ENDPOINTS,
    normalizeOAuthProvider,
    getOAuthAccountDisplayName,
    getNextOAuthLabel,
    getOAuthAutoSwapEnabled,
    rotateOAuthAccounts,
    prioritizeOAuthAccount,
    markOAuthAccountFailure,
    markOAuthAccountSuccess,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    loadCodeAssistProject,
  } = oauthTools;

  const credentialTools = createCredentialTools();
  const {
    jsonHasKey,
    fileExistsNonEmpty,
    readClaudeToken,
    readCodexTokens,
    readGeminiCredsFromKeychain,
    freshGeminiToken,
    getGeminiProjectId,
  } = credentialTools;

  const usageCliTools = createUsageCliTools({
    jsonHasKey,
    fileExistsNonEmpty,
    readClaudeToken,
    readCodexTokens,
    readGeminiCredsFromKeychain,
    freshGeminiToken,
    getGeminiProjectId,
  });
  const {
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    cachedCliStatus,
    CLI_STATUS_TTL,
    execWithTimeout,
    detectAllCli,
    checkTokenFreshness,
  } = usageCliTools;

  let httpAgentCounter = Date.now() % 1_000_000;
  const cachedModels: { data: Record<string, string[]>; loadedAt: number } | null = null;
  const MODELS_CACHE_TTL = 60_000;
  function getNextHttpAgentPid(): number {
    httpAgentCounter += 1;
    return -httpAgentCounter;
  }

  const httpAgentTools = createHttpAgentTools({
    db,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    createSubtaskFromCli,
    completeSubtaskFromCli,
    handleTaskRunComplete,
    setActiveOAuthAccount,
    getProviderModelConfig,
    getOAuthAutoSwapEnabled,
    getPreferredOAuthAccounts,
    prioritizeOAuthAccount,
    rotateOAuthAccounts,
    getOAuthAccountDisplayName,
    exchangeCopilotToken,
    refreshGoogleToken,
    loadCodeAssistProject,
    markOAuthAccountFailure,
    markOAuthAccountSuccess,
    ANTIGRAVITY_ENDPOINTS,
  });
  const {
    createSafeLogStreamOps,
    parseSSEStream,
    parseGeminiSSEStream,
    executeCopilotAgent,
    executeAntigravityAgent,
    launchHttpAgent,
  } = httpAgentTools;

  const apiProviderTools = createApiProviderTools({
    db,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    handleTaskRunComplete,
    createSafeLogStreamOps,
    parseSSEStream,
    parseGeminiSSEStream,
  });
  const { executeApiProviderAgent, launchApiProviderAgent } = apiProviderTools;

  return {
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
    launchHttpAgent,
    launchApiProviderAgent,
    killPidTree,
    isPidAlive,
    interruptPidTree,
    appendTaskLog,
    cachedCliStatus,
    CLI_STATUS_TTL,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    execWithTimeout,
    detectAllCli,
    checkTokenFreshness,
  };
}
