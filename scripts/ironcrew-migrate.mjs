#!/usr/bin/env node
// scripts/ironcrew-migrate.mjs
//
// IronCrew schema migrations, seen from the outside: what is applied, what is
// pending, and whether this build may touch this database at all.
//
// Like scripts/ironcrew-backup.mjs this is a thin shell. It does NOT contain a
// second migration runner: the registry in
// server/modules/bootstrap/migrations/registry.ts is the one source of truth
// for which migrations exist, and runner.ts is the one piece of code that
// applies them. A CLI with its own copy of either would be the copy that is
// wrong on the day it matters.
//
// The server normally applies migrations itself on start, so `apply` is not
// the everyday path — `status` and `check` are. `check` exists because of one
// specific accident: rolling the code back under a database that a newer build
// already migrated. The old build then sees a schema it does not know, writes
// into it happily, and nothing complains until much later. That is worth its
// own command with its own exit code, cheap enough to run before every start.

import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveDbPath as sharedResolveDbPath, announceLegacyDbPath } from "./lib/db-path.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// The registry and the runner are TypeScript, so this script re-executes
// itself under tsx when started as plain node — same reasoning as the backup
// script: `node scripts/ironcrew-migrate.mjs status` has to work from a rescue
// shell without anyone remembering a flag, and without a build step.
if (!process.env.IRONCREW_MIGRATE_TSX) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, IRONCREW_MIGRATE_TSX: "1" }, cwd: repoRoot },
  );
  process.exit(result.status ?? 1);
}

const USAGE = `IronCrew Migrationen

  node scripts/ironcrew-migrate.mjs status [--db <pfad>] [--json]
  node scripts/ironcrew-migrate.mjs check  [--db <pfad>] [--strict] [--json]
  node scripts/ironcrew-migrate.mjs apply  [--db <pfad>] [--dry-run] [--force]

Befehle:
  status     Angewendete und offene Migrationen, Stand der Datenbank
             gegenüber dem Stand dieses Builds.
  check      Prüft, ob dieser Build diese Datenbank anfassen darf.
             Für den Pre-Start-Check gedacht: sagt nichts, wenn alles
             in Ordnung ist, und beendet sich sonst mit Code != 0.
  apply      Offene Migrationen anwenden. Der Dienst tut das beim Start
             selbst; von Hand nur bei angehaltenem Dienst.

Optionen:
  --db <pfad>   Datenbank (Standard: $DB_PATH, sonst ./ironcrew.sqlite,
                ./octooffice.sqlite oder ./data/ironcrew.sqlite — die erste, die existiert)
  --dry-run     Nur zeigen, was laufen WÜRDE. Schreibt nichts.
  --force       'apply' wirklich ausführen (ohne dies wird abgelehnt).
  --strict      Nur 'check': offene Migrationen gelten als Fehler (Code 4).
  --json        Maschinenlesbare Ausgabe statt Tabelle.
  -h, --help    Diese Hilfe

Exit-Codes:
  0  in Ordnung
  1  Bedienfehler oder Datenbank nicht lesbar
  2  Datenbank ist NEUER als der Build (Code wurde zurückgerollt)
  3  Eine registrierte Migration würde stillschweigend übersprungen
  4  nur mit --strict: es sind Migrationen offen
`;

// Exit codes are part of this script's contract — an operator wires them into
// a systemd ExecStartPre or a monitoring check, so they are named, not magic.
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_DB_NEWER = 2;
const EXIT_GAP = 3;
const EXIT_PENDING = 4;

const COMMANDS = new Set(["status", "check", "apply"]);

