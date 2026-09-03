import path from "node:path";
import { INBOX_WEBHOOK_SECRET } from "../../../../config/runtime.ts";
import { sendMessengerMessage, sendMessengerSessionMessage } from "../../../../gateway/client.ts";
import {
  resolveSessionAgentRouteFromDb,
  resolveSessionTargetRouteFromDb,
  resolveSourceChatRoute,
} from "../../../../messenger/session-agent-routing.ts";
import { safeSecretEquals } from "../../../../security/auth.ts";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { BaseRuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow, DelegationOptions, StoredMessage } from "../../shared/types.ts";
import type { DirectivePolicy } from "../../../../types/workflow-types.ts";
import type { DecisionReplyBridgeInput, DecisionReplyBridgeResult } from "./decision-inbox-routes.ts";
import type { PhaseApprovalBridgeInput, PhaseApprovalBridgeResult } from "./phase-approval-bridge.ts";
import { resolveDirectiveLeaderCandidateScope } from "./directive-leader-scope.ts";
import { logger } from "../../../../observability/logger.ts";

const log = logger.child({ module: "ops" });

interface DirectiveAndInboxRouteCtx {
  app: Express;
  db: DatabaseSync;
  broadcast(type: string, payload: unknown): void;
}

type DirectiveAndInboxRouteDeps = {
  IdempotencyConflictError: BaseRuntimeContext["IdempotencyConflictError"];
  StorageBusyError: BaseRuntimeContext["StorageBusyError"];
  enforceDirectiveProjectBinding: boolean;
  resolveMessageIdempotencyKey: BaseRuntimeContext["resolveMessageIdempotencyKey"];
  recordMessageIngressAuditOr503: BaseRuntimeContext["recordMessageIngressAuditOr503"];
  insertMessageWithIdempotency: BaseRuntimeContext["insertMessageWithIdempotency"];
  recordAcceptedIngressAuditOrRollback: BaseRuntimeContext["recordAcceptedIngressAuditOrRollback"];
  normalizeTextField(value: unknown): string | null;
  scheduleAnnouncementReplies(announcement: string): void;
  analyzeDirectivePolicy(content: string): DirectivePolicy;
  shouldExecuteDirectiveDelegation(policy: DirectivePolicy, explicitSkipPlannedMeeting: boolean): boolean;
  findTeamLeader(deptId: string | null, candidateAgentIds?: string[] | null): AgentRow | null;
  handleTaskDelegation(teamLeader: AgentRow, ceoMessage: string, ceoMsgId: string, options?: DelegationOptions): void;
  scheduleAgentReply(agentId: string, ceoMessage: string, messageType: string, options?: DelegationOptions): void;
  resetDirectChatState(agentId: string): { clearedPendingProjectBinding: boolean };
  detectMentions(message: string): { deptIds: string[]; agentIds: string[] };
  tryHandleInboxDecisionReply?: (input: DecisionReplyBridgeInput) => Promise<DecisionReplyBridgeResult>;
  tryHandlePhaseApprovalReply?: (input: PhaseApprovalBridgeInput) => Promise<PhaseApprovalBridgeResult>;
};

function isSessionResetCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /^\/new(?:@[\w_]+)?$/.test(normalized);
}

function detectLangForResetAck(text: string): "ko" | "en" | "ja" | "zh" {
  const sample = text.trim();
  const ko = sample.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g)?.length ?? 0;
  const ja = sample.match(/[\u3040-\u309F\u30A0-\u30FF]/g)?.length ?? 0;
  const zh = sample.match(/[\u4E00-\u9FFF]/g)?.length ?? 0;
  const total = sample.replace(/\s/g, "").length || 1;
  if (ko / total > 0.15) return "ko";
  if (ja / total > 0.15) return "ja";
  if (zh / total > 0.3) return "zh";
  return "en";
}

function buildSessionResetAck(text: string): string {
  const lang = detectLangForResetAck(text);
  if (lang === "ko") return "🧹 현재 대화 세션을 초기화했습니다. 새 대화를 시작할게요.";
  if (lang === "ja") return "🧹 現在の会話セッションを初期化しました。新しい会話を開始します。";
  if (lang === "zh") return "🧹 已重置当前会话。现在开始新的对话。";
  return "🧹 Current conversation session was reset. Starting a new chat.";
}

