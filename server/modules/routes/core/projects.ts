import type { Express } from "express";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getAssignedAgentIdsByProjectIds } from "../shared/project-assignments.ts";
import { createProjectRouteHelpers } from "./projects/helpers.ts";
import { registerProjectContextRoutes } from "./projects/context-routes.ts";
import { DEFAULT_WORKFLOW_PACK_KEY, isWorkflowPackKey } from "../../workflow/packs/definitions.ts";

const CreateProjectSchema = z.object({
  name: z.string().min(1, "Project name is required").max(200),
  project_path: z.string().max(1000).optional(),
  core_goal: z.string().min(1, "Core goal is required").max(5000),
  create_path_if_missing: z.boolean().optional().default(true),
  github_repo: z.string().max(500).optional().nullable(),
  remote_server_id: z.string().max(200).optional().nullable(),
  remote_path: z.string().max(1000).optional().nullable(),
  assignment_mode: z.enum(["auto", "manual"]).optional().default("auto"),
  default_pack_key: z.string().max(100).optional().nullable(),
  agent_ids: z.array(z.string()).optional(),
});

function getNextProductionFolderId(productionPath: string): number {
  let maxId = 0;
  try {
    const entries = fs.readdirSync(productionPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const num = parseInt(entry.name, 10);
        if (!Number.isNaN(num) && num > maxId) {
          maxId = num;
        }
      }
    }
  } catch {
    // If PRODUCTION doesn't exist, start from 0
  }
  return maxId + 1;
}

