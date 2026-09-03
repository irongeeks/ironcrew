import type { RuntimeContext } from "../../types/runtime-context.ts";
import {
  listDiscordChannelsByToken,
  listMessengerSessions,
  sendMessengerMessage,
  sendMessengerSessionMessage,
} from "../../gateway/client.ts";
import { isMessengerChannel, isNativeMessengerChannel } from "../../messenger/channels.ts";
import { getTelegramReceiverStatus } from "../../messenger/telegram-receiver.ts";
import { registerAgentRoutes } from "./core/agents/index.ts";
import { registerDepartmentRoutes } from "./core/departments.ts";
import { registerGitHubRoutes } from "./core/github-routes.ts";
import { registerProjectRoutes } from "./core/projects.ts";
import { registerTaskCrudRoutes } from "./core/tasks/crud.ts";
import { registerTaskExecutionRoutes } from "./core/tasks/execution.ts";
import { registerTaskSubtaskRoutes } from "./core/tasks/subtasks.ts";
import { registerPhaseApprovalRoutes } from "./core/tasks/phase-approval.ts";
import { registerUpdateAutoRoutes } from "./core/update-auto/register.ts";
import { registerDesignParserRoutes } from "./core/design-parser.ts";
import { getDiscordReceiverStatus } from "../../messenger/discord-receiver.ts";
import { toErrorMessage } from "./validation.ts";

