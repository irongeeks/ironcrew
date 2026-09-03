import fs from "node:fs";
import path from "node:path";
import {
  parseWorkflowMeta,
  updateWorkflowMeta,
  hasAutoRetry,
  canRetry,
  hasPipeline,
  getCurrentPipelineDept,
} from "./pipeline-helpers.ts";
import {
  selectAutoAssignableAgentForTask,
  selectAgentForDepartment,
} from "../../routes/core/tasks/execution-run-auto-assign.ts";
import type { SubHandlerResult } from "./run-complete-types.ts";
import type { RunCompleteDeps } from "./run-complete-handler.ts";
import { logger } from "../../../observability/logger.ts";
const log = logger.child({ module: "run-complete-failure" });

type AutoRetryDeps = Pick<
  RunCompleteDeps,
  | "db"
  | "appendTaskLog"
  | "broadcast"
  | "nowMs"
  | "taskWorktrees"
  | "cleanupWorktree"
  | "getAgentDisplayName"
  | "notifyCeo"
  | "pickL"
  | "l"
  | "resolveLang"
>;

type HardFailureDeps = Pick<
  RunCompleteDeps,
  | "db"
  | "appendTaskLog"
  | "broadcast"
  | "nowMs"
  | "logsDir"
  | "taskWorktrees"
  | "cleanupWorktree"
  | "findTeamLeader"
  | "pickL"
  | "l"
  | "notifyCeo"
  | "sendAgentMessage"
  | "resolveLang"
  | "crossDeptNextCallbacks"
  | "subtaskDelegationCallbacks"
  | "reconcileDelegatedSubtasksAfterRun"
  | "prettyStreamJson"
>;

export function handleAutoRetry(
  deps: AutoRetryDeps,
  task: {
    title: string;
    description: string | null;
    workflow_pack_key: string | null;
    workflow_meta_json: string | null;
    assigned_agent_id: string | null;
    department_id: string | null;
    project_id: string | null;
  },
  taskId: string,
  _exitCode: number,
  _logFilePath: string,
  _meta: Record<string, unknown>,
  triggerTaskReRun: (taskId: string, reason: string) => void,
): SubHandlerResult {
  const {
    db,
    appendTaskLog,
    broadcast,
    nowMs,
    taskWorktrees,
    cleanupWorktree,
    getAgentDisplayName,
    notifyCeo,
    pickL,
    l,
    resolveLang,
  } = deps;

  const failMeta = parseWorkflowMeta(task.workflow_meta_json);
  const t = nowMs();

  // Auto-retry: reassign to a different agent in the same department
  if (hasAutoRetry(failMeta) && canRetry(failMeta.auto_retry)) {
    const autoRetry = failMeta.auto_retry;
    autoRetry.failed_agents.push(task.assigned_agent_id ?? "");
    autoRetry.count++;

    // Determine which department to look in (pipeline-aware)
    const retryDeptId = hasPipeline(failMeta)
      ? (getCurrentPipelineDept(failMeta.pipeline) ?? task.department_id)
      : task.department_id;

    const retryResult = retryDeptId
      ? selectAgentForDepartment(
          db as any,
          {
            workflow_pack_key: task.workflow_pack_key,
            department_id: retryDeptId,
            project_id: task.project_id,
          },
          retryDeptId,
          autoRetry.failed_agents,
        )
      : selectAutoAssignableAgentForTask(
          db as any,
          {
            workflow_pack_key: task.workflow_pack_key,
            department_id: task.department_id,
            project_id: task.project_id,
          },
          autoRetry.failed_agents,
        );

    if (retryResult) {
      const newAgent = retryResult.agent;
      db.prepare("UPDATE tasks SET assigned_agent_id = ?, status = 'planned', updated_at = ? WHERE id = ?").run(
        newAgent.id,
        t,
        taskId,
      );
      updateWorkflowMeta(db as any, taskId, { auto_retry: autoRetry }, t);

      // Clean up worktree
      const wtInfo = taskWorktrees.get(taskId);
      if (wtInfo) {
        cleanupWorktree(wtInfo.projectPath, taskId);
      }

      appendTaskLog(
        taskId,
        "system",
        `Auto-retry ${autoRetry.count}/${autoRetry.max}: ${getAgentDisplayName(task as any, "en")} → ${newAgent.name}`,
      );

      const retryLang = resolveLang(task.description ?? task.title);
      notifyCeo(
        pickL(
          l(
            [`'${task.title}' 자동 재시도 ${autoRetry.count}/${autoRetry.max}: ${newAgent.name}에게 재배정되었습니다.`],
            [`'${task.title}' auto-retry ${autoRetry.count}/${autoRetry.max}: reassigned to ${newAgent.name}.`],
            [
              `'${task.title}' 自動リトライ ${autoRetry.count}/${autoRetry.max}: ${newAgent.name} に再割り当てされました。`,
            ],
            [`'${task.title}' 自动重试 ${autoRetry.count}/${autoRetry.max}: 已重新分配给 ${newAgent.name}。`],
          ),
          retryLang,
        ),
        taskId,
      );

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);
      triggerTaskReRun(taskId, `auto_retry_${autoRetry.count}`);
      return { handled: true };
    }

    // No agent available — save updated count and fall through to normal failure
    updateWorkflowMeta(db as any, taskId, { auto_retry: autoRetry }, t);
    appendTaskLog(
      taskId,
      "system",
      `Auto-retry ${autoRetry.count}/${autoRetry.max}: no available agent for reassignment, falling through to normal failure`,
    );
  } else if (hasAutoRetry(failMeta) && !canRetry(failMeta.auto_retry)) {
    appendTaskLog(
      taskId,
      "system",
      `Auto-retry limit reached (${failMeta.auto_retry.count}/${failMeta.auto_retry.max})`,
    );
  }

  return { handled: false };
}

