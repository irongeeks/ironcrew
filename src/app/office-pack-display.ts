import type { Agent, Department, WorkflowPackKey } from "../types";

function mergePackAgent(globalAgent: Agent | undefined, packAgent: Agent): Agent {
  // DB row is the source of truth after hydration.
  if (globalAgent) return globalAgent;
  // Fallback for edge cases before hydration settles.
  return packAgent;
}

function mergePackDepartment(
  globalDepartment: Department | undefined,
  packDepartment: Department,
  preferPackProfile: boolean,
): Department {
  if (!globalDepartment) return packDepartment;
  // During first-pack bootstrap before DB hydration settles, prefer pack profile values.
  if (preferPackProfile) return { ...globalDepartment, ...packDepartment };
  // After hydration, DB row is the source of truth.
  return globalDepartment;
}

export function resolvePackDepartmentsForDisplay(params: {
  packKey: WorkflowPackKey;
  globalDepartments: Department[];
  packDepartments?: Department[] | null;
  preferPackProfile?: boolean;
}): Department[] {
  const { packKey, globalDepartments, packDepartments, preferPackProfile = true } = params;
  if (packKey === "development" || !packDepartments || packDepartments.length === 0) {
    return globalDepartments;
  }

  const globalById = new Map<string, Department>();
  for (const department of globalDepartments) {
    globalById.set(department.id, department);
  }

  const scopedDepartments = packDepartments.map((packDepartment) =>
    mergePackDepartment(globalById.get(packDepartment.id), packDepartment, preferPackProfile),
  );
  // For non-development packs, only show pack-scoped departments — do not append unrelated global departments.
  return scopedDepartments;
}

export function resolvePackAgentViews(params: {
  packKey: WorkflowPackKey;
  globalAgents: Agent[];
  packAgents?: Agent[] | null;
}): { scopedAgents: Agent[]; mergedAgents: Agent[] } {
  const { packKey, globalAgents, packAgents } = params;
  if (packKey === "development" || !packAgents || packAgents.length === 0) {
    return { scopedAgents: globalAgents, mergedAgents: globalAgents };
  }

  const globalById = new Map<string, Agent>();
  for (const agent of globalAgents) {
    globalById.set(agent.id, agent);
  }

  const scopedAgents = packAgents.map((packAgent) => mergePackAgent(globalById.get(packAgent.id), packAgent));
  // For non-development packs, mergedAgents should only contain pack-scoped agents —
  // do not leak unrelated global agents (e.g. browser department) into the pack view.
  return { scopedAgents, mergedAgents: scopedAgents };
}
