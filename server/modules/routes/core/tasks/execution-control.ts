import type { Response } from "express";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "../../shared/types.ts";
import { createHash } from "node:crypto";
import {
  buildTaskInterruptControlToken,
  hasValidCsrfToken,
  hasValidTaskInterruptControlToken,
  shouldRequireCsrf,
} from "../../../../security/auth.ts";
import {
  hashInterruptPrompt,
  queueInterruptPrompt,
  sanitizeInterruptPrompt,
} from "../../../workflow/core/interrupt-injection-tools.ts";

export type TaskExecutionControlRouteDeps = Pick<
  RuntimeContext,
  | "app"
  | "db"
  | "nowMs"
  | "resolveLang"
  | "stopProgressTimer"
  | "activeProcesses"
  | "rollbackTaskWorktree"
  | "clearTaskWorkflowState"
  | "endTaskExecutionSession"
  | "broadcast"
  | "notifyCeo"
  | "pickL"
  | "l"
  | "stopRequestedTasks"
  | "stopRequestModeByTask"
  | "interruptPidTree"
  | "killPidTree"
  | "appendTaskLog"
  | "delegatedTaskToSubtask"
  | "subtaskDelegationCallbacks"
  | "crossDeptNextCallbacks"
  | "subtaskDelegationDispatchInFlight"
  | "subtaskDelegationCompletionNoticeSent"
  | "taskExecutionSessions"
  | "ensureTaskExecutionSession"
  | "getDeptName"
  | "isTaskWorkflowInterrupted"
  | "startTaskExecutionForAgent"
  | "randomDelay"
>;

