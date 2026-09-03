import {
  parseWorkflowMeta,
  updateWorkflowMeta,
  hasPipeline,
  isPipelineComplete,
  getCurrentPipelineDept,
  shouldPreserveWorktreeForNextStep,
  resolveQaBounceStep,
} from "./pipeline-helpers.ts";
import { selectAgentForDepartment } from "../../routes/core/tasks/execution-run-auto-assign.ts";
import type { SubHandlerResult } from "./run-complete-types.ts";
import type { RunCompleteDeps } from "./run-complete-handler.ts";

type Deps = Pick<
  RunCompleteDeps,
  | "db"
  | "appendTaskLog"
  | "broadcast"
  | "nowMs"
  | "taskWorktrees"
  | "cleanupWorktree"
  | "notifyCeo"
  | "pickL"
  | "l"
  | "resolveLang"
>;

export function handleDeptPipelineAdvancement(
  deps: Deps,
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
  exitCode: number,
  _logFilePath: string,
  _meta: Record<string, unknown>,
  result: string | null,
  triggerTaskReRun: (taskId: string, reason: string) => void,
): SubHandlerResult {
  const { db, appendTaskLog, broadcast, nowMs, taskWorktrees, cleanupWorktree, notifyCeo, pickL, l, resolveLang } =
    deps;

  if (exitCode !== 0 || !task) return { handled: false };

  const meta = parseWorkflowMeta(task.workflow_meta_json);
  if (!hasPipeline(meta) || isPipelineComplete(meta.pipeline)) return { handled: false };

  const pipeline = meta.pipeline;
  const completedDept = getCurrentPipelineDept(pipeline) ?? `step_${pipeline.current_step}`;
  const t = nowMs();

  // Capture result from this step
  pipeline.step_results[completedDept] = result ?? "";
  pipeline.current_step++;

  if (!isPipelineComplete(pipeline)) {
    // More steps remain — advance to next department
    const nextDept = getCurrentPipelineDept(pipeline)!;
    const preserveWorktree = shouldPreserveWorktreeForNextStep({
      ...pipeline,
      current_step: pipeline.current_step - 1,
    });

    // Append step result to task description
    const deptLabel = completedDept.charAt(0).toUpperCase() + completedDept.slice(1);
    const stepResultSnippet = (result ?? "").length > 1500 ? (result ?? "").slice(-1500) : (result ?? "");
    const descAppend = `\n\n---\n## ${deptLabel} Output (Pipeline Step ${pipeline.current_step}/${pipeline.steps.length})\n${stepResultSnippet}`;
    const currentDesc =
      (
        db.prepare("SELECT description FROM tasks WHERE id = ?").get(taskId) as
          | { description?: string | null }
          | undefined
      )?.description ?? "";
    db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(currentDesc + descAppend, taskId);

    // Find agent for next department
    const nextAgentResult = selectAgentForDepartment(
      db as any,
      {
        workflow_pack_key: task.workflow_pack_key,
        department_id: nextDept,
        project_id: task.project_id,
      },
      nextDept,
    );

    const nextAgentId = nextAgentResult?.agent.id ?? pipeline.original_agent_id ?? task.assigned_agent_id;
    const nextAgentName = nextAgentResult?.agent.name ?? "current agent";

    // Update task for next step
    db.prepare(
      "UPDATE tasks SET assigned_agent_id = ?, department_id = ?, status = 'planned', updated_at = ? WHERE id = ?",
    ).run(nextAgentId, nextDept, t, taskId);

    // Update workflow meta
    updateWorkflowMeta(db as any, taskId, { pipeline }, t);

    // Handle worktree — skip cleanup for video tasks (plain directories, not git worktrees)
    const isVideoTask = task.workflow_pack_key === "video_preprod";
    if (!preserveWorktree && !isVideoTask) {
      const wtInfo = taskWorktrees.get(taskId);
      if (wtInfo) {
        cleanupWorktree(wtInfo.projectPath, taskId);
        appendTaskLog(taskId, "system", "Worktree cleaned up (pipeline step transition)");
      }
    } else {
      appendTaskLog(taskId, "system", "Worktree preserved for next pipeline step (QA/browser needs code access)");
    }

    appendTaskLog(
      taskId,
      "system",
      `Pipeline step ${pipeline.current_step}/${pipeline.steps.length}: ${completedDept} → ${nextDept} (agent: ${nextAgentName})`,
    );

    const stepLang = resolveLang(task.description ?? task.title);
    notifyCeo(
      pickL(
        l(
          [`'${task.title}' 파이프라인: ${completedDept} 완료 → ${nextDept} 단계로 이동합니다.`],
          [`'${task.title}' pipeline: ${completedDept} done → moving to ${nextDept}.`],
          [`'${task.title}' パイプライン: ${completedDept} 完了 → ${nextDept} ステップへ移行します。`],
          [`'${task.title}' 管道: ${completedDept} 完成 → 进入 ${nextDept} 阶段。`],
        ),
        stepLang,
      ),
      taskId,
    );

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    broadcast("task_update", updatedTask);

    triggerTaskReRun(taskId, `pipeline_step_${pipeline.current_step}`);
    return { handled: true }; // Skip normal review flow
  }

  // Pipeline is complete — save final state and fall through to normal review
  updateWorkflowMeta(db as any, taskId, { pipeline }, t);
  appendTaskLog(taskId, "system", `Pipeline complete (${pipeline.steps.length} steps finished)`);

  return { handled: false };
}

