import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { registerAnnouncementRoutes } from "./messages/announcements-routes.ts";
import { registerChatMessageRoutes } from "./messages/chat-routes.ts";
import { registerDecisionInboxRoutes } from "./messages/decision-inbox-routes.ts";
import { registerDirectiveAndInboxRoutes } from "./messages/directives-inbox-routes.ts";
import { createPhaseApprovalBridge } from "./messages/phase-approval-bridge.ts";

export function registerOpsMessageRoutes(ctx: RuntimeContext): Record<string, never> {
  // Default policy: enforce latest AGENTS rules.
  // Set ENFORCE_DIRECTIVE_PROJECT_BINDING=0 only for temporary local debugging.
  const ENFORCE_DIRECTIVE_PROJECT_BINDING = String(process.env.ENFORCE_DIRECTIVE_PROJECT_BINDING ?? "1").trim() !== "0";
  const __ctx: RuntimeContext = ctx;
  const { app, db, broadcast } = __ctx;

  const IdempotencyConflictError = __ctx.IdempotencyConflictError;
  const StorageBusyError = __ctx.StorageBusyError;
  const firstQueryValue = __ctx.firstQueryValue;

  const resolveMessageIdempotencyKey = __ctx.resolveMessageIdempotencyKey;
  const recordMessageIngressAuditOr503 = __ctx.recordMessageIngressAuditOr503;
  const insertMessageWithIdempotency = __ctx.insertMessageWithIdempotency;
  const recordAcceptedIngressAuditOrRollback = __ctx.recordAcceptedIngressAuditOrRollback;

  const normalizeTextField = __ctx.normalizeTextField;
  const handleReportRequest = __ctx.handleReportRequest;
  const scheduleAgentReply = __ctx.scheduleAgentReply;
  const detectMentions = __ctx.detectMentions;
  const resolveLang = __ctx.resolveLang;
  const handleMentionDelegation = __ctx.handleMentionDelegation;

  const scheduleAnnouncementReplies = __ctx.scheduleAnnouncementReplies;
  const analyzeDirectivePolicy = __ctx.analyzeDirectivePolicy;
  const shouldExecuteDirectiveDelegation = __ctx.shouldExecuteDirectiveDelegation;
  const findTeamLeader = __ctx.findTeamLeader;
  const handleTaskDelegation = __ctx.handleTaskDelegation;
  const resetDirectChatState = __ctx.resetDirectChatState;

  const decisionInboxBridge = registerDecisionInboxRoutes(__ctx);
  const phaseApprovalBridge = createPhaseApprovalBridge({ db });

  registerChatMessageRoutes(
    { app, db, broadcast },
    {
      IdempotencyConflictError,
      StorageBusyError,
      firstQueryValue,
      resolveMessageIdempotencyKey,
      recordMessageIngressAuditOr503,
      insertMessageWithIdempotency,
      recordAcceptedIngressAuditOrRollback,
      normalizeTextField,
      handleReportRequest,
      scheduleAgentReply,
      detectMentions,
      resolveLang,
      handleMentionDelegation,
    },
  );

  registerAnnouncementRoutes(
    { app, db, broadcast },
    {
      IdempotencyConflictError,
      StorageBusyError,
      resolveMessageIdempotencyKey,
      recordMessageIngressAuditOr503,
      insertMessageWithIdempotency,
      recordAcceptedIngressAuditOrRollback,
      scheduleAnnouncementReplies,
      detectMentions,
      findTeamLeader,
      handleTaskDelegation,
    },
  );

  registerDirectiveAndInboxRoutes(
    { app, db, broadcast },
    {
      IdempotencyConflictError,
      StorageBusyError,
      enforceDirectiveProjectBinding: ENFORCE_DIRECTIVE_PROJECT_BINDING,
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
      tryHandleInboxDecisionReply: decisionInboxBridge.tryHandleInboxDecisionReply,
      tryHandlePhaseApprovalReply: phaseApprovalBridge.tryHandlePhaseApprovalReply,
    },
  );

  return {};
}
