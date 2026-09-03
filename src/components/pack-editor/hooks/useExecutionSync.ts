import { useMemo } from "react";
import type { SubTask, SubTaskStatus } from "../../../types";
import type { ExecutionState, PhaseExecutionState } from "../execution-types";

/**
 * Parse a pipeline subtask title to extract phase ID and optional fan-out index.
 * Returns null for non-pipeline subtasks.
 */
export function parsePipelineTitle(title: string): { phaseId: string; index?: number } | null {
  const match = title.match(/^\[pipeline:([^\]]+)\]$/);
  if (!match) return null;

  const raw = match[1];
  if (raw === "__input__") return null;

  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) return { phaseId: raw };

  const phaseId = raw.slice(0, colonIdx);
  const index = parseInt(raw.slice(colonIdx + 1), 10);
  return { phaseId, index: isNaN(index) ? undefined : index };
}

/**
 * Build execution state from a list of subtasks for a specific task.
 * Pure function — no hooks, testable directly.
 */
export function buildExecutionState(taskId: string, subtasks: SubTask[]): ExecutionState {
  const phases = new Map<string, PhaseExecutionState>();
  const fanOutInstances = new Map<string, Array<{ index: number; status: SubTaskStatus; agentId?: string | null }>>();

  for (const sub of subtasks) {
    if (sub.task_id !== taskId) continue;

    const parsed = parsePipelineTitle(sub.title);
    if (!parsed) continue;

    const { phaseId, index } = parsed;

    if (index !== undefined) {
      if (!fanOutInstances.has(phaseId)) fanOutInstances.set(phaseId, []);
      fanOutInstances.get(phaseId)!.push({ index, status: sub.status, agentId: sub.assigned_agent_id });
    }

    if (index === undefined || !phases.has(phaseId)) {
      phases.set(phaseId, {
        phaseId,
        status: sub.status,
        agentId: sub.assigned_agent_id,
        startedAt: sub.status !== "pending" && sub.status !== "blocked" ? sub.created_at : null,
        completedAt: sub.completed_at,
      });
    }
  }

  // Merge fan-out instances
  for (const [phaseId, instances] of fanOutInstances) {
    const base = phases.get(phaseId);
    if (!base) continue;

    const allInstances = [{ index: 0, status: base.status, agentId: base.agentId }, ...instances];
    const total = allInstances.length;
    const doneCount = allInstances.filter((i) => i.status === "done" || i.status === "skipped").length;

    let aggregateStatus: SubTaskStatus = "blocked";
    if (doneCount === total) {
      aggregateStatus = "done";
    } else if (allInstances.some((i) => i.status === "in_progress")) {
      aggregateStatus = "in_progress";
    } else if (allInstances.some((i) => i.status === "pending")) {
      aggregateStatus = "pending";
    }

    phases.set(phaseId, {
      ...base,
      status: aggregateStatus,
      instances: allInstances,
      totalInstances: total,
      doneInstances: doneCount,
    });
  }

  return { taskId, phases };
}

/**
 * Hook that derives execution state from subtasks for a given task.
 * Recomputes when subtasks change (driven by WS updates via useRealtimeSync).
 */
export function useExecutionSync(taskId: string | null, subtasks: SubTask[]): ExecutionState | null {
  return useMemo(() => {
    if (!taskId) return null;
    return buildExecutionState(taskId, subtasks);
  }, [taskId, subtasks]);
}
