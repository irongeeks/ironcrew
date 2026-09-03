import type { DatabaseSync } from "node:sqlite";
import { resolveConstrainedAgentScopeForTask } from "../../core/tasks/execution-run-auto-assign.ts";
import {
  DEFAULT_WORKFLOW_PACK_KEY,
  isWorkflowPackKey,
  type WorkflowPackKey,
} from "../../../workflow/packs/definitions.ts";
import { resolveWorkflowPackKeyForTask } from "../../../workflow/packs/task-pack-resolver.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parsePackSetting(value: unknown): WorkflowPackKey | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  let candidate = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") candidate = parsed.trim();
  } catch {
    // keep raw text
  }

  return isWorkflowPackKey(candidate) ? candidate : null;
}

function readActiveOfficePackKey(db: DbLike): WorkflowPackKey | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'officeWorkflowPack' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  if (!row) return null;
  return parsePackSetting(row.value);
}

function resolveDirectiveWorkflowPackKey(db: DbLike, projectId: string | null): WorkflowPackKey | null {
  const activePack = readActiveOfficePackKey(db);
  if (activePack && activePack !== DEFAULT_WORKFLOW_PACK_KEY) return activePack;

  const normalizedProjectId = normalizeText(projectId);
  if (normalizedProjectId) {
    return resolveWorkflowPackKeyForTask({
      db,
      projectId: normalizedProjectId,
    });
  }

  return activePack;
}

export function resolveDirectiveLeaderCandidateScope(
  db: DbLike,
  projectId: string | null,
  departmentId: string | null = "planning",
): string[] | null {
  const workflowPackKey = resolveDirectiveWorkflowPackKey(db, projectId);
  const normalizedDeptId = normalizeText(departmentId) || "planning";
  const scopedCandidateIds = resolveConstrainedAgentScopeForTask(db, {
    project_id: normalizeText(projectId) || null,
    workflow_pack_key: workflowPackKey,
    department_id: normalizedDeptId,
  });
  if (!Array.isArray(scopedCandidateIds) || scopedCandidateIds.length <= 0) return scopedCandidateIds;

  try {
    const placeholders = scopedCandidateIds.map(() => "?").join(", ");
    const deptRows = db
      .prepare(
        `
        SELECT id
        FROM agents
        WHERE id IN (${placeholders})
          AND department_id = ?
      `,
      )
      .all(...scopedCandidateIds, normalizedDeptId) as Array<{ id?: unknown }>;
    const deptScopedIds = deptRows.map((row) => normalizeText(row.id)).filter((id): id is string => id.length > 0);
    // If no candidate exists for the requested department, keep the broader scope as fallback.
    return deptScopedIds.length > 0 ? deptScopedIds : scopedCandidateIds;
  } catch {
    return scopedCandidateIds;
  }
}
