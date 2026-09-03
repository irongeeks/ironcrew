import { LEVEL_LABELS, LEVEL_COLORS } from "./constants";
import type { ObsMetricRow } from "../../../api/observability";

export function levelLabel(level: number): string {
  return LEVEL_LABELS[level] ?? `L${level}`;
}

export function levelColor(level: number): string {
  if (level >= 50) return LEVEL_COLORS[50]!;
  if (level >= 40) return LEVEL_COLORS[40]!;
  if (level >= 30) return LEVEL_COLORS[30]!;
  return LEVEL_COLORS[20]!;
}

// ---- Status helpers ----

export function statusColor(status: string): string {
  switch (status) {
    case "ok":
      return "#22c55e";
    case "error":
      return "#ef4444";
    case "timeout":
      return "#fbbf24";
    default:
      return "#9ca3af";
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatTime(epoch: number): string {
  return new Date(epoch).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Aggregate raw metric rows into hourly buckets for charting.
 *  Uses epoch-based key for correct chronological sorting, with display label including date. */
export function aggregateToHourlyBuckets(rows: ObsMetricRow[], _since: number): Array<{ time: string; value: number }> {
  // Key by truncated hour epoch (ms) for correct grouping; map to display label + sum
  const buckets = new Map<number, { label: string; value: number }>();
  for (const row of rows) {
    const d = new Date(row.recorded_at);
    const hourEpoch = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    const label =
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const existing = buckets.get(hourEpoch);
    if (existing) {
      existing.value += row.value;
    } else {
      buckets.set(hourEpoch, { label, value: row.value });
    }
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, { label, value }]) => ({ time: label, value }));
}

export function mergeWorkflowBuckets(
  started: Array<{ time: string; value: number }>,
  completed: Array<{ time: string; value: number }>,
): Array<{ time: string; started: number; completed: number }> {
  const map = new Map<string, { started: number; completed: number }>();
  for (const s of started) {
    map.set(s.time, { started: s.value, completed: 0 });
  }
  for (const c of completed) {
    const existing = map.get(c.time);
    if (existing) {
      existing.completed = c.value;
    } else {
      map.set(c.time, { started: 0, completed: c.value });
    }
  }
  // Input arrays are already sorted chronologically by aggregateToHourlyBuckets.
  // Collect all unique time keys in order of first appearance, preserving chronological sort.
  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const s of started) {
    if (!seen.has(s.time)) {
      orderedKeys.push(s.time);
      seen.add(s.time);
    }
  }
  for (const c of completed) {
    if (!seen.has(c.time)) {
      orderedKeys.push(c.time);
      seen.add(c.time);
    }
  }
  return orderedKeys.map((time) => ({ time, ...(map.get(time) ?? { started: 0, completed: 0 }) }));
}
