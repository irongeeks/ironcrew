// server/modules/bootstrap/migrations/0001-drop-presentation-task-type.ts
//
// Drop 'presentation' from tasks.task_type CHECK constraint.
// After the PPT feature removal, no production code produces task_type='presentation'.
// Keeping it in the CHECK list creates silent-failure risk.
//
// SQLite doesn't support ALTER TABLE ... DROP CHECK, so we rebuild the table
// per the SQLite recommended pattern (https://sqlite.org/lang_altertable.html):
//   1. PRAGMA foreign_keys = OFF        (must be OUTSIDE any transaction)
//   2. BEGIN
//   3. Create new table with narrowed CHECK
//   4. Copy rows (rewriting 'presentation' rows to 'documentation')
//   5. Drop old, rename new -> tasks
//   6. COMMIT
//   7. PRAGMA foreign_keys = ON         (must be OUTSIDE the transaction)
//   8. Recreate the indexes that were attached to tasks
//
// Because the PRAGMA must be set outside any transaction, this migration sets
// `managesOwnTransaction: true` so the runner does NOT auto-wrap up() in its
// own BEGIN/COMMIT — that would defeat the PRAGMA (it's a no-op inside a tx)
// and force FK validation against legacy data the migration is rebuilding
// (#141).

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { getTableDdl } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

export const migration: Migration = {
  version: 1,
  description: "Drop 'presentation' from tasks.task_type CHECK constraint",
  managesOwnTransaction: true,
  up(db: DatabaseSync): void {
    const ddl = getTableDdl(db, "tasks");
    // Idempotency: if the CHECK list no longer contains 'presentation' we're done.
    // getTableDdl() returns lowercased text.
    if (!ddl.includes("'presentation'")) {
      log.debug("migration 0001: 'presentation' already absent from tasks CHECK, skipping");
      return;
    }

    // Count any rows that would be rewritten so operators can see the impact.
    const rewriteCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE task_type = 'presentation'").get() as { cnt: number }
    ).cnt;
    if (rewriteCount > 0) {
      log.warn(
        { count: rewriteCount },
        "migration 0001: found tasks with task_type='presentation', rewriting to 'documentation'",
      );
    }

    const newTable = "tasks_drop_presentation_new";

    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN");
      try {
        db.exec(`DROP TABLE IF EXISTS ${newTable}`);
        db.exec(`
          CREATE TABLE ${newTable} (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            department_id TEXT REFERENCES departments(id),
            assigned_agent_id TEXT REFERENCES agents(id),
            project_id TEXT REFERENCES projects(id),
            status TEXT NOT NULL DEFAULT 'inbox'
              CHECK(status IN ('inbox','planned','collaborating','in_progress','review','done','cancelled','pending')),
            priority INTEGER DEFAULT 0,
            task_type TEXT DEFAULT 'general'
              CHECK(task_type IN (
                'general',
                'development',
                'design',
                'analysis',
                'documentation',
                'website_audit',
                'e2e_test',
                'screenshot_comparison',
                'data_extraction',
                'create_mockup',
                'design_system_update',
                'color_palette_generate',
                'typography_review'
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

        // Copy, remapping 'presentation' -> 'documentation'. Use a dynamic column
        // list so we don't break if optional columns (e.g. base_branch, hidden)
        // are absent on this DB.
        const oldCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
        const has = (name: string) => oldCols.some((c) => c.name === name);
        const col = (name: string, fallback: string) => (has(name) ? name : fallback);

        db.exec(`
          INSERT INTO ${newTable} (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_meta_json,
            output_format, agent_routing, project_path, result, started_at,
            completed_at, created_at, updated_at, source_task_id, hidden,
            skipped_phases, base_branch
          )
          SELECT
            id, title, description, department_id, assigned_agent_id,
            ${col("project_id", "NULL")},
            status, priority,
            CASE WHEN task_type = 'presentation' THEN 'documentation' ELSE task_type END,
            ${col("workflow_pack_key", "'development'")},
            ${col("workflow_meta_json", "NULL")},
            ${col("output_format", "NULL")},
            ${col("agent_routing", "NULL")},
            project_path, result, started_at, completed_at, created_at, updated_at,
            ${col("source_task_id", "NULL")},
            ${col("hidden", "0")},
            ${col("skipped_phases", "'[]'")},
            ${col("base_branch", "NULL")}
          FROM tasks
        `);

        db.exec("DROP TABLE tasks");
        db.exec(`ALTER TABLE ${newTable} RENAME TO tasks`);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // best-effort rollback
        }
        throw err;
      }
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }

    // Re-create indexes that were attached to the tasks table.
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_dept ON tasks(department_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, updated_at DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workflow_pack ON tasks(workflow_pack_key, updated_at DESC)");

    log.info({ rewritten: rewriteCount }, "migration 0001 applied: tasks.task_type narrowed (presentation removed)");
  },
};
