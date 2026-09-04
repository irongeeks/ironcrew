/**
 * IronCrew — backup.
 *
 * Produces one self-contained, verified `.tar.gz` per run: a consistent
 * snapshot of the SQLite database, every attachment blob, and any extra files
 * named by the caller, plus a manifest carrying a SHA-256 for each of them.
 *
 * ## Why not `cp ironcrew.sqlite backup.sqlite`
 *
 * The server runs in WAL mode (`server/db/runtime.ts` sets
 * `PRAGMA journal_mode = WAL`). A live database is therefore *at least* three
 * files — `.sqlite`, `-wal`, `-shm` — and the main file alone is not a
 * database as of any point in time: committed transactions may still live only
 * in the WAL. Copying the main file yields a database missing the newest
 * commits; copying the set with `cp` copies them at three different instants,
 * so the WAL can reference pages the main file does not have yet. Both failure
 * modes are silent. You find out on restore day.
 *
 * `VACUUM INTO 'target'` (SQLite ≥ 3.27) instead asks SQLite itself to write a
 * complete, freshly-packed database file from one read transaction. It sees a
 * single consistent point in time, needs no write access to the source, does
 * not block writers, and the result is a plain single file with no WAL of its
 * own. Verified against `node:sqlite`: `DatabaseSync.exec()` runs it, including
 * on a connection opened with `{ readOnly: true }` — which is what this module
 * does, so a backup can never modify production data.
 *
 * ## Why the snapshot is checked before the archive is published
 *
 * A backup nobody verified is a coin flip you resolve on the worst day.
 * `PRAGMA integrity_check` runs against the finished snapshot and a result
 * other than `ok` fails the whole backup — better a loud failure tonight than
 * a useless archive next quarter. Every file additionally gets a SHA-256 in
 * the manifest, so `restoreBackup()` can prove the archive is intact before it
 * touches anything on the target.
 *
 * ## Format
 *
 * A POSIX ustar tar, gzipped — written by hand here (no tar dependency exists
 * in this repository and none is being added) but deliberately standard, so an
 * admin holding only the archive can fall back on `tar xzf` and get their data
 * out without IronCrew. Entries, in order:
 *
 *   manifest.json          format, timestamps, per-file SHA-256, integrity flag
 *   database.sqlite        the VACUUM INTO snapshot
 *   attachments/<...>      the content-addressed blob store, path-for-path
 *   extras/<...>           extra files/directories the caller named
 *
 * Reading and writing are both streamed, so archive size is bounded by disk,
 * not by heap.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface BackupResult {
  path: string;
  bytes: number;
  databaseBytes: number;
  attachmentCount: number;
  createdAt: number;
  integrityOk: boolean;
}

export interface CreateBackupOptions {
  dbPath: string;
  attachmentsDir?: string;
  extraPaths?: string[];
  outDir: string;
  now?: number;
}

export const BACKUP_FORMAT = "ironcrew-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_NAME = "manifest.json";
export const DATABASE_ENTRY = "database.sqlite";
export const ATTACHMENT_PREFIX = "attachments/";
export const EXTRA_PREFIX = "extras/";

export interface ManifestFile {
  /** Path inside the archive. */
  path: string;
  bytes: number;
  sha256: string;
  /** Absolute path this file was read from, for the admin reading the manifest. */
  source?: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: number;
  createdAtIso: string;
  host: string;
  /** True only if `PRAGMA integrity_check` on the snapshot returned exactly "ok". */
  integrityOk: boolean;
  database: ManifestFile;
  attachments: ManifestFile[];
  extras: ManifestFile[];
  /** Extra paths that were requested but did not exist — recorded, not fatal. */
  skippedExtras: string[];
}

export type BackupErrorCode =
  | "DB_MISSING"
  | "INTEGRITY_FAILED"
  | "PATH_TOO_LONG"
  | "FILE_TOO_LARGE"
  | "ARCHIVE_UNREADABLE"
  | "ARCHIVE_CORRUPT"
  | "MANIFEST_INVALID"
  | "DB_EXISTS"
  | "SNAPSHOT_FAILED";

/**
 * Errors carry a stable `code` so callers (and the CLI) can react to the case
 * rather than to the wording of a message.
 */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackupError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// tar (ustar) writer
// ---------------------------------------------------------------------------

const BLOCK = 512;
/** ustar stores the size as 11 octal digits, so 8 GiB - 1 is the ceiling. */
const MAX_ENTRY_BYTES = 8 ** 11 - 1;

function octalField(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/**
 * ustar splits a long name across `prefix` (155) and `name` (100) at a "/".
 * Attachment keys ("attachments/<companyId>/<64 hex chars>") sit right around
 * the 100-byte mark, so this path is load-bearing, not theoretical.
 */
export function splitTarName(name: string): { prefix: string; rest: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: "", rest: name };
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (rest.length > 0 && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) {
      return { prefix, rest };
    }
  }
  throw new BackupError("PATH_TOO_LONG", `Path does not fit a ustar header: "${name}"`);
}

