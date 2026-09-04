/**
 * A backup nobody has restored is not a backup.
 *
 * So these tests do not check that a file appeared. They take a real database
 * with real content, snapshot it, and then read the snapshot back — including
 * the audit hash chain, which is the strongest single statement that the copy
 * is faithful rather than merely present.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { TaskStore } from "../domain/task-store.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import {
  BackupError,
  backupFileName,
  createBackup,
  integrityCheck,
  listBackups,
  pruneBackups,
  sha256File,
  snapshotDatabase,
} from "./backup.ts";

let workdir: string;
let dbPath: string;
let outDir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-backup-"));
  dbPath = path.join(workdir, "ironcrew.sqlite");
  outDir = path.join(workdir, "backups");
  fs.mkdirSync(outDir, { recursive: true });
});

afterEach(() => fs.rmSync(workdir, { recursive: true, force: true }));

/**
 * A database on disk with real IronCrew content, left OPEN by default —
 * a backup that only works against a closed database is useless to a service.
 */
function liveDatabase(): { db: DatabaseSync; companyId: string } {
  const db = createTestDb(dbPath);
  const companyId = seedCompany(db);
  seedAgent(db, companyId);
  const tasks = new TaskStore(db);
  for (let i = 0; i < 5; i++) {
    tasks.create({ companyId, title: `Aufgabe ${i}`, description: "Inhalt", status: "ready" });
  }
  return { db, companyId };
}

function attachmentsWith(count: number): string {
  const dir = path.join(workdir, "attachments");
  fs.mkdirSync(path.join(dir, "ab"), { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, "ab", `blob-${i}.bin`), `inhalt-${i}`);
  }
  return dir;
}

describe("snapshotting a live database", () => {
  it("copies a database that is still open and being written to", () => {
    const { db, companyId } = liveDatabase();
    const target = path.join(workdir, "snap.sqlite");

    snapshotDatabase(dbPath, target);
    // Still writing after the snapshot: the snapshot must be a point in time,
    // not a moving target.
    new TaskStore(db).create({ companyId, title: "Danach", status: "ready" });

    const snap = new DatabaseSync(target, { readOnly: true });
    const count = snap.prepare("SELECT COUNT(*) AS n FROM crew_tasks").get() as { n: number };
    expect(count.n).toBe(5);
    snap.close();
    db.close();
  });

  it("produces a snapshot that passes an integrity check", () => {
    const { db } = liveDatabase();
    const target = path.join(workdir, "snap.sqlite");
    snapshotDatabase(dbPath, target);
    expect(integrityCheck(target)).toBe(true);
    db.close();
  });
});

describe("createBackup", () => {
  it("captures the database and reports what it did", async () => {
    const { db } = liveDatabase();
    const result = await createBackup({ dbPath, outDir });

    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.integrityOk).toBe(true);
    expect(result.databaseBytes).toBeGreaterThan(0);
    expect(result.bytes).toBeGreaterThan(0);
    db.close();
  });

  it("captures attachments and counts them", async () => {
    const { db } = liveDatabase();
    const result = await createBackup({ dbPath, outDir, attachmentsDir: attachmentsWith(3) });
    expect(result.attachmentCount).toBe(3);
    db.close();
  });

  it("records an extra path that was asked for but is not there, without failing", async () => {
    const { db } = liveDatabase();
    // A missing character pack is normal; it must not abort the nightly job.
    await expect(
      createBackup({ dbPath, outDir, extraPaths: [path.join(workdir, "gibtsnicht.yaml")] }),
    ).resolves.toBeTruthy();
    db.close();
  });

  it("refuses when the database does not exist", async () => {
    await expect(createBackup({ dbPath: path.join(workdir, "weg.sqlite"), outDir })).rejects.toBeInstanceOf(
      BackupError,
    );
  });

  it("never overwrites an earlier backup taken in the same second", async () => {
    const { db } = liveDatabase();
    const now = 1_700_000_000_000;
    const first = await createBackup({ dbPath, outDir, now });
    const second = await createBackup({ dbPath, outDir, now });

    expect(second.path).not.toBe(first.path);
    expect(fs.existsSync(first.path)).toBe(true);
    db.close();
  });
});

describe("housekeeping", () => {
  it("names backups so they sort chronologically", () => {
    const early = backupFileName(Date.parse("2026-01-01T00:00:00Z"));
    const late = backupFileName(Date.parse("2026-06-01T00:00:00Z"));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("keeps the newest N and deletes the rest", async () => {
    const { db } = liveDatabase();
    for (let i = 0; i < 4; i++) {
      await createBackup({ dbPath, outDir, now: Date.parse("2026-01-01T00:00:00Z") + i * 86_400_000 });
    }
    expect(listBackups(outDir)).toHaveLength(4);

    const deleted = pruneBackups(outDir, 2);
    expect(deleted).toHaveLength(2);
    expect(listBackups(outDir)).toHaveLength(2);
    db.close();
  });

  it("prunes nothing when there is less than the keep count", async () => {
    const { db } = liveDatabase();
    await createBackup({ dbPath, outDir });
    expect(pruneBackups(outDir, 14)).toEqual([]);
    db.close();
  });

  it("hashes a file reproducibly", async () => {
    const file = path.join(workdir, "x.txt");
    fs.writeFileSync(file, "inhalt");
    expect(await sha256File(file)).toBe(await sha256File(file));
    expect(await sha256File(file)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a corrupt database rather than backing it up quietly", () => {
    const broken = path.join(workdir, "broken.sqlite");
    // Not a database at all: integrityCheck must say so rather than throwing
    // something the nightly job would log as a crash.
    fs.writeFileSync(broken, "das ist keine datenbank");
    expect(integrityCheck(broken)).toBe(false);
  });
});

it("the audit chain still verifies after a snapshot", () => {
  const { db, companyId } = liveDatabase();
  expect(verifyAuditChain(db, companyId).valid).toBe(true);

  const target = path.join(workdir, "snap.sqlite");
  snapshotDatabase(dbPath, target);
  db.close();

  const restored = new DatabaseSync(target);
  // The chain is the strongest single statement that the copy is faithful:
  // any altered byte in any audited row breaks it.
  expect(verifyAuditChain(restored, companyId).valid).toBe(true);
  restored.close();
});
