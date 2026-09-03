import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { hasColumn, hasTable, hasIndex } from "../../../modules/bootstrap/migrations/migration-types.ts";
import { runMigrations } from "../../../modules/bootstrap/migrations/runner.ts";
import type { Migration } from "../../../modules/bootstrap/migrations/migration-types.ts";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE test_table (id TEXT PRIMARY KEY, name TEXT)");
  db.exec("CREATE INDEX idx_test ON test_table(name)");
});

afterEach(() => {
  db.close();
});

describe("hasColumn", () => {
  it("returns true for existing column", () => {
    expect(hasColumn(db, "test_table", "name")).toBe(true);
  });

  it("returns false for non-existing column", () => {
    expect(hasColumn(db, "test_table", "email")).toBe(false);
  });

  it("returns false for non-existing table", () => {
    expect(hasColumn(db, "no_table", "id")).toBe(false);
  });
});

describe("hasTable", () => {
  it("returns true for existing table", () => {
    expect(hasTable(db, "test_table")).toBe(true);
  });

  it("returns false for non-existing table", () => {
    expect(hasTable(db, "no_table")).toBe(false);
  });
});

describe("hasIndex", () => {
  it("returns true for existing index", () => {
    expect(hasIndex(db, "idx_test")).toBe(true);
  });

  it("returns false for non-existing index", () => {
    expect(hasIndex(db, "idx_nope")).toBe(false);
  });
});

// --- Runner tests ---

describe("runMigrations", () => {
  it("creates schema_migrations table and applies all migrations", () => {
    const migrations: Migration[] = [
      { version: 1, description: "add col a", up: (d) => d.exec("ALTER TABLE test_table ADD COLUMN a TEXT") },
      { version: 2, description: "add col b", up: (d) => d.exec("ALTER TABLE test_table ADD COLUMN b TEXT") },
    ];

    runMigrations(db, migrations);

    expect(hasColumn(db, "test_table", "a")).toBe(true);
    expect(hasColumn(db, "test_table", "b")).toBe(true);

    const applied = db.prepare("SELECT version, description FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
      description: string;
    }>;
    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ version: 1, description: "add col a" });
    expect(applied[1]).toMatchObject({ version: 2, description: "add col b" });
  });

  it("skips already-applied migrations", () => {
    const counter = { calls: 0 };
    const migrations: Migration[] = [
      {
        version: 1,
        description: "first",
        up: (d) => {
          counter.calls++;
          d.exec("ALTER TABLE test_table ADD COLUMN first TEXT");
        },
      },
      {
        version: 2,
        description: "second",
        up: (d) => {
          counter.calls++;
          d.exec("ALTER TABLE test_table ADD COLUMN second TEXT");
        },
      },
    ];

    runMigrations(db, migrations);
    expect(counter.calls).toBe(2);

    // Run again — should skip both
    counter.calls = 0;
    runMigrations(db, migrations);
    expect(counter.calls).toBe(0);
  });

  it("rolls back and throws on migration failure", () => {
    const migrations: Migration[] = [
      { version: 1, description: "good", up: (d) => d.exec("ALTER TABLE test_table ADD COLUMN good TEXT") },
      {
        version: 2,
        description: "bad",
        up: () => {
          throw new Error("simulated failure");
        },
      },
    ];

    expect(() => runMigrations(db, migrations)).toThrow("simulated failure");

    // Version 1 should be applied (committed before version 2 failed)
    expect(hasColumn(db, "test_table", "good")).toBe(true);
    const applied = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    expect(applied).toHaveLength(1);
    expect(applied[0]!.version).toBe(1);
  });

  it("detects existing DB and inserts baseline when schema_migrations does not exist", () => {
    const migrations: Migration[] = [
      { version: 0, description: "baseline", up: () => {} },
      { version: 1, description: "new feature", up: (d) => d.exec("ALTER TABLE test_table ADD COLUMN feat TEXT") },
    ];

    runMigrations(db, migrations);

    const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    expect(applied).toHaveLength(2);
    expect(applied[0]!.version).toBe(0);
    expect(applied[1]!.version).toBe(1);
  });

  it("works with empty migration list", () => {
    runMigrations(db, []);
    expect(hasTable(db, "schema_migrations")).toBe(true);
  });
});