export function handleQaBounceBack(
  deps: Deps,
  task: {
    title: string;
    description: string | null;
    workflow_pack_key: string | null;
    workflow_meta_json: string | null;
    assigned_agent_id: string | null;
  },
  taskId: string,
  exitCode: number,
  _logFilePath: string,
  _meta: Record<string, unknown>,
  result: string | null,
  triggerTaskReRun: (taskId: string, reason: string) => void,
): SubHandlerResult {
  const { db, appendTaskLog, broadcast, nowMs, taskWorktrees, cleanupWorktree, notifyCeo, pickL, l, resolveLang } =
    deps;

  if (exitCode === 0 || !task) return { handled: false };

  const failMeta = parseWorkflowMeta(task.workflow_meta_json);
  if (!hasPipeline(failMeta) || isPipelineComplete(failMeta.pipeline)) return { handled: false };

  const bounceStep = resolveQaBounceStep(failMeta.pipeline);
  if (bounceStep < 0) return { handled: false };

  const pipeline = failMeta.pipeline;
  const failedDept = getCurrentPipelineDept(pipeline) ?? "qa";
  const t = nowMs();

  // Record bounce
  const bounceKey = `${failedDept}_bounce_${Date.now()}`;
  pipeline.step_results[bounceKey] = `FAILED (exit ${exitCode}): ${(result ?? "").slice(-500)}`;

  // Append QA feedback to description
  const qaFeedback = (result ?? "").length > 1000 ? (result ?? "").slice(-1000) : (result ?? "");
  const currentDesc =
    (
      db.prepare("SELECT description FROM tasks WHERE id = ?").get(taskId) as
        | { description?: string | null }
        | undefined
    )?.description ?? "";
  db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(
    currentDesc + `\n\n---\n## QA Feedback (Failed)\n${qaFeedback}`,
    taskId,
  );

  // Bounce back to previous step
  pipeline.current_step = bounceStep;
  const prevDept = pipeline.steps[bounceStep]!;
  const prevAgentId = pipeline.original_agent_id ?? task.assigned_agent_id;

  db.prepare(
    "UPDATE tasks SET assigned_agent_id = ?, department_id = ?, status = 'planned', updated_at = ? WHERE id = ?",
  ).run(prevAgentId, prevDept, t, taskId);
  updateWorkflowMeta(db as any, taskId, { pipeline }, t);

  // Clean up worktree — dev agent gets a fresh one (with QA feedback in description)
  const wtInfo = taskWorktrees.get(taskId);
  if (wtInfo) {
    cleanupWorktree(wtInfo.projectPath, taskId);
  }

  appendTaskLog(
    taskId,
    "system",
    `Pipeline QA bounce: ${failedDept} failed → returning to ${prevDept} (step ${bounceStep + 1})`,
  );

  const bounceLang = resolveLang(task.description ?? task.title);
  notifyCeo(
    pickL(
      l(
        [`'${task.title}' QA 실패 → ${prevDept} 단계로 되돌아갑니다. QA 피드백이 업무 설명에 추가되었습니다.`],
        [`'${task.title}' QA failed → bouncing back to ${prevDept}. QA feedback appended to task description.`],
        [`'${task.title}' QA 失敗 → ${prevDept} ステップに戻ります。QAフィードバックがタスク説明に追加されました。`],
        [`'${task.title}' QA 失败 → 返回 ${prevDept} 步骤。QA 反馈已附加到任务描述中。`],
      ),
      bounceLang,
    ),
    taskId,
  );

  const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  broadcast("task_update", updatedTask);
  triggerTaskReRun(taskId, `qa_bounce_to_${prevDept}`);
  return { handled: true };
}
