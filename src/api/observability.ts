import { request } from "./core";

const BASE = "/api/ops/observability";

export interface ObsLogEntry {
  id: number;
  level: number;
  module: string | null;
  message: string;
  data: string | null;
  logged_at: number;
}

export interface ObsSpan {
  id: string;
  trace_id: string;
  task_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: string;
  status: string;
  start_time: number;
  end_time: number | null;
  attributes: string | null;
  events: string | null;
}

export interface ObsTraceRow extends ObsSpan {
  span_count: number;
}

export interface ObsMetricRow {
  id: number;
  name: string;
  type: string;
  value: number;
  labels: string | null;
  recorded_at: number;
}

export interface ObsMetricHourlyRow {
  id: number;
  name: string;
  type: string;
  labels: string | null;
  hour: number;
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export async function fetchLogs(params: {
  limit?: number;
  offset?: number;
  level?: number;
  module?: string;
  search?: string;
  since?: number;
  until?: number;
}): Promise<{ logs: ObsLogEntry[]; total: number; limit: number; offset: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return request(`${BASE}/logs?${qs}`);
}

export async function fetchTraces(params: {
  limit?: number;
  offset?: number;
}): Promise<{ traces: ObsTraceRow[]; limit: number; offset: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return request(`${BASE}/traces?${qs}`);
}

export async function fetchTraceDetail(traceId: string): Promise<{ trace_id: string; spans: ObsSpan[] }> {
  return request(`${BASE}/traces/${encodeURIComponent(traceId)}`);
}

export async function fetchMetricsSummary(since?: number): Promise<{ since: number; summary: Record<string, number> }> {
  const qs = since ? `?since=${since}` : "";
  return request(`${BASE}/metrics/summary${qs}`);
}

export async function fetchMetricTimeSeries(
  name: string,
  since?: number,
  until?: number,
): Promise<{ name: string; since: number; until: number; resolution: string; data: ObsMetricRow[] }> {
  const qs = new URLSearchParams();
  if (since) qs.set("since", String(since));
  if (until) qs.set("until", String(until));
  return request(`${BASE}/metrics/${encodeURIComponent(name)}?${qs}`);
}
