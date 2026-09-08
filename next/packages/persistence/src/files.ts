import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** Set permissions before SQLite can write business data or recover an existing journal. */
export function prepareDatabaseFile(path: string): void {
  if (path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  protectFile(path, true);
  // SQLite creates new journals with the database's mode. Repair old journals first,
  // including a rollback journal left behind by an interrupted older installation.
  for (const suffix of ["-wal", "-shm", "-journal"]) protectFile(path + suffix, false);
}

function protectFile(path: string, create: boolean): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDWR | (create ? constants.O_CREAT : 0) | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Database path must be a regular file");
    // Windows uses directory ACLs; POSIX permission bits cannot express that protection.
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}
