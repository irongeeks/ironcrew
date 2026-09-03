import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKFLOW_PACK_KEY, isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePackKey(value: unknown): WorkflowPackKey | null {
  const text = normalizeText(value);
  return isWorkflowPackKey(text) ? text : null;
}

export function resolveProjectDefaultPackKey(db: DbLike, projectId: string | null | undefined): WorkflowPackKey | null {
  const id = normalizeText(projectId);
  if (!id) return null;
  const row = db.prepare("SELECT default_pack_key FROM projects WHERE id = ? LIMIT 1").get(id) as
    | { default_pack_key?: unknown }
    | undefined;
  return normalizePackKey(row?.default_pack_key);
}

export function resolveTaskPackKeyById(db: DbLike, taskId: string | null | undefined): WorkflowPackKey | null {
  const id = normalizeText(taskId);
  if (!id) return null;
  const row = db.prepare("SELECT workflow_pack_key FROM tasks WHERE id = ? LIMIT 1").get(id) as
    | { workflow_pack_key?: unknown }
    | undefined;
  return normalizePackKey(row?.workflow_pack_key);
}

export function resolveWorkflowPackKeyForTask(params: {
  db: DbLike;
  explicitPackKey?: unknown;
  sourceTaskPackKey?: unknown;
  sourceTaskId?: string | null;
  projectId?: string | null;
  fallbackPackKey?: WorkflowPackKey;
}): WorkflowPackKey {
  const { db, explicitPackKey, sourceTaskPackKey, sourceTaskId, projectId, fallbackPackKey } = params;
  return (
    normalizePackKey(explicitPackKey) ||
    normalizePackKey(sourceTaskPackKey) ||
    resolveTaskPackKeyById(db, sourceTaskId) ||
    resolveProjectDefaultPackKey(db, projectId) ||
    fallbackPackKey ||
    DEFAULT_WORKFLOW_PACK_KEY
  );
}
