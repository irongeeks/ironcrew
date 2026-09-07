import { spawn, execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as tar from "tar";
import { z } from "zod";
import { confinedFile, hashFile, OperationError, safeRelative } from "./common.ts";
import { prepareRecovery, type RecoveryReport } from "./recovery.ts";

export const AGE_VERSION = "1.3.2";
const fileSchema = z
  .object({
    path: z.string().refine(safeRelative),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const backupManifestSchema = z
  .object({
    format: z.literal("ironcrew-backup"),
    formatVersion: z.literal(1),
    appVersion: z.string().min(1),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    complete: z.literal(true),
    files: z.array(fileSchema).max(100000),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export interface BackupOptions {
  databasePath: string;
  blobDirectory: string;
  outputDirectory: string;
  recipient: string;
  ageExecutable: string;
  appVersion: string;
  configuration: Record<string, unknown>;
  /** Must freeze new writes and blob GC until release; offline CLI uses the exclusive instance lock. */
  quiesce: () => Promise<() => Promise<void>>;
  snapshotDatabase?: (destination: string) => Promise<void>;
}
export interface BackupResult {
  archivePath: string;
  sha256: string;
  manifest: BackupManifest;
}
export async function assertAge(executable: string): Promise<void> {
  if (!path.isAbsolute(executable))
    throw new OperationError("age_configuration", "age benötigt einen absoluten, geprüften Programmpfad.");
  const version = await new Promise<string>((resolve, reject) =>
    execFile(executable, ["--version"], { timeout: 15000, maxBuffer: 1024, env: {} }, (error, stdout) =>
      error ? reject(new OperationError("age_unavailable", "age ist nicht verfügbar.")) : resolve(stdout.trim()),
    ),
  );
  if (version !== AGE_VERSION && version !== `v${AGE_VERSION}`)
    throw new OperationError("age_version", `age ${AGE_VERSION} ist erforderlich.`);
}
function safeConfiguration(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) safeConfiguration(entry);
    return;
  }
  if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      if (/password|secret|token|private.?key|api.?key/i.test(key) && !/ref$/i.test(key) && key !== "tokenId")
        throw new OperationError("raw_secret", "Sicherungskonfiguration darf keine rohen Secrets enthalten.");
      safeConfiguration(entry);
    }
}
function checkDatabase(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new OperationError("integrity", "SQLite-Integritätsprüfung fehlgeschlagen.");
    if (db.prepare("SELECT version FROM schema_version").get()?.version !== 1)
      throw new OperationError("schema", "Unbekannte SQLite-Schemaversion.");
  } finally {
    db.close();
  }
}
async function regularFiles(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safeRelative(name) || entry.isSymbolicLink())
      throw new OperationError("unsafe_path", "Blobablage enthält unsichere Pfade.");
    if (entry.isDirectory()) result.push(...(await regularFiles(root, name)));
    else if (entry.isFile()) result.push(name);
    else throw new OperationError("unsafe_path", "Blobablage enthält eine nicht reguläre Datei.");
  }
  return result;
}
async function agePipeline(
  executable: string,
  args: string[],
  input: AsyncIterable<Uint8Array | string>,
  output?: NodeJS.WritableStream,
): Promise<void> {
  const child = spawn(executable, args, { env: {}, stdio: ["pipe", output ? "pipe" : "ignore", "ignore"] });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new OperationError("age_failed", "age konnte nicht gestartet werden.")));
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new OperationError(
              "age_failed",
              "Verschlüsselung/Entschlüsselung fehlgeschlagen. Schlüssel und Archiv prüfen.",
            ),
          ),
    );
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  try {
    await Promise.all([pipeline(input, child.stdin!), ...(output ? [pipeline(child.stdout!, output)] : []), completed]);
  } catch {
    child.kill("SIGKILL");
    await completed.catch(() => undefined);
    throw new OperationError(
      "age_failed",
      "Verschlüsselung/Entschlüsselung fehlgeschlagen. Schlüssel und Archiv prüfen.",
    );
  } finally {
    clearTimeout(timer);
  }
}
export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  await assertAge(options.ageExecutable);
  safeConfiguration(options.configuration);
  if (!/^age1[a-z0-9]{50,}$/.test(options.recipient))
    throw new OperationError("recipient", "Ein öffentlicher age-Empfängerschlüssel ist erforderlich.");
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(options.outputDirectory, ".backup-"));
  await chmod(staging, 0o700);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await options.quiesce();
    const snapshot = path.join(staging, "database.sqlite");
    if (options.snapshotDatabase) await options.snapshotDatabase(snapshot);
    else {
      const db = new DatabaseSync(options.databasePath, { readOnly: true });
      try {
        db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
    }
    await chmod(snapshot, 0o600);
    checkDatabase(snapshot);
    await writeFile(path.join(staging, "configuration.json"), JSON.stringify(options.configuration), { mode: 0o600 });
    const files = ["database.sqlite", "configuration.json"];
    // Provider identities are operational configuration too; preserve only known secret-reference files.
    for (const name of ["channel-config.json"]) {
      try {
        const file = await confinedFile(path.dirname(options.databasePath), name);
        const data = JSON.parse(await readFile(file, "utf8"));
        safeConfiguration(data);
        await writeFile(path.join(staging, name), JSON.stringify(data), { mode: 0o600 });
        files.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const relative of await regularFiles(options.blobDirectory)) {
      const source = await confinedFile(options.blobDirectory, relative);
      const destination = path.join(staging, "blobs", relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      files.push(`blobs/${relative}`);
    }
    // Working files are part of company recovery, not just final immutable blobs.
    for (const category of ["workspaces", "sites"] as const) {
      const sourceRoot = path.join(path.dirname(options.databasePath), category);
      let exists = true;
      try {
        await stat(sourceRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
        else throw error;
      }
      if (!exists) continue;
      for (const relative of await regularFiles(sourceRoot)) {
        const source = await confinedFile(sourceRoot, relative);
        const destination = path.join(staging, category, relative);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(source, destination);
        await chmod(destination, 0o600);
        files.push(`${category}/${relative}`);
      }
    }
    const manifest: BackupManifest = {
      format: "ironcrew-backup",
      formatVersion: 1,
      appVersion: options.appVersion,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      complete: true,
      files: await Promise.all(
        files.map(async (relative) => ({
          path: relative,
          bytes: (await stat(path.join(staging, relative))).size,
          sha256: await hashFile(path.join(staging, relative)),
        })),
      ),
    };
    await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const archivePath = path.join(
      options.outputDirectory,
      `ironcrew-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.tar.age`,
    );
    const partial = path.join(staging, "archive.partial.age");
    const pack = tar.c({ cwd: staging, portable: true, noMtime: true, strict: true }, ["manifest.json", ...files]);
    await agePipeline(options.ageExecutable, ["--recipient", options.recipient, "--output", partial], pack);
    await chmod(partial, 0o600);
    await rename(partial, archivePath);
    return { archivePath, sha256: await hashFile(archivePath), manifest };
  } finally {
    try {
      await release?.();
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
export interface RestoreOptions {
  archivePath: string;
  identityPath: string;
  ageExecutable: string;
  targetDirectory: string;
  maxPlaintextBytes?: number;
  maxFileBytes?: number;
  beforeActivate: (stagedDirectory: string) => Promise<void>;
  prepareRecovery?: (databasePath: string) => Promise<RecoveryReport>;
  /** Existing target ownership is preserved; fresh installs may specify the dedicated service uid/gid. */
  owner?: { uid: number; gid: number };
}
export interface RestoreResult {
  targetDirectory: string;
  previousDirectory?: string;
  manifest: BackupManifest;
  recovery: RecoveryReport;
}
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  await assertAge(options.ageExecutable);
  const target = path.resolve(options.targetDirectory);
  if (target === path.parse(target).root)
    throw new OperationError("target", "Root-Verzeichnis ist kein Wiederherstellungsziel.");
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".restore-"));
  await chmod(staging, 0o700);
  let previousDirectory: string | undefined;
  try {
    const plaintext = path.join(staging, "archive.tar");
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > (options.maxPlaintextBytes ?? 2 * 1024 * 1024 * 1024))
          callback(new OperationError("archive_limit", "Entschlüsseltes Archiv ist zu groß."));
        else callback(null, chunk);
      },
    });
    const writer = createWriteStream(plaintext, { mode: 0o600 });
    const output = pipeline(limiter, writer);
    // Attach rejection handler immediately; pipeline may fail before the age process exits.
    void output.catch(() => undefined);
    await agePipeline(
      options.ageExecutable,
      ["--decrypt", "--identity", options.identityPath],
      createReadStream(options.archivePath),
      limiter,
    );
    await output;
    const seen = new Set<string>();
    let issue: string | undefined;
    let total = 0;
    await tar.t({
      file: plaintext,
      strict: true,
      onReadEntry(entry) {
        const name = entry.path.replace(/\/$/, "");
        const key = name.toLowerCase();
        if (!safeRelative(name) || !["File", "Directory"].includes(entry.type) || seen.has(key))
          issue = "Unsicherer, doppelter oder verknüpfter Archivpfad.";
        seen.add(key);
        total += entry.size;
        if (
          entry.size > (options.maxFileBytes ?? 512 * 1024 * 1024) ||
          total > (options.maxPlaintextBytes ?? 2 * 1024 * 1024 * 1024) ||
          seen.size > 100002
        )
          issue = "Archiv überschreitet Größen- oder Dateilimit.";
        entry.resume();
      },
    });
    if (issue) throw new OperationError("unsafe_archive", issue);
    const extracted = path.join(staging, "data");
    await mkdir(extracted, { mode: 0o700 });
    await tar.x({
      file: plaintext,
      cwd: extracted,
      strict: true,
      preservePaths: false,
      noChmod: true,
      noMtime: true,
      preserveOwner: false,
      umask: 0o077,
    });
    const manifestFile = await confinedFile(extracted, "manifest.json");
    if ((await stat(manifestFile)).size > 16 * 1024 * 1024)
      throw new OperationError("manifest_limit", "Backupmanifest ist zu groß.");
    let manifest: BackupManifest;
    try {
      manifest = backupManifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
    } catch {
      throw new OperationError("manifest", "Backupmanifest ist ungültig.");
    }
    const expected = new Set(["manifest.json"]);
    for (const entry of manifest.files) {
      if (expected.has(entry.path)) throw new OperationError("manifest", "Doppelter Manifesteintrag.");
      expected.add(entry.path);
      const file = await confinedFile(extracted, entry.path);
      if ((await stat(file)).size !== entry.bytes || (await hashFile(file)) !== entry.sha256)
        throw new OperationError("hash", "Backupdatei stimmt nicht mit dem Manifest überein.");
    }
    for (const name of await regularFiles(extracted))
      if (!expected.has(name)) throw new OperationError("manifest", "Archiv enthält eine nicht manifestierte Datei.");
    if (!expected.has("database.sqlite") || !expected.has("configuration.json"))
      throw new OperationError("manifest", "Datenbank oder Konfiguration fehlt im Backup.");
    const database = path.join(extracted, "database.sqlite");
    checkDatabase(database);
    safeConfiguration(JSON.parse(await readFile(path.join(extracted, "configuration.json"), "utf8")));
    if (expected.has("channel-config.json"))
      safeConfiguration(JSON.parse(await readFile(path.join(extracted, "channel-config.json"), "utf8")));
    const recovery = await (options.prepareRecovery ?? prepareRecovery)(database);
    checkDatabase(database);
    await rename(database, path.join(extracted, "company.sqlite"));
    await writeFile(path.join(extracted, "recovery-report.json"), JSON.stringify(recovery, null, 2), { mode: 0o600 });
    let owner = options.owner;
    if (!owner) {
      try {
        const existing = await lstat(target);
        owner = { uid: existing.uid, gid: existing.gid };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (owner && process.platform !== "win32") {
      const fixOwnership = async (directory: string): Promise<void> => {
        await chown(directory, owner!.uid, owner!.gid);
        await chmod(directory, 0o700);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await fixOwnership(file);
          else {
            await chown(file, owner!.uid, owner!.gid);
            await chmod(file, 0o600);
          }
        }
      };
      await fixOwnership(extracted);
    }
    await options.beforeActivate(extracted);
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isDirectory())
        throw new OperationError("target", "Ziel ist kein reguläres Datenverzeichnis.");
      previousDirectory = `${target}.before-recovery-${randomUUID()}`;
      await rename(target, previousDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(extracted, target);
    } catch (error) {
      if (previousDirectory) await rename(previousDirectory, target);
      throw error;
    }
    return { targetDirectory: target, previousDirectory, manifest, recovery };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
