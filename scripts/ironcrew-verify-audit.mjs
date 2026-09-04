#!/usr/bin/env node
// scripts/ironcrew-verify-audit.mjs
//
// Verifies the hash chain in crew_audit_events — the audit log in the DATABASE,
// the one that records approvals, decisions and who signed what.
//
// This is not the same chain as `pnpm run audit:verify`. That one
// (scripts/verify-security-audit-log.mjs) checks the NDJSON security log under
// $LOGS_DIR, which is a separate chain over HTTP-level security events and is
// deliberately excluded from backups. On a restored machine it exits 1 with
// "log file not found" — which is why it was never the right check after a
// restore, and why this script exists.
//
// Like scripts/ironcrew-migrate.mjs and scripts/ironcrew-backup.mjs this is a
// thin shell. The hashing lives in server/ironcrew/domain/audit.ts and is used
// from there, not copied: a verifier carrying its own implementation of the
// algorithm verifies its own copy, not the product. If the two ever drifted
// apart, this script would cheerfully declare a broken chain intact.
//
// The point of running it offline is that it needs no server. After a restore
// the only other way to see this chain is GET /api/crew/audit — which means
// starting the very build you wanted to verify first.

import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveDbPath as sharedResolveDbPath, announceLegacyDbPath } from "./lib/db-path.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// The audit module is TypeScript, so this script re-executes itself under tsx
// when started as plain node — same reasoning as its siblings: `node
// scripts/ironcrew-verify-audit.mjs` has to work from a rescue shell without
// anyone remembering a flag, and without a build step.
//
// The child runs with cwd=repoRoot, so the operator's working directory is
// carried across explicitly. Both the default database name and a relative
// --db must resolve where the operator stood, not where the repository lives:
// somebody in /var/lib/ironcrew typing `--db ./ironcrew.sqlite` means that
// file, and silently verifying a different database is precisely the kind of
// answer this tool must never give.
if (!process.env.IRONCREW_VERIFY_AUDIT_TSX) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, IRONCREW_VERIFY_AUDIT_TSX: "1", IRONCREW_VERIFY_AUDIT_CWD: process.cwd() },
      cwd: repoRoot,
    },
  );
  process.exit(result.status ?? 1);
}

const callerCwd = process.env.IRONCREW_VERIFY_AUDIT_CWD ?? process.cwd();

const USAGE = `IronCrew Audit-Kette prüfen (Datenbank)

  node scripts/ironcrew-verify-audit.mjs [--db <pfad>] [--json]

Prüft die Hash-Kette in crew_audit_events — für JEDE Firma in der Datenbank.
Die Datenbank wird nur lesend geöffnet. Es wird nichts geschrieben, nichts
migriert und kein Dienst gebraucht; das ist der Sinn: nach einem Restore soll
man die Kette prüfen können, OHNE den Build zu starten, den man prüfen will.

Nicht zu verwechseln mit 'pnpm run audit:verify'. Das prüft eine andere Kette:
die NDJSON-Datei unter $LOGS_DIR. Logs liegen absichtlich nicht im Backup.

Optionen:
  --db <pfad>   Datenbank (Standard: $DB_PATH, sonst ./ironcrew.sqlite,
                ersatzweise ./octooffice.sqlite oder ./data/…, wenn es nur die gibt)
  --json        Maschinenlesbare Ausgabe statt Tabelle.
  -h, --help    Diese Hilfe

Exit-Codes:
  0  alle Ketten in Ordnung
  1  Bedienfehler, Datenbank nicht lesbar oder keine IronCrew-Datenbank
  2  eine Kette ist gebrochen ODER die seq-Folge hat ein Loch
`;