function resolveProductionBasePath(): string | null {
  // Check for PRODUCTION folder relative to workspace root
  const candidates = [path.resolve(process.cwd(), "PRODUCTION")];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

type FirstQueryValue = (value: unknown) => string | undefined;
type NormalizeTextField = (value: unknown) => string | null;
type RunInTransaction = (fn: () => void) => void;

interface RegisterProjectRoutesOptions {
  app: Express;
  db: DatabaseSync;
  firstQueryValue: FirstQueryValue;
  normalizeTextField: NormalizeTextField;
  runInTransaction: RunInTransaction;
  nowMs: () => number;
}

export function registerProjectRoutes({
  app,
  db,
  firstQueryValue,
  normalizeTextField,
  runInTransaction,
  nowMs,
}: RegisterProjectRoutesOptions): void {
  const {
    PROJECT_PATH_ALLOWED_ROOTS,
    normalizeProjectPathInput,
    pathInsideRoot,
    isPathInsideAllowedRoots,
    getContainingAllowedRoot,
    findConflictingProjectByPath,
    inspectDirectoryPath,
    ensureDirectoryPathExists,
    collectProjectPathSuggestions,
    resolveInitialBrowsePath,
    pickNativeDirectoryPath,
    validateProjectAgentIds,
  } = createProjectRouteHelpers({ db, normalizeTextField });

  app.get("/api/projects", (req, res) => {
    const page = Math.max(Number(firstQueryValue(req.query.page)) || 1, 1);
    const pageSizeRaw = Number(firstQueryValue(req.query.page_size)) || 10;
    const pageSize = Math.min(Math.max(pageSizeRaw, 1), 50);
    const search = normalizeTextField(firstQueryValue(req.query.search));

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      conditions.push("(p.name LIKE ? OR p.project_path LIKE ? OR p.core_goal LIKE ?)");
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const totalRow = db
      .prepare(
        `
    SELECT COUNT(*) AS cnt
    FROM projects p
    ${where}
  `,
      )
      .get(...(params as SQLInputValue[])) as { cnt: number };
    const total = Number(totalRow?.cnt ?? 0) || 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
    const offset = (page - 1) * pageSize;

    const rows = db
      .prepare(
        `
    SELECT p.*,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
    FROM projects p
    ${where}
    ORDER BY COALESCE(p.last_used_at, p.updated_at) DESC, p.updated_at DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `,
      )
      .all(...([...(params as SQLInputValue[]), pageSize, offset] as SQLInputValue[]));

    const projectRows = rows as Array<Record<string, unknown> & { id: string }>;
    const assignedByProject = getAssignedAgentIdsByProjectIds(
      db,
      projectRows.map((row) => row.id),
    );
    const projects = projectRows.map((row) => ({
      ...row,
      assigned_agent_ids: assignedByProject.get(row.id) ?? [],
    }));

    res.json({
      projects,
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
    });
  });

  app.get("/api/projects/path-check", (req, res) => {
    const raw = firstQueryValue(req.query.path);
    const normalized = normalizeProjectPathInput(raw);
    if (!normalized) return res.status(400).json({ ok: false, error: "project_path_required" });
    if (!isPathInsideAllowedRoots(normalized)) {
      return res
        .status(403)
        .json({ ok: false, error: "project_path_outside_allowed_roots", allowed_roots: PROJECT_PATH_ALLOWED_ROOTS });
    }

    const inspected = inspectDirectoryPath(normalized);
    res.json({
      ok: true,
      normalized_path: normalized,
      exists: inspected.exists,
      is_directory: inspected.isDirectory,
      can_create: inspected.canCreate,
      nearest_existing_parent: inspected.nearestExistingParent,
    });
  });

  app.post("/api/projects/path-mkdir", (req, res) => {
    const raw = normalizeProjectPathInput((req.body as Record<string, unknown>)?.path as string);
    if (!raw) return res.status(400).json({ ok: false, error: "path_required" });
    if (!isPathInsideAllowedRoots(raw)) {
      return res.status(403).json({ ok: false, error: "path_outside_allowed_roots" });
    }
    try {
      fs.mkdirSync(raw, { recursive: true });
      res.json({ ok: true, path: raw, created: true });
    } catch (err) {
      console.error("[projects] mkdir_failed:", err);
      res.status(500).json({ ok: false, error: "mkdir_failed" });
    }
  });

  app.get("/api/projects/path-suggestions", (req, res) => {
    const q = normalizeTextField(firstQueryValue(req.query.q)) ?? "";
    const parsedLimit = Number(firstQueryValue(req.query.limit) ?? "30");
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, Math.trunc(parsedLimit))) : 30;
    const paths = collectProjectPathSuggestions(q, limit);
    res.json({ ok: true, paths });
  });

  app.post("/api/projects/path-native-picker", async (_req, res) => {
    try {
      const picked = await pickNativeDirectoryPath();
      if (picked.cancelled) return res.json({ ok: false, cancelled: true });
      if (!picked.path) return res.status(400).json({ ok: false, error: "native_picker_unavailable" });

      const normalized = normalizeProjectPathInput(picked.path);
      if (!normalized) return res.status(400).json({ ok: false, error: "project_path_required" });
      if (!isPathInsideAllowedRoots(normalized)) {
        return res
          .status(403)
          .json({ ok: false, error: "project_path_outside_allowed_roots", allowed_roots: PROJECT_PATH_ALLOWED_ROOTS });
      }
      try {
        if (!fs.statSync(normalized).isDirectory()) {
          return res.status(400).json({ ok: false, error: "project_path_not_directory" });
        }
      } catch {
        return res.status(400).json({ ok: false, error: "project_path_not_found" });
      }

      return res.json({ ok: true, path: normalized, source: picked.source });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: "native_picker_failed", reason: message });
    }
  });

  app.get("/api/projects/path-browse", (req, res) => {
    const raw = firstQueryValue(req.query.path);
    const currentPath = resolveInitialBrowsePath(raw ?? null);
    if (!isPathInsideAllowedRoots(currentPath)) {
      return res
        .status(403)
        .json({ ok: false, error: "project_path_outside_allowed_roots", allowed_roots: PROJECT_PATH_ALLOWED_ROOTS });
    }

    let entries: Array<{ name: string; path: string }> = [];
    try {
      const dirents = fs.readdirSync(currentPath, { withFileTypes: true });
      entries = dirents
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({
          name: entry.name,
          path: path.join(currentPath, entry.name),
        }));
    } catch {
      entries = [];
    }

    const MAX_ENTRIES = 300;
    const truncated = entries.length > MAX_ENTRIES;
    const containingRoot = getContainingAllowedRoot(currentPath);
    const candidateParent = path.dirname(currentPath);
    const parent =
      candidateParent !== currentPath && (!containingRoot || pathInsideRoot(candidateParent, containingRoot))
        ? candidateParent
        : null;
    res.json({
      ok: true,
      current_path: currentPath,
      parent_path: parent !== currentPath ? parent : null,
      entries: entries.slice(0, MAX_ENTRIES),
      truncated,
    });
  });

  app.post("/api/projects", (req, res) => {
    const parseResult = CreateProjectSchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((issue) => {
        const p = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
        return p + issue.message;
      });
      return res.status(400).json({ ok: false, error: "validation_failed", message: issues.join("; ") });
    }
    const body = parseResult.data;
    const name = normalizeTextField(body.name);
    let projectPath = normalizeProjectPathInput(body.project_path);
    const coreGoal = normalizeTextField(body.core_goal);
    const createPathIfMissing = body.create_path_if_missing !== false;
    if (!name) return res.status(400).json({ ok: false, error: "name_required", message: "Project name is required" });
    if (!coreGoal)
      return res.status(400).json({ ok: false, error: "core_goal_required", message: "Core goal is required" });

    // Auto-create PRODUCTION folder if no project_path provided
    let autoCreatedPath = false;
    if (!projectPath) {
      const productionBase = resolveProductionBasePath();
      if (!productionBase) {
        return res.status(400).json({
          ok: false,
          error: "production_folder_not_found",
          message: "PRODUCTION folder not found and no project_path provided",
        });
      }
      const nextId = getNextProductionFolderId(productionBase);
      const autoPath = path.join(productionBase, String(nextId));
      const ensureDir = ensureDirectoryPathExists(autoPath);
      if (!ensureDir.ok) {
        return res.status(400).json({ ok: false, error: "project_path_unavailable", reason: ensureDir.reason });
      }
      projectPath = autoPath;
      autoCreatedPath = true;
    }

    if (!isPathInsideAllowedRoots(projectPath)) {
      return res
        .status(403)
        .json({ ok: false, error: "project_path_outside_allowed_roots", allowed_roots: PROJECT_PATH_ALLOWED_ROOTS });
    }
    const conflictingProject = findConflictingProjectByPath(projectPath);
    if (conflictingProject) {
      return res.status(409).json({
        ok: false,
        error: "project_path_conflict",
        existing_project_id: conflictingProject.id,
        existing_project_name: conflictingProject.name,
        existing_project_path: conflictingProject.project_path,
      });
    }
    const inspected = inspectDirectoryPath(projectPath);
    if (inspected.exists && !inspected.isDirectory) {
      return res.status(400).json({ ok: false, error: "project_path_not_directory" });
    }
    if (!inspected.exists && !autoCreatedPath) {
      if (!createPathIfMissing) {
        return res.status(409).json({
          ok: false,
          error: "project_path_not_found",
          normalized_path: projectPath,
          can_create: inspected.canCreate,
          nearest_existing_parent: inspected.nearestExistingParent,
        });
      }
      const ensureDir = ensureDirectoryPathExists(projectPath);
      if (!ensureDir.ok) {
        return res.status(400).json({ ok: false, error: "project_path_unavailable", reason: ensureDir.reason });
      }
    }

    const githubRepo = body.github_repo ? body.github_repo.trim() || null : null;
    // Remote server metadata (stored for reference; task execution still uses local project_path)
    const remoteServerId = normalizeTextField(body.remote_server_id) || null;
    const remotePath = normalizeTextField(body.remote_path) || null;
    const assignmentMode = body.assignment_mode === "manual" ? "manual" : "auto";
    const requestedDefaultPackKey = normalizeTextField(body.default_pack_key);
    if (requestedDefaultPackKey && !isWorkflowPackKey(requestedDefaultPackKey)) {
      return res.status(400).json({ ok: false, error: "invalid_default_pack_key" });
    }
    const defaultPackKey = requestedDefaultPackKey ?? DEFAULT_WORKFLOW_PACK_KEY;
    const validatedAgentIds = validateProjectAgentIds(body.agent_ids);
    if ("error" in validatedAgentIds) {
      return res.status(400).json({
        ok: false,
        error: validatedAgentIds.error.code,
        invalid_ids: validatedAgentIds.error.invalidIds ?? [],
      });
    }
    const agentIds = validatedAgentIds.agentIds;

    const id = randomUUID();
    const t = nowMs();
    runInTransaction(() => {
      db.prepare(
        `
      INSERT INTO projects (
        id, name, project_path, core_goal, default_pack_key, assignment_mode, last_used_at, created_at, updated_at, github_repo, remote_server_id, remote_path
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      ).run(
        id,
        name,
        projectPath,
        coreGoal,
        defaultPackKey,
        assignmentMode,
        t,
        t,
        t,
        githubRepo,
        remoteServerId,
        remotePath,
      );

      if (assignmentMode === "manual" && agentIds.length > 0) {
        const insertPA = db.prepare("INSERT INTO project_agents (project_id, agent_id, created_at) VALUES (?, ?, ?)");
        for (const agentId of agentIds) {
          insertPA.run(id, agentId, t);
        }
      }

      // Auto-bind enabled docs providers when knowledgeAutoBindDefault is on
      const autoBindSetting = db
        .prepare("SELECT value FROM settings WHERE key = 'knowledgeAutoBindDefault' LIMIT 1")
        .get() as { value: string } | undefined;
      const autoBindEnabled =
        autoBindSetting?.value === "true" || autoBindSetting?.value === '"true"' || autoBindSetting?.value === "1";
      if (autoBindEnabled) {
        const enabledProviders = db.prepare("SELECT id FROM docs_providers WHERE enabled = 1").all() as Array<{
          id: string;
        }>;
        const insertBinding = db.prepare(
          "INSERT INTO docs_provider_bindings (id, provider_id, project_id, project_path_prefix, created_at) VALUES (?, ?, ?, NULL, ?)",
        );
        for (const prov of enabledProviders) {
          insertBinding.run(randomUUID(), prov.id, id, t);
        }
      }
    });

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    const assignedAgentIds = (
      db.prepare("SELECT agent_id FROM project_agents WHERE project_id = ?").all(id) as Array<{ agent_id: string }>
    ).map((row) => row.agent_id);
    res.json({
      ok: true,
      project: { ...project, assigned_agent_ids: assignedAgentIds },
      auto_created_path: autoCreatedPath,
      project_path: projectPath,
    });
  });

  app.patch("/api/projects/:id", (req, res) => {
    const id = String(req.params.id);
    const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "not_found" });

    const body = req.body ?? {};
    const updates: string[] = ["updated_at = ?"];
    const params: unknown[] = [nowMs()];
    const createPathIfMissing = body.create_path_if_missing !== false;

    if ("name" in body) {
      const value = normalizeTextField(body.name);
      if (!value) return res.status(400).json({ ok: false, error: "name_required" });
      updates.push("name = ?");
      params.push(value);
    }
    if ("project_path" in body) {
      const value = normalizeProjectPathInput(body.project_path);
      if (!value) return res.status(400).json({ ok: false, error: "project_path_required" });
      if (!isPathInsideAllowedRoots(value)) {
        return res
          .status(403)
          .json({ ok: false, error: "project_path_outside_allowed_roots", allowed_roots: PROJECT_PATH_ALLOWED_ROOTS });
      }
      const conflictingProject = findConflictingProjectByPath(value, id);
      if (conflictingProject) {
        return res.status(409).json({
          ok: false,
          error: "project_path_conflict",
          existing_project_id: conflictingProject.id,
          existing_project_name: conflictingProject.name,
          existing_project_path: conflictingProject.project_path,
        });
      }
      const inspected = inspectDirectoryPath(value);
      if (inspected.exists && !inspected.isDirectory) {
        return res.status(400).json({ ok: false, error: "project_path_not_directory" });
      }
      if (!inspected.exists) {
        if (!createPathIfMissing) {
          return res.status(409).json({
            ok: false,
            error: "project_path_not_found",
            normalized_path: value,
            can_create: inspected.canCreate,
            nearest_existing_parent: inspected.nearestExistingParent,
          });
        }
        const ensureDir = ensureDirectoryPathExists(value);
        if (!ensureDir.ok) {
          return res.status(400).json({ ok: false, error: "project_path_unavailable", reason: ensureDir.reason });
        }
      }
      updates.push("project_path = ?");
      params.push(value);
    }
    if ("core_goal" in body) {
      const value = normalizeTextField(body.core_goal);
      if (!value) return res.status(400).json({ ok: false, error: "core_goal_required" });
      updates.push("core_goal = ?");
      params.push(value);
    }
    if ("github_repo" in body) {
      const value = typeof body.github_repo === "string" ? body.github_repo.trim() || null : null;
      updates.push("github_repo = ?");
      params.push(value);
    }
    if ("remote_server_id" in body) {
      const value = normalizeTextField(body.remote_server_id) || null;
      updates.push("remote_server_id = ?");
      params.push(value);
    }
    if ("remote_path" in body) {
      const value = normalizeTextField(body.remote_path) || null;
      updates.push("remote_path = ?");
      params.push(value);
    }
    if ("assignment_mode" in body) {
      const value = body.assignment_mode === "manual" ? "manual" : "auto";
      updates.push("assignment_mode = ?");
      params.push(value);
    }
    if ("default_pack_key" in body) {
      const value = normalizeTextField(body.default_pack_key);
      if (!value || !isWorkflowPackKey(value)) {
        return res.status(400).json({ ok: false, error: "invalid_default_pack_key" });
      }
      updates.push("default_pack_key = ?");
      params.push(value);
    }

    const hasAgentIdsUpdate = "agent_ids" in body;
    let agentIds: string[] = [];
    if (hasAgentIdsUpdate) {
      const validatedAgentIds = validateProjectAgentIds((body as Record<string, unknown>).agent_ids);
      if ("error" in validatedAgentIds) {
        return res.status(400).json({
          ok: false,
          error: validatedAgentIds.error.code,
          invalid_ids: validatedAgentIds.error.invalidIds ?? [],
        });
      }
      agentIds = validatedAgentIds.agentIds;
    }

    if (updates.length <= 1 && !hasAgentIdsUpdate) {
      return res.status(400).json({ ok: false, error: "no_fields" });
    }

    runInTransaction(() => {
      if (updates.length > 1) {
        params.push(id);
        db.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).run(...(params as SQLInputValue[]));
      }
      if (hasAgentIdsUpdate) {
        db.prepare("DELETE FROM project_agents WHERE project_id = ?").run(id);
        if (agentIds.length > 0) {
          const insertPA = db.prepare("INSERT INTO project_agents (project_id, agent_id, created_at) VALUES (?, ?, ?)");
          const t = nowMs();
          for (const agentId of agentIds) {
            insertPA.run(id, agentId, t);
          }
        }
      }
    });

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    const assignedAgentIds = (
      db.prepare("SELECT agent_id FROM project_agents WHERE project_id = ?").all(id) as Array<{ agent_id: string }>
    ).map((row) => row.agent_id);
    res.json({ ok: true, project: { ...project, assigned_agent_ids: assignedAgentIds } });
  });

  app.delete("/api/projects/:id", (req, res) => {
    const id = String(req.params.id);
    const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "not_found" });

    db.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  app.get("/api/projects/:id", (req, res) => {
    const id = String(req.params.id);
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (!project) return res.status(404).json({ ok: false, error: "not_found" });

    const tasks = db
      .prepare(
        `
    SELECT t.id, t.title, t.status, t.task_type, t.priority, t.created_at, t.updated_at, t.completed_at,
           t.source_task_id,
           t.assigned_agent_id,
           COALESCE(a.name, '') AS assigned_agent_name,
           COALESCE(a.name_ko, '') AS assigned_agent_name_ko
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.project_id = ?
    ORDER BY t.created_at DESC
    LIMIT 300
  `,
      )
      .all(id);

    const reports = db
      .prepare(
        `
    SELECT t.id, t.title, t.completed_at, t.created_at, t.assigned_agent_id,
           COALESCE(a.name, '') AS agent_name,
           COALESCE(a.name_ko, '') AS agent_name_ko,
           COALESCE(d.name, '') AS dept_name,
           COALESCE(d.name_ko, '') AS dept_name_ko
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.assigned_agent_id
    LEFT JOIN departments d ON d.id = t.department_id
    WHERE t.project_id = ?
      AND t.status = 'done'
      AND (t.source_task_id IS NULL OR TRIM(t.source_task_id) = '')
    ORDER BY t.completed_at DESC, t.created_at DESC
    LIMIT 200
  `,
      )
      .all(id);

    const decisionEvents = db
      .prepare(
        `
    SELECT
      id,
      snapshot_hash,
      event_type,
      summary,
      selected_options_json,
      note,
      task_id,
      meeting_id,
      created_at
    FROM project_review_decision_events
    WHERE project_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 300
  `,
      )
      .all(id);

    const assignedAgents = db
      .prepare(
        `
    SELECT a.* FROM agents a
    INNER JOIN project_agents pa ON pa.agent_id = a.id
    WHERE pa.project_id = ?
    ORDER BY a.department_id, a.role, a.name
  `,
      )
      .all(id);
    const assignedAgentIds = assignedAgents.map((agent: any) => agent.id);

    res.json({
      project: { ...project, assigned_agent_ids: assignedAgentIds },
      assigned_agents: assignedAgents,
      tasks,
      reports,
      decision_events: decisionEvents,
    });
  });

  registerProjectContextRoutes({ app, db });
}
