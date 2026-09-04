/**
 * The half that matters on the worst day.
 *
 * Two properties are worth more than everything else here: a restore verifies
 * the archive *before* it touches the target, and it never destroys what it
 * replaces. Someone restoring the wrong backup onto a live system has to be
 * able to get back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { TaskStore } from "../domain/task-store.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { BackupError, createBackup } from "./backup.ts";
import { inspectBackup, restoreBackup } from "./restore.ts";

/**
 * These tests run against a real file, not `:memory:`, and that is the whole
 * point: an in-memory database cannot be snapshotted from outside the process
 * holding it, so a backup tested against one would test nothing.
 *
 * The price is real disk work per test — `createTestDb(dbPath)` applies every
 * migration to a fresh file, each with its own fsync, and `snapshotDatabase`
 * then runs `VACUUM INTO`. Locally that is roughly 200 ms a test; on a shared
 * CI runner under v8 coverage instrumentation it is several times that, and
 * vitest's 5-second default is not a bound that describes what these tests do.
 * It went red the moment the migration list grew by two.
 *
 * So the bound is stated here rather than left at a default that happens to
 * fit on a fast machine. It is not a device for hiding a slow test: nothing is
 * skipped, every assertion still runs, and a genuine hang still fails the
 * suite — just after twenty seconds rather than five.
 */
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

let workdir: string;
let dbPath: string;
let outDir: string;
let companyId: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-restore-"));
  dbPath = path.join(workdir, "ironcrew.sqlite");
  outDir = path.join(workdir, "backups");
  fs.mkdirSync(outDir, { recursive: true });
});

afterEach(() => fs.rmSync(workdir, { recursive: true, force: true }));

function seedDatabase(titles: string[]): void {
  const db = createTestDb(dbPath);
  companyId = seedCompany(db);
  seedAgent(db, companyId);
  const tasks = new TaskStore(db);
  for (const title of titles) tasks.create({ companyId, title, status: "ready" });
  db.close();
}

function titlesIn(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT title FROM crew_tasks ORDER BY title").all() as Array<{ title: string }>;
  db.close();
  return rows.map((r) => r.title);
}

