import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { BaseRuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow, StoredMessage, DelegationOptions } from "../../shared/types.ts";

interface AnnouncementRouteCtx {
  app: Express;
  db: DatabaseSync;
  broadcast(type: string, payload: unknown): void;
}

type AnnouncementRouteDeps = {
  IdempotencyConflictError: BaseRuntimeContext["IdempotencyConflictError"];
  StorageBusyError: BaseRuntimeContext["StorageBusyError"];
  resolveMessageIdempotencyKey: BaseRuntimeContext["resolveMessageIdempotencyKey"];
  recordMessageIngressAuditOr503: BaseRuntimeContext["recordMessageIngressAuditOr503"];
  insertMessageWithIdempotency: BaseRuntimeContext["insertMessageWithIdempotency"];
  recordAcceptedIngressAuditOrRollback: BaseRuntimeContext["recordAcceptedIngressAuditOrRollback"];
  scheduleAnnouncementReplies(announcement: string): void;
  detectMentions(message: string): { deptIds: string[]; agentIds: string[] };
  findTeamLeader(deptId: string | null, candidateAgentIds?: string[] | null): AgentRow | null;
  handleTaskDelegation(teamLeader: AgentRow, ceoMessage: string, ceoMsgId: string, options?: DelegationOptions): void;
};

export function registerAnnouncementRoutes(ctx: AnnouncementRouteCtx, deps: AnnouncementRouteDeps): void {
  const { app, db, broadcast } = ctx;
  const {
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
  } = deps;

  app.post("/api/announcements", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = resolveMessageIdempotencyKey(req, body, "api.announcements");
    const content = body.content;
    if (!content || typeof content !== "string") {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/announcements",
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

    let storedMessage: StoredMessage;
    let created: boolean;
    try {
      ({ message: storedMessage, created } = await insertMessageWithIdempotency({
        senderType: "ceo",
        senderId: null,
        receiverType: "all",
        receiverId: null,
        content,
        messageType: "announcement",
        idempotencyKey,
      }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        const conflictErr = err as { key: string };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/announcements",
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
            endpoint: "/api/announcements",
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
          endpoint: "/api/announcements",
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
          endpoint: "/api/announcements",
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
    broadcast("announcement", msg);

    // Team leaders respond to announcements with staggered delays
    scheduleAnnouncementReplies(content);

    // Check for @mentions in announcements — trigger delegation
    const mentions = detectMentions(content);
    if (mentions.deptIds.length > 0 || mentions.agentIds.length > 0) {
      const mentionDelay = 5000 + Math.random() * 2000;
      setTimeout(() => {
        const processedDepts = new Set<string>();

        for (const deptId of mentions.deptIds) {
          if (processedDepts.has(deptId)) continue;
          processedDepts.add(deptId);
          const leader = findTeamLeader(deptId);
          if (leader) {
            handleTaskDelegation(leader, content, "");
          }
        }

        for (const agentId of mentions.agentIds) {
          const mentioned = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
          if (mentioned?.department_id && !processedDepts.has(mentioned.department_id)) {
            processedDepts.add(mentioned.department_id);
            const leader = findTeamLeader(mentioned.department_id);
            if (leader) {
              handleTaskDelegation(leader, content, "");
            }
          }
        }
      }, mentionDelay);
    }

    res.json({ ok: true, message: msg });
  });
}