const buildAgentUpgradeRequiredPayload = () => {
  const repoRoot = process.cwd();
  const installerPaths = {
    mac_linux: path.join(repoRoot, "scripts", "setup.sh"),
    windows_powershell: path.join(repoRoot, "scripts", "setup.ps1"),
    agents_template: path.join(repoRoot, "templates", "AGENTS-octooffice.md"),
  };
  const agentsTargetPath = path.join(repoRoot, "AGENTS.md");
  const installCommands = {
    mac_linux: "bash scripts/setup.sh",
    windows_powershell: "powershell -ExecutionPolicy Bypass -File .\\scripts\\setup.ps1",
    agents_only: "pnpm run setup",
  };
  const absoluteInstallCommands = {
    mac_linux: `bash "${installerPaths.mac_linux}"`,
    windows_powershell: `powershell -ExecutionPolicy Bypass -File "${installerPaths.windows_powershell}"`,
    agents_only: `pnpm run setup -- --agents-path "${agentsTargetPath}"`,
  };
  const recommendedInstallCommand =
    process.platform === "win32" ? absoluteInstallCommands.windows_powershell : absoluteInstallCommands.mac_linux;

  return {
    error: "agent_upgrade_required",
    reason: "install_first",
    message: `OpenClaw AGENTS is outdated (HTTP 428). Install path: ${installerPaths.mac_linux} (or ${installerPaths.windows_powershell}). Target AGENTS path: ${agentsTargetPath}. Should I install it now?`,
    message_ko: `OpenClaw AGENTS가 구버전입니다(HTTP 428). 설치 경로: ${installerPaths.mac_linux} (또는 ${installerPaths.windows_powershell}), 대상 AGENTS: ${agentsTargetPath}. 지금 제가 직접 설치해드릴까요?`,
    required_agent_rules_version: 2,
    required_action: "install_latest_agents_rules",
    installer_files: ["scripts/setup.sh", "scripts/setup.ps1", "templates/AGENTS-octooffice.md"],
    installer_absolute_paths: installerPaths,
    agents_target_path: agentsTargetPath,
    install_commands: installCommands,
    install_commands_absolute: absoluteInstallCommands,
    recommended_install_command: recommendedInstallCommand,
    user_prompt: {
      ko: `OpenClaw AGENTS 규칙이 구버전입니다. 설치 파일: ${installerPaths.mac_linux} / ${installerPaths.windows_powershell}, 대상 AGENTS: ${agentsTargetPath}. 지금 제가 직접 설치해드릴까요? (예/아니오)`,
      en: `OpenClaw AGENTS rules are outdated. Installer files: ${installerPaths.mac_linux} / ${installerPaths.windows_powershell}, target AGENTS: ${agentsTargetPath}. Should I install it now? (yes/no)`,
    },
    next_step_ko: "사용자가 동의하면 설치 스크립트를 실행한 뒤 같은 directive를 1회 재시도하세요.",
    next_step_en: "If the user agrees, run installer script and retry the same directive once.",
  };
};