// Exit codes are part of this script's contract — somebody wires them into a
// cron job or a monitoring check, so they are named, not magic. 2 is the one
// that matters there: it means the evidence itself is in question.
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_BROKEN = 2;

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
      case "--json":
        opts.json = true;
        break;
      case "--":
        // `pnpm run audit:verify:db -- --db …` is what people type out of
        // habit; pnpm 10 forwards the separator itself. Swallowing it beats
        // answering a real question with "Unbekannte Option: --".
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unbekannte Option: ${arg}`);
        throw new Error(`Unerwartetes Argument: ${arg}`);
    }
  }
  return opts;
}

function say(message) {
  console.log(`[ironcrew-verify-audit] ${message}`);
}

function fail(message, code = EXIT_ERROR) {
  console.error(`[ironcrew-verify-audit] ${message}`);
  process.exit(code);
}

function formatTimestamp(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "—";
  return new Date(value)
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

/**
 * Resolution order lives in scripts/lib/db-path.mjs, shared with the migrate
 * and backup CLIs so all three answer "which database?" identically. The
 * notice matters most here: verifying the pre-rename file is right, but
 * verifying it without saying which file was read is an answer nobody can
 * check.
 */
function resolveDbPath(opts) {
  const dbPath = sharedResolveDbPath({ explicit: opts.db, cwd: callerCwd, repoRoot });
  announceLegacyDbPath(dbPath, "[ironcrew-verify-audit]");
  return dbPath;
}

/**
 * Opens the database strictly read-only.
 *
 * No fallback to a read-write open, deliberately — this is where this script
 * differs from ironcrew-migrate.mjs, which falls back because its job is to
 * migrate. A tool somebody runs BECAUSE they suspect tampering must not be
 * able to write to the evidence, not even a -wal file. If read-only is
 * refused, that is an answer, and the operator gets to decide what to do about
 * it — copying the file aside is the usual one.
 */
async function openDatabaseReadOnly(dbPath) {
  if (!fs.existsSync(dbPath)) {
    fail(
      `Datenbank nicht gefunden: ${dbPath}\n` +
        "                       Pfad mit --db angeben oder DB_PATH setzen. Siehe --help.",
    );
  }
  const { DatabaseSync } = await import("node:sqlite");
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    fail(
      `Datenbank nicht lesbar: ${dbPath}\n` +
        `                       ${err?.message ?? String(err)}\n` +
        "                       Nur-Lesen ist Absicht und wird nicht aufgeweicht. Wenn die Datei\n" +
        "                       gerade benutzt wird: eine Kopie prüfen (cp -a) statt das Original.",
    );
  }
}

function tableExists(db, name) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row && Number(row.cnt) > 0);
}

/**
 * Sequence shape for one company, independent of the hashing.
 *
 * This is the check the chain itself cannot make. `verifyAuditChain()` walks
 * the rows that are there; a row deleted from the END of the chain leaves the
 * remainder perfectly verifiable. A hole in the middle shows up in both, but
 * only here does it get a name and a list of the missing numbers.
 */
function sequenceShape(db, companyId) {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS cnt, MIN(seq) AS min_seq, MAX(seq) AS max_seq
         FROM crew_audit_events WHERE company_id = ?`,
    )
    .get(companyId);
  const count = Number(agg?.cnt ?? 0);
  if (count === 0) return { count: 0, minSeq: null, maxSeq: null, missing: [], expected: 0 };

  const minSeq = Number(agg.min_seq);
  const maxSeq = Number(agg.max_seq);
  // A chain always starts at 1 (appendAuditEvent numbers from prev+1), so a
  // minimum above 1 is a hole at the front, not a different starting point.
  const expected = maxSeq;
  const missing = [];
  if (count !== expected) {
    const present = new Set(
      db
        .prepare("SELECT seq FROM crew_audit_events WHERE company_id = ? ORDER BY seq")
        .all(companyId)
        .map((r) => Number(r.seq)),
    );
    for (let s = 1; s <= maxSeq; s++) if (!present.has(s)) missing.push(s);
  }
  return { count, minSeq, maxSeq, missing, expected };
}