export function registerTaskExecutionControlRoutes(deps: TaskExecutionControlRouteDeps): void {
  const {
    app,
    db,
    nowMs,
    resolveLang,
    stopProgressTimer,
    activeProcesses,
    rollbackTaskWorktree,
    clearTaskWorkflowState,
    endTaskExecutionSession,
    broadcast,
    notifyCeo,
    pickL,
    l,
    stopRequestedTasks,
    stopRequestModeByTask,
    interruptPidTree,
    killPidTree,
    appendTaskLog,
    delegatedTaskToSubtask,
    subtaskDelegationCallbacks,
    crossDeptNextCallbacks,
    subtaskDelegationDispatchInFlight,
    subtaskDelegationCompletionNoticeSent,
    taskExecutionSessions,
    ensureTaskExecutionSession,
    getDeptName,
    isTaskWorkflowInterrupted,
    startTaskExecutionForAgent,
    randomDelay,
  } = deps;

  function requireCsrfGuard(
    req: { method?: string; header(name: string): string | undefined },
    res: Response,
  ): boolean {
    if (!shouldRequireCsrf(req as any)) return true;
    if (hasValidCsrfToken(req as any)) return true;
    res.status(403).json({ error: "csrf_token_invalid" });
    return false;
  }

  function readInterruptSessionProof(req: {
    body?: Record<string, unknown>;
    header(name: string): string | undefined;
  }): { sessionId: string; controlToken: string } {
    const body = req.body ?? {};
    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const fromHeader = req.header("x-task-interrupt-token");
    const fromBody = typeof body.interrupt_token === "string" ? body.interrupt_token : "";
    const controlToken = (fromHeader ?? fromBody ?? "").trim();
    return { sessionId, controlToken };
  }

  function validateInterruptProof(
    taskId: string,
    sessionId: string,
    controlToken: string,
  ): { ok: true; session: any } | { ok: false; status: number; error: string } {
    const activeSession = taskExecutionSessions.get(taskId);
    if (!activeSession?.sessionId) return { ok: false, status: 409, error: "task_session_missing" };
    if (activeSession.sessionId !== sessionId) return { ok: false, status: 409, error: "task_session_mismatch" };
    if (!hasValidTaskInterruptControlToken(taskId, sessionId, controlToken)) {
      return { ok: false, status: 403, error: "task_interrupt_token_invalid" };
    }
    return { ok: true, session: activeSession };
  }

  function buildInterruptProofPayload(
    taskId: string,
    fallbackAgentId?: string | null,
  ): {
    session_id: string;
    control_token: string;
    requires_csrf: boolean;
  } | null {
    let activeSession = taskExecutionSessions.get(taskId);
    if (!activeSession?.sessionId && fallbackAgentId) {
      const agentRow = db.prepare("SELECT cli_provider FROM agents WHERE id = ?").get(fallbackAgentId) as
        | { cli_provider: string | null }
        | undefined;
      const provider = (agentRow?.cli_provider || "claude").trim() || "claude";
      activeSession = ensureTaskExecutionSession(taskId, fallbackAgentId, provider);
    }
    if (!activeSession?.sessionId) return null;
    return {
      session_id: activeSession.sessionId,
      control_token: buildTaskInterruptControlToken(taskId, activeSession.sessionId),
      requires_csrf: true,
    };
  }

  app.post("/api/tasks/:id/inject", (req, res) => {
    const id = String(req.params.id);
    if (!requireCsrfGuard(req as any, res)) return;

    const task = db.prepare("SELECT id, title, status FROM tasks WHERE id = ?").get(id) as
      | { id: string; title: string; status: string }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status !== "pending") {
      return res
        .status(400)
        .json({ error: "invalid_status", message: `Cannot inject prompt while status is '${task.status}'` });
    }

    const { sessionId, controlToken } = readInterruptSessionProof(req as any);
    if (!sessionId || !controlToken) {
      return res.status(400).json({ error: "session_proof_required" });
    }

    const proof = validateInterruptProof(id, sessionId, controlToken);
    if (!proof.ok) {
      return res.status(proof.status).json({ error: proof.error });
    }

    const sanitized = sanitizeInterruptPrompt((req.body ?? {})["prompt"]);
    if (!sanitized.ok) {
      return res.status(400).json({ error: sanitized.error });
    }

    const promptHash = hashInterruptPrompt(sanitized.value);
    const controlTokenHash = createHash("sha256").update(controlToken, "utf8").digest("hex");
    queueInterruptPrompt(db as any, {
      taskId: id,
      sessionId,
      promptText: sanitized.value,
      promptHash,
      actorTokenHash: controlTokenHash,
      now: nowMs(),
    });

    const pendingRow = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM task_interrupt_injections WHERE task_id = ? AND session_id = ? AND consumed_at IS NULL",
      )
      .get(id, sessionId) as { cnt: number } | undefined;
    const pendingCount = Math.max(0, Number(pendingRow?.cnt ?? 0));

    appendTaskLog(
      id,
      "system",
      `INJECT queued (session=${sessionId}, sha256=${promptHash.slice(0, 12)}, chars=${sanitized.value.length}, pending=${pendingCount})`,
    );
    broadcast("task_interrupt", {
      task_id: id,
      action: "inject",
      session_id: sessionId,
      prompt_hash: promptHash.slice(0, 16),
      pending_count: pendingCount,
      ts: nowMs(),
    });

    return res.json({
      ok: true,
      queued: true,
      session_id: sessionId,
      prompt_hash: promptHash,
      pending_count: pendingCount,
    });
  });

  app.post("/api/tasks/:id/stop", (req, res) => {
    const id = String(req.params.id);
    if (!requireCsrfGuard(req as any, res)) return;

    const mode = String(req.body?.mode ?? req.query.mode ?? "cancel");
    const targetStatus = mode === "pause" ? "pending" : "cancelled";
    if (mode === "pause") {
      const { sessionId, controlToken } = readInterruptSessionProof(req as any);
      const hasAnyProof = Boolean(sessionId || controlToken);
      if (hasAnyProof) {
        if (!sessionId || !controlToken) {
          return res.status(400).json({ error: "session_proof_required" });
        }
        const proof = validateInterruptProof(id, sessionId, controlToken);
        if (!proof.ok) {
          return res.status(proof.status).json({ error: proof.error });
        }
      }
    }

    const cancelDelegatedWorkflowState = () => {
      const linkedSubtasks = db
        .prepare("SELECT id, task_id FROM subtasks WHERE delegated_task_id = ?")
        .all(id) as Array<{ id: string; task_id: string }>;
      if (linkedSubtasks.length === 0) return;

      const blockedReason = "Delegated task cancelled";
      const touchedParentTaskIds = new Set<string>();
      for (const linked of linkedSubtasks) {
        if (linked.task_id) touchedParentTaskIds.add(linked.task_id);
        const result = db
          .prepare(
            "UPDATE subtasks SET status = 'blocked', blocked_reason = ?, completed_at = NULL WHERE id = ? AND status NOT IN ('done', 'blocked', 'cancelled')",
          )
          .run(blockedReason, linked.id);
        if (result.changes > 0) {
          broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(linked.id));
        }
      }

      delegatedTaskToSubtask.delete(id);
      const pendingCallback = subtaskDelegationCallbacks.get(id);
      subtaskDelegationCallbacks.delete(id);
      if (pendingCallback) {
        try {
          pendingCallback();
        } catch {
          // Continue queue cleanup even if callback fails
        }
      }
      crossDeptNextCallbacks.delete(id);

      for (const parentTaskId of touchedParentTaskIds) {
        const remainingDelegated = db
          .prepare(
            `
        SELECT COUNT(DISTINCT s.delegated_task_id) AS cnt
        FROM subtasks s
        JOIN tasks dt ON dt.id = s.delegated_task_id
        WHERE s.task_id = ?
          AND s.delegated_task_id IS NOT NULL
          AND s.delegated_task_id != ''
          AND s.delegated_task_id != ?
          AND dt.status IN ('planned', 'in_progress', 'review', 'pending')
      `,
          )
          .get(parentTaskId, id) as { cnt: number } | undefined;

        if ((remainingDelegated?.cnt ?? 0) === 0) {
          subtaskDelegationDispatchInFlight.delete(parentTaskId);
          subtaskDelegationCompletionNoticeSent.delete(parentTaskId);
        } else {
          appendTaskLog(
            parentTaskId,
            "system",
            `Delegation queue state preserved (other delegated tasks still active: ${remainingDelegated?.cnt ?? 0})`,
          );
        }
        appendTaskLog(parentTaskId, "system", `Delegation queue stopped (child task cancelled: ${id.slice(0, 8)})`);
      }
    };

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: string;
          title: string;
          status: string;
          assigned_agent_id: string | null;
          department_id: string | null;
        }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const lang = resolveLang(task.title);

    stopProgressTimer(id);

    const activeChild = activeProcesses.get(id);
    if (!activeChild?.pid) {
      db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(targetStatus, nowMs(), id);
      if (targetStatus !== "pending") {
        cancelDelegatedWorkflowState();
        clearTaskWorkflowState(id);
        endTaskExecutionSession(id, `stop_${targetStatus}`);
      }
      const shouldRollback = targetStatus !== "pending";
      const rolledBack = shouldRollback ? rollbackTaskWorktree(id, `stop_${targetStatus}_no_active_process`) : false;
      if (task.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
      }
      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      broadcast("task_update", updatedTask);
      const statusChanged = task.status !== targetStatus;
      if (targetStatus === "pending" && statusChanged) {
        notifyCeo(
          pickL(
            l(
              [
                `'${task.title}' 작업이 보류 상태로 전환되었습니다. 세션은 유지되며 재개 시 이어서 진행됩니다.${rolledBack ? " 코드 변경분은 git rollback 처리되었습니다." : ""}`,
              ],
              [
                `'${task.title}' was moved to pending. The session is preserved and will continue on resume.${rolledBack ? " Code changes were rolled back via git." : ""}`,
              ],
              [
                `'${task.title}' は保留状態に変更されました。セッションは維持され、再開時に継続します。${rolledBack ? " コード変更は git でロールバックされました。" : ""}`,
              ],
              [
                `'${task.title}' 已转为待处理状态。会话会被保留，恢复后将继续执行。${rolledBack ? " 代码变更已通过 git 回滚。" : ""}`,
              ],
            ),
            lang,
          ),
          id,
        );
      } else if (targetStatus !== "pending") {
        notifyCeo(
          pickL(
            l(
              [
                `'${task.title}' 작업이 취소되었습니다.${rolledBack ? " 코드 변경분은 git rollback 처리되었습니다." : ""}`,
              ],
              [`'${task.title}' was cancelled.${rolledBack ? " Code changes were rolled back via git." : ""}`],
              [
                `'${task.title}' はキャンセルされました。${rolledBack ? " コード変更は git でロールバックされました。" : ""}`,
              ],
              [`'${task.title}' 已取消。${rolledBack ? " 代码变更已通过 git 回滚。" : ""}`],
            ),
            lang,
          ),
          id,
        );
      }
      return res.json({
        ok: true,
        stopped: false,
        status: targetStatus,
        rolled_back: rolledBack,
        message: "No active process found.",
        interrupt: targetStatus === "pending" ? buildInterruptProofPayload(id, task.assigned_agent_id) : null,
      });
    }

    stopRequestedTasks.add(id);
    stopRequestModeByTask.set(id, targetStatus === "pending" ? "pause" : "cancel");
    if (targetStatus === "pending") {
      if (activeChild.pid < 0) {
        activeChild.kill();
      } else {
        interruptPidTree(activeChild.pid);
      }
    } else {
      if (activeChild.pid < 0) {
        activeChild.kill();
      } else {
        killPidTree(activeChild.pid);
      }
    }

    const actionLabel = targetStatus === "pending" ? "PAUSE_BREAK" : "STOP";
    appendTaskLog(
      id,
      "system",
      targetStatus === "pending"
        ? `${actionLabel} sent to pid ${activeChild.pid} (graceful interrupt, session_kept=true)`
        : `${actionLabel} sent to pid ${activeChild.pid}`,
    );

    const shouldRollback = targetStatus !== "pending";
    const rolledBack = shouldRollback ? rollbackTaskWorktree(id, `stop_${targetStatus}`) : false;

    const t = nowMs();
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(targetStatus, t, id);
    if (targetStatus !== "pending") {
      cancelDelegatedWorkflowState();
      clearTaskWorkflowState(id);
      endTaskExecutionSession(id, `stop_${targetStatus}`);
    }

    if (task.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(task.assigned_agent_id);
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
      broadcast("agent_status", updatedAgent);
    }

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    broadcast("task_update", updatedTask);

    if (targetStatus === "pending") {
      notifyCeo(
        pickL(
          l(
            [
              `'${task.title}' 작업이 보류 상태로 전환되었습니다. 인터럽트(SIGINT)로 브레이크를 걸었고 세션은 유지됩니다.${rolledBack ? " 코드 변경분은 git rollback 처리되었습니다." : ""}`,
            ],
            [
              `'${task.title}' was moved to pending. A graceful interrupt (SIGINT) was sent and the session is preserved.${rolledBack ? " Code changes were rolled back via git." : ""}`,
            ],
            [
              `'${task.title}' は保留状態に変更されました。SIGINT による中断を送り、セッションは維持されます。${rolledBack ? " コード変更は git でロールバックされました。" : ""}`,
            ],
            [
              `'${task.title}' 已转为待处理状态。已发送 SIGINT 中断，且会话将被保留。${rolledBack ? " 代码变更已通过 git 回滚。" : ""}`,
            ],
          ),
          lang,
        ),
        id,
      );
    } else {
      notifyCeo(
        pickL(
          l(
            [
              `'${task.title}' 작업이 취소되었습니다.${rolledBack ? " 코드 변경분은 git rollback 처리되었습니다." : ""}`,
            ],
            [`'${task.title}' was cancelled.${rolledBack ? " Code changes were rolled back via git." : ""}`],
            [
              `'${task.title}' はキャンセルされました。${rolledBack ? " コード変更は git でロールバックされました。" : ""}`,
            ],
            [`'${task.title}' 已取消。${rolledBack ? " 代码变更已通过 git 回滚。" : ""}`],
          ),
          lang,
        ),
        id,
      );
    }

    res.json({
      ok: true,
      stopped: true,
      status: targetStatus,
      pid: activeChild.pid,
      rolled_back: rolledBack,
      interrupt: targetStatus === "pending" ? buildInterruptProofPayload(id, task.assigned_agent_id) : null,
    });
  });

  app.post("/api/tasks/:id/resume", (req, res) => {
    const id = String(req.params.id);
    if (!requireCsrfGuard(req as any, res)) return;

    const { sessionId, controlToken } = readInterruptSessionProof(req as any);
    const hasAnyProof = Boolean(sessionId || controlToken);
    if (hasAnyProof) {
      if (!sessionId || !controlToken) {
        return res.status(400).json({ error: "session_proof_required" });
      }
      const proof = validateInterruptProof(id, sessionId, controlToken);
      if (!proof.ok) {
        return res.status(proof.status).json({ error: proof.error });
      }
    }

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: string;
          title: string;
          status: string;
          assigned_agent_id: string | null;
        }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const lang = resolveLang(task.title);
    if (activeProcesses.has(id)) {
      return res.status(409).json({
        error: "already_running",
        message: "Task process is already active.",
      });
    }

    if (task.status !== "pending" && task.status !== "cancelled") {
      return res.status(400).json({ error: "invalid_status", message: `Cannot resume from '${task.status}'` });
    }

    const wasPaused = task.status === "pending";
    const targetStatus = task.assigned_agent_id ? "planned" : "inbox";
    const t = nowMs();
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(targetStatus, t, id);

    appendTaskLog(id, "system", `RESUME: ${task.status} → ${targetStatus}`);

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    broadcast("task_update", updatedTask);

    let autoResumed = false;
    const existingSession = taskExecutionSessions.get(id);
    if (wasPaused && task.assigned_agent_id) {
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as AgentRow | undefined;
      if (agent && agent.status !== "offline") {
        autoResumed = true;
        const deptId = agent.department_id ?? null;
        const deptName = deptId ? getDeptName(deptId) : "Unassigned";
        appendTaskLog(id, "system", `RESUME auto-run scheduled (session=${existingSession?.sessionId ?? "new"})`);
        setTimeout(
          () => {
            if (isTaskWorkflowInterrupted(id) || activeProcesses.has(id)) return;
            startTaskExecutionForAgent(id, agent, deptId, deptName);
          },
          randomDelay(450, 900),
        );
      }
    }

    if (autoResumed) {
      notifyCeo(
        pickL(
          l(
            [`'${task.title}' 작업이 복구되었습니다. (${targetStatus}) 기존 세션을 유지한 채 자동 재개를 시작합니다.`],
            [
              `'${task.title}' was resumed. (${targetStatus}) Auto-resume is starting with the existing session preserved.`,
            ],
            [`'${task.title}' が復旧されました。(${targetStatus}) 既存セッションを保持したまま自動再開します。`],
            [`'${task.title}' 已恢复。(${targetStatus}) 将在保留原会话的情况下自动继续执行。`],
          ),
          lang,
        ),
        id,
      );
    } else {
      notifyCeo(
        pickL(
          l(
            [`'${task.title}' 작업이 복구되었습니다. (${targetStatus})`],
            [`'${task.title}' was resumed. (${targetStatus})`],
            [`'${task.title}' が復旧されました。(${targetStatus})`],
            [`'${task.title}' 已恢复。(${targetStatus})`],
          ),
          lang,
        ),
        id,
      );
    }

    res.json({
      ok: true,
      status: targetStatus,
      auto_resumed: autoResumed,
      session_id: existingSession?.sessionId ?? null,
    });
  });
}
