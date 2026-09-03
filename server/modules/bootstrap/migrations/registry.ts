import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migration-types.ts";
import { migration as baseline } from "./0000-baseline.ts";
import { migration as m0001DropPresentationTaskType } from "./0001-drop-presentation-task-type.ts";
import { migration as m0002IronCommandDomain } from "./0002-iron-command-domain.ts";
import { migration as m0003IcMilestones } from "./0003-ic-milestones.ts";

// Import future migrations here:
// import { migration as m0004 } from "./0004-example.ts";

/**
 * Entry in the registry — pairs each Migration with the on-disk filename that
 * declares it. The filename is used by the startup auto-scan (below) to detect
 * migration files that exist on disk but were never added to the registry.
 */
interface MigrationEntry {
  filename: string;
  migration: Migration;
}

const MIGRATION_ENTRIES: MigrationEntry[] = [
  { filename: "0000-baseline.ts", migration: baseline },
  { filename: "0001-drop-presentation-task-type.ts", migration: m0001DropPresentationTaskType },
  { filename: "0002-iron-command-domain.ts", migration: m0002IronCommandDomain },
  { filename: "0003-ic-milestones.ts", migration: m0003IcMilestones },
];

export function validateMigrations(migrations: Migration[]): void {
  const seen = new Set<number>();
  let prev = -Infinity;
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`);
    }
    if (m.version < prev) {
      throw new Error(`Migration versions not in ascending order: ${m.version} after ${prev}`);
    }
    seen.add(m.version);
    prev = m.version;
  }
}

/**
 * Scans the migrations directory for `NNNN-*.ts` files and throws if any such
 * file exists on disk but is absent from `registered`. Catches the common
 * "forgot to register the migration" bug at startup.
 *
 * Exported for test use. Skips test files (`*.test.ts`), `registry.ts`,
 * `runner.ts`, and `migration-types.ts`.
 */
export function assertAllMigrationFilesRegistered(migrationsDir: string, registered: Iterable<string>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(migrationsDir);
  } catch {
    // If the directory can't be read (e.g. bundled/built distribution), skip.
    return;
  }

  const migrationFilePattern = /^\d{4}-[a-z0-9-]+\.ts$/i;
  const onDisk = entries.filter((f) => migrationFilePattern.test(f) && !f.endsWith(".test.ts"));
  const registeredSet = new Set(registered);

  for (const f of onDisk) {
    if (!registeredSet.has(f)) {
      throw new Error(
        `Migration file ${f} exists on disk but is not registered in registry.ts — add an import + MIGRATION_ENTRIES entry, or rename it.`,
      );
    }
  }
}

// --- startup-time sanity checks ---

const allMigrations: Migration[] = MIGRATION_ENTRIES.map((e) => e.migration);
validateMigrations(allMigrations);

// Auto-scan: warn/throw if a NNNN-*.ts file exists on disk but was never added
// to MIGRATION_ENTRIES. Only run when we can resolve the directory (not when
// loaded in a test-only bundle).
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assertAllMigrationFilesRegistered(
    here,
    MIGRATION_ENTRIES.map((e) => e.filename),
  );
} catch (err) {
  // If the error is our own "not registered" error, let it propagate so it's
  // loud at startup. Any other error (e.g. fileURLToPath failure in a
  // non-file-URL context) is silently ignored.
  if (err instanceof Error && err.message.startsWith("Migration file ")) {
    throw err;
  }
}

export { allMigrations, MIGRATION_ENTRIES };
