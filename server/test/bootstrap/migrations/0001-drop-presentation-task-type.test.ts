import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migration as dropPresentation } from "../../../modules/bootstrap/migrations/0001-drop-presentation-task-type.ts";
import { getTableDdl, hasColumn } from "../../../modules/bootstrap/migrations/migration-types.ts";
import { runMigrations } from "../../../modules/bootstrap/migrations/runner.ts";

let db: DatabaseSync;

/**
 * Create a minimal `tasks` table shaped like the pre-0001 schema: includes
 * 'presentation' in the task_type CHECK. We bypass base-schema.ts /
 * baseline.up() on purpose — on a fresh install the CHECK is already narrow
 * (base-schema.ts was updated alongside this migration), so the only way to
 * exercise the rewrite path is to simulate a legacy DB.
 */
function createLegacyTasksTable(d: DatabaseSync): void {
  // Stub parent tables — production has these from base-schema; we need them here
  // so CREATE TABLE on the rebuilt tasks (with REFERENCES …) is valid even when
  // foreign_keys enforcement is on (which it is inside the runner's transaction
  // since PRAGMA foreign_keys is a no-op inside a tx).
  d.exec("CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY)");
  d.exec("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY)");
  d.exec("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY)");
  d.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      assigned_agent_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'inbox'
        CHECK(status IN ('inbox','planned','collaborating','in_progress','review','done','cancelled','pending')),
      priority INTEGER DEFAULT 0,
      task_type TEXT DEFAULT 'general'
        CHECK(task_type IN (
          'general','development','design','analysis','presentation','documentation',
          'website_audit','e2e_test','screenshot_comparison','data_extraction',
          'create_mockup','design_system_update','color_palette_generate','typography_review'
        )),
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      workflow_meta_json TEXT,
      output_format TEXT,
      agent_routing TEXT,
      project_path TEXT,
      result TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()*1000),
      updated_at INTEGER DEFAULT (unixepoch()*1000),
      source_task_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      skipped_phases TEXT NOT NULL DEFAULT '[]',
      base_branch TEXT
    )
  `);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  createLegacyTasksTable(db);
});

afterEach(() => {
  db.close();
});

describe("migration 0001 — drop 'presentation' from tasks.task_type CHECK", () => {
  it("has version 1", () => {
    expect(dropPresentation.version).toBe(1);
  });

  it("removes 'presentation' from the tasks CHECK constraint", () => {
    expect(getTableDdl(db, "tasks")).toContain("'presentation'");

    dropPresentation.up(db);

    expect(getTableDdl(db, "tasks")).not.toContain("'presentation'");
  });

  it("is a no-op when the CHECK already lacks 'presentation'", () => {
    // First application narrows the CHECK.
    dropPresentation.up(db);
    const ddlAfterFirst = getTableDdl(db, "tasks");

    // Second application should detect that 'presentation' is already gone
    // and skip the rebuild entirely.
    expect(() => dropPresentation.up(db)).not.toThrow();

    expect(getTableDdl(db, "tasks")).toBe(ddlAfterFirst);
  });

  it("rewrites existing 'presentation' rows to 'documentation'", () => {
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, title, task_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "task-p",
      "old PPT task",
      "presentation",
      now,
      now,
    );
    db.prepare("INSERT INTO tasks (id, title, task_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "task-g",
      "normal task",
      "general",
      now,
      now,
    );

    dropPresentation.up(db);

    const rewritten = db.prepare("SELECT task_type FROM tasks WHERE id = ?").get("task-p") as { task_type: string };
    expect(rewritten.task_type).toBe("documentation");
    const untouched = db.prepare("SELECT task_type FROM tasks WHERE id = ?").get("task-g") as { task_type: string };
    expect(untouched.task_type).toBe("general");
  });

  it("rejects new rows with task_type='presentation' after migration", () => {
    dropPresentation.up(db);
    const now = Date.now();
    expect(() =>
      db
        .prepare("INSERT INTO tasks (id, title, task_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("bad", "bad task", "presentation", now, now),
    ).toThrow();
  });

  it("applies cleanly through runMigrations (no nested-transaction error) [#141]", () => {
    // Regression for #141: the runner wraps each migration in BEGIN/COMMIT,
    // and the migration must not start its own transaction on top.
    expect(() => runMigrations(db, [dropPresentation])).not.toThrow();
    expect(getTableDdl(db, "tasks")).not.toContain("'presentation'");
    const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get() as
      | { version: number }
      | undefined;
    expect(applied?.version).toBe(1);
  });

  it("preserves all task columns expected by downstream code", () => {
    dropPresentation.up(db);
    for (const col of [
      "id",
      "title",
      "description",
      "department_id",
      "assigned_agent_id",
      "project_id",
      "status",
      "priority",
      "task_type",
      "workflow_pack_key",
      "workflow_meta_json",
      "output_format",
      "agent_routing",
      "project_path",
      "result",
      "started_at",
      "completed_at",
      "created_at",
      "updated_at",
      "source_task_id",
      "hidden",
      "skipped_phases",
    ]) {
      expect(hasColumn(db, "tasks", col)).toBe(true);
    }
  });
});