export function handleHardFailure(
  deps: HardFailureDeps,
  task: {
    title: string;
    description: string | null;
    department_id: string | null;
    source_task_id: string | null;
  },
  taskId: string,
  exitCode: number,
  _logFilePath: string,
  _meta: Record<string, unknown>,
): void {
  const {
    db,
    appendTaskLog,
    broadcast,
    nowMs,
    logsDir,
    taskWorktrees,
    cleanupWorktree,
    findTeamLeader,
    pickL,
    l,
    notifyCeo,
    sendAgentMessage,
    resolveLang,
    crossDeptNextCallbacks,
    subtaskDelegationCallbacks,
    reconcileDelegatedSubtasksAfterRun,
    prettyStreamJson,
  } = deps;

  const t = nowMs();

  // ── FAILURE: Reset to inbox, team leader reports failure ──
  db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(t, taskId);

  // Reset any in_progress pipeline subtasks back to pending so the graph-runner
  // can restart them when the task is picked up from inbox again.
  db.prepare(
    "UPDATE subtasks SET status = 'pending' WHERE task_id = ? AND title LIKE '[pipeline:%' AND status = 'in_progress'",
  ).run(taskId);

  if (task?.source_task_id) {
    reconcileDelegatedSubtasksAfterRun(taskId, exitCode);
  }

  const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  broadcast("task_update", updatedTask);

  // Clean up worktree on failure — failed work shouldn't persist
  const failWtInfo = taskWorktrees.get(taskId);
  if (failWtInfo) {
    cleanupWorktree(failWtInfo.projectPath, taskId);
    appendTaskLog(taskId, "system", "Worktree cleaned up (task failed)");
  }

  if (task) {
    const leader = findTeamLeader(task.department_id);
    if (leader) {
      setTimeout(() => {
        // Read error output for failure report
        let errorBody = "";
        try {
          const logFile = path.join(logsDir, `${taskId}.log`);
          if (fs.existsSync(logFile)) {
            const raw = fs.readFileSync(logFile, "utf8");
            const pretty = prettyStreamJson(raw);
            errorBody = pretty.length > 300 ? "..." + pretty.slice(-300) : pretty;
          }
        } catch (err) {
          log.debug({ err, taskId, operation: "read_error_log" }, "cannot read error log file");
        }

        const failLang = resolveLang(task.description ?? task.title);
        const failContent = errorBody
          ? pickL(
              l(
                [
                  `대표님, '${task.title}' 작업에 문제가 발생했습니다 (종료코드: ${exitCode}).\n\n❌ 오류 내용:\n${errorBody}\n\n재배정하거나 업무 내용을 수정한 후 다시 시도해주세요.`,
                ],
                [
                  `CEO, '${task.title}' failed with an issue (exit code: ${exitCode}).\n\n❌ Error:\n${errorBody}\n\nPlease reassign the agent or revise the task, then try again.`,
                ],
                [
                  `CEO、'${task.title}' の処理中に問題が発生しました (終了コード: ${exitCode})。\n\n❌ エラー内容:\n${errorBody}\n\n担当再割り当てまたはタスク内容を修正して再試行してください。`,
                ],
                [
                  `CEO，'${task.title}' 执行时发生问题（退出码：${exitCode}）。\n\n❌ 错误内容:\n${errorBody}\n\n请重新分配代理或修改任务后重试。`,
                ],
              ),
              failLang,
            )
          : pickL(
              l(
                [
                  `대표님, '${task.title}' 작업에 문제가 발생했습니다 (종료코드: ${exitCode}). 에이전트를 재배정하거나 업무 내용을 수정한 후 다시 시도해주세요.`,
                ],
                [
                  `CEO, '${task.title}' failed with an issue (exit code: ${exitCode}). Please reassign the agent or revise the task, then try again.`,
                ],
                [
                  `CEO、'${task.title}' の処理中に問題が発生しました (終了コード: ${exitCode})。担当再割り当てまたはタスク内容を修正して再試行してください。`,
                ],
                [`CEO，'${task.title}' 执行时发生问题（退出码：${exitCode}）。请重新分配代理或修改任务后重试。`],
              ),
              failLang,
            );

        sendAgentMessage(leader, failContent, "report", "all", null, taskId);
      }, 1500);
    }
    const failLang = resolveLang(task.description ?? task.title);
    notifyCeo(
      pickL(
        l(
          [`'${task.title}' 작업 실패 (exit code: ${exitCode}).`],
          [`Task '${task.title}' failed (exit code: ${exitCode}).`],
          [`'${task.title}' のタスクが失敗しました (exit code: ${exitCode})。`],
          [`任务 '${task.title}' 失败（exit code: ${exitCode}）。`],
        ),
        failLang,
      ),
      taskId,
    );
  }

  // Even on failure, trigger next cross-dept cooperation so the queue doesn't stall
  const nextCallback = crossDeptNextCallbacks.get(taskId);
  if (nextCallback) {
    crossDeptNextCallbacks.delete(taskId);
    setTimeout(nextCallback, 3000);
  }

  // Even on failure, trigger next subtask delegation so the queue doesn't stall
  const subtaskNext = subtaskDelegationCallbacks.get(taskId);
  if (subtaskNext) {
    subtaskDelegationCallbacks.delete(taskId);
    setTimeout(subtaskNext, 3000);
  }
}
