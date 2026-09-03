import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { createTaskReportHelpers } from "./helpers.ts";
import { logger } from "../../../../observability/logger.ts";

const log = logger.child({ module: "ops" });

export function registerTaskReportRoutes(ctx: RuntimeContext): void {
  const { app, db, nowMs, archivePlanningConsolidatedReport } = ctx;
  const {
    normalizeTaskText,
    buildTextPreview,
    normalizeProjectName,
    sortReportDocuments,
    fetchMeetingMinutesForTask,
    buildTaskSection,
  } = createTaskReportHelpers({ db, nowMs });

  app.get("/api/task-reports", (_req, res) => {
    try {
      const rows = db
        .prepare(
          `
      SELECT t.id, t.title, t.description, t.department_id, t.assigned_agent_id,
             t.status, t.project_id, t.project_path, t.source_task_id, t.created_at, t.completed_at,
             COALESCE(a.name, '') AS agent_name,
             COALESCE(a.name_ko, '') AS agent_name_ko,
             COALESCE(a.role, '') AS agent_role,
             COALESCE(d.name, '') AS dept_name,
             COALESCE(d.name_ko, '') AS dept_name_ko,
             COALESCE(p.name, '') AS project_name_db
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      LEFT JOIN departments d ON d.id = t.department_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'done'
        AND (t.source_task_id IS NULL OR TRIM(t.source_task_id) = '')
      ORDER BY t.completed_at DESC
      LIMIT 50
    `,
        )
        .all() as Array<Record<string, unknown>>;

      const reports = rows.map((row) => ({
        ...row,
        project_name:
          normalizeTaskText(row.project_name_db) ||
          normalizeProjectName(row.project_path, normalizeTaskText(row.title) || "General"),
      }));
      res.json({ ok: true, reports });
    } catch (err) {
      log.error({ err }, "task reports error");
      res.status(500).json({ ok: false, error: "Failed to fetch reports" });
    }
  });

  app.get("/api/task-reports/:taskId", (req, res) => {
    const { taskId } = req.params;
    try {
      const taskWithJoins = db
        .prepare(
          `
      SELECT t.id, t.title, t.description, t.department_id, t.assigned_agent_id,
             t.status, t.project_id, t.project_path, t.result, t.source_task_id,
             t.created_at, t.started_at, t.completed_at,
             COALESCE(a.name, '') AS agent_name,
             COALESCE(a.name_ko, '') AS agent_name_ko,
             COALESCE(a.role, '') AS agent_role,
             COALESCE(d.name, '') AS dept_name,
             COALESCE(d.name_ko, '') AS dept_name_ko,
             COALESCE(p.name, '') AS project_name_db,
             COALESCE(p.project_path, '') AS project_path_db,
             COALESCE(p.core_goal, '') AS project_core_goal
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      LEFT JOIN departments d ON d.id = t.department_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?
    `,
        )
        .get(taskId) as Record<string, unknown> | undefined;
      if (!taskWithJoins) return res.status(404).json({ ok: false, error: "Task not found" });

      const rootTaskId = normalizeTaskText(taskWithJoins.source_task_id) || String(taskWithJoins.id);
      const rootTask = db
        .prepare(
          `
      SELECT t.id, t.title, t.description, t.department_id, t.assigned_agent_id,
             t.status, t.project_id, t.project_path, t.result, t.source_task_id,
             t.created_at, t.started_at, t.completed_at,
             COALESCE(a.name, '') AS agent_name,
             COALESCE(a.name_ko, '') AS agent_name_ko,
             COALESCE(a.role, '') AS agent_role,
             COALESCE(d.name, '') AS dept_name,
             COALESCE(d.name_ko, '') AS dept_name_ko,
             COALESCE(p.name, '') AS project_name_db,
             COALESCE(p.project_path, '') AS project_path_db,
             COALESCE(p.core_goal, '') AS project_core_goal
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      LEFT JOIN departments d ON d.id = t.department_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?
    `,
        )
        .get(rootTaskId) as Record<string, unknown> | undefined;
      if (!rootTask) return res.status(404).json({ ok: false, error: "Root task not found" });

      const relatedTasks = db
        .prepare(
          `
      SELECT t.id, t.title, t.description, t.department_id, t.assigned_agent_id,
             t.status, t.project_id, t.project_path, t.result, t.source_task_id,
             t.created_at, t.started_at, t.completed_at,
             COALESCE(a.name, '') AS agent_name,
             COALESCE(a.name_ko, '') AS agent_name_ko,
             COALESCE(a.role, '') AS agent_role,
             COALESCE(d.name, '') AS dept_name,
             COALESCE(d.name_ko, '') AS dept_name_ko,
             COALESCE(p.name, '') AS project_name_db,
             COALESCE(p.project_path, '') AS project_path_db,
             COALESCE(p.core_goal, '') AS project_core_goal
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      LEFT JOIN departments d ON d.id = t.department_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id = ? OR t.source_task_id = ?
      ORDER BY CASE WHEN t.id = ? THEN 0 ELSE 1 END, t.completed_at DESC, t.created_at ASC
    `,
        )
        .all(rootTaskId, rootTaskId, rootTaskId) as Array<Record<string, unknown>>;

      const rootSubtasks = db
        .prepare(
          `
      SELECT s.id, s.title, s.status, s.assigned_agent_id, s.target_department_id, s.delegated_task_id, s.completed_at,
             COALESCE(a.name, '') AS agent_name, COALESCE(a.name_ko, '') AS agent_name_ko,
             COALESCE(d.name, '') AS target_dept_name, COALESCE(d.name_ko, '') AS target_dept_name_ko
      FROM subtasks s
      LEFT JOIN agents a ON a.id = s.assigned_agent_id
      LEFT JOIN departments d ON d.id = s.target_department_id
      WHERE s.task_id = ?
      ORDER BY s.created_at ASC
    `,
        )
        .all(rootTaskId) as Array<Record<string, unknown>>;

      const linkedSubtasksByTaskId = new Map<string, Array<Record<string, unknown>>>();
      for (const st of rootSubtasks) {
        const delegatedTaskId = normalizeTaskText(st.delegated_task_id);
        if (!delegatedTaskId) continue;
        const bucket = linkedSubtasksByTaskId.get(delegatedTaskId) ?? [];
        bucket.push(st);
        linkedSubtasksByTaskId.set(delegatedTaskId, bucket);
      }

      const teamReports = relatedTasks.map((item) =>
        buildTaskSection(item, linkedSubtasksByTaskId.get(String(item.id)) ?? []),
      );

      const planningSection =
        teamReports.find((s) => s.task_id === rootTaskId && s.department_id === "planning") ??
        teamReports.find((s) => s.department_id === "planning") ??
        teamReports[0] ??
        null;

      const projectId = normalizeTaskText(rootTask.project_id) || null;
      const projectPath =
        normalizeTaskText(rootTask.project_path_db) || normalizeTaskText(rootTask.project_path) || null;
      const projectName =
        normalizeTaskText(rootTask.project_name_db) ||
        normalizeProjectName(projectPath, normalizeTaskText(rootTask.title) || "General");
      const projectCoreGoal = normalizeTaskText(rootTask.project_core_goal) || null;

      const rootLogs = db
        .prepare("SELECT kind, message, created_at FROM task_logs WHERE task_id = ? ORDER BY created_at ASC")
        .all(rootTaskId);
      const rootMinutes = fetchMeetingMinutesForTask(rootTaskId);

      const archiveRow = db
        .prepare(
          `
      SELECT a.summary_markdown, a.updated_at, a.created_at, a.generated_by_agent_id,
             COALESCE(ag.name, '') AS agent_name,
             COALESCE(ag.name_ko, '') AS agent_name_ko
      FROM task_report_archives a
      LEFT JOIN agents ag ON ag.id = a.generated_by_agent_id
      WHERE a.root_task_id = ?
      ORDER BY a.updated_at DESC
      LIMIT 1
    `,
        )
        .get(rootTaskId) as Record<string, unknown> | undefined;

      const archiveSummaryContent = normalizeTaskText(archiveRow?.summary_markdown);
      const planningArchiveDoc = archiveSummaryContent
        ? sortReportDocuments([
            {
              id: `archive:${rootTaskId}`,
              title: `${projectName}-planning-consolidated.md`,
              source: "archive",
              path: null,
              mime: "text/markdown",
              size_bytes: archiveSummaryContent.length,
              updated_at: Number(archiveRow?.updated_at ?? archiveRow?.created_at ?? 0) || nowMs(),
              truncated: false,
              text_preview: buildTextPreview(archiveSummaryContent),
              content: archiveSummaryContent,
            },
          ])
        : [];

      const planningSummary = planningSection
        ? {
            title: "Planning Lead Consolidated Summary",
            content: archiveSummaryContent || planningSection.summary || "",
            source_task_id: planningSection.task_id ?? rootTaskId,
            source_agent_name: normalizeTaskText(archiveRow?.agent_name) || planningSection.agent_name,
            source_department_name: planningSection.department_name,
            generated_at: Number(
              archiveRow?.updated_at ??
                archiveRow?.created_at ??
                planningSection.completed_at ??
                planningSection.created_at ??
                nowMs(),
            ),
            documents: sortReportDocuments([
              ...planningArchiveDoc,
              ...((planningSection.documents ?? []) as Array<Record<string, unknown>>),
            ]),
          }
        : {
            title: "Planning Lead Consolidated Summary",
            content: archiveSummaryContent || "",
            source_task_id: rootTaskId,
            source_agent_name: normalizeTaskText(archiveRow?.agent_name) || "",
            source_department_name: "",
            generated_at: Number(archiveRow?.updated_at ?? archiveRow?.created_at ?? nowMs()),
            documents: planningArchiveDoc,
          };

      res.json({
        ok: true,
        requested_task_id: String(taskWithJoins.id),
        project: {
          root_task_id: rootTaskId,
          project_id: projectId,
          project_name: projectName,
          project_path: projectPath,
          core_goal: projectCoreGoal,
        },
        task: rootTask,
        logs: rootLogs,
        subtasks: rootSubtasks,
        meeting_minutes: rootMinutes,
        planning_summary: planningSummary,
        team_reports: teamReports,
      });
    } catch (err) {
      log.error({ err }, "task report by id error");
      res.status(500).json({ ok: false, error: "Failed to fetch report detail" });
    }
  });

  app.post("/api/task-reports/:taskId/archive", async (req, res) => {
    const { taskId } = req.params;
    try {
      if (typeof archivePlanningConsolidatedReport !== "function") {
        return res.status(503).json({ ok: false, error: "archive_generator_unavailable" });
      }
      const row = db.prepare("SELECT id, source_task_id FROM tasks WHERE id = ?").get(taskId) as
        | { id: string; source_task_id: string | null }
        | undefined;
      if (!row) return res.status(404).json({ ok: false, error: "Task not found" });

      const rootTaskId = normalizeTaskText(row.source_task_id) || row.id;
      await archivePlanningConsolidatedReport(rootTaskId);

      const archive = db
        .prepare(
          `
      SELECT root_task_id, generated_by_agent_id, updated_at
      FROM task_report_archives
      WHERE root_task_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `,
        )
        .get(rootTaskId) as
        | { root_task_id: string; generated_by_agent_id: string | null; updated_at: number }
        | undefined;

      if (!archive) {
        return res.status(500).json({ ok: false, error: "Failed to archive consolidated report" });
      }

      res.json({
        ok: true,
        root_task_id: archive.root_task_id,
        generated_by_agent_id: archive.generated_by_agent_id,
        updated_at: archive.updated_at,
      });
    } catch (err) {
      log.error({ err }, "task report archive error");
      res.status(500).json({ ok: false, error: "Failed to archive consolidated report" });
    }
  });
}
