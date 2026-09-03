export const REPORT_FLOW_PREFIX = "[REPORT FLOW]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readReportFlowValue(description: string | null | undefined, key: string): string | null {
  const source = String(description ?? "");
  const re = new RegExp(`${escapeRegExp(REPORT_FLOW_PREFIX)}\\s*${escapeRegExp(key)}=([^\\n\\r]+)`, "i");
  const m = source.match(re);
  return m ? m[1].trim() : null;
}

export function upsertReportFlowValue(description: string | null | undefined, key: string, value: string): string {
  const source = String(description ?? "");
  const line = `${REPORT_FLOW_PREFIX} ${key}=${value}`;
  const re = new RegExp(`${escapeRegExp(REPORT_FLOW_PREFIX)}\\s*${escapeRegExp(key)}=[^\\n\\r]*`, "i");
  if (re.test(source)) return source.replace(re, line);
  return source.trimEnd() ? `${source.trimEnd()}\n${line}` : line;
}

export function isReportRequestTask(
  task: { task_type?: string | null; description?: string | null } | null | undefined,
): boolean {
  if (!task) return false;
  const taskType = String(task.task_type ?? "");
  if (taskType !== "documentation") return false;
  return /\[REPORT REQUEST\]/i.test(String(task.description ?? ""));
}

export function extractReportPathByLabel(description: string | null | undefined, label: string): string | null {
  const desc = String(description ?? "");
  const re = new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, "im");
  const m = desc.match(re);
  if (!m?.[1]) return null;
  const value = m[1].trim();
  return value || null;
}
