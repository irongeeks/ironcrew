/**
 * Inter-Agent Context Sharing
 *
 * Builds a prompt block containing summaries from related completed tasks,
 * so agents have context from prior work in the same project or department.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

type RelatedTask = {
  id: string;
  title: string;
  assigned_agent_id: string | null;
  result: string | null;
  completed_at: number | null;
};

const MAX_RELATED_TASKS = 3;
const MAX_LOG_TAIL_CHARS = 500;
const MAX_RESULT_CHARS = 300;

/**
 * Build a context block for a task based on related completed tasks.
 * Returns an empty string if no relevant context is found.
 */
export function buildRelatedTaskContextBlock(
  db: DbLike,
  task: {
    id: string;
    project_id?: string | null;
    source_task_id?: string | null;
    department_id?: string | null;
    workflow_pack_key?: string | null;
  },
  logsDir: string,
): string {
  const related: RelatedTask[] = [];
  const seenIds = new Set<string>();
  seenIds.add(task.id);

  // 1. Parent/sibling tasks via source_task_id
  if (task.source_task_id) {
    const siblings = db
      .prepare(
        `SELECT id, title, assigned_agent_id, result, completed_at
         FROM tasks
         WHERE source_task_id = ? AND id != ? AND status = 'done'
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(task.source_task_id, task.id, MAX_RELATED_TASKS) as RelatedTask[];
    for (const t of siblings) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        related.push(t);
      }
    }

    // Also fetch parent task itself
    const parent = db
      .prepare(
        `SELECT id, title, assigned_agent_id, result, completed_at
         FROM tasks
         WHERE id = ? AND status = 'done'`,
      )
      .get(task.source_task_id) as RelatedTask | undefined;
    if (parent && !seenIds.has(parent.id)) {
      seenIds.add(parent.id);
      related.push(parent);
    }
  }

  // 2. Tasks in same project that completed recently
  if (task.project_id && related.length < MAX_RELATED_TASKS) {
    const limit = MAX_RELATED_TASKS - related.length;
    const projectTasks = db
      .prepare(
        `SELECT id, title, assigned_agent_id, result, completed_at
         FROM tasks
         WHERE project_id = ? AND id != ? AND status = 'done'
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(task.project_id, task.id, limit) as RelatedTask[];
    for (const t of projectTasks) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        related.push(t);
      }
    }
  }

  // 3. Same department, recent completions (fallback)
  if (related.length === 0 && task.department_id) {
    const deptTasks = db
      .prepare(
        `SELECT id, title, assigned_agent_id, result, completed_at
         FROM tasks
         WHERE department_id = ? AND id != ? AND status = 'done'
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(task.department_id, task.id, MAX_RELATED_TASKS) as RelatedTask[];
    for (const t of deptTasks) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        related.push(t);
      }
    }
  }

  if (related.length === 0) return "";

  // Build context block
  const entries: string[] = [];
  for (const r of related.slice(0, MAX_RELATED_TASKS)) {
    const agentName = r.assigned_agent_id
      ? ((db.prepare("SELECT name FROM agents WHERE id = ?").get(r.assigned_agent_id) as { name?: string } | undefined)
          ?.name ?? "Unknown")
      : "Unknown";

    let summary = "";
    // Try task result first
    if (r.result) {
      summary = r.result.length > MAX_RESULT_CHARS ? r.result.slice(-MAX_RESULT_CHARS) : r.result;
    } else {
      // Fallback: read last N chars from log file (tail-read to avoid loading entire file)
      const logFile = path.join(logsDir, `${r.id}.log`);
      try {
        const fd = fs.openSync(logFile, "r");
        try {
          const stat = fs.fstatSync(fd);
          const readStart = Math.max(0, stat.size - MAX_LOG_TAIL_CHARS);
          const buf = Buffer.alloc(Math.min(MAX_LOG_TAIL_CHARS, stat.size));
          fs.readSync(fd, buf, 0, buf.length, readStart);
          summary = buf.toString("utf-8").trim();
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // ignore log read errors
      }
    }

    if (summary) {
      entries.push(`- "${r.title}" (by ${agentName}): ${summary}`);
    } else {
      entries.push(`- "${r.title}" (by ${agentName}): completed`);
    }
  }

  return [
    "",
    "## Related Work Context",
    "The following tasks were recently completed in the same project/department:",
    ...entries,
    "Use this context to maintain consistency and avoid duplicating work.",
    "",
  ].join("\n");
}
