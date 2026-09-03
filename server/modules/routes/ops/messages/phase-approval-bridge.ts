import { sendMessengerMessage, type MessengerChannel } from "../../../../gateway/client.ts";
import { isMessengerChannel } from "../../../../messenger/channels.ts";
import { resolveSourceChatRoute } from "../../../../messenger/session-agent-routing.ts";
import { logger } from "../../../../observability/logger.ts";
import { PORT, SESSION_AUTH_TOKEN } from "../../../../config/runtime.ts";

const log = logger.child({ module: "phase-approval-bridge" });

/**
 * Regex to match "approve <phaseId>" or "approve <taskId>/<phaseId>" replies.
 * The optional <taskId>/ prefix disambiguates when multiple tasks await the same phase.
 * Supports: "approve planning", "approve task-123/planning", "genehmigen review"
 */
const APPROVE_PHASE_RE = /^(?:approve|genehmigen|승인|承認|批准)\s+(?:([a-z0-9_-]+)\/)?([a-z][a-z0-9_]*)\s*$/i;

export type PhaseApprovalBridgeInput = {
  text: string;
  source?: string | null;
  chat?: string | null;
  channel?: MessengerChannel;
  targetId?: string | null;
};

export type PhaseApprovalBridgeResult = {
  handled: boolean;
  status: number;
  payload: Record<string, unknown>;
};

type PhaseApprovalBridgeDeps = {
  db: {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
  };
};

export function createPhaseApprovalBridge(deps: PhaseApprovalBridgeDeps) {
  const { db } = deps;

  async function tryHandlePhaseApprovalReply(input: PhaseApprovalBridgeInput): Promise<PhaseApprovalBridgeResult> {
    const text = String(input.text || "").trim();
    if (!text) return { handled: false, status: 200, payload: {} };

    const match = text.match(APPROVE_PHASE_RE);
    if (!match) return { handled: false, status: 200, payload: {} };

    const explicitTaskId = match[1] ?? null;
    const phaseId = match[2];

    // Resolve messenger route for acknowledgment messages
    const route =
      isMessengerChannel(input.channel) && input.targetId
        ? { channel: input.channel, targetId: input.targetId }
        : resolveSourceChatRoute({ source: input.source ?? null, chat: input.chat ?? null });

    // ── Resolve task ID ──────────────────────────────────────────────────────
    let taskId: string;

    if (explicitTaskId) {
      // Scoped form: approve <taskId>/<phaseId>
      const subtask = db
        .prepare("SELECT id FROM subtasks WHERE task_id = ? AND title = ? AND status = 'awaiting_approval' LIMIT 1")
        .get(explicitTaskId, `[pipeline:${phaseId}]`) as { id: string } | undefined;

      if (!subtask) {
        if (route) {
          await sendMessengerMessage({
            channel: route.channel,
            targetId: route.targetId,
            text: `\u26A0\uFE0F Phase "${phaseId}" in task "${explicitTaskId}" is not currently awaiting approval.`,
          }).catch(() => {});
        }
        return { handled: true, status: 404, payload: { error: "phase_not_awaiting_approval" } };
      }
      taskId = explicitTaskId;
    } else {
      // Unscoped form: approve <phaseId> — must resolve to exactly one task
      const candidates = db
        .prepare("SELECT task_id FROM subtasks WHERE title = ? AND status = 'awaiting_approval'")
        .all(`[pipeline:${phaseId}]`) as Array<{ task_id: string }>;

      if (candidates.length === 0) {
        if (route) {
          await sendMessengerMessage({
            channel: route.channel,
            targetId: route.targetId,
            text: `\u26A0\uFE0F No phase "${phaseId}" is currently awaiting approval.`,
          }).catch(() => {});
        }
        return { handled: true, status: 404, payload: { error: "phase_not_awaiting_approval" } };
      }

      if (candidates.length > 1) {
        const taskIds = candidates.map((c) => c.task_id).join(", ");
        if (route) {
          await sendMessengerMessage({
            channel: route.channel,
            targetId: route.targetId,
            text: `\u26A0\uFE0F Multiple tasks are waiting on phase "${phaseId}" (${taskIds}).\nReply with "approve <taskId>/${phaseId}" to specify which one.`,
          }).catch(() => {});
        }
        return {
          handled: true,
          status: 409,
          payload: { error: "ambiguous_phase_approval", taskIds: candidates.map((c) => c.task_id) },
        };
      }

      taskId = candidates[0].task_id;
    }

    // ── Delegate to the real approval HTTP endpoint ──────────────────────────
    // This ensures graph advancement, agent release, re-run, and task-state
    // updates all happen identically to a UI approval click.
    let approved = false;
    let httpStatus = 500;
    try {
      const resp = await fetch(
        `http://127.0.0.1:${PORT}/api/core/tasks/${encodeURIComponent(taskId)}/phases/${encodeURIComponent(phaseId)}/approve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
          },
        },
      );
      httpStatus = resp.status;
      approved = resp.ok;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ taskId, phaseId, err: msg }, "phase approval HTTP delegate failed");
    }

    if (!approved) {
      if (route) {
        await sendMessengerMessage({
          channel: route.channel,
          targetId: route.targetId,
          text: `\u26A0\uFE0F Could not approve phase "${phaseId}" (HTTP ${httpStatus}).`,
        }).catch(() => {});
      }
      return { handled: true, status: httpStatus, payload: { error: "approval_failed" } };
    }

    log.info({ taskId, phaseId }, "phase approved via messenger reply");

    if (route) {
      const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string } | undefined;
      await sendMessengerMessage({
        channel: route.channel,
        targetId: route.targetId,
        text: `\u2705 Phase "${phaseId}" approved for "${task?.title ?? taskId}".`,
      }).catch(() => {});
    }

    return {
      handled: true,
      status: 200,
      payload: { task_id: taskId, phase_id: phaseId, approved: true },
    };
  }

  return { tryHandlePhaseApprovalReply };
}
