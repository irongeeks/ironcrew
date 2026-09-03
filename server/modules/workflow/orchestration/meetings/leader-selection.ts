import type { DbLike } from "../../../../types/db-like.ts";
import { resolveConstrainedAgentScopeForTask } from "../../../routes/core/tasks/execution-run-auto-assign.ts";

interface AgentRow {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
}

type LeaderSelectionDeps = {
  db: DbLike;
  findTeamLeader: (departmentId: string, candidateAgentIds?: string[] | null) => AgentRow | null;
  detectTargetDepartments: (text: string) => string[];
};

export function createMeetingLeaderSelectionTools(deps: LeaderSelectionDeps) {
  const { db, findTeamLeader, detectTargetDepartments } = deps;

  function getLeadersByDepartmentIds(deptIds: string[], candidateAgentIds?: string[] | null): AgentRow[] {
    const out: AgentRow[] = [];
    const seen = new Set<string>();
    for (const deptId of deptIds) {
      if (!deptId) continue;
      const leader = findTeamLeader(deptId, candidateAgentIds);
      if (!leader || seen.has(leader.id)) continue;
      out.push(leader);
      seen.add(leader.id);
    }
    return out;
  }

  function getAllActiveTeamLeaders(candidateAgentIds?: string[] | null): AgentRow[] {
    if (Array.isArray(candidateAgentIds) && candidateAgentIds.length <= 0) return [];
    const scopedIds = Array.isArray(candidateAgentIds)
      ? [...new Set(candidateAgentIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : null;
    if (Array.isArray(scopedIds) && scopedIds.length <= 0) return [];
    const scopeClause = Array.isArray(scopedIds) ? `AND a.id IN (${scopedIds.map(() => "?").join(",")})` : "";
    return db
      .prepare(
        `
    SELECT a.*
    FROM agents a
    LEFT JOIN departments d ON a.department_id = d.id
    WHERE a.role = 'team_leader' AND a.status != 'offline'
      ${scopeClause}
    ORDER BY d.sort_order ASC, a.name ASC
  `,
      )
      .all(...(scopedIds ?? [])) as unknown as AgentRow[];
  }

  function getTaskRelatedDepartmentIds(
    taskId: string,
    fallbackDeptId: string | null,
    preloadedTask?: { title: string; description: string | null; department_id: string | null } | null,
  ): string[] {
    const task = (preloadedTask ??
      (db.prepare("SELECT title, description, department_id FROM tasks WHERE id = ?").get(taskId) as
        | { title: string; description: string | null; department_id: string | null }
        | undefined)) as { title: string; description: string | null; department_id: string | null } | undefined;

    const deptSet = new Set<string>();
    if (fallbackDeptId) deptSet.add(fallbackDeptId);
    if (task?.department_id) deptSet.add(task.department_id);

    const subtaskDepts = db
      .prepare(
        "SELECT DISTINCT target_department_id FROM subtasks WHERE task_id = ? AND target_department_id IS NOT NULL",
      )
      .all(taskId) as Array<{ target_department_id: string | null }>;
    for (const row of subtaskDepts) {
      if (row.target_department_id) deptSet.add(row.target_department_id);
    }

    const sourceText = `${task?.title ?? ""} ${task?.description ?? ""}`;
    for (const deptId of detectTargetDepartments(sourceText)) {
      deptSet.add(deptId);
    }

    return [...deptSet];
  }

  function getTaskReviewLeaders(
    taskId: string,
    fallbackDeptId: string | null,
    opts?: { minLeaders?: number; includePlanning?: boolean; fallbackAll?: boolean },
  ): AgentRow[] {
    const includePlanning = opts?.includePlanning ?? true;
    const minLeaders = opts?.minLeaders ?? 2;
    const fallbackAll = opts?.fallbackAll ?? true;

    const taskMeta = db
      .prepare("SELECT project_id, workflow_pack_key, department_id, title, description FROM tasks WHERE id = ?")
      .get(taskId) as
      | {
          project_id: string | null;
          workflow_pack_key: string | null;
          department_id: string | null;
          title: string;
          description: string | null;
        }
      | undefined;
    const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
      project_id: taskMeta?.project_id ?? null,
      workflow_pack_key: taskMeta?.workflow_pack_key ?? null,
      department_id: taskMeta?.department_id ?? fallbackDeptId ?? null,
    });
    const packScopedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
      project_id: null,
      workflow_pack_key: taskMeta?.workflow_pack_key ?? null,
      department_id: taskMeta?.department_id ?? fallbackDeptId ?? null,
    });

    // Check project manual mode — only team leaders of assigned agents' departments attend
    if (taskMeta?.project_id) {
      const proj = db.prepare("SELECT assignment_mode FROM projects WHERE id = ?").get(taskMeta.project_id) as
        | { assignment_mode: string }
        | undefined;
      if (proj?.assignment_mode === "manual") {
        const assignedAgents = db
          .prepare(
            "SELECT DISTINCT a.department_id FROM project_agents pa JOIN agents a ON a.id = pa.agent_id WHERE pa.project_id = ?",
          )
          .all(taskMeta.project_id) as Array<{ department_id: string | null }>;
        const manualDeptIds = assignedAgents.map((r) => r.department_id).filter(Boolean) as string[];
        const relatedDeptIds = getTaskRelatedDepartmentIds(taskId, fallbackDeptId, taskMeta);
        const desiredDeptIds = [...new Set([...manualDeptIds, ...relatedDeptIds])];

        const leaders = getLeadersByDepartmentIds(desiredDeptIds, constrainedAgentIds);
        const seen = new Set(leaders.map((l) => l.id));

        // Retry with pack scope for related department leaders not found in manual scope
        for (const deptId of relatedDeptIds) {
          const hasDeptLeader = leaders.some((leader) => leader.department_id === deptId);
          if (hasDeptLeader) continue;
          const fallbackLeader = findTeamLeader(deptId, packScopedAgentIds);
          if (!fallbackLeader || seen.has(fallbackLeader.id)) continue;
          leaders.push(fallbackLeader);
          seen.add(fallbackLeader.id);
        }

        if (includePlanning) {
          // Always include planning team leader
          const planningLeader =
            findTeamLeader("planning", constrainedAgentIds) ?? findTeamLeader("planning", packScopedAgentIds);
          if (planningLeader && !seen.has(planningLeader.id)) {
            leaders.unshift(planningLeader);
            seen.add(planningLeader.id);
          }
        }

        // In manual mode, supplement with pack-scoped leaders when related departments are undetected or too few
        if (fallbackAll && leaders.length < minLeaders) {
          const fallbackScope =
            Array.isArray(packScopedAgentIds) && packScopedAgentIds.length > 0
              ? packScopedAgentIds
              : constrainedAgentIds;
          for (const leader of getAllActiveTeamLeaders(fallbackScope)) {
            if (seen.has(leader.id)) continue;
            leaders.push(leader);
            seen.add(leader.id);
          }
        }
        return leaders;
      }
    }

    const deptIds = getTaskRelatedDepartmentIds(taskId, fallbackDeptId, taskMeta);
    const leaders = getLeadersByDepartmentIds(deptIds, constrainedAgentIds);

    const seen = new Set(leaders.map((l) => l.id));
    if (includePlanning) {
      const planningLeader = findTeamLeader("planning", constrainedAgentIds);
      if (planningLeader && !seen.has(planningLeader.id)) {
        leaders.unshift(planningLeader);
        seen.add(planningLeader.id);
      }
    }

    // If related departments are not detectable, expand to all team leaders
    // so approval is based on real multi-party communication.
    if (fallbackAll && leaders.length < minLeaders) {
      for (const leader of getAllActiveTeamLeaders(constrainedAgentIds)) {
        if (seen.has(leader.id)) continue;
        leaders.push(leader);
        seen.add(leader.id);
      }
    }

    return leaders;
  }

  return {
    getLeadersByDepartmentIds,
    getAllActiveTeamLeaders,
    getTaskRelatedDepartmentIds,
    getTaskReviewLeaders,
  };
}