/** The first broken entry, so somebody can go and look at what happened there. */
function brokenEntryContext(db, companyId, seq) {
  const row = db
    .prepare(
      `SELECT id, seq, action, actor_type, actor_id, outcome, entity_type, entity_id, created_at
         FROM crew_audit_events WHERE company_id = ? AND seq = ?`,
    )
    .get(companyId, seq);
  if (!row) return null;
  return {
    id: String(row.id),
    seq: Number(row.seq),
    action: String(row.action),
    actorType: String(row.actor_type),
    actorId: String(row.actor_id),
    outcome: String(row.outcome),
    entityType: String(row.entity_type ?? ""),
    entityId: String(row.entity_id ?? ""),
    createdAt: Number(row.created_at),
  };
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

  if (opts.help) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }

  const dbPath = resolveDbPath(opts);
  const { verifyAuditChain } = await import(path.join(repoRoot, "server/ironcrew/domain/audit.ts"));
  const db = await openDatabaseReadOnly(dbPath);

  let report;
  try {
    if (!tableExists(db, "crew_audit_events")) {
      // An ancient or foreign database. A real answer, not an error to dress
      // up as a stack trace.
      const message =
        `Diese Datenbank hat keine Tabelle crew_audit_events: ${dbPath}\n` +
        "                       Es gibt hier keine Audit-Kette zu prüfen. Entweder ist es nicht die\n" +
        "                       IronCrew-Datenbank, oder sie ist älter als Migration 0002 (bzw. steht\n" +
        "                       noch unter dem alten Namen ic_audit_events, Migration 0006).\n" +
        "                       Stand der Datenbank ansehen: node scripts/ironcrew-migrate.mjs status";
      if (opts.json) {
        console.log(JSON.stringify({ database: dbPath, error: "crew_audit_events fehlt" }, null, 2));
        process.exit(EXIT_ERROR);
      }
      fail(message);
      return;
    }

    const companyRows = tableExists(db, "crew_companies")
      ? db.prepare("SELECT id, name FROM crew_companies ORDER BY created_at ASC, id ASC").all()
      : [];
    const companies = companyRows.map((r) => ({ id: String(r.id), name: String(r.name ?? "") }));

    // Audit rows whose company no longer exists. The foreign key cascades, so
    // this should be impossible — which is exactly why it is worth naming when
    // it happens. Their chains get verified too; every row in the table is
    // somebody's evidence.
    const known = new Set(companies.map((c) => c.id));
    const orphanIds = db
      .prepare("SELECT DISTINCT company_id FROM crew_audit_events ORDER BY company_id")
      .all()
      .map((r) => String(r.company_id))
      .filter((id) => !known.has(id));

    const targets = [
      ...companies.map((c) => ({ ...c, orphan: false })),
      ...orphanIds.map((id) => ({ id, name: "(Firma fehlt)", orphan: true })),
    ];

    const results = targets.map((target) => {
      const shape = sequenceShape(db, target.id);
      const chain = verifyAuditChain(db, target.id);
      const broken = chain.valid ? null : brokenEntryContext(db, target.id, chain.brokenAtSeq);
      return { ...target, ...shape, chain, broken };
    });

    const totalEntries = results.reduce((sum, r) => sum + r.count, 0);
    const brokenChains = results.filter((r) => !r.chain.valid);
    const withHoles = results.filter((r) => r.missing.length > 0);
    const code = brokenChains.length > 0 || withHoles.length > 0 ? EXIT_BROKEN : EXIT_OK;

    report = { dbPath, results, totalEntries, brokenChains, withHoles, orphanIds, code };
  } finally {
    db.close();
  }

  const { results, totalEntries, brokenChains, withHoles, orphanIds, code } = report;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          database: dbPath,
          companiesChecked: results.length,
          totalEntries,
          valid: brokenChains.length === 0,
          holesFound: withHoles.length > 0,
          orphanCompanyIds: orphanIds,
          companies: results.map((r) => ({
            companyId: r.id,
            name: r.name,
            orphan: r.orphan,
            entries: r.count,
            minSeq: r.minSeq,
            maxSeq: r.maxSeq,
            missingSeqs: r.missing,
            valid: r.chain.valid,
            checked: r.chain.checked,
            brokenAtSeq: r.chain.brokenAtSeq ?? null,
            reason: r.chain.reason ?? null,
            brokenEntry: r.broken,
          })),
          exitCode: code,
        },
        null,
        2,
      ),
    );
    process.exit(code);
  }

  say(`Datenbank: ${dbPath}`);
  say(`Firmen: ${results.length}   Audit-Einträge gesamt: ${totalEntries}`);
  console.log("");

  if (results.length === 0) {
    say("Keine Firma in crew_companies und keine Audit-Einträge. Es gibt nichts zu prüfen.");
    process.exit(EXIT_OK);
  }

  console.log(
    renderTable(
      ["Firma", "ID", "Einträge", "seq von", "seq bis", "Lücken", "Kette"],
      results.map((r) => [
        r.name,
        r.id,
        String(r.count),
        r.minSeq ?? "—",
        r.maxSeq ?? "—",
        r.missing.length === 0 ? "—" : String(r.missing.length),
        r.chain.valid ? "ok" : `GEBROCHEN bei seq ${r.chain.brokenAtSeq}`,
      ]),
    ),
  );
  console.log("");

  for (const r of brokenChains) {
    console.error(`[ironcrew-verify-audit] KETTE GEBROCHEN — ${r.name} (${r.id})`);
    console.error(`[ironcrew-verify-audit]   erster Bruch bei seq ${r.chain.brokenAtSeq}: ${r.chain.reason ?? "—"}`);
    console.error(`[ironcrew-verify-audit]   davor geprüft und in Ordnung: ${r.chain.checked} Eintrag/Einträge`);
    if (r.broken) {
      console.error(
        `[ironcrew-verify-audit]   Eintrag: seq ${r.broken.seq}  Aktion '${r.broken.action}'  ` +
          `Akteur ${r.broken.actorType}/${r.broken.actorId}  Ergebnis ${r.broken.outcome}`,
      );
      console.error(
        `[ironcrew-verify-audit]            Objekt ${r.broken.entityType || "—"}/${r.broken.entityId || "—"}  ` +
          `Zeit ${formatTimestamp(r.broken.createdAt)}  id ${r.broken.id}`,
      );
    } else {
      console.error(`[ironcrew-verify-audit]   Zu dieser seq gibt es keine Zeile mehr — sie wurde gelöscht.`);
    }
  }

  for (const r of withHoles) {
    const shown = r.missing.slice(0, 20).join(", ");
    const rest = r.missing.length > 20 ? `, … (${r.missing.length - 20} weitere)` : "";
    console.error(
      `[ironcrew-verify-audit] LÜCKE in der seq-Folge — ${r.name} (${r.id}): ` +
        `${r.count} von ${r.expected} erwarteten Einträgen, fehlend: ${shown}${rest}`,
    );
  }

  if (withHoles.length > 0) {
    // Said plainly, because the opposite mistake is expensive in both
    // directions: treating a hole as proof, or waving it away.
    console.error(
      "[ironcrew-verify-audit] Ein Loch in der seq-Folge ist KEIN Beweis für Manipulation — ein Import\n" +
        "                       oder eine halb gelaufene Migration kann eines hinterlassen. Aber es ist\n" +
        "                       die Form, die ein Löschen hinterlässt, und die Anwendung selbst legt\n" +
        "                       keine an: sie kennt für diese Tabelle weder UPDATE noch DELETE.",
    );
  }

  if (orphanIds.length > 0) {
    console.error(
      `[ironcrew-verify-audit] ${orphanIds.length} Audit-Kette(n) ohne zugehörige Firma: ${orphanIds.join(", ")}\n` +
        "                       Der Fremdschlüssel löscht eigentlich mit; solche Zeilen sollte es nicht geben.",
    );
  }

  if (code === EXIT_OK) {
    say(`Alle Ketten in Ordnung — ${results.length} Firma/Firmen, ${totalEntries} Eintrag/Einträge geprüft.`);
    say(
      "Das ist eine Aussage über die geprüften Zeilen. Am ENDE einer Kette abgeschnittene Einträge\n" +
        "                       hinterlassen weder Bruch noch Lücke — dagegen hilft nur ein Backup zum Vergleich.",
    );
  } else {
    console.error(
      "[ironcrew-verify-audit] Nächster Schritt: NICHT weiterarbeiten und nichts überschreiben. Die Datei\n" +
        "                       sichern (cp -a), das letzte Backup einspielen und dessen Kette prüfen —\n" +
        "                       siehe docs/BACKUP.md.",
    );
  }
  process.exit(code);
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
