import type { SQLInputValue, DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import type { BaseRuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow, StoredMessage, DelegationOptions } from "../../shared/types.ts";
import type { Lang } from "../../../../types/lang.ts";

interface ChatMessageRouteCtx {
  app: Express;
  db: DatabaseSync;
  broadcast(type: string, payload: unknown): void;
}

type ChatMessageRouteDeps = {
  IdempotencyConflictError: BaseRuntimeContext["IdempotencyConflictError"];
  StorageBusyError: BaseRuntimeContext["StorageBusyError"];
  firstQueryValue(value: unknown): string | undefined;
  resolveMessageIdempotencyKey: BaseRuntimeContext["resolveMessageIdempotencyKey"];
  recordMessageIngressAuditOr503: BaseRuntimeContext["recordMessageIngressAuditOr503"];
  insertMessageWithIdempotency: BaseRuntimeContext["insertMessageWithIdempotency"];
  recordAcceptedIngressAuditOrRollback: BaseRuntimeContext["recordAcceptedIngressAuditOrRollback"];
  normalizeTextField(value: unknown): string | null;
  handleReportRequest(targetAgentId: string, ceoMessage: string): boolean;
  scheduleAgentReply(agentId: string, ceoMessage: string, messageType: string, options?: DelegationOptions): void;
  detectMentions(message: string): { deptIds: string[]; agentIds: string[] };
  resolveLang(text?: string, fallback?: Lang): Lang;
  handleMentionDelegation(originLeader: AgentRow, targetDeptId: string, ceoMessage: string, lang: Lang): void;
};

export function registerChatMessageRoutes(ctx: ChatMessageRouteCtx, deps: ChatMessageRouteDeps): void {
  const { app, db, broadcast } = ctx;
  const {
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
  } = deps;

  app.get("/api/messages", (req, res) => {
    const receiverType = firstQueryValue(req.query.receiver_type);
    const receiverId = firstQueryValue(req.query.receiver_id);
    const limitRaw = firstQueryValue(req.query.limit);
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 500);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (receiverType && receiverId) {
      // Conversation with a specific agent: show messages TO and FROM that agent
      conditions.push(
        "((receiver_type = ? AND receiver_id = ?) OR (sender_type = 'agent' AND sender_id = ?) OR receiver_type = 'all')",
      );
      params.push(receiverType, receiverId, receiverId);
    } else if (receiverType) {
      conditions.push("receiver_type = ?");
      params.push(receiverType);
    } else if (receiverId) {
      conditions.push("(receiver_id = ? OR receiver_type = 'all')");
      params.push(receiverId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const messages = db
      .prepare(
        `
    SELECT m.*,
      a.name AS sender_name,
      a.avatar_emoji AS sender_avatar
    FROM messages m
    LEFT JOIN agents a ON m.sender_type = 'agent' AND m.sender_id = a.id
    ${where}
    ORDER BY m.created_at DESC
    LIMIT ?
  `,
      )
      .all(...(params as SQLInputValue[]));

    res.json({ messages: messages.reverse() }); // return in chronological order
  });

  app.post("/api/messages", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = resolveMessageIdempotencyKey(req, body, "api.messages");
    const content = body.content;
    if (!content || typeof content !== "string") {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/messages",
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

    const senderType = typeof body.sender_type === "string" ? body.sender_type : "ceo";
    const senderId = typeof body.sender_id === "string" ? body.sender_id : null;
    const receiverType = typeof body.receiver_type === "string" ? body.receiver_type : "all";
    const receiverId = typeof body.receiver_id === "string" ? body.receiver_id : null;
    const messageType = typeof body.message_type === "string" ? body.message_type : "chat";
    const taskId = typeof body.task_id === "string" ? body.task_id : null;
    const projectId = normalizeTextField(body.project_id);
    const projectPath = normalizeTextField(body.project_path);
    const projectContext = normalizeTextField(body.project_context);

    let storedMessage: StoredMessage;
    let created: boolean;
    try {
      ({ message: storedMessage, created } = await insertMessageWithIdempotency({
        senderType,
        senderId,
        receiverType,
        receiverId,
        content,
        messageType,
        taskId,
        idempotencyKey,
      }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        const conflictErr = err as { key: string };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/messages",
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
            endpoint: "/api/messages",
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
          endpoint: "/api/messages",
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
          endpoint: "/api/messages",
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
    broadcast("new_message", msg);

    // Schedule agent auto-reply when CEO messages an agent
    if (senderType === "ceo" && receiverType === "agent" && receiverId) {
      if (messageType === "report") {
        const handled = handleReportRequest(receiverId, content);
        if (!handled) {
          scheduleAgentReply(receiverId, content, messageType, {
            projectId,
            projectPath,
            projectContext,
          });
        }
        return res.json({ ok: true, message: msg });
      }

      scheduleAgentReply(receiverId, content, messageType, {
        projectId,
        projectPath,
        projectContext,
      });

      // Check for @mentions to other departments/agents
      const mentions = detectMentions(content);
      if (mentions.deptIds.length > 0 || mentions.agentIds.length > 0) {
        const senderAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(receiverId) as AgentRow | undefined;
        if (senderAgent) {
          const lang = resolveLang(content);
          const mentionDelay = 4000 + Math.random() * 2000; // After the main delegation starts
          setTimeout(() => {
            // Handle department mentions
            for (const deptId of mentions.deptIds) {
              if (deptId === senderAgent.department_id) continue; // Skip own department
              handleMentionDelegation(senderAgent, deptId, content, lang);
            }
            // Handle agent mentions — find their department and delegate there
            for (const agentId of mentions.agentIds) {
              const mentioned = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
              if (mentioned && mentioned.department_id && mentioned.department_id !== senderAgent.department_id) {
                if (!mentions.deptIds.includes(mentioned.department_id)) {
                  handleMentionDelegation(senderAgent, mentioned.department_id, content, lang);
                }
              }
            }
          }, mentionDelay);
        }
      }
    }

    res.json({ ok: true, message: msg });
  });

  // Delete conversation messages
  app.delete("/api/messages", (req, res) => {
    const agentId = firstQueryValue(req.query.agent_id);
    const scope = firstQueryValue(req.query.scope) || "conversation"; // "conversation" or "all"

    if (scope === "all") {
      // Delete all messages (announcements + conversations)
      const result = db.prepare("DELETE FROM messages").run();
      broadcast("messages_cleared", { scope: "all" });
      return res.json({ ok: true, deleted: result.changes });
    }

    if (agentId) {
      // Delete messages for a specific agent conversation + announcements shown in that chat
      const result = db
        .prepare(
          `DELETE FROM messages WHERE
        (sender_type = 'ceo' AND receiver_type = 'agent' AND receiver_id = ?)
        OR (sender_type = 'agent' AND sender_id = ?)
        OR receiver_type = 'all'
        OR message_type = 'announcement'`,
        )
        .run(agentId, agentId);
      broadcast("messages_cleared", { scope: "agent", agent_id: agentId });
      return res.json({ ok: true, deleted: result.changes });
    }

    // Delete only announcements/broadcasts
    const result = db
      .prepare("DELETE FROM messages WHERE receiver_type = 'all' OR message_type = 'announcement'")
      .run();
    broadcast("messages_cleared", { scope: "announcements" });
    res.json({ ok: true, deleted: result.changes });
  });
}
