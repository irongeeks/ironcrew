import type { TaskExecutionContext } from "../types/runtime-context-domains.ts";

/**
 * Dependencies for TaskExecutionContext — pass-through from runtimeContext.
 *
 * Functions originate from project-context-tools.ts, cli-tools.ts,
 * prompt-skills.ts, subtask-seeding.ts, cli-runtime.ts,
 * http-agent-tools.ts, stream-tools.ts, and api-provider-tools.ts.
 * All are closures over runtimeContext in barrel modules.
 */
export interface TaskExecutionDeps {
  // Constants
  ANSI_ESCAPE_REGEX: TaskExecutionContext["ANSI_ESCAPE_REGEX"];
  CLI_SPINNER_LINE_REGEX: TaskExecutionContext["CLI_SPINNER_LINE_REGEX"];
  CONTEXT_IGNORE_DIRS: TaskExecutionContext["CONTEXT_IGNORE_DIRS"];
  CONTEXT_IGNORE_FILES: TaskExecutionContext["CONTEXT_IGNORE_FILES"];
  EXECUTION_CONTINUITY_POLICY_LINES: TaskExecutionContext["EXECUTION_CONTINUITY_POLICY_LINES"];
  MVP_CODE_REVIEW_POLICY_BASE_LINES: TaskExecutionContext["MVP_CODE_REVIEW_POLICY_BASE_LINES"];
  WARNING_FIX_OVERRIDE_LINE: TaskExecutionContext["WARNING_FIX_OVERRIDE_LINE"];

  // Caches
  cliOutputDedupCache: TaskExecutionContext["cliOutputDedupCache"];

  // Functions
  buildAgentArgs: TaskExecutionContext["buildAgentArgs"];
  buildAvailableSkillsPromptBlock: TaskExecutionContext["buildAvailableSkillsPromptBlock"];
  buildCliFailureMessage: TaskExecutionContext["buildCliFailureMessage"];
  buildDirectReplyPrompt: TaskExecutionContext["buildDirectReplyPrompt"];
  buildFileTree: TaskExecutionContext["buildFileTree"];
  buildHealthPayload: TaskExecutionContext["buildHealthPayload"];
  buildMvpCodeReviewPolicyBlock: TaskExecutionContext["buildMvpCodeReviewPolicyBlock"];
  buildProjectContextContent: TaskExecutionContext["buildProjectContextContent"];
  buildSubtaskDelegationPrompt: TaskExecutionContext["buildSubtaskDelegationPrompt"];
  buildTaskExecutionPrompt: TaskExecutionContext["buildTaskExecutionPrompt"];
  completeSubtaskFromCli: TaskExecutionContext["completeSubtaskFromCli"];
  createSubtaskFromCli: TaskExecutionContext["createSubtaskFromCli"];
  ensureClaudeMd: TaskExecutionContext["ensureClaudeMd"];
  executeApiProviderAgent: TaskExecutionContext["executeApiProviderAgent"];
  executeCopilotAgent: TaskExecutionContext["executeCopilotAgent"];
  executeAntigravityAgent: TaskExecutionContext["executeAntigravityAgent"];
  generateProjectContext: TaskExecutionContext["generateProjectContext"];
  getRecentChanges: TaskExecutionContext["getRecentChanges"];
  hasExplicitWarningFixRequest: TaskExecutionContext["hasExplicitWarningFixRequest"];
  launchApiProviderAgent: TaskExecutionContext["launchApiProviderAgent"];
  launchHttpAgent: TaskExecutionContext["launchHttpAgent"];
  normalizeStreamChunk: TaskExecutionContext["normalizeStreamChunk"];
  parseAndCreateSubtasks: TaskExecutionContext["parseAndCreateSubtasks"];
  parseGeminiSSEStream: TaskExecutionContext["parseGeminiSSEStream"];
  parseHttpAgentSubtasks: TaskExecutionContext["parseHttpAgentSubtasks"];
  parseSSEStream: TaskExecutionContext["parseSSEStream"];
  resolveAntigravityModel: TaskExecutionContext["resolveAntigravityModel"];
  resolveCopilotModel: TaskExecutionContext["resolveCopilotModel"];
  runAgentOneShot: TaskExecutionContext["runAgentOneShot"];
  shouldSkipDuplicateCliOutput: TaskExecutionContext["shouldSkipDuplicateCliOutput"];
  clearCliOutputDedup: TaskExecutionContext["clearCliOutputDedup"];
  spawnCliAgent: TaskExecutionContext["spawnCliAgent"];
}

