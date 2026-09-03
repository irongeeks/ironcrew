import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  description: string;
  up(db: DatabaseSync): void;
  /**
   * Set to true for migrations that need to manage their own transaction
   * (e.g. table-rebuild migrations that must toggle PRAGMA foreign_keys
   * outside a transaction per the SQLite recommended pattern). The runner
   * skips its auto-BEGIN/COMMIT wrapper for this migration; the migration
   * itself is responsible for committing before returning.
   */
  managesOwnTransaction?: boolean;
}

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

export function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
    cnt: number;
  };
  return row.cnt > 0;
}

export function hasIndex(db: DatabaseSync, index: string): boolean {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='index' AND name=?").get(index) as {
    cnt: number;
  };
  return row.cnt > 0;
}

export function getTableDdl(db: DatabaseSync, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
    | { sql: string }
    | undefined;
  return (row?.sql ?? "").toLowerCase();
}
