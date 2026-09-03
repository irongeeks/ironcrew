import type { Agent, Department } from "../../types";

type DepartmentSyncPatch = Partial<Pick<Department, "name" | "name_ko" | "name_ja" | "name_zh" | "icon">>;
type AgentSyncPatch = Partial<
  Pick<Agent, "name" | "name_ko" | "name_ja" | "name_zh" | "department_id" | "avatar_emoji">
>;

export interface OfficePackSyncPlan {
  departmentPatches: Array<{ id: string; patch: DepartmentSyncPatch }>;
  agentPatches: Array<{ id: string; patch: AgentSyncPatch }>;
}

function normalizeNullableString(value: string | null | undefined): string {
  return value ?? "";
}

export function buildOfficePackSyncPlan(params: {
  currentDepartments: Department[];
  currentAgents: Agent[];
  nextDepartments: Department[];
  nextAgents: Agent[];
}): OfficePackSyncPlan {
  const { currentDepartments, currentAgents, nextDepartments, nextAgents } = params;

  const nextDepartmentMap = new Map(nextDepartments.map((department) => [department.id, department]));
  const nextAgentMap = new Map(nextAgents.map((agent) => [agent.id, agent]));

  const departmentPatches: Array<{ id: string; patch: DepartmentSyncPatch }> = [];
  for (const department of currentDepartments) {
    const next = nextDepartmentMap.get(department.id);
    if (!next) continue;

    const patch: DepartmentSyncPatch = {};
    if (department.name !== next.name) patch.name = next.name;
    if (department.name_ko !== next.name_ko) patch.name_ko = next.name_ko;
    if (normalizeNullableString(department.name_ja) !== normalizeNullableString(next.name_ja)) {
      patch.name_ja = next.name_ja ?? null;
    }
    if (normalizeNullableString(department.name_zh) !== normalizeNullableString(next.name_zh)) {
      patch.name_zh = next.name_zh ?? null;
    }
    if (department.icon !== next.icon) patch.icon = next.icon;

    if (Object.keys(patch).length > 0) {
      departmentPatches.push({ id: department.id, patch });
    }
  }

  const agentPatches: Array<{ id: string; patch: AgentSyncPatch }> = [];
  for (const agent of currentAgents) {
    const next = nextAgentMap.get(agent.id);
    if (!next) continue;

    const patch: AgentSyncPatch = {};
    if (agent.name !== next.name) patch.name = next.name;
    if (agent.name_ko !== next.name_ko) patch.name_ko = next.name_ko;
    if (normalizeNullableString(agent.name_ja) !== normalizeNullableString(next.name_ja)) {
      patch.name_ja = next.name_ja ?? null;
    }
    if (normalizeNullableString(agent.name_zh) !== normalizeNullableString(next.name_zh)) {
      patch.name_zh = next.name_zh ?? null;
    }
    if ((agent.department_id ?? null) !== (next.department_id ?? null)) {
      patch.department_id = next.department_id ?? null;
    }
    if (agent.avatar_emoji !== next.avatar_emoji) patch.avatar_emoji = next.avatar_emoji;

    if (Object.keys(patch).length > 0) {
      agentPatches.push({ id: agent.id, patch });
    }
  }

  return { departmentPatches, agentPatches };
}
