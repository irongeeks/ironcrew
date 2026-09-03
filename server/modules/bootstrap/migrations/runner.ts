import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

export function runMigrations(db: DatabaseSync, migrations: Migration[]): void {
  // 1. Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER DEFAULT (unixepoch()*1000)
    )
  `);

  // 2. Read highest applied version
  const row = db.prepare("SELECT MAX(version) AS max_version FROM schema_migrations").get() as {
    max_version: number | null;
  };
  const highestApplied = row.max_version ?? -1;

  // 3. Filter and sort pending migrations
  const pending = migrations.filter((m) => m.version > highestApplied).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    log.info({ highestApplied, total: migrations.length }, "all migrations already applied");
    return;
  }

  log.info({ pending: pending.length, highestApplied }, "applying pending migrations");

  // 4. Apply each migration in its own transaction
  const insertStmt = db.prepare("INSERT INTO schema_migrations (version, description) VALUES (?, ?)");

  for (const migration of pending) {
    log.info({ version: migration.version, description: migration.description }, "applying migration");
    if (migration.managesOwnTransaction) {
      // Migration owns its tx (e.g. table-rebuild migrations that must toggle
      // PRAGMA foreign_keys outside a tx, per SQLite recommended pattern). It
      // must have committed by the time up() returns.
      try {
        migration.up(db);
        insertStmt.run(migration.version, migration.description);
        log.info({ version: migration.version, description: migration.description }, "migration applied");
      } catch (err) {
        log.fatal(
          { version: migration.version, description: migration.description, err },
          "migration failed — server cannot start",
        );
        throw err;
      }
      continue;
    }
    try {
      db.exec("BEGIN");
      migration.up(db);
      insertStmt.run(migration.version, migration.description);
      db.exec("COMMIT");
      log.info({ version: migration.version, description: migration.description }, "migration applied");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort rollback
      }
      log.fatal(
        { version: migration.version, description: migration.description, err },
        "migration failed — server cannot start",
      );
      throw err;
    }
  }
}
