import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  DEFAULT_WORKFLOW_PACK_KEY,
  isWorkflowPackKey,
  type WorkflowPackKey,
} from "../../../workflow/packs/definitions.ts";

type DbLike = Pick<DatabaseSync, "prepare">;
let cachedHasAgentWorkflowPackColumn: boolean | null = null;

type ProjectAssignmentModeRow = {
  assignment_mode?: string | null;
};

type ProjectAgentRow = {
  agent_id: string;
};

export type AutoAssignableAgent = {
  id: string;
  name: string;
  department_id: string | null;
  role: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  status: string;
  current_task_id: string | null;
  created_at: number;
};

type CandidateTaskShape = {
  workflow_pack_key?: string | null;
  department_id?: string | null;
  project_id?: string | null;
};

export type AutoAssignSelectionResult = {
  packKey: WorkflowPackKey;
  agent: AutoAssignableAgent;
};

const PACK_DEPARTMENT_PRIORITIES: Record<WorkflowPackKey, string[]> = {
  development: ["dev", "qa", "planning", "design"],
  design_studio: ["design", "qa", "planning", "dev"],
  web_research_report: ["dev", "planning", "qa"],
  video_preprod: ["design", "planning", "dev", "qa"],
};

const VALID_AGENT_ROLES = new Set(["team_leader", "senior", "junior", "intern"]);
const VALID_CLI_PROVIDERS = new Set([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "copilot",
  "antigravity",
  "api",
  "openclaw",
]);

type OfficePackProfileAgent = {
  id: string;
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  department_id: string | null;
  role: string;
  cli_provider: string | null;
  avatar_emoji: string;
  personality: string | null;
  created_at: number;
};

type OfficePackProfileDepartment = {
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

function normalizePackKey(raw: string | null | undefined): WorkflowPackKey {
  if (isWorkflowPackKey(raw)) return raw;
  return DEFAULT_WORKFLOW_PACK_KEY;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown): string | null {
  const text = normalizeText(value);
  return text.length > 0 ? text : null;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const i = Math.trunc(num);
  return i >= 0 ? i : fallback;
}

function normalizeOfficePackProfileDepartment(raw: unknown): OfficePackProfileDepartment | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const id = normalizeText(obj.id);
  if (!id) return null;
  const now = Date.now();
  return {
    id,
    name: normalizeText(obj.name) || id,
    name_ko: normalizeText(obj.name_ko) || normalizeText(obj.name) || id,
    name_ja: normalizeText(obj.name_ja),
    name_zh: normalizeText(obj.name_zh),
    icon: normalizeText(obj.icon) || "🏢",
    color: normalizeText(obj.color) || "#64748b",
    description: normalizeOptionalText(obj.description),
    prompt: normalizeOptionalText(obj.prompt),
    sort_order: normalizePositiveInt(obj.sort_order, 99),
    created_at: normalizePositiveInt(obj.created_at, now),
  };
}

function normalizeOfficePackProfileAgent(raw: unknown): OfficePackProfileAgent | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const id = normalizeText(obj.id);
  if (!id) return null;

  const roleRaw = normalizeText(obj.role).toLowerCase();
  const role = VALID_AGENT_ROLES.has(roleRaw) ? roleRaw : "senior";

  const cliProviderRaw = normalizeText(obj.cli_provider).toLowerCase();
  const cli_provider = VALID_CLI_PROVIDERS.has(cliProviderRaw) ? cliProviderRaw : "codex";

  const now = Date.now();
  const name = normalizeText(obj.name) || id;
  return {
    id,
    name,
    name_ko: normalizeText(obj.name_ko) || name,
    name_ja: normalizeText(obj.name_ja),
    name_zh: normalizeText(obj.name_zh),
    department_id: normalizeOptionalText(obj.department_id),
    role,
    cli_provider,
    avatar_emoji: normalizeText(obj.avatar_emoji) || "🤖",
    personality: normalizeOptionalText(obj.personality),
    created_at: normalizePositiveInt(obj.created_at, now),
  };
}

function loadOfficePackProfileFromSettings(
  db: DbLike,
  packKey: WorkflowPackKey,
): { departments: OfficePackProfileDepartment[]; agents: OfficePackProfileAgent[] } | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'officePackProfiles' LIMIT 1").get() as
      | { value?: unknown }
      | undefined;
    if (!row) return null;

    const parsedRaw = typeof row.value === "string" ? safeJsonParse(row.value) : row.value;
    const root = asObject(parsedRaw);
    if (!root) return null;

    const packProfileRaw = root[packKey];
    const packProfile = asObject(packProfileRaw);
    if (!packProfile) return null;

    const departments = Array.isArray(packProfile.departments)
      ? packProfile.departments.map(normalizeOfficePackProfileDepartment).filter(Boolean)
      : [];
    const agents = Array.isArray(packProfile.agents)
      ? packProfile.agents.map(normalizeOfficePackProfileAgent).filter(Boolean)
      : [];

    return {
      departments: departments as OfficePackProfileDepartment[],
      agents: agents as OfficePackProfileAgent[],
    };
  } catch {
    return null;
  }
}

