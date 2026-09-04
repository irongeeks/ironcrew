/**
 * IronCrew — restore.
 *
 * The half of the backup story that decides whether the other half was worth
 * anything. Three rules shape it:
 *
 * 1. **Verify everything before touching anything.** The archive is unpacked
 *    into a staging directory, every entry is checked against the SHA-256 in
 *    the manifest, and `PRAGMA integrity_check` is run on the extracted
 *    database — all of it before a single byte of the target is modified. A
 *    half-restored system is worse than a non-restored one: the non-restored
 *    one still has its old database.
 * 2. **Never overwrite silently.** An existing database aborts the restore
 *    unless `force` is set. Restoring onto a live system is a decision, not a
 *    default.
 * 3. **Never delete what you replace.** With `force`, the existing database —
 *    and its `-wal`/`-shm` siblings, which belong to *that* database and must
 *    not be left beside a different one — is moved to
 *    `<name>.pre-restore-<timestamp>`. Someone who restores last month's
 *    archive onto production by mistake has to be able to get back.
 *
 * Staging lives next to the target database so the final step is a rename
 * within one filesystem; a cross-device fallback exists but is a copy, and a
 * copy is not atomic.
 *
 * Extras are *not* written back to the absolute paths recorded in the
 * manifest. Those paths describe the machine the backup came from, and
 * following them would let an archive write anywhere on this one. They land in
 * `restored-extras-<timestamp>/` beside the database and the admin puts them
 * where they belong — a deliberate manual step for files like
 * `config/private/character-pack.local.yaml`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";

import {
  ATTACHMENT_PREFIX,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  DATABASE_ENTRY,
  EXTRA_PREFIX,
  MANIFEST_NAME,
  errText,
  integrityCheck,
  type BackupManifest,
} from "./backup.ts";

export interface RestoreResult {
  database: boolean;
  attachments: number;
  extras: string[];
}

export interface RestoreBackupOptions {
  backupPath: string;
  dbPath: string;
  attachmentsDir?: string;
  force?: boolean;
}

const BLOCK = 512;

// ---------------------------------------------------------------------------
// tar (ustar) reader — streamed, so a large archive never lands in the heap
// ---------------------------------------------------------------------------

interface TarHeader {
  name: string;
  size: number;
  typeflag: string;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text === "") return 0;
  const value = parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new BackupError("ARCHIVE_CORRUPT", `Unreadable numeric tar header field: "${text}".`);
  }
  return value;
}

function parseTarHeader(block: Buffer): TarHeader {
  // The stored checksum is computed with its own field blanked out.
  const stored = readOctal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (sum !== stored) {
    throw new BackupError("ARCHIVE_CORRUPT", `tar header checksum mismatch (expected ${stored}, computed ${sum}).`);
  }
  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: readOctal(block, 124, 12),
    typeflag: readString(block, 156, 1) || "0",
  };
}

/**
 * Entry names are attacker-influenced the moment an archive comes from
 * somewhere else, so they are validated rather than trusted: relative, no
 * traversal, no drive letters, no backslashes.
 */
function assertSafeEntryName(name: string): void {
  if (
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new BackupError("ARCHIVE_CORRUPT", `Refusing an unsafe path from the archive: "${name}".`);
  }
}

interface ExtractedEntry {
  name: string;
  bytes: number;
  sha256: string;
  absPath: string;
}

