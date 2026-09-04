#!/usr/bin/env node
// scripts/ironcrew-backup.mjs
//
// IronCrew backup and restore, for cron and for the day something went wrong.
//
// Deliberately a thin shell around server/ironcrew/backup/: the logic — the
// online snapshot, the integrity check, the manifest, the refusal to overwrite
// — lives there where it is covered by tests. A CLI that reimplemented any of
// it would be the untested copy that runs at 3am.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveDbPath, announceLegacyDbPath } from "./lib/db-path.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// The backup modules are TypeScript, so this script re-executes itself under
// tsx when it was started as plain node. Doing it here rather than telling the
// admin to remember a flag matters: this is the script someone runs from a
// rescue shell at 3am, and `node scripts/ironcrew-backup.mjs` has to work.
if (!process.env.IRONCREW_BACKUP_TSX) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, IRONCREW_BACKUP_TSX: "1" }, cwd: repoRoot },
  );
  process.exit(result.status ?? 1);
}

const USAGE = `IronCrew Backup

  node scripts/ironcrew-backup.mjs --out <dir> [options]
  node scripts/ironcrew-backup.mjs --restore <archive> --db <pfad> [--force]
  node scripts/ironcrew-backup.mjs --inspect <archive>

Optionen:
  --out <dir>          Zielverzeichnis für das Backup
  --db <pfad>          Datenbank (Standard: $DB_PATH, sonst ./ironcrew.sqlite,
                       ./octooffice.sqlite oder ./data/ironcrew.sqlite)
  --attachments <dir>  Anhang-Verzeichnis (Standard: neben der Datenbank)
  --extra <pfad>       Zusätzliche Datei/Verzeichnis, mehrfach erlaubt
  --keep <n>           Nur die neuesten n Backups behalten
  --restore <archiv>   Wiederherstellen statt sichern
  --inspect <archiv>   Nur das Manifest anzeigen, nichts anfassen
  --force              Vorhandene Datenbank überschreiben (wird beiseitegelegt)
  -h, --help           Diese Hilfe
`;

function parseArgs(argv) {
  const opts = { extras: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const needsValue = (name) => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Option ${name} braucht einen Wert.`);
      }
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--out":
        opts.out = needsValue(arg);
        break;
      case "--db":
        opts.db = needsValue(arg);
        break;
      case "--attachments":
        opts.attachments = needsValue(arg);
        break;
      case "--extra":
        opts.extras.push(needsValue(arg));
        break;
      case "--keep":
        opts.keep = Number(needsValue(arg));
        break;
      case "--restore":
        opts.restore = needsValue(arg);
        break;
      case "--inspect":
        opts.inspect = needsValue(arg);
        break;
      case "--force":
        opts.force = true;
        break;
      default:
        throw new Error(`Unbekannte Option: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`[ironcrew-backup] ${message}`);
  process.exit(1);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(USAGE);
    fail(err.message);
    return;
  }

  if (opts.help || process.argv.length <= 2) {
    console.log(USAGE);
    return;
  }

  const { createBackup, pruneBackups } = await import(path.join(repoRoot, "server/ironcrew/backup/backup.ts"));
  const { restoreBackup, inspectBackup } = await import(path.join(repoRoot, "server/ironcrew/backup/restore.ts"));

  const dbPath = resolveDbPath({ explicit: opts.db, cwd: process.cwd(), repoRoot });
  announceLegacyDbPath(dbPath, "[ironcrew-backup]");
  const attachmentsDir = opts.attachments
    ? path.resolve(opts.attachments)
    : path.join(path.dirname(dbPath), "attachments");

  if (opts.inspect) {
    const manifest = await inspectBackup(path.resolve(opts.inspect));
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (opts.restore) {
    const result = await restoreBackup({
      backupPath: path.resolve(opts.restore),
      dbPath,
      attachmentsDir,
      force: Boolean(opts.force),
    });
    console.log(`[ironcrew-backup] wiederhergestellt: Datenbank=${result.database} Anhänge=${result.attachments}`);
    // Said every time, because it is the step people skip: the service was
    // stopped for this, and a restored database is not in use until it starts.
    console.log("[ironcrew-backup] Dienst wieder starten: sudo systemctl start ironcrew");
    return;
  }

  if (!opts.out) fail("--out fehlt. Siehe --help.");

  const result = await createBackup({
    dbPath,
    outDir: path.resolve(opts.out),
    attachmentsDir,
    extraPaths: opts.extras.map((p) => path.resolve(p)),
  });

  console.log(
    `[ironcrew-backup] ${result.path} (${(result.bytes / 1_048_576).toFixed(1)} MiB, ` +
      `${result.attachmentCount} Anhänge, Integrität ${result.integrityOk ? "ok" : "FEHLER"})`,
  );

  if (Number.isFinite(opts.keep) && opts.keep > 0) {
    const removed = pruneBackups(path.resolve(opts.out), opts.keep);
    if (removed.length > 0) console.log(`[ironcrew-backup] ${removed.length} alte Backups entfernt`);
  }
}

main().catch((err) => {
  // Exit non-zero and say what failed: a cron job that fails silently is a
  // backup that does not exist and nobody knows it.
  fail(err?.message ?? String(err));
});