function selectExistingAgentIds(db: DbLike, candidateIds: string[]): string[] {
  if (candidateIds.length <= 0) return [];
  const placeholders = candidateIds.map(() => "?").join(", ");
  try {
    const rows = db
      .prepare(
        `
        SELECT id
        FROM agents
        WHERE id IN (${placeholders})
      `,
      )
      .all(...(candidateIds as SQLInputValue[])) as Array<{ id?: unknown }>;
    return rows.map((row) => normalizeText(row?.id)).filter((id): id is string => id.length > 0);
  } catch {
    return [];
  }
}

function selectAgentIdsByDepartments(db: DbLike, departmentIds: string[]): string[] {
  if (departmentIds.length <= 0) return [];
  const placeholders = departmentIds.map(() => "?").join(", ");
  try {
    const rows = db
      .prepare(
        `
        SELECT id
        FROM agents
        WHERE department_id IN (${placeholders})
      `,
      )
      .all(...(departmentIds as SQLInputValue[])) as Array<{ id?: unknown }>;
    return rows.map((row) => normalizeText(row?.id)).filter((id): id is string => id.length > 0);
  } catch {
    return [];
  }
}

function loadPackProfileAgentScope(db: DbLike, packKey: WorkflowPackKey): string[] | null {
  if (packKey === "development") return null;

  const profile = loadOfficePackProfileFromSettings(db, packKey);
  if (!profile || profile.agents.length <= 0) return null;
  const profileAgentIds = profile.agents.map((agent) => normalizeText(agent.id)).filter((id) => id.length > 0);
  const existingIds = selectExistingAgentIds(db, profileAgentIds);
  if (existingIds.length > 0) return existingIds;

  const profileDepartmentIds = Array.from(
    new Set(profile.agents.map((agent) => normalizeText(agent.department_id)).filter((id) => id.length > 0)),
  );
  const departmentScopedIds = selectAgentIdsByDepartments(db, profileDepartmentIds);
  if (departmentScopedIds.length > 0) return departmentScopedIds;
  return null;
}

function buildPreferredDepartmentOrder(
  packKey: WorkflowPackKey,
  taskDepartmentId: string | null | undefined,
): string[] {
  const preferred = PACK_DEPARTMENT_PRIORITIES[packKey] ?? PACK_DEPARTMENT_PRIORITIES[DEFAULT_WORKFLOW_PACK_KEY];
  const out: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    if (out.includes(value)) return;
    out.push(value);
  };

  add(taskDepartmentId);
  for (const deptId of preferred) add(deptId);
  return out;
}

function loadManualProjectAgentScope(db: DbLike, projectId: string | null | undefined): string[] | null {
  if (!projectId) return null;
  const project = db.prepare("SELECT assignment_mode FROM projects WHERE id = ?").get(projectId) as
    | ProjectAssignmentModeRow
    | undefined;
  if (project?.assignment_mode !== "manual") return null;
  const rows = db
    .prepare("SELECT agent_id FROM project_agents WHERE project_id = ?")
    .all(projectId) as ProjectAgentRow[];
  return rows.map((row) => row.agent_id).filter((id) => typeof id === "string" && id.length > 0);
}

function combineAgentScopes(primary: string[] | null, secondary: string[] | null): string[] | null {
  if (Array.isArray(primary) && Array.isArray(secondary)) {
    const set = new Set(secondary);
    return primary.filter((id) => set.has(id));
  }
  if (Array.isArray(primary)) return primary;
  if (Array.isArray(secondary)) return secondary;
  return null;
}

function loadActiveOAuthAccountIdsByProvider(db: DbLike): Map<string, Set<string>> | null {
  try {
    const rows = db.prepare("SELECT id, provider FROM oauth_accounts WHERE status = 'active'").all() as Array<{
      id?: unknown;
      provider?: unknown;
    }>;
    const out = new Map<string, Set<string>>();
    for (const row of rows) {
      const id = normalizeText(row?.id);
      const provider = normalizeText(row?.provider).toLowerCase();
      if (!id || !provider) continue;
      const current = out.get(provider) ?? new Set<string>();
      current.add(id);
      out.set(provider, current);
    }
    return out;
  } catch {
    // Some tests or legacy databases may not have oauth_accounts yet.
    return null;
  }
}

function isOAuthBackedProviderReady(
  agent: AutoAssignableAgent,
  activeOAuthByProvider: Map<string, Set<string>> | null,
): boolean {
  const provider = normalizeText(agent.cli_provider).toLowerCase();
  const requiredOAuthProvider =
    provider === "copilot" ? "github" : provider === "antigravity" ? "google_antigravity" : null;
  if (!requiredOAuthProvider) return true;
  if (!activeOAuthByProvider) return true;

  const activeAccounts = activeOAuthByProvider.get(requiredOAuthProvider);
  if (!activeAccounts || activeAccounts.size <= 0) return false;

  const preferredAccountId = normalizeText(agent.oauth_account_id);
  if (preferredAccountId && !activeAccounts.has(preferredAccountId)) return false;
  return true;
}

