import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "orchestration" });

type CreateReportWorkflowToolsDeps = Record<string, any>;

export function createReportWorkflowTools(deps: CreateReportWorkflowToolsDeps) {
  const {
    db,
    broadcast,
    appendTaskLog,
    nowMs,
    resolveLang,
    pickL,
    l,
    sendAgentMessage,
    findTeamLeader,
    getAgentDisplayName,
    setTaskCreationAuditCompletion,
    reviewRoundState,
    reviewInFlight,
    endTaskExecutionSession,
    notifyTaskStatus,
    refreshCliUsageData,
    archivePlanningConsolidatedReport,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    notifyCeo,
  } = deps;

  function emitTaskReportEvent(taskId: string): void {
    try {
      const reportTask = db
        .prepare(
          `
    SELECT t.id, t.title, t.description, t.department_id, t.assigned_agent_id,
           t.status, t.project_path, t.created_at, t.completed_at,
           COALESCE(a.name, '') AS agent_name,
           COALESCE(a.name_ko, '') AS agent_name_ko,
           COALESCE(a.role, '') AS agent_role,
           COALESCE(d.name, '') AS dept_name,
           COALESCE(d.name_ko, '') AS dept_name_ko
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.assigned_agent_id
    LEFT JOIN departments d ON d.id = t.department_id
    WHERE t.id = ?
  `,
        )
        .get(taskId) as Record<string, unknown> | undefined;
      const reportLogs = db
        .prepare("SELECT kind, message, created_at FROM task_logs WHERE task_id = ? ORDER BY created_at ASC")
        .all(taskId) as Array<{ kind: string; message: string; created_at: number }>;
      const reportSubtasks = db
        .prepare(
          "SELECT id, title, status, assigned_agent_id, completed_at FROM subtasks WHERE task_id = ? ORDER BY created_at ASC",
        )
        .all(taskId) as Array<Record<string, unknown>>;
      const reportMinutes = db
        .prepare(
          `
    SELECT
      mm.meeting_type,
      mm.round AS round_number,
      COALESCE((
        SELECT group_concat(entry_line, '\n')
        FROM (
          SELECT printf('[%s] %s', COALESCE(e.speaker_name, 'Unknown'), e.content) AS entry_line
          FROM meeting_minute_entries e
          WHERE e.meeting_id = mm.id
          ORDER BY e.seq ASC, e.id ASC
        )
      ), '') AS entries,
      mm.created_at
    FROM meeting_minutes mm
    WHERE mm.task_id = ?
    ORDER BY mm.created_at ASC
  `,
        )
        .all(taskId) as Array<Record<string, unknown>>;
      if (reportTask) {
        broadcast("task_report", {
          task: reportTask,
          logs: reportLogs.slice(-30),
          subtasks: reportSubtasks,
          meeting_minutes: reportMinutes,
        });
      }
    } catch (reportErr) {
      log.error({ err: reportErr }, "task_report broadcast error");
    }
  }

  function shouldDeferTaskReportUntilPlanningArchive(task: {
    source_task_id?: string | null;
    department_id?: string | null;
  }): boolean {
    if (task.source_task_id) return false;
    const planningLeader = findTeamLeader("planning") || findTeamLeader(task.department_id ?? "");
    return Boolean(planningLeader);
  }

  function completeTaskWithoutReview(
    task: {
      id: string;
      title: string;
      description: string | null;
      department_id: string | null;
      source_task_id: string | null;
      assigned_agent_id: string | null;
    },
    note: string,
  ): void {
    const t = nowMs();
    const lang = resolveLang(task.description ?? task.title);
    appendTaskLog(task.id, "system", note);
    db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(t, t, task.id);
    setTaskCreationAuditCompletion(task.id, true);
    reviewRoundState.delete(task.id);
    reviewInFlight.delete(task.id);
    endTaskExecutionSession(task.id, "task_done_no_review");

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
    broadcast("task_update", updatedTask);
    notifyTaskStatus(task.id, task.title, "done", lang);

    refreshCliUsageData()
      .then((usage: unknown) => broadcast("cli_usage_update", usage))
      .catch((err: unknown) => {
        log.warn({ err }, "CLI usage refresh failed");
      });
    const deferTaskReport = shouldDeferTaskReportUntilPlanningArchive(task);
    if (deferTaskReport) {
      appendTaskLog(task.id, "system", "Task report popup deferred until planning consolidated archive is ready");
    } else {
      emitTaskReportEvent(task.id);
    }

    const reporter = task.assigned_agent_id
      ? (db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as any | undefined)
      : undefined;
    if (reporter) {
      sendAgentMessage(
        reporter,
        pickL(
          l(
            [`대표님, '${task.title}' 보고 업무를 검토 회의 없이 완료 처리했습니다.`],
            [`CEO, '${task.title}' report work was completed without review meeting.`],
            [`CEO、'${task.title}' の報告業務をレビュー会議なしで完了処理しました。`],
            [`CEO，'${task.title}' 报告任务已在无评审会议情况下完成。`],
          ),
          lang,
        ),
        "report",
        "all",
        null,
        task.id,
      );
    }

    const leader = findTeamLeader(task.department_id);
    const leaderName = leader
      ? getAgentDisplayName(leader, lang)
      : pickL(l(["팀장"], ["Team Lead"], ["チームリーダー"], ["组长"]), lang);
    notifyCeo(
      pickL(
        l(
          [`${leaderName}: '${task.title}' 보고 업무를 검토 회의 없이 마감했습니다.`],
          [`${leaderName}: '${task.title}' report task was closed without review meeting.`],
          [`${leaderName}: '${task.title}' の報告業務をレビュー会議なしでクローズしました。`],
          [`${leaderName}：'${task.title}' 报告任务已无评审会议直接关闭。`],
        ),
        lang,
      ),
      task.id,
    );

    if (!task.source_task_id) {
      void archivePlanningConsolidatedReport(task.id);
    }

    const nextCallback = crossDeptNextCallbacks.get(task.id);
    if (nextCallback) {
      crossDeptNextCallbacks.delete(task.id);
      nextCallback();
    } else {
      recoverCrossDeptQueueAfterMissingCallback(task.id);
    }
    const subtaskNext = subtaskDelegationCallbacks.get(task.id);
    if (subtaskNext) {
      subtaskDelegationCallbacks.delete(task.id);
      subtaskNext();
    }
  }

  return {
    emitTaskReportEvent,
    shouldDeferTaskReportUntilPlanningArchive,
    completeTaskWithoutReview,
  };
}