function tarHeader(name: string, size: number, mtimeSeconds: number): Buffer {
  if (size > MAX_ENTRY_BYTES) {
    throw new BackupError("FILE_TOO_LARGE", `"${name}" is ${size} bytes; the tar entry limit is ${MAX_ENTRY_BYTES}.`);
  }
  const { prefix, rest } = splitTarName(name);
  const block = Buffer.alloc(BLOCK, 0);
  block.write(rest, 0, 100, "utf8");
  block.write(octalField(0o644, 8), 100, 8, "ascii");
  block.write(octalField(0, 8), 108, 8, "ascii");
  block.write(octalField(0, 8), 116, 8, "ascii");
  block.write(octalField(size, 12), 124, 12, "ascii");
  block.write(octalField(Math.max(0, Math.floor(mtimeSeconds)), 12), 136, 12, "ascii");
  // The checksum is computed over a header whose checksum field is spaces.
  block.write("        ", 148, 8, "ascii");
  block.write("0", 156, 1, "ascii"); // typeflag: regular file
  block.write("ustar\0", 257, 6, "latin1");
  block.write("00", 263, 2, "ascii");
  block.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

function padTo512(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export async function sha256File(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Regular files only, relative POSIX paths, sorted. Symlinks are deliberately
 * skipped: following one out of the blob store would put arbitrary filesystem
 * content into a backup that an admin will later unpack somewhere else.
 */
function walkFiles(rootDir: string, rel = ""): string[] {
  const out: string[] = [];
  const dir = rel ? path.join(rootDir, rel) : rootDir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(rootDir, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out.sort();
}

function utcStamp(now: number): string {
  const iso = new Date(now).toISOString();
  return iso.slice(0, 19).replace(/[-:]/g, "") + "Z";
}

/** `ironcrew-backup-20260904T101500Z.tar.gz` — sorts chronologically, which is what `--keep` prunes on. */
export function backupFileName(now: number, suffixIndex = 0): string {
  const suffix = suffixIndex === 0 ? "" : `-${suffixIndex}`;
  return `ironcrew-backup-${utcStamp(now)}${suffix}.tar.gz`;
}

function uniqueArchivePath(outDir: string, now: number): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(outDir, backupFileName(now, i));
    if (!fs.existsSync(candidate)) return candidate;
  }
  // Same second, a thousand times: something is wrong with the caller, not us.
  return path.join(outDir, backupFileName(now, Date.now() % 100000));
}

// ---------------------------------------------------------------------------
// SQLite snapshot
// ---------------------------------------------------------------------------

/**
 * Consistent snapshot of a possibly-live database. Opened read-only, so this
 * cannot write to production even if something below it misbehaves.
 * `targetPath` must not exist — VACUUM INTO refuses an existing file, which is
 * a feature: it can never half-overwrite something.
 */
export function snapshotDatabase(dbPath: string, targetPath: string): void {
  if (!fs.existsSync(dbPath)) {
    throw new BackupError("DB_MISSING", `No database at "${dbPath}".`);
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new BackupError("SNAPSHOT_FAILED", `Could not open "${dbPath}" for reading: ${errText(err)}`, { cause: err });
  }
  try {
    // exec() takes no bindings, so the path goes in as an SQL string literal
    // with doubled quotes — the standard SQLite escape.
    db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } catch (err) {
    throw new BackupError("SNAPSHOT_FAILED", `VACUUM INTO failed for "${dbPath}": ${errText(err)}`, { cause: err });
  } finally {
    db.close();
  }
}

/** `PRAGMA integrity_check` returns exactly one row reading "ok" on a healthy file. */
export function integrityCheck(dbPath: string): boolean {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
    return rows.length === 1 && rows[0]?.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// createBackup
// ---------------------------------------------------------------------------

interface PendingEntry {
  name: string;
  absPath: string;
  bytes: number;
  sha256: string;
  source?: string;
}

export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const now = opts.now ?? Date.now();
  const dbPath = path.resolve(opts.dbPath);
  const outDir = path.resolve(opts.outDir);

  if (!fs.existsSync(dbPath)) {
    throw new BackupError("DB_MISSING", `No database at "${dbPath}".`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  // Staging lives inside outDir so the finished archive is only ever renamed
  // within one filesystem — a rename is atomic, a cross-device copy is not.
  const staging = fs.mkdtempSync(path.join(outDir, ".ironcrew-backup-"));
  try {
    const snapshotPath = path.join(staging, DATABASE_ENTRY);
    snapshotDatabase(dbPath, snapshotPath);

    const integrityOk = integrityCheck(snapshotPath);
    if (!integrityOk) {
      throw new BackupError(
        "INTEGRITY_FAILED",
        `PRAGMA integrity_check did not return "ok" for the snapshot of "${dbPath}". No archive was written.`,
      );
    }

    const databaseBytes = fs.statSync(snapshotPath).size;
    const entries: PendingEntry[] = [];
    const dbEntry: ManifestFile = {
      path: DATABASE_ENTRY,
      bytes: databaseBytes,
      sha256: await sha256File(snapshotPath),
      source: dbPath,
    };
    entries.push({ ...dbEntry, absPath: snapshotPath, name: DATABASE_ENTRY });

    const attachments: ManifestFile[] = [];
    if (opts.attachmentsDir) {
      const root = path.resolve(opts.attachmentsDir);
      if (fs.existsSync(root)) {
        for (const rel of walkFiles(root)) {
          const abs = path.join(root, rel);
          const file: ManifestFile = {
            path: `${ATTACHMENT_PREFIX}${rel}`,
            bytes: fs.statSync(abs).size,
            sha256: await sha256File(abs),
          };
          attachments.push(file);
          entries.push({ ...file, absPath: abs, name: file.path });
        }
      }
    }

    const extras: ManifestFile[] = [];
    const skippedExtras: string[] = [];
    const usedExtraNames = new Set<string>();
    for (const raw of opts.extraPaths ?? []) {
      const abs = path.resolve(raw);
      if (!fs.existsSync(abs)) {
        // Not fatal: a nightly backup must not stop because an optional
        // override file was never created. It is recorded in the manifest so
        // its absence is visible rather than assumed.
        skippedExtras.push(abs);
        continue;
      }
      const label = uniqueName(path.basename(abs) || "extra", usedExtraNames);
      const stat = fs.statSync(abs);
      const files: Array<{ abs: string; name: string }> = stat.isDirectory()
        ? walkFiles(abs).map((rel) => ({ abs: path.join(abs, rel), name: `${EXTRA_PREFIX}${label}/${rel}` }))
        : [{ abs, name: `${EXTRA_PREFIX}${label}` }];
      for (const f of files) {
        const file: ManifestFile = {
          path: f.name,
          bytes: fs.statSync(f.abs).size,
          sha256: await sha256File(f.abs),
          source: f.abs,
        };
        extras.push(file);
        entries.push({ ...file, absPath: f.abs, name: f.name });
      }
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: now,
      createdAtIso: new Date(now).toISOString(),
      host: os.hostname(),
      integrityOk,
      database: dbEntry,
      attachments,
      extras,
      skippedExtras,
    };
    const manifestPath = path.join(staging, MANIFEST_NAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    // The manifest goes first so `tar xzf ... manifest.json` (and any partial
    // read) reaches it immediately.
    const ordered: PendingEntry[] = [
      {
        name: MANIFEST_NAME,
        absPath: manifestPath,
        bytes: fs.statSync(manifestPath).size,
        sha256: await sha256File(manifestPath),
      },
      ...entries,
    ];

    const archivePath = uniqueArchivePath(outDir, now);
    const partPath = `${archivePath}.part`;
    await writeArchive(ordered, partPath, now);
    fs.renameSync(partPath, archivePath);

    return {
      path: archivePath,
      bytes: fs.statSync(archivePath).size,
      databaseBytes,
      attachmentCount: attachments.length,
      createdAt: now,
      integrityOk,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base}-${i++}`;
  used.add(candidate);
  return candidate;
}

async function writeArchive(entries: PendingEntry[], partPath: string, now: number): Promise<void> {
  const mtime = Math.floor(now / 1000);
  await pipeline(
    (async function* () {
      for (const entry of entries) {
        yield tarHeader(entry.name, entry.bytes, mtime);
        let written = 0;
        for await (const chunk of createReadStream(entry.absPath)) {
          written += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
        if (written !== entry.bytes) {
          // The file changed underneath us; a tar with a wrong size field is
          // unreadable, so fail here rather than publish it.
          throw new BackupError(
            "ARCHIVE_CORRUPT",
            `"${entry.absPath}" changed while it was being archived (${entry.bytes} → ${written} bytes).`,
          );
        }
        const pad = padTo512(entry.bytes);
        if (pad > 0) yield Buffer.alloc(pad, 0);
      }
      // Two zero blocks terminate a tar stream.
      yield Buffer.alloc(BLOCK * 2, 0);
    })(),
    createGzip({ level: 6 }),
    createWriteStream(partPath),
  );
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Every archive in `dir` this module would have written, newest name last. */
export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^ironcrew-backup-\d{8}T\d{6}Z(-\d+)?\.tar\.gz$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Keep the newest `keep` archives, delete the rest. `keep <= 0` deletes
 * nothing — an operator typo must never be the thing that empties the backup
 * directory.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const all = listBackups(dir);
  const doomed = all.slice(0, Math.max(0, all.length - Math.floor(keep)));
  for (const file of doomed) fs.rmSync(file, { force: true });
  return doomed;
}