function hasAgentWorkflowPackColumn(db: DbLike): boolean {
  if (cachedHasAgentWorkflowPackColumn !== null) return cachedHasAgentWorkflowPackColumn;
  try {
    const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name?: unknown }>;
    cachedHasAgentWorkflowPackColumn = cols.some((col) => normalizeText(col.name) === "workflow_pack_key");
  } catch {
    cachedHasAgentWorkflowPackColumn = false;
  }
  return cachedHasAgentWorkflowPackColumn;
}

function selectCandidate(
  db: DbLike,
  preferredDeptIds: string[],
  constrainedAgentIds: string[] | null,
  packKey: WorkflowPackKey,
  excludeAgentIds?: string[],
): AutoAssignableAgent | null {
  if (Array.isArray(constrainedAgentIds) && constrainedAgentIds.length === 0) {
    return null;
  }

  const conditions: string[] = [
    "cli_provider IS NOT NULL",
    "status IN ('idle', 'break')",
    "(current_task_id IS NULL OR current_task_id = '')",
  ];
  const params: SQLInputValue[] = [];

  if (preferredDeptIds.length > 0) {
    conditions.push(`department_id IN (${preferredDeptIds.map(() => "?").join(", ")})`);
    params.push(...preferredDeptIds);
  }

  if (Array.isArray(constrainedAgentIds)) {
    conditions.push(`id IN (${constrainedAgentIds.map(() => "?").join(", ")})`);
    params.push(...constrainedAgentIds);
  }

  if (excludeAgentIds && excludeAgentIds.length > 0) {
    conditions.push(`id NOT IN (${excludeAgentIds.map(() => "?").join(", ")})`);
    params.push(...excludeAgentIds);
  }

  if (hasAgentWorkflowPackColumn(db)) {
    conditions.push("COALESCE(workflow_pack_key, 'development') = ?");
    params.push(packKey);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
      SELECT id, name, department_id, role, cli_provider, oauth_account_id, status, current_task_id, created_at
      FROM agents
      ${where}
      ORDER BY created_at ASC
    `,
    )
    .all(...params) as AutoAssignableAgent[];
  if (rows.length === 0) return null;

  const activeOAuthByProvider = loadActiveOAuthAccountIdsByProvider(db);
  const runnableRows = rows.filter((row) => isOAuthBackedProviderReady(row, activeOAuthByProvider));
  if (runnableRows.length === 0) return null;

  const deptRank = (deptId: string | null): number => {
    if (!deptId) return preferredDeptIds.length + 1;
    const index = preferredDeptIds.indexOf(deptId);
    return index >= 0 ? index : preferredDeptIds.length;
  };
  const statusRank = (status: string): number => (status === "idle" ? 0 : status === "break" ? 1 : 2);
  const leaderRank = (role: string): number => (role === "team_leader" ? 1 : 0);

  runnableRows.sort((a, b) => {
    const byDept = deptRank(a.department_id) - deptRank(b.department_id);
    if (byDept !== 0) return byDept;

    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;

    const byLeader = leaderRank(a.role) - leaderRank(b.role);
    if (byLeader !== 0) return byLeader;

    return (a.created_at ?? 0) - (b.created_at ?? 0);
  });

  return runnableRows[0] ?? null;
}

export function resolveConstrainedAgentScopeForTask(db: DbLike, task: CandidateTaskShape): string[] | null {
  const packKey = normalizePackKey(task.workflow_pack_key);
  const packScope = loadPackProfileAgentScope(db, packKey);
  const manualScope = loadManualProjectAgentScope(db, task.project_id);
  return combineAgentScopes(packScope, manualScope);
}

export function selectAutoAssignableAgentForTask(
  db: DbLike,
  task: CandidateTaskShape,
  excludeAgentIds?: string[],
): AutoAssignSelectionResult | null {
  const packKey = normalizePackKey(task.workflow_pack_key);
  const preferredDeptIds = buildPreferredDepartmentOrder(packKey, task.department_id);
  const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db, task);

  const preferredCandidate = selectCandidate(db, preferredDeptIds, constrainedAgentIds, packKey, excludeAgentIds);
  if (preferredCandidate) {
    return { packKey, agent: preferredCandidate };
  }

  const fallbackCandidate = selectCandidate(db, [], constrainedAgentIds, packKey, excludeAgentIds);
  if (!fallbackCandidate) return null;

  return { packKey, agent: fallbackCandidate };
}

/**
 * Select an available agent for a specific department, optionally excluding certain agents.
 * Used by the department pipeline to assign agents per step.
 */
export function selectAgentForDepartment(
  db: DbLike,
  task: CandidateTaskShape,
  departmentId: string,
  excludeAgentIds?: string[],
): AutoAssignSelectionResult | null {
  const packKey = normalizePackKey(task.workflow_pack_key);
  const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db, task);

  // Force department as the only preferred department
  const candidate = selectCandidate(db, [departmentId], constrainedAgentIds, packKey, excludeAgentIds);
  if (!candidate) return null;
  return { packKey, agent: candidate };
}
