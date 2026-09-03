import fs from "node:fs";
import path from "node:path";

import { collectPackTerminalArtifacts } from "./pack-artifact-collector.ts";
import type { RunCompleteDeps } from "./run-complete-handler.ts";

type Deps = Pick<
  RunCompleteDeps,
  | "db"
  | "appendTaskLog"
  | "broadcast"
  | "nowMs"
  | "taskWorktrees"
  | "logsDir"
  | "findTeamLeader"
  | "getAgentDisplayName"
  | "pickL"
  | "l"
  | "notifyCeo"
  | "sendAgentMessage"
  | "resolveLang"
  | "formatTaskSubtaskProgressSummary"
  | "crossDeptNextCallbacks"
  | "recoverCrossDeptQueueAfterMissingCallback"
  | "subtaskDelegationCallbacks"
  | "finishReview"
  | "reconcileDelegatedSubtasksAfterRun"
  | "completeTaskWithoutReview"
  | "isReportRequestTask"
  | "notifyTaskStatus"
  | "prettyStreamJson"
  | "getWorktreeDiffSummary"
  | "hasVisibleDiffSummary"
  | "packRegistry"
>;

export function handleSuccessPath(
  deps: Deps,
  task: {
    title: string;
    description: string | null;
    department_id: string | null;
    source_task_id: string | null;
    assigned_agent_id: string | null;
    workflow_pack_key: string | null;
    workflow_meta_json: string | null;
    project_id: string | null;
    project_path: string | null;
  },
  taskId: string,
  _exitCode: number,
  _logFilePath: string,
  _meta: Record<string, unknown>,
): void {
  const {
    db,
    appendTaskLog,
    broadcast,
    nowMs,
    taskWorktrees,
    logsDir,
    findTeamLeader,
    getAgentDisplayName,
    pickL,
    l,
    notifyCeo,
    sendAgentMessage,
    resolveLang,
    formatTaskSubtaskProgressSummary,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    finishReview,
    reconcileDelegatedSubtasksAfterRun,
    completeTaskWithoutReview,
    isReportRequestTask,
    notifyTaskStatus,
    prettyStreamJson,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
    packRegistry,
  } = deps;

  const t = nowMs();

  // Report request task
  if (isReportRequestTask(task)) {
    completeTaskWithoutReview(
      {
        id: taskId,
        title: task.title,
        description: task.description,
        department_id: task.department_id,
        source_task_id: task.source_task_id,
        assigned_agent_id: task.assigned_agent_id,
      },
      "Status → done (report workflow: review meeting skipped for documentation/report task)",
    );
    return;
  }

  // ── SUCCESS: Move to 'review' for team leader check ──
  db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(t, taskId);

  appendTaskLog(taskId, "system", "Status → review (team leader review pending)");

  const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  broadcast("task_update", updatedTask);
  if (task) notifyTaskStatus(taskId, task.title, "review", resolveLang(task.description ?? task.title));

  // Collaboration child tasks should wait in review until parent consolidation meeting.
  // Queue continuation is still triggered so sequential delegation does not stall.
  if (task?.source_task_id) {
    reconcileDelegatedSubtasksAfterRun(taskId, 0);
    const sourceLang = resolveLang(task.description ?? task.title);
    appendTaskLog(taskId, "system", "Status → review (delegated collaboration task waiting for parent consolidation)");
    notifyCeo(
      pickL(
        l(
          [
            `'${task.title}' 협업 하위 태스크가 Review 대기 상태로 전환되었습니다. 상위 업무의 전체 취합 회의에서 일괄 검토/머지합니다.`,
          ],
          [
            `'${task.title}' collaboration child task is now waiting in Review. It will be consolidated in the parent task's single review/merge meeting.`,
          ],
          [
            `'${task.title}' の協業子タスクはReview待機に入りました。上位タスクの一括レビュー/マージ会議で統合処理します。`,
          ],
          [`'${task.title}' 协作子任务已进入 Review 等待。将在上级任务的一次性评审/合并会议中统一处理。`],
        ),
        sourceLang,
      ),
      taskId,
    );

    const nextDelay = 800 + Math.random() * 600;
    const nextCallback = crossDeptNextCallbacks.get(taskId);
    if (nextCallback) {
      crossDeptNextCallbacks.delete(taskId);
      setTimeout(nextCallback, nextDelay);
    } else {
      recoverCrossDeptQueueAfterMissingCallback(taskId);
    }
    const subtaskNext = subtaskDelegationCallbacks.get(taskId);
    if (subtaskNext) {
      subtaskDelegationCallbacks.delete(taskId);
      setTimeout(subtaskNext, nextDelay);
    }
    return;
  }

  // Notify: task entering review
  if (task) {
    const lang = resolveLang(task.description ?? task.title);
    const isDesignReviewFlow = task.workflow_pack_key === "design_studio" && task.department_id === "design";
    const leader = isDesignReviewFlow ? findTeamLeader("qa") : findTeamLeader(task.department_id);
    const leaderName = leader
      ? getAgentDisplayName(leader, lang)
      : pickL(l(["팀장"], ["Team Lead"], ["チームリーダー"], ["组长"]), lang);
    notifyCeo(
      pickL(
        l(
          [
            isDesignReviewFlow
              ? `${leaderName}이(가) '${task.title}' 디자인 결과를 QA 검토 중입니다. 검토 후 CEO 승인 단계로 전환합니다.`
              : `${leaderName}이(가) '${task.title}' 결과를 검토 중입니다.`,
          ],
          [
            isDesignReviewFlow
              ? `${leaderName} is running QA review for '${task.title}' design output before CEO approval.`
              : `${leaderName} is reviewing the result for '${task.title}'.`,
          ],
          [
            isDesignReviewFlow
              ? `${leaderName} が '${task.title}' のデザイン成果を QA レビュー中です。レビュー後に CEO 承認へ進みます。`
              : `${leaderName}が '${task.title}' の成果をレビュー中です。`,
          ],
          [
            isDesignReviewFlow
              ? `${leaderName} 正在对 '${task.title}' 的设计结果进行 QA 评审，之后将进入 CEO 审批。`
              : `${leaderName} 正在审核 '${task.title}' 的结果。`,
          ],
        ),
        lang,
      ),
      taskId,
    );
  }

  // Schedule team leader review message (2-3s delay)
  setTimeout(() => {
    if (!task) return;
    const isDesignReviewFlow = task.workflow_pack_key === "design_studio" && task.department_id === "design";
    const reviewer = isDesignReviewFlow ? findTeamLeader("qa") : findTeamLeader(task.department_id);
    if (!reviewer) {
      // No team leader — auto-approve
      finishReview(taskId, task.title);
      return;
    }

    // Read the task result for the report — prefer pack artifacts for pack-based tasks
    let reportBody = "";
    const wtInfo = taskWorktrees.get(taskId);
    const effectivePath = wtInfo?.worktreePath ?? task.project_path;
    if (task.workflow_pack_key && packRegistry && effectivePath) {
      try {
        const artifacts = collectPackTerminalArtifacts(packRegistry, task.workflow_pack_key, effectivePath);
        if (artifacts.length > 0) {
          const primary = artifacts[0];
          reportBody = `📄 ${primary.path}:\n${primary.content}`;
        }
      } catch {
        // fall through to CLI log tail
      }
    }
    if (!reportBody) {
      try {
        const logFile = path.join(logsDir, `${taskId}.log`);
        if (fs.existsSync(logFile)) {
          const raw = fs.readFileSync(logFile, "utf8");
          const pretty = prettyStreamJson(raw);
          reportBody = pretty.length > 500 ? "..." + pretty.slice(-500) : pretty;
        }
      } catch {
        /* ignore */
      }
    }

    // If worktree exists, include diff summary in the report
    let diffSummary = "";
    if (wtInfo) {
      diffSummary = getWorktreeDiffSummary(wtInfo.projectPath, taskId);
      if (hasVisibleDiffSummary(diffSummary)) {
        appendTaskLog(taskId, "system", `Worktree diff summary:\n${diffSummary}`);
      }
    }

    // Team leader sends completion report with actual result content + diff
    const reportLang = resolveLang(task.description ?? task.title);
    const reviewerName = getAgentDisplayName(reviewer, reportLang);
    let reportContent = reportBody
      ? pickL(
          l(
            [`대표님, '${task.title}' 업무 완료 보고드립니다.\n\n📋 결과:\n${reportBody}`],
            [`CEO, reporting completion for '${task.title}'.\n\n📋 Result:\n${reportBody}`],
            [`CEO、'${task.title}' の完了をご報告します。\n\n📋 結果:\n${reportBody}`],
            [`CEO，汇报 '${task.title}' 已完成。\n\n📋 结果:\n${reportBody}`],
          ),
          reportLang,
        )
      : pickL(
          l(
            [`대표님, '${task.title}' 업무 완료 보고드립니다. 작업이 성공적으로 마무리되었습니다.`],
            [`CEO, reporting completion for '${task.title}'. The work has been finished successfully.`],
            [`CEO、'${task.title}' の完了をご報告します。作業は正常に完了しました。`],
            [`CEO，汇报 '${task.title}' 已完成。任务已成功结束。`],
          ),
          reportLang,
        );

    const subtaskProgressLabel = pickL(
      l(
        ["📌 보완/협업 진행 요약"],
        ["📌 Remediation/Collaboration Progress"],
        ["📌 補完/協業 進捗サマリー"],
        ["📌 整改/协作进度摘要"],
      ),
      reportLang,
    );
    const subtaskProgress = formatTaskSubtaskProgressSummary(taskId, reportLang);
    if (subtaskProgress) {
      reportContent += `\n\n${subtaskProgressLabel}\n${subtaskProgress}`;
    }

    if (hasVisibleDiffSummary(diffSummary)) {
      reportContent += pickL(
        l(
          [`\n\n📝 변경사항 (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
          [`\n\n📝 Changes (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
          [`\n\n📝 変更点 (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
          [`\n\n📝 变更内容 (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
        ),
        reportLang,
      );

      if (isDesignReviewFlow) {
        reportContent += pickL(
          l(
            [
              `\n\n[Design QA Review]\nQA 팀장(${reviewerName})이 디자인 산출물과 접근성/핸드오프 항목을 검토한 뒤 CEO 최종 승인을 요청합니다.`,
            ],
            [
              `\n\n[Design QA Review]\nQA lead (${reviewerName}) reviewed design outputs, accessibility checks, and handoff readiness before requesting CEO approval.`,
            ],
            [
              `\n\n[Design QA Review]\nQAリーダー（${reviewerName}）がデザイン成果物・アクセシビリティ・ハンドオフ準備状況を確認し、CEO最終承認を依頼します。`,
            ],
            [
              `\n\n[Design QA Review]\nQA 负责人（${reviewerName}）已审查设计产物、可访问性检查与交接完备度，并请求 CEO 最终审批。`,
            ],
          ),
          reportLang,
        );
      }
    }

    sendAgentMessage(reviewer, reportContent, "report", "all", null, taskId);

    // After another 2-3s: team leader approves → move to done
    setTimeout(() => {
      finishReview(taskId, task.title);
    }, 2500);
  }, 2500);
}