/**
 * Creates a TaskExecutionContext by forwarding all properties from deps.
 *
 * Transitional pass-through factory. Future work will refactor source
 * modules (cli-tools.ts, stream-tools.ts, etc.) to accept narrow deps
 * so their functions can be imported and composed here directly.
 */
export function createTaskExecutionContext(deps: TaskExecutionDeps): TaskExecutionContext {
  return {
    ANSI_ESCAPE_REGEX: deps.ANSI_ESCAPE_REGEX,
    CLI_SPINNER_LINE_REGEX: deps.CLI_SPINNER_LINE_REGEX,
    CONTEXT_IGNORE_DIRS: deps.CONTEXT_IGNORE_DIRS,
    CONTEXT_IGNORE_FILES: deps.CONTEXT_IGNORE_FILES,
    EXECUTION_CONTINUITY_POLICY_LINES: deps.EXECUTION_CONTINUITY_POLICY_LINES,
    MVP_CODE_REVIEW_POLICY_BASE_LINES: deps.MVP_CODE_REVIEW_POLICY_BASE_LINES,
    WARNING_FIX_OVERRIDE_LINE: deps.WARNING_FIX_OVERRIDE_LINE,

    cliOutputDedupCache: deps.cliOutputDedupCache,

    buildAgentArgs: deps.buildAgentArgs,
    buildAvailableSkillsPromptBlock: deps.buildAvailableSkillsPromptBlock,
    buildCliFailureMessage: deps.buildCliFailureMessage,
    buildDirectReplyPrompt: deps.buildDirectReplyPrompt,
    buildFileTree: deps.buildFileTree,
    buildHealthPayload: deps.buildHealthPayload,
    buildMvpCodeReviewPolicyBlock: deps.buildMvpCodeReviewPolicyBlock,
    buildProjectContextContent: deps.buildProjectContextContent,
    buildSubtaskDelegationPrompt: deps.buildSubtaskDelegationPrompt,
    buildTaskExecutionPrompt: deps.buildTaskExecutionPrompt,
    completeSubtaskFromCli: deps.completeSubtaskFromCli,
    createSubtaskFromCli: deps.createSubtaskFromCli,
    ensureClaudeMd: deps.ensureClaudeMd,
    executeApiProviderAgent: deps.executeApiProviderAgent,
    executeCopilotAgent: deps.executeCopilotAgent,
    executeAntigravityAgent: deps.executeAntigravityAgent,
    generateProjectContext: deps.generateProjectContext,
    getRecentChanges: deps.getRecentChanges,
    hasExplicitWarningFixRequest: deps.hasExplicitWarningFixRequest,
    launchApiProviderAgent: deps.launchApiProviderAgent,
    launchHttpAgent: deps.launchHttpAgent,
    normalizeStreamChunk: deps.normalizeStreamChunk,
    parseAndCreateSubtasks: deps.parseAndCreateSubtasks,
    parseGeminiSSEStream: deps.parseGeminiSSEStream,
    parseHttpAgentSubtasks: deps.parseHttpAgentSubtasks,
    parseSSEStream: deps.parseSSEStream,
    resolveAntigravityModel: deps.resolveAntigravityModel,
    resolveCopilotModel: deps.resolveCopilotModel,
    runAgentOneShot: deps.runAgentOneShot,
    shouldSkipDuplicateCliOutput: deps.shouldSkipDuplicateCliOutput,
    clearCliOutputDedup: deps.clearCliOutputDedup,
    spawnCliAgent: deps.spawnCliAgent,
  };
}
