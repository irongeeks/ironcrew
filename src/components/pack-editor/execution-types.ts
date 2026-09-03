import type { SubTaskStatus } from "../../types";

export interface PhaseExecutionState {
  phaseId: string;
  status: SubTaskStatus;
  instances?: Array<{ index: number; status: SubTaskStatus; agentId?: string | null }>;
  totalInstances?: number;
  doneInstances?: number;
  agentId?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface ExecutionState {
  taskId: string;
  phases: Map<string, PhaseExecutionState>;
}