export function registerDirectiveAndInboxRoutes(
  ctx: DirectiveAndInboxRouteCtx,
  deps: DirectiveAndInboxRouteDeps,
): void {
  const { app, db, broadcast } = ctx;
  const {
    IdempotencyConflictError,
    StorageBusyError,
    enforceDirectiveProjectBinding,
    resolveMessageIdempotencyKey,
    recordMessageIngressAuditOr503,
    insertMessageWithIdempotency,
    recordAcceptedIngressAuditOrRollback,
    normalizeTextField,
    scheduleAnnouncementReplies,
    analyzeDirectivePolicy,
    shouldExecuteDirectiveDelegation,
    findTeamLeader,
    handleTaskDelegation,
    scheduleAgentReply,
    resetDirectChatState,
    detectMentions,
    tryHandleInboxDecisionReply,
    tryHandlePhaseApprovalReply,
  } = deps;

  const manualProjectModeCache = new Map<string, boolean>();

  const isManualProject = (projectId: string | null): boolean => {
    const normalizedProjectId = normalizeTextField(projectId);
    if (!normalizedProjectId) return false;
    const cached = manualProjectModeCache.get(normalizedProjectId);
    if (cached !== undefined) return cached;
    const row = db.prepare("SELECT assignment_mode FROM projects WHERE id = ? LIMIT 1").get(normalizedProjectId) as
      | { assignment_mode?: unknown }
      | undefined;
    const isManual = String(row?.assignment_mode ?? "").trim() === "manual";
    manualProjectModeCache.set(normalizedProjectId, isManual);
    return isManual;
  };

  const hasScopedDepartmentMember = (departmentId: string, scopedCandidateAgentIds: string[] | null): boolean => {
    if (!Array.isArray(scopedCandidateAgentIds)) return false;
    const scopedIds = [
      ...new Set(scopedCandidateAgentIds.map((id) => normalizeTextField(id)).filter((id): id is string => !!id)),
    ];
    if (scopedIds.length <= 0) return false;
    const placeholders = scopedIds.map(() => "?").join(", ");
    const row = db
      .prepare(
        `
          SELECT 1 AS hit
          FROM agents
          WHERE id IN (${placeholders})
            AND department_id = ?
          LIMIT 1
        `,
      )
      .get(...scopedIds, departmentId) as { hit?: unknown } | undefined;
    return !!row;
  };

  const findDirectiveLeader = (
    departmentId: string,
    projectId: string | null,
    scopedCandidateAgentIds: string[] | null,
  ): AgentRow | null => {
    if (!departmentId) return null;
    const scopedLeader = findTeamLeader(departmentId, scopedCandidateAgentIds);
    if (scopedLeader) return scopedLeader;
    if (Array.isArray(scopedCandidateAgentIds)) {
      // In manual projects, a selected member may exist without selecting the team leader.
      // Allow only the department leader as a coordinator fallback for that exact department.
      if (isManualProject(projectId) && hasScopedDepartmentMember(departmentId, scopedCandidateAgentIds)) {
        return findTeamLeader(departmentId);
      }
      return null;
    }
    if (projectId) return null;
    return findTeamLeader(departmentId);
  };

  app.post("/api/directives", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = resolveMessageIdempotencyKey(req, body, "api.directives");
    const content = body.content;
    const explicitProjectId = normalizeTextField(body.project_id);
    const explicitProjectPath = normalizeTextField(body.project_path);
    const explicitProjectContext = normalizeTextField(body.project_context);
    const explicitSource = normalizeTextField(body.source);
    const explicitChat = normalizeTextField(body.chat);
    if (!content || typeof content !== "string") {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/directives",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 400,
          detail: "content_required",
        })
      )
        return;
      return res.status(400).json({ error: "content_required" });
    }

    if (enforceDirectiveProjectBinding && !explicitProjectId) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/directives",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 428,
          detail: "agent_upgrade_required:install_first",
        })
      )
        return;
      return res.status(428).json(buildAgentUpgradeRequiredPayload());
    }

    let storedMessage: StoredMessage;
    let created: boolean;
    try {
      ({ message: storedMessage, created } = await insertMessageWithIdempotency({
        senderType: "ceo",
        senderId: null,
        receiverType: "all",
        receiverId: null,
        content,
        messageType: "directive",
        idempotencyKey,
      }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        const conflictErr = err as { key: string };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/directives",
            req,
            body,
            idempotencyKey,
            outcome: "idempotency_conflict",
            statusCode: 409,
            detail: "payload_mismatch",
          })
        )
          return;
        return res.status(409).json({ error: "idempotency_conflict", idempotency_key: conflictErr.key });
      }
      if (err instanceof StorageBusyError) {
        const busyErr = err as { operation: string; attempts: number };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/directives",
            req,
            body,
            idempotencyKey,
            outcome: "storage_busy",
            statusCode: 503,
            detail: `operation=${busyErr.operation}, attempts=${busyErr.attempts}`,
          })
        )
          return;
        return res.status(503).json({ error: "storage_busy", retryable: true, operation: busyErr.operation });
      }
      throw err;
    }
    const msg = { ...storedMessage };

    if (!created) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/directives",
          req,
          body,
          idempotencyKey,
          outcome: "duplicate",
          statusCode: 200,
          messageId: msg.id,
          detail: "idempotent_replay",
        })
      )
        return;
      return res.json({ ok: true, message: msg, duplicate: true });
    }

    if (
      !(await recordAcceptedIngressAuditOrRollback(
        res,
        {
          endpoint: "/api/directives",
          req,
          body,
          idempotencyKey,
          outcome: "accepted",
          statusCode: 200,
          detail: "created",
        },
        msg.id,
      ))
    )
      return;
    // 2. Broadcast to all
    broadcast("announcement", msg);

    // 3. Team leaders respond
    scheduleAnnouncementReplies(content);
    const directivePolicy = analyzeDirectivePolicy(content);
    const explicitSkip = body.skipPlannedMeeting === true;
    const shouldDelegate = shouldExecuteDirectiveDelegation(directivePolicy, explicitSkip);
    const directiveSessionRoute = resolveSessionTargetRouteFromDb({
      db,
      source: explicitSource,
      chat: explicitChat,
    });
    const directiveFallbackRoute = resolveSourceChatRoute({
      source: explicitSource,
      chat: explicitChat,
    });
    const directiveReplyRoute = directiveSessionRoute ?? directiveFallbackRoute;
    const delegationOptions: DelegationOptions = {
      skipPlannedMeeting: explicitSkip || directivePolicy.skipPlannedMeeting,
      skipPlanSubtasks: explicitSkip || directivePolicy.skipPlanSubtasks,
      projectId: explicitProjectId,
      projectPath: explicitProjectPath,
      projectContext: explicitProjectContext,
      messengerChannel: directiveReplyRoute?.channel,
      messengerTargetId: directiveReplyRoute?.targetId,
      messengerSessionKey: directiveSessionRoute
        ? `${directiveSessionRoute.channel}:${directiveSessionRoute.sessionId}`
        : null,
    };
    const directiveLeaderScopeByDept = new Map<string, string[] | null>();
    const getDirectiveLeaderScope = (deptId: string): string[] | null => {
      const normalizedDeptId = normalizeTextField(deptId) ?? "planning";
      if (!directiveLeaderScopeByDept.has(normalizedDeptId)) {
        directiveLeaderScopeByDept.set(
          normalizedDeptId,
          resolveDirectiveLeaderCandidateScope(db as any, explicitProjectId ?? null, normalizedDeptId),
        );
      }
      return directiveLeaderScopeByDept.get(normalizedDeptId) ?? null;
    };

    if (shouldDelegate) {
      // 4. Auto-delegate to planning team leader
      const planningLeader = findDirectiveLeader(
        "planning",
        explicitProjectId ?? null,
        getDirectiveLeaderScope("planning"),
      );
      if (planningLeader) {
        const delegationDelay = 3000 + Math.random() * 2000;
        setTimeout(() => {
          handleTaskDelegation(planningLeader, content, "", delegationOptions);
        }, delegationDelay);
      }

      // 5. Additional @mentions trigger delegation to other departments
      const mentions = detectMentions(content);
      if (mentions.deptIds.length > 0 || mentions.agentIds.length > 0) {
        const mentionDelay = 5000 + Math.random() * 2000;
        setTimeout(() => {
          const processedDepts = new Set<string>(["planning"]);

          for (const deptId of mentions.deptIds) {
            if (processedDepts.has(deptId)) continue;
            processedDepts.add(deptId);
            const leader = findDirectiveLeader(deptId, explicitProjectId ?? null, getDirectiveLeaderScope(deptId));
            if (leader) {
              handleTaskDelegation(leader, content, "", delegationOptions);
            }
          }

          for (const agentId of mentions.agentIds) {
            const mentioned = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
            if (mentioned?.department_id && !processedDepts.has(mentioned.department_id)) {
              processedDepts.add(mentioned.department_id);
              const leader = findDirectiveLeader(
                mentioned.department_id,
                explicitProjectId ?? null,
                getDirectiveLeaderScope(mentioned.department_id),
              );
              if (leader) {
                handleTaskDelegation(leader, content, "", delegationOptions);
              }
            }
          }
        }, mentionDelay);
      }
    }

    res.json({ ok: true, message: msg });
  });

  app.post("/api/inbox", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = resolveMessageIdempotencyKey(req, body, "api.inbox");
    if (!INBOX_WEBHOOK_SECRET) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 503,
          detail: "inbox_webhook_secret_not_configured",
        })
      )
        return;
      return res.status(503).json({ error: "inbox_webhook_secret_not_configured" });
    }
    const providedSecret = req.header("x-inbox-secret") ?? "";
    if (!safeSecretEquals(providedSecret, INBOX_WEBHOOK_SECRET)) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 401,
          detail: "invalid_webhook_secret",
        })
      )
        return;
      return res.status(401).json({ error: "unauthorized" });
    }

    const text = body.text;
    if (!text || typeof text !== "string" || !text.trim()) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 400,
          detail: "text_required",
        })
      )
        return;
      return res.status(400).json({ error: "text_required" });
    }

    const raw = text.trimStart();
    const isDirective = raw.startsWith("$");
    const content = isDirective ? raw.slice(1).trimStart() : raw;
    const inboxProjectId = normalizeTextField(body.project_id);
    const inboxProjectPath = normalizeTextField(body.project_path);
    const inboxProjectContext = normalizeTextField(body.project_context);
    const inboxSource = normalizeTextField(body.source);
    const inboxChat = normalizeTextField(body.chat);
    const directiveSessionRoute = resolveSessionTargetRouteFromDb({
      db,
      source: inboxSource,
      chat: inboxChat,
    });
    const directiveFallbackRoute = resolveSourceChatRoute({
      source: inboxSource,
      chat: inboxChat,
    });
    const directiveReplyRoute = directiveSessionRoute ?? directiveFallbackRoute;
    if (!content) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 400,
          detail: "empty_content",
        })
      )
        return;
      return res.status(400).json({ error: "empty_content" });
    }

    if (enforceDirectiveProjectBinding && isDirective && !inboxProjectId) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 428,
          detail: "agent_upgrade_required:install_first",
        })
      )
        return;
      return res.status(428).json(buildAgentUpgradeRequiredPayload());
    }

    const sessionRoute = !isDirective
      ? resolveSessionAgentRouteFromDb({
          db,
          source: inboxSource,
          chat: inboxChat,
        })
      : null;
    const routedAgent = sessionRoute
      ? (db.prepare("SELECT id FROM agents WHERE id = ? LIMIT 1").get(sessionRoute.agentId) as
          | { id: string }
          | undefined)
      : null;
    const shouldRouteToSessionAgent = Boolean(sessionRoute && routedAgent);
    if (sessionRoute && !routedAgent) {
      log.warn(
        { agentId: sessionRoute.agentId, channel: sessionRoute.channel, targetId: sessionRoute.targetId },
        "inbox session route ignored: mapped agent not found",
      );
    }
    if (!isDirective && !shouldRouteToSessionAgent) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 422,
          detail: "session_agent_not_configured",
        })
      )
        return;
      return res.status(422).json({
        error: "session_agent_not_configured",
        message: "non-directive inbox messages require a mapped agent on messenger session",
      });
    }

    if (!isDirective && shouldRouteToSessionAgent && sessionRoute && isSessionResetCommand(content)) {
      const cleared = db
        .prepare(
          `
          DELETE FROM messages
          WHERE
            (sender_type = 'ceo' AND receiver_type = 'agent' AND receiver_id = ?)
            OR (sender_type = 'agent' AND sender_id = ?)
        `,
        )
        .run(sessionRoute.agentId, sessionRoute.agentId);
      const resetState = resetDirectChatState(sessionRoute.agentId) as
        | { clearedPendingProjectBinding?: boolean }
        | undefined;
      const sessionKey = `${sessionRoute.channel}:${sessionRoute.sessionId}`;
      const ack = buildSessionResetAck(content);
      try {
        await sendMessengerSessionMessage(sessionKey, ack);
      } catch {
        await sendMessengerMessage({
          channel: sessionRoute.channel,
          targetId: sessionRoute.targetId,
          text: ack,
        }).catch(() => {
          // ignore acknowledgement send failures
        });
      }
      broadcast("messages_cleared", {
        scope: "agent",
        agent_id: sessionRoute.agentId,
        source: "messenger_session_reset",
      });
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "accepted",
          statusCode: 200,
          detail: `session_reset:deleted=${cleared.changes};pending_project_binding_cleared=${resetState?.clearedPendingProjectBinding === true}`,
        })
      )
        return;
      return res.json({
        ok: true,
        directive: false,
        routed: "session_reset",
        deleted: cleared.changes,
        session: {
          channel: sessionRoute.channel,
          session_id: sessionRoute.sessionId,
          target_id: sessionRoute.targetId,
        },
      });
    }

    const messageType = isDirective ? "directive" : "chat";
    let storedMessage: StoredMessage;
    let created: boolean;
    try {
      ({ message: storedMessage, created } = await insertMessageWithIdempotency({
        senderType: "ceo",
        senderId: null,
        receiverType: shouldRouteToSessionAgent ? "agent" : "all",
        receiverId: shouldRouteToSessionAgent && sessionRoute ? sessionRoute.agentId : null,
        content,
        messageType,
        idempotencyKey,
      }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        const conflictErr = err as { key: string };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/inbox",
            req,
            body,
            idempotencyKey,
            outcome: "idempotency_conflict",
            statusCode: 409,
            detail: "payload_mismatch",
          })
        )
          return;
        return res.status(409).json({ error: "idempotency_conflict", idempotency_key: conflictErr.key });
      }
      if (err instanceof StorageBusyError) {
        const busyErr = err as { operation: string; attempts: number };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/inbox",
            req,
            body,
            idempotencyKey,
            outcome: "storage_busy",
            statusCode: 503,
            detail: `operation=${busyErr.operation}, attempts=${busyErr.attempts}`,
          })
        )
          return;
        return res.status(503).json({ error: "storage_busy", retryable: true, operation: busyErr.operation });
      }
      throw err;
    }
    const msg = { ...storedMessage };

    if (!created) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "duplicate",
          statusCode: 200,
          messageId: msg.id,
          detail: "idempotent_replay",
        })
      )
        return;
      return res.json({
        ok: true,
        id: msg.id,
        directive: isDirective,
        duplicate: true,
        routed: shouldRouteToSessionAgent ? "agent" : "announcement",
      });
    }

    if (
      !(await recordAcceptedIngressAuditOrRollback(
        res,
        {
          endpoint: "/api/inbox",
          req,
          body,
          idempotencyKey,
          outcome: "accepted",
          statusCode: 200,
          detail: isDirective ? "created:directive" : "created:agent_session",
        },
        msg.id,
      ))
    )
      return;

    // Try phase approval replies first ("approve <phaseId>")
    if (!isDirective && shouldRouteToSessionAgent && sessionRoute && tryHandlePhaseApprovalReply) {
      const approvalResult = await tryHandlePhaseApprovalReply({
        text: content,
        source: inboxSource,
        chat: inboxChat,
        channel: sessionRoute.channel,
        targetId: sessionRoute.targetId,
      });
      if (approvalResult.handled) {
        broadcast("new_message", msg);
        return res.status(approvalResult.status).json({
          ok: approvalResult.status < 400,
          id: msg.id,
          directive: false,
          routed: "phase_approval",
          approval: approvalResult.payload,
          session: {
            channel: sessionRoute.channel,
            session_id: sessionRoute.sessionId,
            target_id: sessionRoute.targetId,
          },
        });
      }
    }

    if (!isDirective && shouldRouteToSessionAgent && sessionRoute && tryHandleInboxDecisionReply) {
      const decisionResult = await tryHandleInboxDecisionReply({
        text: content,
        body,
        source: inboxSource,
        chat: inboxChat,
        channel: sessionRoute.channel,
        targetId: sessionRoute.targetId,
      });
      if (decisionResult.handled) {
        broadcast("new_message", msg);
        return res.status(decisionResult.status).json({
          ok: decisionResult.status < 400,
          id: msg.id,
          directive: false,
          routed: "decision_reply",
          decision: decisionResult.payload,
          session: {
            channel: sessionRoute.channel,
            session_id: sessionRoute.sessionId,
            target_id: sessionRoute.targetId,
          },
        });
      }
    }

    if (!isDirective && shouldRouteToSessionAgent && sessionRoute) {
      broadcast("new_message", msg);
      const directReplyOptions: DelegationOptions = {
        projectId: inboxProjectId,
        projectPath: inboxProjectPath,
        projectContext: inboxProjectContext,
        messengerChannel: sessionRoute.channel,
        messengerTargetId: sessionRoute.targetId,
        messengerSessionKey: `${sessionRoute.channel}:${sessionRoute.sessionId}`,
      };
      scheduleAgentReply(sessionRoute.agentId, content, "chat", directReplyOptions);
      return res.json({
        ok: true,
        id: msg.id,
        directive: false,
        routed: "agent",
        agent_id: sessionRoute.agentId,
        session: {
          channel: sessionRoute.channel,
          session_id: sessionRoute.sessionId,
          target_id: sessionRoute.targetId,
        },
      });
    }

    // $ prefix only: announcement/directive flow
    // Broadcast
    broadcast("announcement", msg);

    // Team leaders respond
    scheduleAnnouncementReplies(content);
    const directivePolicy = isDirective ? analyzeDirectivePolicy(content) : null;
    const inboxExplicitSkip = body.skipPlannedMeeting === true;
    const shouldDelegateDirective =
      isDirective && directivePolicy ? shouldExecuteDirectiveDelegation(directivePolicy, inboxExplicitSkip) : false;
    const directiveDelegationOptions: DelegationOptions = {
      skipPlannedMeeting: inboxExplicitSkip || !!directivePolicy?.skipPlannedMeeting,
      skipPlanSubtasks: inboxExplicitSkip || !!directivePolicy?.skipPlanSubtasks,
      projectId: inboxProjectId,
      projectPath: inboxProjectPath,
      projectContext: inboxProjectContext,
      messengerChannel: directiveReplyRoute?.channel,
      messengerTargetId: directiveReplyRoute?.targetId,
      messengerSessionKey: directiveSessionRoute
        ? `${directiveSessionRoute.channel}:${directiveSessionRoute.sessionId}`
        : null,
    };
    const directiveLeaderScopeByDept = new Map<string, string[] | null>();
    const getDirectiveLeaderScope = (deptId: string): string[] | null => {
      if (!(shouldDelegateDirective || isDirective)) return null;
      const normalizedDeptId = normalizeTextField(deptId) ?? "planning";
      if (!directiveLeaderScopeByDept.has(normalizedDeptId)) {
        directiveLeaderScopeByDept.set(
          normalizedDeptId,
          resolveDirectiveLeaderCandidateScope(db as any, inboxProjectId ?? null, normalizedDeptId),
        );
      }
      return directiveLeaderScopeByDept.get(normalizedDeptId) ?? null;
    };

    if (shouldDelegateDirective) {
      // Auto-delegate to planning team leader
      const planningLeader = findDirectiveLeader(
        "planning",
        inboxProjectId ?? null,
        getDirectiveLeaderScope("planning"),
      );
      if (planningLeader) {
        const delegationDelay = 3000 + Math.random() * 2000;
        setTimeout(() => {
          handleTaskDelegation(planningLeader, content, "", directiveDelegationOptions);
        }, delegationDelay);
      }
    }

    // Handle @mentions
    const mentions = detectMentions(content);
    const shouldHandleMentions = !isDirective || shouldDelegateDirective;
    if (shouldHandleMentions && (mentions.deptIds.length > 0 || mentions.agentIds.length > 0)) {
      const mentionDelay = 5000 + Math.random() * 2000;
      setTimeout(() => {
        const processedDepts = new Set<string>(isDirective ? ["planning"] : []);

        for (const deptId of mentions.deptIds) {
          if (processedDepts.has(deptId)) continue;
          processedDepts.add(deptId);
          const leader = isDirective
            ? findDirectiveLeader(deptId, inboxProjectId ?? null, getDirectiveLeaderScope(deptId))
            : findTeamLeader(deptId);
          if (leader) {
            handleTaskDelegation(leader, content, "", isDirective ? directiveDelegationOptions : {});
          }
        }

        for (const agentId of mentions.agentIds) {
          const mentioned = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
          if (mentioned?.department_id && !processedDepts.has(mentioned.department_id)) {
            processedDepts.add(mentioned.department_id);
            const leader =
              isDirective && mentioned.department_id
                ? findDirectiveLeader(
                    mentioned.department_id,
                    inboxProjectId ?? null,
                    getDirectiveLeaderScope(mentioned.department_id),
                  )
                : findTeamLeader(mentioned.department_id);
            if (leader) {
              handleTaskDelegation(leader, content, "", isDirective ? directiveDelegationOptions : {});
            }
          }
        }
      }, mentionDelay);
    }

    res.json({ ok: true, id: msg.id, directive: isDirective, routed: "announcement" });
  });
}
