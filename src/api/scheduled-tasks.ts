import { del, post, put, request } from "./core";

const BASE = "/api/ops/scheduled-tasks";

export interface ScheduledTask {
  id: string;
  title: string;
  description: string;
  cron_expression: string;
  timezone: string;
  workflow_pack_key: string | null;
  project_path: string | null;
  department_id: string | null;
  priority: number;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ScheduledTaskInput {
  title: string;
  description?: string;
  cron_expression: string;
  timezone?: string;
  workflow_pack_key?: string | null;
  project_path?: string | null;
  department_id?: string | null;
  priority?: number;
  enabled?: boolean;
}

export interface ScheduleHistoryEntry {
  id: string;
  title: string;
  status: string;
  priority: number;
  created_at: number;
  completed_at: number | null;
}

export function fetchScheduledTasks(): Promise<ScheduledTask[]> {
  return request<ScheduledTask[]>(BASE);
}

export function createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
  return post<ScheduledTask>(BASE, input);
}

export function updateScheduledTask(id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
  return put<ScheduledTask>(`${BASE}/${id}`, input);
}

export function deleteScheduledTask(id: string): Promise<void> {
  return del<void>(`${BASE}/${id}`);
}

export function toggleScheduledTask(id: string): Promise<ScheduledTask> {
  return post<ScheduledTask>(`${BASE}/${id}/toggle`);
}

export function triggerScheduledTask(id: string): Promise<{ ok: boolean; task_id?: string }> {
  return post<{ ok: boolean; task_id?: string }>(`${BASE}/${id}/trigger`);
}

export function fetchScheduleHistory(id: string, limit = 20): Promise<ScheduleHistoryEntry[]> {
  return request<ScheduleHistoryEntry[]>(`${BASE}/${id}/history?limit=${limit}`);
}
