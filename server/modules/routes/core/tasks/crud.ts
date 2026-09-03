import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { MeetingMinuteEntryRow, MeetingMinutesRow } from "../../shared/types.ts";
import { isWorkflowPackKey } from "../../../workflow/packs/definitions.ts";
import { resolveWorkflowPackKeyForTask } from "../../../workflow/packs/task-pack-resolver.ts";
import type { PackRegistry } from "../../../../packs/pack-registry.ts";
import { parseBody } from "../../validation.ts";
import { BulkHideSchema, CreateTaskSchema, UpdateTaskSchema } from "./schemas.ts";

export type TaskCrudRouteDeps = Pick<
  RuntimeContext,
  | "app"
  | "db"
  | "nowMs"
  | "firstQueryValue"
  | "reconcileCrossDeptSubtasks"
  | "normalizeTextField"
  | "recordTaskCreationAudit"
  | "appendTaskLog"
  | "broadcast"
  | "setTaskCreationAuditCompletion"
  | "clearTaskWorkflowState"
  | "endTaskExecutionSession"
  | "activeProcesses"
  | "stopRequestedTasks"
  | "killPidTree"
  | "logsDir"
> & {
  packRegistry?: PackRegistry;
};

export function registerTaskCrudRoutes(deps: TaskCrudRouteDeps): void {
  const {
    app,
    db,
    nowMs,
    firstQueryValue,
    reconcileCrossDeptSubtasks,
    normalizeTextField,
    recordTaskCreationAudit,
    appendTaskLog,
    broadcast,
    setTaskCreationAuditCompletion,
    clearTaskWorkflowState,
    endTaskExecutionSession,
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    logsDir,
    packRegistry,
  } = deps;

  function normalizeProjectPathInput(raw: unknown): string | null {
    const value = normalizeTextField(raw);
    if (!value) return null;

    let candidate = value;
    if (candidate === "~") {
      candidate = os.homedir();
    } else if (candidate.startsWith("~/")) {
      candidate = path.join(os.homedir(), candidate.slice(2));
    } else if (candidate === "/Projects" || candidate.startsWith("/Projects/")) {
      const suffix = candidate.slice("/Projects".length).replace(/^\/+/, "");
      candidate = suffix ? path.join(os.homedir(), "Projects", suffix) : path.join(os.homedir(), "Projects");
    } else if (candidate === "/projects" || candidate.startsWith("/projects/")) {
      const suffix = candidate.slice("/projects".length).replace(/^\/+/, "");
      candidate = suffix ? path.join(os.homedir(), "projects", suffix) : path.join(os.homedir(), "projects");
    }

    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
    return path.normalize(absolute);
  }

  function isAllowedProjectPath(candidate: string): boolean {
    // Resolve symlinks to prevent bypass via symlink indirection.
    // When the full path doesn't exist yet, walk up to the deepest existing
    // ancestor, resolve symlinks on that, then re-append the remaining segments.
    // This prevents bypass via a symlink intermediate (e.g. /Projects/link/new-dir
    // where "link" is a symlink to an external location).
    let resolved: string;
    const absolute = path.resolve(candidate);
    try {
      resolved = fs.realpathSync(absolute);
    } catch {
      // Walk up to find deepest existing ancestor
      let current = absolute;
      const trailing: string[] = [];

      while (true) {
        const parent = path.dirname(current);
        if (parent === current) break; // reached filesystem root
        trailing.unshift(path.basename(current));
        current = parent;
        try {
          const realAncestor = fs.realpathSync(current);
          resolved = path.join(realAncestor, ...trailing);
          break;
        } catch {
          // keep walking up
        }
      }
      // If nothing resolved (shouldn't happen — root always exists), fall back
      resolved ??= absolute;
    }
    const allowedRoots = [process.cwd(), path.join(os.homedir(), "Projects"), path.join(os.homedir(), "projects")];
    const registeredPaths = db.prepare("SELECT project_path FROM projects WHERE project_path IS NOT NULL").all() as {
      project_path: string;
    }[];
    for (const row of registeredPaths) {
      if (row.project_path) allowedRoots.push(path.resolve(row.project_path));
    }
    // Resolve symlinks for allowed roots too
    const resolvedRoots = allowedRoots.map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    });
    return resolvedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  app.get("/api/tasks", (req, res) => {
    reconcileCrossDeptSubtasks();
    const statusFilter = firstQueryValue(req.query.status);
    const deptFilter = firstQueryValue(req.query.department_id);
    const agentFilter = firstQueryValue(req.query.agent_id);
    const projectFilter = firstQueryValue(req.query.project_id);
    const workflowPackFilter = normalizeTextField(firstQueryValue(req.query.workflow_pack_key));

    if (workflowPackFilter && !isWorkflowPackKey(workflowPackFilter)) {
      return res.status(400).json({ error: "invalid_workflow_pack_key" });
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (statusFilter) {
      conditions.push("t.status = ?");
      params.push(statusFilter);
    }
    if (deptFilter) {
      conditions.push("t.department_id = ?");
      params.push(deptFilter);
    }
    if (agentFilter) {
      conditions.push("t.assigned_agent_id = ?");
      params.push(agentFilter);
    }
    if (projectFilter) {
      conditions.push("t.project_id = ?");
      params.push(projectFilter);
    }
    if (workflowPackFilter) {
      conditions.push("t.workflow_pack_key = ?");
      params.push(workflowPackFilter);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const subtaskTotalExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id)
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;
    const subtaskDoneExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'done')
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND c.status = 'done'
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;

    let tasks: unknown[];
    try {
      tasks = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.icon, d.icon) AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(t.workflow_pack_key, 'development')
       AND opd.department_id = t.department_id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      ${where}
      ORDER BY t.priority DESC, t.updated_at DESC
    `,
        )
        .all(...(params as SQLInputValue[]));
    } catch {
      tasks = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        d.name AS department_name,
        d.icon AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      ${where}
      ORDER BY t.priority DESC, t.updated_at DESC
    `,
        )
        .all(...(params as SQLInputValue[]));
    }

    res.json({ tasks });
  });

  app.post("/api/tasks", (req, res) => {
    const parsed = parseBody(CreateTaskSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "title_required", detail: parsed.error });
    }
    const body = parsed.data;
    const id = randomUUID();
    const t = nowMs();

    const title = body.title;

    const requestedProjectId = normalizeTextField(body.project_id);
    let resolvedProjectId: string | null = null;
    let resolvedProjectPath = normalizeProjectPathInput(body.project_path);

    // Auto-assign workspace from pack's default_workspace when no project path is provided
    const packKey = body.workflow_pack_key;
    if (!resolvedProjectPath && !requestedProjectId && packKey && packRegistry) {
      try {
        const loadedPack = packRegistry.get(packKey);
        const defaultWs = loadedPack?.definition?.staff?.default_workspace;
        if (defaultWs) {
          const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40);
          const wsDir = path.join(process.cwd(), defaultWs, `${slug}-${id.slice(0, 8)}`);
          fs.mkdirSync(wsDir, { recursive: true });
          resolvedProjectPath = wsDir;
        }
      } catch {
        // pack not in registry — skip auto-workspace
      }
    }

    if (requestedProjectId) {
      const project = db.prepare("SELECT id, project_path FROM projects WHERE id = ?").get(requestedProjectId) as
        | {
            id: string;
            project_path: string;
          }
        | undefined;
      if (!project) return res.status(400).json({ error: "project_not_found" });
      resolvedProjectId = project.id;
      if (!resolvedProjectPath) resolvedProjectPath = normalizeTextField(project.project_path);
    } else if (resolvedProjectPath) {
      const projectByPath = db
        .prepare(
          "SELECT id, project_path FROM projects WHERE project_path = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1",
        )
        .get(resolvedProjectPath) as { id: string; project_path: string } | undefined;
      if (projectByPath) {
        resolvedProjectId = projectByPath.id;
        resolvedProjectPath = normalizeTextField(projectByPath.project_path) ?? resolvedProjectPath;
      }
    }

    if (resolvedProjectPath && !isAllowedProjectPath(resolvedProjectPath)) {
      return res.status(400).json({ error: "project_path_not_allowed" });
    }

    db.prepare(
      `
    INSERT INTO tasks (
      id, title, description, department_id, assigned_agent_id, project_id,
      status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format,
      project_path, base_branch, skipped_phases, agent_routing, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    ).run(
      id,
      title,
      body.description ?? null,
      body.department_id ?? null,
      body.assigned_agent_id ?? null,
      resolvedProjectId,
      body.status ?? "inbox",
      body.priority ?? 0,
      body.task_type ?? "general",
      resolveWorkflowPackKeyForTask({
        db: db as any,
        explicitPackKey: body.workflow_pack_key,
        projectId: resolvedProjectId,
      }),
      typeof body.workflow_meta_json === "string"
        ? body.workflow_meta_json
        : body.workflow_meta_json
          ? JSON.stringify(body.workflow_meta_json)
          : null,
      typeof body.output_format === "string" ? body.output_format : null,
      resolvedProjectPath,
      body.base_branch ?? null,
      Array.isArray(body.skipped_phases) ? JSON.stringify(body.skipped_phases) : (body.skipped_phases ?? "[]"),
      body.agent_routing ?? null,
      t,
      t,
    );
    recordTaskCreationAudit({
      taskId: id,
      taskTitle: title,
      taskStatus: String(body.status ?? "inbox"),
      departmentId: typeof body.department_id === "string" ? body.department_id : null,
      assignedAgentId: typeof body.assigned_agent_id === "string" ? body.assigned_agent_id : null,
      taskType: typeof body.task_type === "string" ? body.task_type : "general",
      projectPath: resolvedProjectPath,
      trigger: body.trigger ?? "api.tasks.create",
      triggerDetail: body.trigger_detail ?? "POST /api/tasks",
      actorType: "api_client",
      req,
      body: typeof body === "object" && body ? (body as Record<string, unknown>) : null,
    });

    if (resolvedProjectId) {
      db.prepare("UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?").run(t, t, resolvedProjectId);
    }

    appendTaskLog(id, "system", `Task created: ${title}`);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    broadcast("task_update", task);
    res.json({ id, task });
  });

  app.get("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id);
    reconcileCrossDeptSubtasks(id);
    const subtaskTotalExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id)
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;
    const subtaskDoneExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'done')
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND c.status = 'done'
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;
    let task: unknown;
    try {
      task = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        a.cli_provider AS agent_provider,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.icon, d.icon) AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(t.workflow_pack_key, 'development')
       AND opd.department_id = t.department_id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?
    `,
        )
        .get(id);
    } catch {
      task = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        a.cli_provider AS agent_provider,
        d.name AS department_name,
        d.icon AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?
    `,
        )
        .get(id);
    }
    if (!task) return res.status(404).json({ error: "not_found" });

    const logs = db.prepare("SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 200").all(id);
    const subtasks = db.prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY created_at").all(id);

    res.json({ task, logs, subtasks });
  });

  app.get("/api/tasks/:id/meeting-minutes", (req, res) => {
    const id = String(req.params.id);
    const task = db.prepare("SELECT id, source_task_id FROM tasks WHERE id = ?").get(id) as
      | { id: string; source_task_id: string | null }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const taskIds = [id];
    if (task.source_task_id) taskIds.push(task.source_task_id);

    const meetings = db
      .prepare(
        `SELECT * FROM meeting_minutes WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY started_at DESC, round DESC`,
      )
      .all(...taskIds) as unknown as MeetingMinutesRow[];

    const data = meetings.map((meeting) => {
      const entries = db
        .prepare("SELECT * FROM meeting_minute_entries WHERE meeting_id = ? ORDER BY seq ASC, id ASC")
        .all(meeting.id) as unknown as MeetingMinuteEntryRow[];
      return { ...meeting, entries };
    });

    res.json({ meetings: data });
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id);
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const parsed = parseBody(UpdateTaskSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", detail: parsed.error });
    }
    const body = parsed.data;
    if ("workflow_pack_key" in body) {
      const workflowPackKey = normalizeTextField(body.workflow_pack_key);
      if (!workflowPackKey || !isWorkflowPackKey(workflowPackKey)) {
        return res.status(400).json({ error: "invalid_workflow_pack_key" });
      }
      body.workflow_pack_key = workflowPackKey;
    }
    if ("workflow_meta_json" in body) {
      const rawWorkflowMeta = body.workflow_meta_json;
      if (rawWorkflowMeta === null) {
        body.workflow_meta_json = null;
      } else if (typeof rawWorkflowMeta === "string") {
        body.workflow_meta_json = rawWorkflowMeta;
      } else {
        body.workflow_meta_json = JSON.stringify(rawWorkflowMeta);
      }
    }
    if ("output_format" in body && body.output_format !== null && typeof body.output_format !== "string") {
      return res.status(400).json({ error: "invalid_output_format" });
    }

    const allowedFields = [
      "title",
      "description",
      "department_id",
      "assigned_agent_id",
      "status",
      "priority",
      "task_type",
      "workflow_pack_key",
      "workflow_meta_json",
      "output_format",
      "project_path",
      "result",
      "hidden",
      "skipped_phases",
    ];

    if ("skipped_phases" in body && body.skipped_phases !== undefined) {
      if (Array.isArray(body.skipped_phases)) {
        body.skipped_phases = JSON.stringify(body.skipped_phases);
      }
    }

    if ("project_path" in body && body.project_path != null) {
      const candidatePath = String(body.project_path);
      if (candidatePath && !isAllowedProjectPath(candidatePath)) {
        return res.status(400).json({ error: "project_path_not_allowed" });
      }
    }

    const updates: string[] = ["updated_at = ?"];
    const updateTs = nowMs();
    const params: unknown[] = [updateTs];
    let touchedProjectId: string | null = null;

    for (const field of allowedFields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        params.push((body as Record<string, unknown>)[field]);
      }
    }

    if ("project_id" in body) {
      const requestedProjectId = normalizeTextField(body.project_id);
      if (!requestedProjectId) {
        updates.push("project_id = ?");
        params.push(null);
      } else {
        const project = db.prepare("SELECT id, project_path FROM projects WHERE id = ?").get(requestedProjectId) as
          | {
              id: string;
              project_path: string;
            }
          | undefined;
        if (!project) return res.status(400).json({ error: "project_not_found" });
        updates.push("project_id = ?");
        params.push(project.id);
        touchedProjectId = project.id;
        if (!("project_path" in body)) {
          updates.push("project_path = ?");
          params.push(project.project_path);
        }
      }
    }

    if (body.status === "done" && !("completed_at" in body)) {
      updates.push("completed_at = ?");
      params.push(nowMs());
    }
    if (body.status === "in_progress" && !("started_at" in body)) {
      updates.push("started_at = ?");
      params.push(nowMs());
    }

    // Clear timestamps when status regresses
    if (body.status) {
      const oldStatus = (existing as Record<string, unknown>).status as string | undefined;
      const terminalStatuses = ["done", "cancelled"];
      const nonTerminalStatuses = ["pending", "planned", "collaborating", "in_progress", "review", "inbox"];

      // Clear completed_at when moving from a terminal status to a non-terminal one
      if (
        oldStatus &&
        terminalStatuses.includes(oldStatus) &&
        nonTerminalStatuses.includes(body.status) &&
        !("completed_at" in body)
      ) {
        updates.push("completed_at = ?");
        params.push(null);
      }

      // Clear started_at when regressing back to pending (but not for rework scenarios like review → in_progress)
      if (oldStatus && oldStatus !== "pending" && body.status === "pending" && !("started_at" in body)) {
        updates.push("started_at = ?");
        params.push(null);
      }
    }

    params.push(id);
    db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...(params as SQLInputValue[]));
    if (touchedProjectId) {
      db.prepare("UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?").run(
        updateTs,
        updateTs,
        touchedProjectId,
      );
    }

    const nextStatus = typeof body.status === "string" ? body.status : null;
    if (nextStatus) {
      setTaskCreationAuditCompletion(id, nextStatus === "done");
    }
    if (
      nextStatus &&
      (nextStatus === "cancelled" || nextStatus === "pending" || nextStatus === "done" || nextStatus === "inbox")
    ) {
      clearTaskWorkflowState(id);
      if (nextStatus === "done" || nextStatus === "cancelled") {
        endTaskExecutionSession(id, `task_status_${nextStatus}`);
      }
    }

    appendTaskLog(id, "system", `Task updated: ${Object.keys(body as object).join(", ")}`);

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    broadcast("task_update", updated);
    res.json({ ok: true, task: updated });
  });

  app.post("/api/tasks/bulk-hide", (req, res) => {
    const parsed = BulkHideSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", detail: parsed.error.message });
    }
    const { statuses, hidden } = parsed.data;
    const placeholders = statuses.map(() => "?").join(",");
    const result = db
      .prepare(`UPDATE tasks SET hidden = ?, updated_at = ? WHERE status IN (${placeholders}) AND hidden != ?`)
      .run(hidden, nowMs(), ...statuses, hidden);
    broadcast("tasks_changed", {});
    res.json({ ok: true, affected: result.changes });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id);
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          assigned_agent_id: string | null;
        }
      | undefined;
    if (!existing) return res.status(404).json({ error: "not_found" });

    endTaskExecutionSession(id, "task_deleted");
    clearTaskWorkflowState(id);

    const activeChild = activeProcesses.get(id);
    if (activeChild?.pid) {
      stopRequestedTasks.add(id);
      if (activeChild.pid < 0) {
        activeChild.kill();
      } else {
        killPidTree(activeChild.pid);
      }
      activeProcesses.delete(id);
    }

    // Wrap all DB mutations in a transaction. ROLLBACK is best-effort so a
    // failing rollback (e.g. DB already closed / no active tx) does not mask
    // the original error.
    db.exec("BEGIN");
    try {
      if (existing.assigned_agent_id) {
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?",
        ).run(existing.assigned_agent_id, id);
      }
      db.prepare(
        `
        INSERT INTO logs (level, module, message, data, logged_at)
        SELECT 30, 'task_log', message, json_object('taskId', task_id, 'kind', kind, 'originalId', id), created_at
        FROM task_logs WHERE task_id = ?
      `,
      ).run(id);
      db.prepare("DELETE FROM task_logs WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM messages WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM token_usage WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort rollback
      }
      throw e;
    }

    for (const suffix of [".log", ".prompt.txt"]) {
      const filePath = path.join(logsDir, `${id}${suffix}`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // Log file cleanup is best-effort
      }
    }

    broadcast("task_update", { id, deleted: true });
    res.json({ ok: true });
  });
}