describe("a full round trip", () => {
  it("restores the rows that were there", async () => {
    seedDatabase(["Alpha", "Beta", "Gamma"]);
    const backup = await createBackup({ dbPath, outDir });

    const target = path.join(workdir, "restored.sqlite");
    const result = await restoreBackup({ backupPath: backup.path, dbPath: target });

    expect(result.database).toBe(true);
    expect(titlesIn(target)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("keeps the audit chain verifiable", async () => {
    seedDatabase(["Alpha"]);
    const backup = await createBackup({ dbPath, outDir });

    const target = path.join(workdir, "restored.sqlite");
    await restoreBackup({ backupPath: backup.path, dbPath: target });

    const db = new DatabaseSync(target);
    // Any altered byte in any audited row breaks this, which is why it is the
    // check worth running after a restore rather than a row count.
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    db.close();
  });

  it("round-trips attachments with their contents", async () => {
    seedDatabase(["Alpha"]);
    const attachments = path.join(workdir, "attachments");
    fs.mkdirSync(path.join(attachments, "de"), { recursive: true });
    fs.writeFileSync(path.join(attachments, "de", "blob.bin"), "geheimer inhalt");

    const backup = await createBackup({ dbPath, outDir, attachmentsDir: attachments });
    const targetAttachments = path.join(workdir, "restored-attachments");
    const result = await restoreBackup({
      backupPath: backup.path,
      dbPath: path.join(workdir, "restored.sqlite"),
      attachmentsDir: targetAttachments,
    });

    expect(result.attachments).toBe(1);
    expect(fs.readFileSync(path.join(targetAttachments, "de", "blob.bin"), "utf-8")).toBe("geheimer inhalt");
  });

  it("restores a backup taken while the database was open and still being written", async () => {
    const db = createTestDb(dbPath);
    companyId = seedCompany(db);
    seedAgent(db, companyId);
    const tasks = new TaskStore(db);
    tasks.create({ companyId, title: "Vorher", status: "ready" });

    const backup = await createBackup({ dbPath, outDir });
    tasks.create({ companyId, title: "Nachher", status: "ready" });
    db.close();

    const target = path.join(workdir, "restored.sqlite");
    await restoreBackup({ backupPath: backup.path, dbPath: target });

    // A point in time, not a moving target: the row written after the
    // snapshot must not be in it.
    expect(titlesIn(target)).toEqual(["Vorher"]);
  });
});

describe("it never destroys what it replaces", () => {
  it("refuses to overwrite an existing database without force", async () => {
    seedDatabase(["Alpha"]);
    const backup = await createBackup({ dbPath, outDir });

    await expect(restoreBackup({ backupPath: backup.path, dbPath })).rejects.toBeInstanceOf(BackupError);
    // And the live database is untouched.
    expect(titlesIn(dbPath)).toEqual(["Alpha"]);
  });

  it("moves the existing database aside when forced, rather than deleting it", async () => {
    seedDatabase(["Alt"]);
    const backup = await createBackup({ dbPath, outDir });

    // A different database now lives at the target path — the "wrong restore"
    // situation this rule exists for. Removed first, because re-running the
    // migrations over an already-migrated file is not what a fresh install does.
    fs.rmSync(dbPath);
    seedDatabase(["Neu"]);

    await restoreBackup({ backupPath: backup.path, dbPath, force: true });
    expect(titlesIn(dbPath)).toEqual(["Alt"]);

    // Somebody who restored the wrong backup has to be able to get back.
    const asideNames = fs.readdirSync(workdir).filter((f) => f.includes("pre-restore"));
    expect(asideNames.length).toBeGreaterThan(0);
    expect(titlesIn(path.join(workdir, asideNames[0]))).toEqual(["Neu"]);
  });
});

describe("it verifies before it touches anything", () => {
  it("refuses a truncated archive and leaves the target unchanged", async () => {
    seedDatabase(["Alpha"]);
    const backup = await createBackup({ dbPath, outDir });

    const truncated = path.join(workdir, "kaputt.tar");
    const whole = fs.readFileSync(backup.path);
    fs.writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));

    const target = path.join(workdir, "ziel.sqlite");
    fs.writeFileSync(target, "unveraendert");

    await expect(restoreBackup({ backupPath: truncated, dbPath: target, force: true })).rejects.toBeInstanceOf(
      BackupError,
    );
    // A half-restored system is worse than a non-restored one.
    expect(fs.readFileSync(target, "utf-8")).toBe("unveraendert");
  });

  it("refuses an archive whose contents do not match its manifest", async () => {
    seedDatabase(["Alpha"]);
    const backup = await createBackup({ dbPath, outDir });

    const tampered = fs.readFileSync(backup.path);
    // Flip bytes deep inside the payload, past the headers.
    const at = Math.floor(tampered.length * 0.6);
    tampered[at] = tampered[at] ^ 0xff;
    const tamperedPath = path.join(workdir, "manipuliert.tar");
    fs.writeFileSync(tamperedPath, tampered);

    const target = path.join(workdir, "ziel.sqlite");
    await expect(restoreBackup({ backupPath: tamperedPath, dbPath: target })).rejects.toBeInstanceOf(BackupError);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses a file that is not an archive at all", async () => {
    const notAnArchive = path.join(workdir, "notiz.txt");
    fs.writeFileSync(notAnArchive, "nur text");
    await expect(
      restoreBackup({ backupPath: notAnArchive, dbPath: path.join(workdir, "z.sqlite") }),
    ).rejects.toBeInstanceOf(BackupError);
  });

  it("refuses a backup that does not exist", async () => {
    await expect(
      restoreBackup({ backupPath: path.join(workdir, "weg.tar"), dbPath: path.join(workdir, "z.sqlite") }),
    ).rejects.toBeInstanceOf(BackupError);
  });
});

describe("inspecting without restoring", () => {
  it("reads the manifest so an admin can check before committing", async () => {
    seedDatabase(["Alpha"]);
    const backup = await createBackup({ dbPath, outDir, now: 1_700_000_000_000 });

    const manifest = await inspectBackup(backup.path);
    expect(manifest.createdAt).toBe(1_700_000_000_000);
    expect(manifest.integrityOk).toBe(true);
    expect(manifest.database.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
