import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRelatedTaskContextBlock } from "./context-sharing.ts";

type TaskInsert = {
  id: string;
  title: string;
  status?: string;
  source_task_id?: string | null;
  project_id?: string | null;
  department_id?: string | null;
  assigned_agent_id?: string | null;
  result?: string | null;
  completed_at?: number | null;
};

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      source_task_id TEXT,
      project_id TEXT,
      department_id TEXT,
      assigned_agent_id TEXT,
      result TEXT,
      completed_at INTEGER
    );
  `);
  return db;
}

function insertAgent(db: DatabaseSync, id: string, name: string): void {
  db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(id, name);
}

function insertTask(db: DatabaseSync, t: TaskInsert): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, source_task_id, project_id, department_id, assigned_agent_id, result, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.title,
    t.status ?? "done",
    t.source_task_id ?? null,
    t.project_id ?? null,
    t.department_id ?? null,
    t.assigned_agent_id ?? null,
    t.result ?? null,
    t.completed_at ?? null,
  );
}

describe("buildRelatedTaskContextBlock", () => {
  let db: DatabaseSync;
  let tmpLogs: string;

  beforeEach(() => {
    db = setupDb();
    tmpLogs = fs.mkdtempSync(path.join(os.tmpdir(), "ctxshare-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpLogs, { recursive: true, force: true });
  });

  it("returns empty string when no related tasks exist", () => {
    const out = buildRelatedTaskContextBlock(db, { id: "t1", project_id: "p1", department_id: "d1" }, tmpLogs);
    expect(out).toBe("");
  });

  it("returns empty string when task has no project/department/source", () => {
    insertTask(db, { id: "other", title: "Other", project_id: "p1" });
    const out = buildRelatedTaskContextBlock(db, { id: "t1" }, tmpLogs);
    expect(out).toBe("");
  });

  it("includes sibling tasks via source_task_id with agent name and result", () => {
    insertAgent(db, "a1", "Alice");
    insertTask(db, {
      id: "sib1",
      title: "Sibling One",
      source_task_id: "parent1",
      assigned_agent_id: "a1",
      result: "Did the thing.",
      completed_at: 100,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toContain("## Related Work Context");
    expect(out).toContain('"Sibling One" (by Alice): Did the thing.');
    expect(out).toContain("Use this context to maintain consistency");
  });

  it("includes parent task itself when status=done", () => {
    insertTask(db, {
      id: "parent1",
      title: "Parent Task",
      status: "done",
      result: "Parent result",
      completed_at: 50,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toContain('"Parent Task" (by Unknown): Parent result');
  });

  it("excludes parent task when not done", () => {
    insertTask(db, {
      id: "parent1",
      title: "Parent Pending",
      status: "in_progress",
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toBe("");
  });

  it("does not duplicate parent if already pulled in via siblings query", () => {
    insertTask(db, {
      id: "parent1",
      title: "Parent",
      status: "done",
      result: "P",
      completed_at: 10,
    });
    insertTask(db, {
      id: "sib1",
      title: "Sib",
      source_task_id: "parent1",
      result: "S",
      completed_at: 20,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    const matches = out.match(/"Parent"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(out).toContain('"Sib"');
  });

  it("falls back to project tasks when source_task_id has no siblings", () => {
    insertTask(db, {
      id: "p-other",
      title: "Project Task",
      project_id: "proj1",
      result: "Project work done",
      completed_at: 200,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", project_id: "proj1" }, tmpLogs);
    expect(out).toContain('"Project Task" (by Unknown): Project work done');
  });

  it("falls back to department tasks only when no source/project matches found", () => {
    insertTask(db, {
      id: "d-other",
      title: "Dept Task",
      department_id: "dept1",
      result: "Dept output",
      completed_at: 300,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", department_id: "dept1" }, tmpLogs);
    expect(out).toContain('"Dept Task" (by Unknown): Dept output');
  });

  it("does NOT use department fallback when project tasks were found", () => {
    insertTask(db, {
      id: "p-task",
      title: "Project Has",
      project_id: "proj1",
      result: "p",
      completed_at: 100,
    });
    insertTask(db, {
      id: "d-task",
      title: "Dept Has",
      department_id: "dept1",
      result: "d",
      completed_at: 200,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", project_id: "proj1", department_id: "dept1" }, tmpLogs);
    expect(out).toContain('"Project Has"');
    expect(out).not.toContain('"Dept Has"');
  });

  it("limits to MAX_RELATED_TASKS (3) results", () => {
    for (let i = 0; i < 6; i++) {
      insertTask(db, {
        id: `s${i}`,
        title: `Sib ${i}`,
        source_task_id: "parent1",
        result: `r${i}`,
        completed_at: 100 + i,
      });
    }
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    const bulletCount = (out.match(/^- "/gm) ?? []).length;
    expect(bulletCount).toBe(3);
  });

  it("truncates result to last MAX_RESULT_CHARS (300) characters", () => {
    const longResult = "X".repeat(50) + "Y".repeat(350);
    insertTask(db, {
      id: "s1",
      title: "Long",
      source_task_id: "parent1",
      result: longResult,
      completed_at: 100,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toContain("Y");
    // The leading 'X' run should be sliced out
    expect(out).not.toMatch(/X{40,}/);
    // Find the entry line and assert its summary length is <= 300
    const line = out.split("\n").find((l) => l.startsWith('- "Long"'))!;
    const summary = line.split("): ")[1] ?? "";
    expect(summary.length).toBeLessThanOrEqual(300);
  });

  it("reads log tail when result is null", () => {
    const head = "A".repeat(800);
    const tail = "LOGTAIL_MARKER";
    const content = head + tail;
    insertTask(db, {
      id: "s1",
      title: "FromLog",
      source_task_id: "parent1",
      result: null,
      completed_at: 100,
    });
    fs.writeFileSync(path.join(tmpLogs, "s1.log"), content, "utf-8");
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toContain("LOGTAIL_MARKER");
    expect(out).toContain('"FromLog"');
  });

  it("reads entire log when smaller than MAX_LOG_TAIL_CHARS", () => {
    insertTask(db, {
      id: "s1",
      title: "Small",
      source_task_id: "parent1",
      result: null,
      completed_at: 100,
    });
    fs.writeFileSync(path.join(tmpLogs, "s1.log"), "tiny content", "utf-8");
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toContain("tiny content");
  });

  it("falls back to 'completed' marker when result is null and log file missing", () => {
    insertTask(db, {
      id: "s1",
      title: "NoLog",
      source_task_id: "parent1",
      result: null,
      completed_at: 100,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toContain('"NoLog" (by Unknown): completed');
  });

  it("uses 'Unknown' when assigned_agent_id is set but agent row missing", () => {
    insertTask(db, {
      id: "s1",
      title: "GhostAgent",
      source_task_id: "parent1",
      assigned_agent_id: "missing-agent",
      result: "ok",
      completed_at: 100,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toContain('"GhostAgent" (by Unknown): ok');
  });

  it("excludes the task itself from results (id != ?)", () => {
    insertTask(db, {
      id: "self",
      title: "Self",
      source_task_id: "parent1",
      result: "self-result",
      completed_at: 100,
    });
    insertTask(db, {
      id: "other",
      title: "Other",
      source_task_id: "parent1",
      result: "other-result",
      completed_at: 90,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "self", source_task_id: "parent1" }, tmpLogs);
    expect(out).not.toContain('"Self"');
    expect(out).toContain('"Other"');
  });

  it("orders sibling results by completed_at DESC", () => {
    insertTask(db, {
      id: "old",
      title: "Old",
      source_task_id: "parent1",
      result: "o",
      completed_at: 1,
    });
    insertTask(db, {
      id: "new",
      title: "New",
      source_task_id: "parent1",
      result: "n",
      completed_at: 999,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out.indexOf('"New"')).toBeLessThan(out.indexOf('"Old"'));
  });

  it("combines siblings and project tasks up to limit, deduplicating", () => {
    insertTask(db, {
      id: "shared",
      title: "Shared",
      source_task_id: "parent1",
      project_id: "proj1",
      result: "s",
      completed_at: 200,
    });
    insertTask(db, {
      id: "p1",
      title: "ProjOnly",
      project_id: "proj1",
      result: "p",
      completed_at: 150,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1", project_id: "proj1" }, tmpLogs);
    const sharedCount = (out.match(/"Shared"/g) ?? []).length;
    expect(sharedCount).toBe(1);
    expect(out).toContain('"ProjOnly"');
  });

  it("ignores tasks with status != 'done'", () => {
    insertTask(db, {
      id: "wip",
      title: "InProgress",
      status: "in_progress",
      source_task_id: "parent1",
      result: "x",
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    expect(out).toBe("");
  });

  it("returns block ending with empty string and consistency note", () => {
    insertTask(db, {
      id: "s1",
      title: "S1",
      source_task_id: "parent1",
      result: "r",
      completed_at: 100,
    });
    const out = buildRelatedTaskContextBlock(db, { id: "t1", source_task_id: "parent1" }, tmpLogs);
    const lines = out.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("## Related Work Context");
    expect(lines[lines.length - 1]).toBe("");
    expect(out).toContain("Use this context to maintain consistency and avoid duplicating work.");
  });
});