async function extractTarGz(archivePath: string, stagingDir: string): Promise<ExtractedEntry[]> {
  const source = createReadStream(archivePath);
  const gunzip = createGunzip();
  // .pipe() does not forward errors; without this a read failure would hang
  // the for-await instead of throwing.
  source.on("error", (err) => gunzip.destroy(err));

  const entries: ExtractedEntry[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let mode: "header" | "data" | "pad" = "header";
  // A separate flag rather than a fourth `mode`: reaching the end-of-archive
  // marker is not another parser state to be in, it is the parser being done.
  // Keeping it out of the union also keeps the narrowing honest — TypeScript
  // could see that nothing inside the state machine ever sets mode to "eof".
  let reachedEof = false;
  let current: {
    name: string;
    size: number;
    remaining: number;
    fd: number;
    hash: ReturnType<typeof createHash>;
  } | null = null;
  let padRemaining = 0;

  const finishEntry = (): void => {
    if (!current) return;
    fs.closeSync(current.fd);
    entries.push({
      name: current.name,
      bytes: current.size,
      sha256: current.hash.digest("hex"),
      absPath: path.join(stagingDir, current.name),
    });
    current = null;
  };

  try {
    for await (const chunk of source.pipe(gunzip)) {
      if (reachedEof) continue;
      pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);

      let progressed = true;
      while (progressed && !reachedEof) {
        progressed = false;

        if (mode === "header") {
          if (pending.length < BLOCK) break;
          const header = pending.subarray(0, BLOCK);
          pending = pending.subarray(BLOCK);
          progressed = true;
          if (isZeroBlock(header)) {
            reachedEof = true;
            break;
          }
          const parsed = parseTarHeader(header);
          if (parsed.typeflag !== "0" && parsed.typeflag !== "\0") {
            throw new BackupError("ARCHIVE_CORRUPT", `Unsupported tar entry type "${parsed.typeflag}".`);
          }
          assertSafeEntryName(parsed.name);
          const target = path.join(stagingDir, parsed.name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          current = {
            name: parsed.name,
            size: parsed.size,
            remaining: parsed.size,
            fd: fs.openSync(target, "w"),
            hash: createHash("sha256"),
          };
          if (parsed.size === 0) {
            finishEntry();
            mode = "header";
          } else {
            mode = "data";
          }
          continue;
        }

        if (mode === "data") {
          if (pending.length === 0 || !current) break;
          const take = Math.min(pending.length, current.remaining);
          const slice = pending.subarray(0, take);
          fs.writeSync(current.fd, slice);
          current.hash.update(slice);
          current.remaining -= take;
          pending = pending.subarray(take);
          progressed = true;
          if (current.remaining === 0) {
            padRemaining = (BLOCK - (current.size % BLOCK)) % BLOCK;
            finishEntry();
            mode = padRemaining > 0 ? "pad" : "header";
          }
          continue;
        }

        if (mode === "pad") {
          if (pending.length === 0) break;
          const take = Math.min(pending.length, padRemaining);
          pending = pending.subarray(take);
          padRemaining -= take;
          progressed = true;
          if (padRemaining === 0) mode = "header";
        }
      }
    }
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError("ARCHIVE_CORRUPT", `Could not read "${archivePath}": ${errText(err)}`, { cause: err });
  } finally {
    if (current) {
      try {
        fs.closeSync(current.fd);
      } catch {
        // best effort — the staging directory is discarded either way
      }
    }
  }

  if (!reachedEof) {
    // A tar stream that stopped mid-entry, or never reached its terminator.
    throw new BackupError("ARCHIVE_CORRUPT", `"${archivePath}" ends mid-archive; it is truncated or damaged.`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function parseManifest(absPath: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (err) {
    throw new BackupError("MANIFEST_INVALID", `${MANIFEST_NAME} is not valid JSON: ${errText(err)}`, { cause: err });
  }
  const manifest = parsed as BackupManifest;
  if (!manifest || typeof manifest !== "object" || manifest.format !== BACKUP_FORMAT) {
    throw new BackupError("MANIFEST_INVALID", `${MANIFEST_NAME} is not an ${BACKUP_FORMAT} manifest.`);
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      "MANIFEST_INVALID",
      `Backup format version ${manifest.formatVersion} cannot be read by this build (expected ${BACKUP_FORMAT_VERSION}).`,
    );
  }
  if (!manifest.database || manifest.database.path !== DATABASE_ENTRY) {
    throw new BackupError("MANIFEST_INVALID", `${MANIFEST_NAME} does not describe a ${DATABASE_ENTRY}.`);
  }
  return manifest;
}

/** Every file the manifest claims must be present, intact, and nothing else may be. */
function verifyAgainstManifest(manifest: BackupManifest, extracted: ExtractedEntry[]): void {
  const found = new Map(extracted.map((entry) => [entry.name, entry]));
  const expected = [manifest.database, ...(manifest.attachments ?? []), ...(manifest.extras ?? [])];

  for (const file of expected) {
    const entry = found.get(file.path);
    if (!entry) {
      throw new BackupError(
        "ARCHIVE_CORRUPT",
        `"${file.path}" is listed in the manifest but missing from the archive.`,
      );
    }
    if (entry.bytes !== file.bytes) {
      throw new BackupError(
        "ARCHIVE_CORRUPT",
        `"${file.path}" is ${entry.bytes} bytes, the manifest says ${file.bytes}.`,
      );
    }
    if (entry.sha256 !== file.sha256) {
      throw new BackupError("ARCHIVE_CORRUPT", `"${file.path}" fails its SHA-256 check; the archive is damaged.`);
    }
  }

  const allowed = new Set([MANIFEST_NAME, ...expected.map((file) => file.path)]);
  for (const entry of extracted) {
    if (!allowed.has(entry.name)) {
      throw new BackupError("ARCHIVE_CORRUPT", `"${entry.name}" is in the archive but not in the manifest.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Filesystem moves
// ---------------------------------------------------------------------------

function stamp(now: number): string {
  return new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

/** rename where possible; a copy is the fallback across filesystems. */
function movePath(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

// ---------------------------------------------------------------------------
// restoreBackup
// ---------------------------------------------------------------------------

export async function restoreBackup(opts: RestoreBackupOptions): Promise<RestoreResult> {
  const archivePath = path.resolve(opts.backupPath);
  const dbPath = path.resolve(opts.dbPath);
  const force = opts.force === true;

  if (!fs.existsSync(archivePath)) {
    throw new BackupError("ARCHIVE_UNREADABLE", `No backup archive at "${archivePath}".`);
  }

  // Cheap pre-flight so the common mistake fails in a second rather than
  // after unpacking a multi-gigabyte archive. The same check is repeated
  // below, immediately before the move, because time passes in between.
  if (fs.existsSync(dbPath) && !force) {
    throw new BackupError(
      "DB_EXISTS",
      `"${dbPath}" already exists. Restoring over it needs force; the existing file is then kept as .pre-restore-<timestamp>.`,
    );
  }

  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dbDir, ".ironcrew-restore-"));

  try {
    const extracted = await extractTarGz(archivePath, staging);

    const manifestEntry = extracted.find((entry) => entry.name === MANIFEST_NAME);
    if (!manifestEntry) {
      throw new BackupError("MANIFEST_INVALID", `"${archivePath}" contains no ${MANIFEST_NAME}.`);
    }
    const manifest = parseManifest(manifestEntry.absPath);
    verifyAgainstManifest(manifest, extracted);

    const stagedDb = path.join(staging, DATABASE_ENTRY);
    if (!integrityCheck(stagedDb)) {
      throw new BackupError(
        "INTEGRITY_FAILED",
        `The database in "${archivePath}" fails PRAGMA integrity_check. Nothing on the target was changed.`,
      );
    }

    // --- everything above this line is read-only with respect to the target --

    if (fs.existsSync(dbPath) && !force) {
      throw new BackupError("DB_EXISTS", `"${dbPath}" already exists. Restoring over it needs force.`);
    }

    const now = Date.now();
    const suffix = `.pre-restore-${stamp(now)}`;
    if (fs.existsSync(dbPath)) {
      // The -wal/-shm files belong to the database being replaced. Leaving
      // them beside a different file is how a restored database gets a
      // journal that does not describe it.
      for (const sibling of ["", "-wal", "-shm", "-journal"]) {
        const from = `${dbPath}${sibling}`;
        if (fs.existsSync(from)) movePath(from, `${from}${suffix}`);
      }
    }
    movePath(stagedDb, dbPath);

    let attachments = 0;
    if (opts.attachmentsDir) {
      const root = path.resolve(opts.attachmentsDir);
      for (const file of manifest.attachments ?? []) {
        const rel = file.path.slice(ATTACHMENT_PREFIX.length);
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Blobs are content-addressed, so an existing file with this name has
        // these exact bytes; overwriting is a no-op either way.
        movePath(path.join(staging, file.path), target);
        attachments++;
      }
    }

    const extras: string[] = [];
    if ((manifest.extras ?? []).length > 0) {
      const extrasDir = path.join(dbDir, `restored-extras-${stamp(now)}`);
      for (const file of manifest.extras) {
        const rel = file.path.slice(EXTRA_PREFIX.length);
        const target = path.join(extrasDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        movePath(path.join(staging, file.path), target);
        extras.push(target);
      }
    }

    return { database: true, attachments, extras };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Read-only inspection: verify an archive end to end without restoring it.
 * This is the "test a restore without touching production" primitive — and
 * the thing a cron job should run occasionally, because an archive nobody has
 * ever opened is not a backup.
 */
export async function inspectBackup(archivePath: string): Promise<BackupManifest> {
  const abs = path.resolve(archivePath);
  if (!fs.existsSync(abs)) {
    throw new BackupError("ARCHIVE_UNREADABLE", `No backup archive at "${abs}".`);
  }
  const staging = fs.mkdtempSync(path.join(path.dirname(abs), ".ironcrew-verify-"));
  try {
    const extracted = await extractTarGz(abs, staging);
    const manifestEntry = extracted.find((entry) => entry.name === MANIFEST_NAME);
    if (!manifestEntry) {
      throw new BackupError("MANIFEST_INVALID", `"${abs}" contains no ${MANIFEST_NAME}.`);
    }
    const manifest = parseManifest(manifestEntry.absPath);
    verifyAgainstManifest(manifest, extracted);
    if (!integrityCheck(path.join(staging, DATABASE_ENTRY))) {
      throw new BackupError("INTEGRITY_FAILED", `The database in "${abs}" fails PRAGMA integrity_check.`);
    }
    return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
