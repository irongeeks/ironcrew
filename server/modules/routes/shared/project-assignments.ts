import type { DatabaseSync } from "node:sqlite";

export function getAssignedAgentIdsByProjectIds(db: DatabaseSync, projectIds: string[]): Map<string, string[]> {
  const assignedByProject = new Map<string, string[]>();
  if (projectIds.length === 0) return assignedByProject;

  const placeholders = projectIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT project_id, agent_id
       FROM project_agents
       WHERE project_id IN (${placeholders})
       ORDER BY project_id, created_at`,
    )
    .all(...projectIds) as unknown as Array<{ project_id: string; agent_id: string }>;

  for (const row of rows) {
    const current = assignedByProject.get(row.project_id);
    if (current) {
      current.push(row.agent_id);
    } else {
      assignedByProject.set(row.project_id, [row.agent_id]);
    }
  }

  return assignedByProject;
}