export function registerRoutesPartA(ctx: RuntimeContext): Record<string, never> {
  const __ctx: RuntimeContext = ctx;
  const activeProcesses = __ctx.activeProcesses;
  const analyzeSubtaskDepartment = __ctx.analyzeSubtaskDepartment;
  const app = __ctx.app;
  const appendTaskLog = __ctx.appendTaskLog;
  const broadcast = __ctx.broadcast;
  const buildTaskExecutionPrompt = __ctx.buildTaskExecutionPrompt;
  const buildAvailableSkillsPromptBlock =
    __ctx.buildAvailableSkillsPromptBlock ||
    ((provider: string) => `[Available Skills][provider=${provider || "unknown"}][unavailable]`);
  const clearTaskWorkflowState = __ctx.clearTaskWorkflowState;
  const createWorktree = __ctx.createWorktree;
  const crossDeptNextCallbacks = __ctx.crossDeptNextCallbacks;
  const db = __ctx.db;
  const delegatedTaskToSubtask = __ctx.delegatedTaskToSubtask;
  const endTaskExecutionSession = __ctx.endTaskExecutionSession;
  const ensureClaudeMd = __ctx.ensureClaudeMd;
  const ensureTaskExecutionSession = __ctx.ensureTaskExecutionSession;
  const findTeamLeader = __ctx.findTeamLeader;
  const firstQueryValue = __ctx.firstQueryValue;
  const generateProjectContext = __ctx.generateProjectContext;
  const getAgentDisplayName = __ctx.getAgentDisplayName;
  const getProviderModelConfig = __ctx.getProviderModelConfig;
  const getRecentChanges = __ctx.getRecentChanges;
  const getRecentConversationContext = __ctx.getRecentConversationContext;
  const getTaskContinuationContext = __ctx.getTaskContinuationContext;
  const handleTaskRunComplete = __ctx.handleTaskRunComplete;
  const hasExplicitWarningFixRequest = __ctx.hasExplicitWarningFixRequest;
  const getNextHttpAgentPid = __ctx.getNextHttpAgentPid;
  const interruptPidTree = __ctx.interruptPidTree;
  const isTaskWorkflowInterrupted = __ctx.isTaskWorkflowInterrupted;
  const killPidTree = __ctx.killPidTree;
  const launchApiProviderAgent = __ctx.launchApiProviderAgent;
  const launchHttpAgent = __ctx.launchHttpAgent;
  const logsDir = __ctx.logsDir;
  const normalizeTextField = __ctx.normalizeTextField;
  const notifyCeo = __ctx.notifyCeo;
  const nowMs = __ctx.nowMs;
  const randomDelay = __ctx.randomDelay;
  const recordTaskCreationAudit = __ctx.recordTaskCreationAudit;
  const setTaskCreationAuditCompletion = __ctx.setTaskCreationAuditCompletion;
  const reconcileCrossDeptSubtasks = __ctx.reconcileCrossDeptSubtasks;
  const resolveProjectPath = __ctx.resolveProjectPath;
  const resolveLang = __ctx.resolveLang;
  const rollbackTaskWorktree = __ctx.rollbackTaskWorktree;
  const runInTransaction = __ctx.runInTransaction;
  const sendAgentMessage = __ctx.sendAgentMessage;
  const spawnCliAgent = __ctx.spawnCliAgent;
  const startProgressTimer = __ctx.startProgressTimer;
  const startTaskExecutionForAgent = __ctx.startTaskExecutionForAgent;
  const stopProgressTimer = __ctx.stopProgressTimer;
  const stopRequestModeByTask = __ctx.stopRequestModeByTask;
  const stopRequestedTasks = __ctx.stopRequestedTasks;
  const subtaskDelegationCallbacks = __ctx.subtaskDelegationCallbacks;
  const subtaskDelegationCompletionNoticeSent = __ctx.subtaskDelegationCompletionNoticeSent;
  const subtaskDelegationDispatchInFlight = __ctx.subtaskDelegationDispatchInFlight;
  const taskExecutionSessions = __ctx.taskExecutionSessions;
  const getDeptName = __ctx.getDeptName;
  const getDeptRoleConstraint = __ctx.getDeptRoleConstraint;
  const l = __ctx.l;
  const pickL = __ctx.pickL;

  // ===========================================================================
  // API ENDPOINTS
  // ===========================================================================

  registerUpdateAutoRoutes(
    { app: __ctx.app, db: __ctx.db, dbPath: __ctx.dbPath, activeProcesses: __ctx.activeProcesses },
    __ctx as import("../../types/runtime-context-domains.ts").UtilContext,
  );

  // ---------------------------------------------------------------------------
  // Direct messenger channels
  // ---------------------------------------------------------------------------
  app.get("/api/messenger/sessions", (_req, res) => {
    try {
      const sessions = listMessengerSessions();
      res.json({ ok: true, sessions });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });

  app.get("/api/messenger/receiver/telegram", (_req, res) => {
    try {
      res.json({ ok: true, status: getTelegramReceiverStatus() });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });

  app.get("/api/messenger/receiver/discord", (_req, res) => {
    try {
      res.json({ ok: true, status: getDiscordReceiverStatus() });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });

  app.post("/api/messenger/discord/channels", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { token?: string };
      const token = normalizeTextField(body.token);
      if (!token) {
        return res.status(400).json({ ok: false, error: "discord_token_required" });
      }
      const channels = await listDiscordChannelsByToken(token);
      return res.json({ ok: true, channels });
    } catch (err: unknown) {
      const message = toErrorMessage(err);
      const status = /discord api failed \((\d{3})\)/.exec(message)?.[1];
      if (status === "401" || status === "403") {
        return res.status(Number(status)).json({ ok: false, error: "discord_auth_failed" });
      }
      if (status === "429") {
        return res.status(429).json({ ok: false, error: "discord_rate_limited" });
      }
      return res.status(502).json({ ok: false, error: "discord_channel_lookup_failed" });
    }
  });

  app.post("/api/messenger/send", async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        sessionKey?: string;
        channel?: string;
        targetId?: string;
        text?: string;
      };
      const text = normalizeTextField(body.text);
      if (!text) {
        return res.status(400).json({ ok: false, error: "text required" });
      }

      const sessionKey = normalizeTextField(body.sessionKey);
      if (sessionKey) {
        const sessionChannelHint = sessionKey.split(":", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          sessionChannelHint &&
          isMessengerChannel(sessionChannelHint) &&
          !isNativeMessengerChannel(sessionChannelHint)
        ) {
          return res.status(400).json({ ok: false, error: `channel transport not implemented: ${sessionChannelHint}` });
        }
        await sendMessengerSessionMessage(sessionKey, text);
        return res.json({ ok: true });
      }

      const channel = normalizeTextField(body.channel);
      const targetId = normalizeTextField(body.targetId);
      if (!channel || !targetId) {
        return res.status(400).json({ ok: false, error: "sessionKey or channel/targetId required" });
      }
      if (!isMessengerChannel(channel)) {
        return res.status(400).json({ ok: false, error: "unsupported channel" });
      }
      if (!isNativeMessengerChannel(channel)) {
        return res.status(400).json({ ok: false, error: `channel transport not implemented: ${channel}` });
      }

      await sendMessengerMessage({
        channel,
        targetId,
        text,
      });
      return res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // Departments
  // ---------------------------------------------------------------------------
  registerDepartmentRoutes({
    app,
    db,
    broadcast,
    normalizeTextField,
    runInTransaction,
  });

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  registerProjectRoutes({
    app,
    db,
    firstQueryValue,
    normalizeTextField,
    runInTransaction,
    nowMs,
  });

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------
  registerAgentRoutes(__ctx);

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------
  registerTaskCrudRoutes({
    app,
    db,
    nowMs,
    firstQueryValue,
    reconcileCrossDeptSubtasks,
    normalizeTextField,
    recordTaskCreationAudit,
    appendTaskLog,
    broadcast,
    setTaskCreationAuditCompletion,
    clearTaskWorkflowState,
    endTaskExecutionSession,
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    logsDir,
    packRegistry: (__ctx as any).packRegistry,
  });

  // ---------------------------------------------------------------------------
  // SubTask endpoints
  // ---------------------------------------------------------------------------
  registerTaskSubtaskRoutes({
    app,
    db,
    firstQueryValue,
    nowMs,
    analyzeSubtaskDepartment,
    getDeptName,
    broadcast,
    appendTaskLog,
    findTeamLeader,
    resolveLang,
    getAgentDisplayName,
    sendAgentMessage,
    pickL,
    l,
  });

  registerTaskExecutionRoutes({
    app,
    db,
    activeProcesses,
    appendTaskLog,
    nowMs,
    resolveLang,
    ensureTaskExecutionSession,
    resolveProjectPath,
    logsDir,
    createWorktree,
    generateProjectContext,
    getRecentChanges,
    ensureClaudeMd,
    getDeptRoleConstraint,
    normalizeTextField,
    getRecentConversationContext,
    getTaskContinuationContext,
    pickL,
    l,
    getProviderModelConfig,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    broadcast,
    getAgentDisplayName,
    notifyCeo,
    startProgressTimer,
    launchApiProviderAgent,
    launchHttpAgent,
    spawnCliAgent,
    handleTaskRunComplete,
    buildAvailableSkillsPromptBlock,
    packRegistry: (__ctx as any).packRegistry,
    graphRunner: (__ctx as any).graphRunner,
    stopProgressTimer,
    rollbackTaskWorktree,
    clearTaskWorkflowState,
    endTaskExecutionSession,
    stopRequestedTasks,
    stopRequestModeByTask,
    interruptPidTree,
    killPidTree,
    delegatedTaskToSubtask,
    subtaskDelegationCallbacks,
    crossDeptNextCallbacks,
    subtaskDelegationDispatchInFlight,
    subtaskDelegationCompletionNoticeSent,
    taskExecutionSessions,
    getDeptName,
    isTaskWorkflowInterrupted,
    startTaskExecutionForAgent,
    randomDelay,
  });

  registerDesignParserRoutes({
    app,
    db,
    normalizeTextField,
  });

  registerPhaseApprovalRoutes({
    app,
    db,
    nowMs,
    broadcast,
    appendTaskLog,
    packRegistry: (__ctx as any).packRegistry,
    graphRunner: (__ctx as any).graphRunner,
    activeProcesses,
    stopRequestedTasks: __ctx.stopRequestedTasks,
    killPidTree: __ctx.killPidTree,
    endTaskExecutionSession: __ctx.endTaskExecutionSession,
    runTask: __ctx.runTask,
  } as any);

  registerGitHubRoutes({
    app,
    db,
    broadcast,
  });

  return {};
}
