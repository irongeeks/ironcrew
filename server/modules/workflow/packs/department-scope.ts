import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKFLOW_PACK_KEY, isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

export type DepartmentScopedRow = {
  id: string;
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  icon: string;
  color: string;
  description: string | null;
  prompt: string | null;
  sort_order: number;
  created_at: number;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseWorkflowPackKeyInput(value: unknown): WorkflowPackKey | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") candidate = parsed.trim();
  } catch {
    // keep raw string
  }
  return isWorkflowPackKey(candidate) ? candidate : null;
}

function normalizeWorkflowPackKeyInput(value: unknown): WorkflowPackKey {
  return parseWorkflowPackKeyInput(value) ?? DEFAULT_WORKFLOW_PACK_KEY;
}

export function readActiveOfficeWorkflowPackKey(db: DbLike): WorkflowPackKey {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'officeWorkflowPack' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  return normalizeWorkflowPackKeyInput(row?.value);
}

function hasOfficePackDepartmentTable(db: DbLike): boolean {
  try {
    const row = db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'office_pack_departments'
          LIMIT 1
        `,
      )
      .get() as { name?: unknown } | undefined;
    return normalizeText(row?.name) === "office_pack_departments";
  } catch {
    return false;
  }
}

function mapPackDepartmentRow(row: Record<string, unknown> | undefined): DepartmentScopedRow | null {
  if (!row) return null;
  const id = normalizeText(row.department_id);
  if (!id) return null;
  return {
    id,
    name: normalizeText(row.name) || id,
    name_ko: normalizeText(row.name_ko) || normalizeText(row.name) || id,
    name_ja: normalizeText(row.name_ja),
    name_zh: normalizeText(row.name_zh),
    icon: normalizeText(row.icon) || "🏢",
    color: normalizeText(row.color) || "#64748b",
    description: normalizeText(row.description) || null,
    prompt: normalizeText(row.prompt) || null,
    sort_order: Number.isFinite(Number(row.sort_order)) ? Math.max(0, Math.trunc(Number(row.sort_order))) : 99,
    created_at: Number.isFinite(Number(row.created_at)) ? Math.max(0, Math.trunc(Number(row.created_at))) : Date.now(),
  };
}

function mapBaseDepartmentRow(row: Record<string, unknown> | undefined): DepartmentScopedRow | null {
  if (!row) return null;
  const id = normalizeText(row.id);
  if (!id) return null;
  return {
    id,
    name: normalizeText(row.name) || id,
    name_ko: normalizeText(row.name_ko) || normalizeText(row.name) || id,
    name_ja: normalizeText(row.name_ja),
    name_zh: normalizeText(row.name_zh),
    icon: normalizeText(row.icon) || "🏢",
    color: normalizeText(row.color) || "#64748b",
    description: normalizeText(row.description) || null,
    prompt: normalizeText(row.prompt) || null,
    sort_order: Number.isFinite(Number(row.sort_order)) ? Math.max(0, Math.trunc(Number(row.sort_order))) : 99,
    created_at: Number.isFinite(Number(row.created_at)) ? Math.max(0, Math.trunc(Number(row.created_at))) : Date.now(),
  };
}

export function getDepartmentForPack(
  db: DbLike,
  packKeyInput: unknown,
  departmentIdInput: unknown,
): DepartmentScopedRow | null {
  const departmentId = normalizeText(departmentIdInput);
  if (!departmentId) return null;
  const packKey = normalizeWorkflowPackKeyInput(packKeyInput);

  if (packKey !== DEFAULT_WORKFLOW_PACK_KEY && hasOfficePackDepartmentTable(db)) {
    try {
      const packRow = db
        .prepare(
          `
            SELECT
              workflow_pack_key, department_id, name, name_ko, name_ja, name_zh,
              icon, color, description, prompt, sort_order, created_at
            FROM office_pack_departments
            WHERE workflow_pack_key = ? AND department_id = ?
            LIMIT 1
          `,
        )
        .get(packKey, departmentId) as Record<string, unknown> | undefined;
      const mappedPack = mapPackDepartmentRow(packRow);
      if (mappedPack) return mappedPack;
    } catch {
      // fall back to base departments table
    }
  }

  try {
    const baseRow = db
      .prepare(
        `
          SELECT id, name, name_ko, name_ja, name_zh, icon, color, description, prompt, sort_order, created_at
          FROM departments
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(departmentId) as Record<string, unknown> | undefined;
    return mapBaseDepartmentRow(baseRow);
  } catch {
    return null;
  }
}

export function getDepartmentPromptForPack(
  db: DbLike,
  packKeyInput: unknown,
  departmentIdInput: unknown,
): string | null {
  return getDepartmentForPack(db, packKeyInput, departmentIdInput)?.prompt ?? null;
}
