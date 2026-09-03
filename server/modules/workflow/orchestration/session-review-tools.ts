import type { Lang } from "../../../types/lang.ts";

type CreateSessionReviewToolsDeps = Record<string, any>;

export function createSessionReviewTools(deps: CreateSessionReviewToolsDeps) {
  const {
    taskExecutionSessions,
    nowMs,
    randomUUID,
    stopRequestedTasks,
    clearCliOutputDedup,
    crossDeptNextCallbacks,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    delegatedTaskToSubtask,
    subtaskDelegationCompletionNoticeSent,
    reviewRoundState,
    reviewInFlight,
    appendTaskLog,
    notifyCeo,
    pickL,
    l,
    db,
    finishReview,
    randomDelay,
  } = deps;

  function ensureTaskExecutionSession(taskId: string, agentId: string, provider: string): any {
    const now = nowMs();
    const existing = taskExecutionSessions.get(taskId);
    if (existing && existing.agentId === agentId && existing.provider === provider) {
      existing.lastTouchedAt = now;
      taskExecutionSessions.set(taskId, existing);
      return existing;
    }

    const nextSession: any = {
      sessionId: randomUUID(),
      taskId,
      agentId,
      provider,
      openedAt: now,
      lastTouchedAt: now,
    };
    taskExecutionSessions.set(taskId, nextSession);
    appendTaskLog(
      taskId,
      "system",
      existing
        ? `Execution session rotated: ${existing.sessionId} -> ${nextSession.sessionId} (agent=${agentId}, provider=${provider})`
        : `Execution session opened: ${nextSession.sessionId} (agent=${agentId}, provider=${provider})`,
    );
    return nextSession;
  }

  function endTaskExecutionSession(taskId: string, reason: string): void {
    const existing = taskExecutionSessions.get(taskId);
    if (!existing) return;
    taskExecutionSessions.delete(taskId);
    appendTaskLog(
      taskId,
      "system",
      `Execution session closed: ${existing.sessionId} (reason=${reason}, duration_ms=${Math.max(0, nowMs() - existing.openedAt)})`,
    );
  }

  function getTaskStatusById(taskId: string): string | null {
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
    return row?.status ?? null;
  }

  function isTaskWorkflowInterrupted(taskId: string): boolean {
    const status = getTaskStatusById(taskId);
    if (!status) return true; // deleted
    if (stopRequestedTasks.has(taskId)) return true;
    return status === "cancelled" || status === "pending" || status === "done" || status === "inbox";
  }

  function clearTaskWorkflowState(taskId: string): void {
    clearCliOutputDedup(taskId);
    crossDeptNextCallbacks.delete(taskId);
    subtaskDelegationCallbacks.delete(taskId);
    subtaskDelegationDispatchInFlight.delete(taskId);
    delegatedTaskToSubtask.delete(taskId);
    subtaskDelegationCompletionNoticeSent.delete(taskId);
    reviewInFlight.delete(taskId);
    reviewInFlight.delete(`planned:${taskId}`);
    reviewRoundState.delete(taskId);
    reviewRoundState.delete(`planned:${taskId}`);
    const status = getTaskStatusById(taskId);
    if (status === "done" || status === "cancelled") {
      endTaskExecutionSession(taskId, `workflow_cleared_${status}`);
    }
  }

  type ReviewRoundMode = "parallel_remediation" | "merge_synthesis" | "final_decision";

  function getReviewRoundMode(round: number): ReviewRoundMode {
    if (round <= 1) return "parallel_remediation";
    if (round === 2) return "merge_synthesis";
    return "final_decision";
  }

  function scheduleNextReviewRound(taskId: string, taskTitle: string, currentRound: number, lang: Lang): void {
    const nextRound = currentRound + 1;
    appendTaskLog(taskId, "system", `Review round ${currentRound}: scheduling round ${nextRound} finalization meeting`);
    notifyCeo(
      pickL(
        l(
          [
            `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${currentRound} 취합이 완료되어 라운드 ${nextRound} 최종 승인 회의로 즉시 전환합니다.`,
          ],
          [
            `[CEO OFFICE] '${taskTitle}' review round ${currentRound} consolidation is complete. Moving directly to final approval round ${nextRound}.`,
          ],
          [
            `[CEO OFFICE] '${taskTitle}' のレビューラウンド${currentRound}集約が完了したため、最終承認ラウンド${nextRound}へ即時移行します。`,
          ],
          [`[CEO OFFICE] '${taskTitle}' 第 ${currentRound} 轮评审已完成汇总，立即转入第 ${nextRound} 轮最终审批会议。`],
        ),
        lang,
      ),
      taskId,
    );
    setTimeout(
      () => {
        const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
          | { status: string }
          | undefined;
        if (!current || current.status !== "review") return;
        finishReview(taskId, taskTitle, {
          bypassProjectDecisionGate: true,
          trigger: "review_round_transition",
        });
      },
      randomDelay(1200, 1900),
    );
  }

  function getProjectReviewGateSnapshot(projectId: string): {
    activeTotal: number;
    activeReview: number;
    rootReviewTotal: number;
    ready: boolean;
  } {
    const row = db
      .prepare(
        `
  SELECT
    SUM(CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS active_total,
    SUM(CASE WHEN status NOT IN ('done', 'cancelled') AND status = 'review' THEN 1 ELSE 0 END) AS active_review,
    SUM(CASE WHEN status = 'review' AND source_task_id IS NULL THEN 1 ELSE 0 END) AS root_review_total
  FROM tasks
  WHERE project_id = ?
`,
      )
      .get(projectId) as
      | {
          active_total: number | null;
          active_review: number | null;
          root_review_total: number | null;
        }
      | undefined;
    const activeTotal = row?.active_total ?? 0;
    const activeReview = row?.active_review ?? 0;
    const rootReviewTotal = row?.root_review_total ?? 0;
    const ready = activeTotal > 0 && activeTotal === activeReview && rootReviewTotal > 0;
    return { activeTotal, activeReview, rootReviewTotal, ready };
  }

  return {
    ensureTaskExecutionSession,
    endTaskExecutionSession,
    getTaskStatusById,
    isTaskWorkflowInterrupted,
    clearTaskWorkflowState,
    getReviewRoundMode,
    scheduleNextReviewRound,
    getProjectReviewGateSnapshot,
  };
}