function parseArgs(argv) {
  const opts = {};
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
      case "--db":
        opts.db = needsValue(arg);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unbekannte Option: ${arg}`);
        if (opts.command) throw new Error(`Mehr als ein Befehl angegeben: ${opts.command} und ${arg}`);
        if (!COMMANDS.has(arg)) throw new Error(`Unbekannter Befehl: ${arg}`);
        opts.command = arg;
    }
  }
  return opts;
}

function say(message) {
  console.log(`[ironcrew-migrate] ${message}`);
}

function fail(message, code = EXIT_ERROR) {
  console.error(`[ironcrew-migrate] ${message}`);
  process.exit(code);
}

/** Zero-padded version, so 3 and 21 line up in a table and match the filenames. */
function pad4(version) {
  return String(version).padStart(4, "0");
}

function formatTimestamp(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

/** Minimal fixed-width table. No dependency, and the output stays greppable. */
function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) =>
    "  " +
    cells
      .map((c, i) => String(c ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

function resolveDbPath(opts) {
  const dbPath = sharedResolveDbPath({ explicit: opts.db, cwd: process.cwd(), repoRoot });
  announceLegacyDbPath(dbPath, "[ironcrew-migrate]");
  return dbPath;
}

/**
 * Opens the database read-only where possible. Read-only matters for `status`
 * and `check`: those are run against a database the service is using, and a
 * read-write open of a SQLite file can create -wal/-shm files owned by the
 * wrong user. Falls back to a normal open when read-only is refused (which
 * happens for a WAL database whose -shm file does not exist yet).
 */
async function openDatabase(dbPath, { readOnly }) {
  if (!fs.existsSync(dbPath)) {
    fail(
      `Datenbank nicht gefunden: ${dbPath}\n` + "            Pfad mit --db angeben oder DB_PATH setzen. Siehe --help.",
    );
  }
  const { DatabaseSync } = await import("node:sqlite");
  if (!readOnly) return new DatabaseSync(dbPath);
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return new DatabaseSync(dbPath);
  }
}

/**
 * Reads schema_migrations. Deliberately does NOT create the table: a missing
 * table is a real answer ("this database has never been migrated"), not
 * something to fix behind the operator's back.
 */
function readAppliedRows(db) {
  const exists = db
    .prepare("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!exists || exists.cnt === 0) return null;
  return db.prepare("SELECT version, description, applied_at FROM schema_migrations ORDER BY version").all();
}

/**
 * Everything both `status` and `check` need to say, computed once.
 *
 * `pending` deserves a note: runner.ts selects pending migrations with
 * `version > MAX(applied version)`, not "every registered version that is
 * absent". A registered migration whose version sits BELOW that high-water
 * mark is therefore never applied and never will be — it is a gap, not
 * something waiting its turn. That is why the two are counted separately.
 */
function analyse(migrations, appliedRows) {
  const applied = appliedRows ?? [];
  const appliedVersions = new Set(applied.map((r) => Number(r.version)));
  const highestApplied = applied.length > 0 ? Math.max(...appliedVersions) : -1;
  const buildVersion = migrations.length > 0 ? Math.max(...migrations.map((m) => m.version)) : -1;

  const pending = migrations.filter((m) => !appliedVersions.has(m.version) && m.version > highestApplied);
  const gaps = migrations.filter((m) => !appliedVersions.has(m.version) && m.version < highestApplied);

  // Versions recorded in the database that this build does not know about.
  // This is the downgrade fingerprint: the rows were written by a newer build.
  const known = new Set(migrations.map((m) => m.version));
  const unknown = applied.filter((r) => !known.has(Number(r.version)));

  return {
    applied,
    appliedVersions,
    highestApplied,
    buildVersion,
    pending,
    gaps,
    unknown,
    dbIsNewer: highestApplied > buildVersion || unknown.length > 0,
  };
}

async function loadMigrations() {
  // The registry validates itself on import (ascending, no duplicates, no
  // unregistered file on disk), so a broken registry fails here rather than
  // producing a plausible-looking but wrong table.
  const { allMigrations } = await import(path.join(repoRoot, "server/modules/bootstrap/migrations/registry.ts"));
  return allMigrations;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function commandStatus(opts) {
  const dbPath = resolveDbPath(opts);
  const migrations = await loadMigrations();
  const db = await openDatabase(dbPath, { readOnly: true });
  let appliedRows;
  try {
    appliedRows = readAppliedRows(db);
  } finally {
    db.close();
  }

  const a = analyse(migrations, appliedRows);
  const appliedAt = new Map(a.applied.map((r) => [Number(r.version), Number(r.applied_at)]));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          database: dbPath,
          databaseVersion: a.highestApplied,
          buildVersion: a.buildVersion,
          migrated: appliedRows !== null,
          applied: a.applied.map((r) => ({
            version: Number(r.version),
            description: r.description,
            appliedAt: Number(r.applied_at),
          })),
          pending: a.pending.map((m) => ({ version: m.version, description: m.description })),
          gaps: a.gaps.map((m) => ({ version: m.version, description: m.description })),
          unknown: a.unknown.map((r) => ({ version: Number(r.version), description: r.description })),
          databaseNewerThanBuild: a.dbIsNewer,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  say(`Datenbank: ${dbPath}`);
  if (appliedRows === null) {
    say("Diese Datenbank hat keine Tabelle schema_migrations.");
    say(
      `Es ist eine neue oder fremde Datenbank; der erste Start würde alle ${migrations.length} Migrationen anwenden.`,
    );
  }
  say(
    `Stand Datenbank: ${a.highestApplied < 0 ? "—" : pad4(a.highestApplied)}   ` +
      `Stand Build: ${a.buildVersion < 0 ? "—" : pad4(a.buildVersion)}   ` +
      `offen: ${a.pending.length}`,
  );
  console.log("");

  const rows = [];
  for (const m of migrations) {
    const isApplied = a.appliedVersions.has(m.version);
    const status = isApplied ? "angewendet" : m.version < a.highestApplied ? "ÜBERSPRUNGEN" : "offen";
    rows.push([pad4(m.version), status, isApplied ? formatTimestamp(appliedAt.get(m.version)) : "—", m.description]);
  }
  for (const r of a.unknown) {
    rows.push([pad4(Number(r.version)), "UNBEKANNT", formatTimestamp(Number(r.applied_at)), r.description ?? ""]);
  }
  rows.sort((x, y) => Number(x[0]) - Number(y[0]));
  console.log(renderTable(["Version", "Status", "Angewendet am (UTC)", "Beschreibung"], rows));
  console.log("");

  if (a.unknown.length > 0) {
    say(
      `${a.unknown.length} Migration(en) stehen in der Datenbank, die dieser Build nicht kennt — ` +
        "die Datenbank wurde von einem neueren Build migriert.",
    );
  }
  if (a.gaps.length > 0) {
    say(
      `${a.gaps.length} Migration(en) sind älter als der Stand der Datenbank und trotzdem nicht angewendet. ` +
        "Sie laufen NIE nach: der Runner nimmt nur Versionen oberhalb des höchsten Standes.",
    );
  }
  if (a.pending.length > 0) {
    say(`${a.pending.length} Migration(en) offen — der nächste Start des Dienstes wendet sie an.`);
  }
  if (a.pending.length === 0 && a.gaps.length === 0 && !a.dbIsNewer) {
    say("Datenbank und Build sind auf demselben Stand.");
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function commandCheck(opts) {
  const dbPath = resolveDbPath(opts);
  const migrations = await loadMigrations();
  const db = await openDatabase(dbPath, { readOnly: true });
  let appliedRows;
  try {
    appliedRows = readAppliedRows(db);
  } finally {
    db.close();
  }

  const a = analyse(migrations, appliedRows);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          database: dbPath,
          databaseVersion: a.highestApplied,
          buildVersion: a.buildVersion,
          databaseNewerThanBuild: a.dbIsNewer,
          skipped: a.gaps.map((m) => m.version),
          pending: a.pending.map((m) => m.version),
        },
        null,
        2,
      ),
    );
  }

  if (a.dbIsNewer) {
    // The whole reason this command exists. Loud, and with the way out named,
    // because the tempting reaction — "start it anyway, it seems to work" — is
    // exactly the one that costs data.
    console.error(`[ironcrew-migrate] ABBRUCH: Die Datenbank ist neuer als dieser Build.`);
    console.error(`[ironcrew-migrate] Datenbank: ${dbPath}`);
    console.error(
      `[ironcrew-migrate] Stand Datenbank: ${pad4(a.highestApplied)}   Stand Build: ${a.buildVersion < 0 ? "—" : pad4(a.buildVersion)}`,
    );
    if (a.unknown.length > 0) {
      console.error(
        `[ironcrew-migrate] Unbekannte Versionen in der Datenbank: ${a.unknown.map((r) => pad4(Number(r.version))).join(", ")}`,
      );
    }
    console.error(
      "[ironcrew-migrate] Dieser Build kennt das Schema nicht, das er vor sich hat. Er würde trotzdem starten\n" +
        "                   und schreiben — deshalb dieser Check. Entweder den neueren Build wieder\n" +
        "                   einspielen, oder das Backup von VOR dem Upgrade zurückspielen\n" +
        "                   (docs/BACKUP.md). Es gibt keine Down-Migrationen. Siehe docs/UPGRADE.md.",
    );
    return EXIT_DB_NEWER;
  }

  if (a.gaps.length > 0) {
    console.error(
      `[ironcrew-migrate] ABBRUCH: ${a.gaps.length} registrierte Migration(en) werden nie angewendet: ` +
        a.gaps.map((m) => pad4(m.version)).join(", "),
    );
    console.error(
      "[ironcrew-migrate] Der Runner wendet nur Versionen oberhalb des höchsten angewendeten Standes an.\n" +
        "                   Eine Migration mit kleinerer Nummer, die später dazukam, bleibt liegen.\n" +
        "                   Sie braucht eine neue, höhere Versionsnummer.",
    );
    return EXIT_GAP;
  }

  if (opts.strict && a.pending.length > 0) {
    console.error(
      `[ironcrew-migrate] ${a.pending.length} Migration(en) offen (--strict): ` +
        a.pending.map((m) => pad4(m.version)).join(", "),
    );
    return EXIT_PENDING;
  }

  if (!opts.json) {
    // Quiet on success would be more unix-like, but this runs before a start
    // and in a journal an explicit "ok" is the difference between "checked"
    // and "never ran".
    say(
      `ok — Stand Datenbank ${a.highestApplied < 0 ? "—" : pad4(a.highestApplied)}, ` +
        `Stand Build ${a.buildVersion < 0 ? "—" : pad4(a.buildVersion)}, offen: ${a.pending.length}`,
    );
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function commandApply(opts) {
  const dbPath = resolveDbPath(opts);
  const migrations = await loadMigrations();

  // Even the dry run refuses to touch a database it may not read.
  const probe = await openDatabase(dbPath, { readOnly: true });
  let appliedRows;
  try {
    appliedRows = readAppliedRows(probe);
  } finally {
    probe.close();
  }
  const a = analyse(migrations, appliedRows);

  say(`Datenbank: ${dbPath}`);
  say(
    `Stand Datenbank: ${a.highestApplied < 0 ? "—" : pad4(a.highestApplied)}   ` +
      `Stand Build: ${a.buildVersion < 0 ? "—" : pad4(a.buildVersion)}`,
  );

  if (a.dbIsNewer) {
    return fail(
      "Die Datenbank ist neuer als dieser Build. Es wird nichts angewendet.\n" +
        "            Erst 'check' lesen und docs/UPGRADE.md.",
      EXIT_DB_NEWER,
    );
  }

  if (a.pending.length === 0) {
    say("Nichts zu tun — keine offenen Migrationen.");
    if (a.gaps.length > 0) {
      say(
        `Achtung: ${a.gaps.length} Migration(en) sind übersprungen und laufen nicht nach: ` +
          a.gaps.map((m) => pad4(m.version)).join(", "),
      );
      return EXIT_GAP;
    }
    return EXIT_OK;
  }

  console.log("");
  console.log(
    renderTable(
      ["Version", "Beschreibung", "Transaktion"],
      a.pending.map((m) => [pad4(m.version), m.description, m.managesOwnTransaction ? "eigene" : "Runner"]),
    ),
  );
  console.log("");

  if (opts.dryRun) {
    say(`--dry-run: ${a.pending.length} Migration(en) WÜRDEN laufen. Es wurde nichts geschrieben.`);
    return EXIT_OK;
  }

  if (!opts.force) {
    return fail(
      "Abgelehnt: 'apply' schreibt in die Datenbank und ist nicht rückgängig zu machen.\n" +
        "            Vorher: Dienst anhalten (sudo systemctl stop ironcrew) und ein Backup anlegen\n" +
        "            (node scripts/ironcrew-backup.mjs --out …, siehe docs/BACKUP.md).\n" +
        "            Danach mit --force wiederholen. Zum reinen Ansehen: --dry-run.",
    );
  }

  // From here on the existing runner does the work — the same code path the
  // server takes on start, including the per-migration transaction and the
  // schema_migrations bookkeeping.
  const { runMigrations } = await import(path.join(repoRoot, "server/modules/bootstrap/migrations/runner.ts"));
  const db = await openDatabase(dbPath, { readOnly: false });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, migrations);
  } finally {
    db.close();
  }
  say(`${a.pending.length} Migration(en) angewendet. Neuer Stand: ${pad4(a.buildVersion)}`);
  say("Dienst wieder starten: sudo systemctl start ironcrew");
  return EXIT_OK;
}

// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(USAGE);
    fail(err.message);
    return;
  }

  if (opts.help) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }
  if (!opts.command) {
    // No command is a mistake, not a request for help — exit non-zero so a
    // typo in a cron line or a unit file does not look like success.
    console.log(USAGE);
    fail("Kein Befehl angegeben: status, check oder apply.");
  }

  const code =
    opts.command === "status"
      ? await commandStatus(opts)
      : opts.command === "check"
        ? await commandCheck(opts)
        : await commandApply(opts);
  process.exit(code);
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
