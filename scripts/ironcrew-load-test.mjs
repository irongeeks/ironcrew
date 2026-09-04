#!/usr/bin/env node
// scripts/ironcrew-load-test.mjs
//
// "Hält diese Kiste meine Firma aus?" — beantwortet an der echten Domänen-
// schicht, gegen eine echte SQLite-Datei.
//
// Like scripts/ironcrew-migrate.mjs and scripts/ironcrew-backup.mjs this is a
// thin shell: it contains no SQL of its own. Every operation it times is the
// same call the server makes — TaskStore.claim(), RunRequestStore.claimNext(),
// appendAuditEvent(), ProjectStore.list(), ApprovalEngine.listPending(). A load
// test with its own fast copy of the query measures the copy, not the product.
//
// WHY IT DOES NOT GO THROUGH HTTP
//
// Because the numbers would then be Express, JSON and the loopback, and those
// are not what falls over first. What falls over first is a single-file SQLite
// database being read by a Command Center that polls eight endpoints at once
// while the scheduler drains a queue. That is all below the route layer, so
// that is where this measures.
//
// WHY A REAL FILE AND NOT server/ironcrew/domain/test-db.ts
//
// test-db.ts is honest for unit tests and wrong here, for two reasons:
//
//   1. It defaults to `:memory:`. An in-memory database has no page cache
//      pressure, no WAL, no fsync and no file to grow — it cannot answer "how
//      big does this get" or "what happens when two connections write".
//   2. It starts at migration 0002 and skips the baseline. A real installation
//      carries the legacy OctoOffice tables in the same file, and the crew
//      tables share its page cache and its WAL.
//
// So the schema here is built exactly the way server/server-main.ts builds it:
// applyBaseSchema() first, then runMigrations() with the registry. The load
// test therefore also proves that a fresh database can be created the way the
// server creates one.
//
// WHY WORKER THREADS
//
// node:sqlite's DatabaseSync is synchronous. Inside one process there is no
// interleaving at all, so "concurrency" in a single thread would be a loop
// pretending to be a race. The claim phase therefore runs in worker threads,
// each with its OWN connection to the same file — genuinely concurrent writers
// that SQLite has to serialise. That is stricter than production (the control
// plane is one process with one connection), which is the right direction for
// a test of an atomic claim.
//
// One consequence has to be stated rather than hidden: appendAuditEvent() reads
// the previous seq and then inserts, without opening a transaction, because in
// a single-connection process it does not need one. Under two connections that
// pair races and loses on UNIQUE (company_id, seq). The workers therefore wrap
// each claim in BEGIN IMMEDIATE — which is what a second writer process would
// have to do anyway, and which does not weaken the test: the compare-and-set is
// still decided by the WHERE clause, and a loser still sees changes === 0.
//
// WHY IT DOES NOT FAIL ON BEING SLOW
//
// It exits non-zero for a broken invariant — a task claimed twice, a request
// claimed twice, a broken audit hash chain — and never for a slow percentile.
// A load test that goes red on a busy CI runner is a load test that gets
// deleted within a month, and then nobody measures anything at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const selfUrl = import.meta.url;
const here = path.dirname(fileURLToPath(selfUrl));
const repoRoot = path.resolve(here, "..");

// The stores are TypeScript, so this script re-executes itself under tsx when
// started as plain node — same reasoning as the backup and migrate scripts.
// A worker thread inherits the environment, so it lands here with the flag set
// and does not re-exec; it does NOT inherit the tsx hook itself, which is
// registered separately in the worker branch below.
if (!process.env.IRONCREW_LOADTEST_TSX) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    // node:sqlite is still flagged experimental, so every connection — main
    // thread and each worker — prints the same two-line warning. Silenced here
    // rather than in the report, where five copies of it would sit between the
    // operator and the numbers.
    ["--disable-warning=ExperimentalWarning", "--import", "tsx", fileURLToPath(selfUrl), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, IRONCREW_LOADTEST_TSX: "1" }, cwd: repoRoot },
  );
  process.exit(result.status ?? 1);
}

// The migration runner and several stores log at info level. Twenty-five
// "migration applied" lines before the first measurement bury the report, so
// the default is quiet — but only as a default: an operator who set LOG_LEVEL
// asked for that level and gets it.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "error";

// ---------------------------------------------------------------------------
// Shared: opening a connection the way the server opens one
// ---------------------------------------------------------------------------

const SRC = {
  baseSchema: path.join(repoRoot, "server/modules/bootstrap/schema/base-schema.ts"),
  registry: path.join(repoRoot, "server/modules/bootstrap/migrations/registry.ts"),
  runner: path.join(repoRoot, "server/modules/bootstrap/migrations/runner.ts"),
  audit: path.join(repoRoot, "server/ironcrew/domain/audit.ts"),
  ids: path.join(repoRoot, "server/ironcrew/domain/ids.ts"),
  taskStore: path.join(repoRoot, "server/ironcrew/domain/task-store.ts"),
  projectStore: path.join(repoRoot, "server/ironcrew/domain/project-store.ts"),
  runRequestStore: path.join(repoRoot, "server/ironcrew/domain/run-request-store.ts"),
  notificationStore: path.join(repoRoot, "server/ironcrew/domain/notification-store.ts"),
  decisionStore: path.join(repoRoot, "server/ironcrew/domain/decision-store.ts"),
  approvalReviewStore: path.join(repoRoot, "server/ironcrew/domain/approval-review-store.ts"),
  approvalPolicy: path.join(repoRoot, "server/ironcrew/policy/approval-policy.ts"),
  runStore: path.join(repoRoot, "server/ironcrew/runtime/run-store.ts"),
};

/**
 * Opens a connection with the same pragmas server/db/runtime.ts sets. WAL and
 * busy_timeout are not tuning here — without them a second writer fails
 * immediately instead of waiting, and the measurement would be of the failure.
 */
async function openDb(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Wall-clock milliseconds around one call, plus the call's return value. */
function timed(fn) {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

// ---------------------------------------------------------------------------
// Worker role
//
// Each worker owns one connection and answers phase messages. Spawned once and
// reused across phases because starting a worker under tsx costs about a
// second — paying that per phase would dominate the numbers it is measuring.
// ---------------------------------------------------------------------------

if (!isMainThread) {
  // A worker thread does not inherit the parent's `--import tsx` hook, and
  // `execArgv` does not carry it either — Node would fall back to its own
  // strip-only type removal, which rejects the parameter properties the stores
  // are written with. So the hook is registered here, in the thread that needs
  // it, through tsx's own API.
  const { register } = await import("tsx/esm/api");
  register();

  const { dbPath, companyId, agentId, workerIndex } = workerData;
  const db = await openDb(dbPath);
  const { TaskStore } = await import(SRC.taskStore);
  const { RunRequestStore } = await import(SRC.runRequestStore);
  const { RunStore } = await import(SRC.runStore);
  const tasks = new TaskStore(db);
  const queue = new RunRequestStore(db);
  const runs = new RunStore(db);

  const isBusy = (err) => /SQLITE_BUSY|database is locked|busy/i.test(String(err?.message ?? err));

  /**
   * One guarded attempt. BEGIN IMMEDIATE takes the write lock up front so the
   * store's read-then-write pair (including the audit append inside it) cannot
   * interleave with another connection's. See the header.
   */
  const inWriteTx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A failed rollback means the transaction was never opened; nothing to undo.
      }
      throw err;
    }
  };

  /**
   * Claim phase: read the claimable shortlist, then race everyone else for the
   * rows on it. Stops after `idleRounds` consecutive rounds that claimed
   * nothing, which is how a real drain notices the queue has run dry.
   */
  function claimPhase({ idleRounds, maxRounds }) {
    const findMs = [];
    const claimMs = [];
    const runMs = [];
    const claims = [];
    let attempts = 0;
    let lost = 0;
    let busy = 0;
    let idle = 0;

    for (let round = 0; round < maxRounds && idle < idleRounds; round++) {
      const found = timed(() => tasks.findClaimable(companyId, Date.now(), 20));
      findMs.push(found.ms);
      if (found.value.length === 0) {
        idle++;
        continue;
      }
      let claimedThisRound = 0;
      for (const candidate of found.value) {
        attempts++;
        // A real run row first, because `crew_run_requests.run_id` and the rest
        // of the schema reference `crew_runs(id)` — a made-up run id would fail
        // the foreign key, which is the schema correctly refusing a shortcut.
        const created = timed(() =>
          runs.create({
            companyId,
            taskId: candidate.id,
            agentId,
            projectId: candidate.project_id,
            runtimeType: "mock",
            correlationId: candidate.correlation_id,
            workerId: `loadtest-worker-${workerIndex}`,
          }),
        );
        runMs.push(created.ms);
        const runId = created.value.id;

        const t0 = performance.now();
        let row = null;
        try {
          row = inWriteTx(() =>
            tasks.claim({
              taskId: candidate.id,
              runId,
              agentId,
              expectedVersion: candidate.status_version,
              actorId: `loadtest-worker-${workerIndex}`,
            }),
          );
        } catch (err) {
          if (isBusy(err)) {
            busy++;
            continue;
          }
          throw err;
        }
        claimMs.push(performance.now() - t0);
        if (row) {
          claims.push({ taskId: row.id, runId, worker: workerIndex });
          claimedThisRound++;
        } else {
          // The expected outcome for a loser: the WHERE clause refused, no
          // exception, no retry storm. Exactly the contract task-store.ts states.
          lost++;
        }
      }
      idle = claimedThisRound > 0 ? 0 : idle + 1;
    }

    return { findMs, claimMs, runMs, claims, attempts, lost, busy };
  }

  /** Queue phase: drain run requests the way scheduler-driven drains do. */
  function queuePhase({ idleRounds, maxRounds }) {
    const claimMs = [];
    const completeMs = [];
    const claimed = [];
    let busy = 0;
    let idle = 0;

    for (let round = 0; round < maxRounds && idle < idleRounds; round++) {
      let request = null;
      const t0 = performance.now();
      try {
        request = inWriteTx(() => queue.claimNext(companyId, `drain-${workerIndex}`));
      } catch (err) {
        if (isBusy(err)) {
          busy++;
          continue;
        }
        throw err;
      }
      claimMs.push(performance.now() - t0);
      if (!request) {
        idle++;
        continue;
      }
      idle = 0;
      claimed.push({ requestId: request.id, taskId: request.task_id, worker: workerIndex });

      // What a drain does between claiming and completing: it dispatches a run.
      const run = runs.create({
        companyId,
        taskId: request.task_id,
        agentId,
        runtimeType: "mock",
        correlationId: request.correlation_id,
        workerId: `drain-${workerIndex}`,
      });

      const t1 = performance.now();
      try {
        inWriteTx(() => queue.complete(request.id, { runId: run.id }));
      } catch (err) {
        if (isBusy(err)) {
          busy++;
          continue;
        }
        throw err;
      }
      completeMs.push(performance.now() - t1);
    }

    return { claimMs, completeMs, claimed, busy };
  }

  parentPort.on("message", (msg) => {
    try {
      if (msg.phase === "claim") {
        parentPort.postMessage({ phase: "claim", ok: true, ...claimPhase(msg) });
      } else if (msg.phase === "queue") {
        parentPort.postMessage({ phase: "queue", ok: true, ...queuePhase(msg) });
      } else if (msg.phase === "stop") {
        db.close();
        process.exit(0);
      }
    } catch (err) {
      // The stack travels with the message: a worker's exception is otherwise a
      // one-line mystery in the parent, with no frame naming the store call.
      parentPort.postMessage({ phase: msg.phase, ok: false, error: err?.stack ?? err?.message ?? String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Main role
// ---------------------------------------------------------------------------

const USAGE = `IronCrew Lasttest

  node scripts/ironcrew-load-test.mjs [Optionen]

Baut eine NEUE Datenbank mit dem echten Schema, füllt sie mit einer Firma in
realistischer Größe und misst die Operationen, die im Betrieb heiß sind:
Aufgaben-Claim unter Konkurrenz, Warteschlange, Audit-Kette und die Abfragen,
die ein offenes Command Center im Sekundentakt stellt.

Größe der Firma:
  --agents <n>            Agenten (Standard: 12)
  --projects <n>          Projekte (Standard: 20)
  --tasks <n>             Aufgaben (Standard: 2000)
  --approvals <n>         Freigaben, davon jede zweite mit Quorum 2 (Standard: 50)
  --audit-events <n>      Zusätzliche Audit-Einträge (Standard: 20000)

Last:
  --workers <n>           Gleichzeitige Worker mit eigener Verbindung (Standard: 4)
  --claim-tasks <n>       Aufgaben in 'ready', um die die Worker sich streiten
                          (Standard: 500)
  --queue-requests <n>    Lauf-Anforderungen in der Warteschlange (Standard: 500)
  --poll-rounds <n>       Runden des Command-Center-Pollings (Standard: 50)

Sonstiges:
  --db <pfad>             Datenbankdatei. Muss NEU sein — der Lasttest schreibt
                          Müll und weigert sich, eine vorhandene Datei
                          anzufassen. Standard: temporäre Datei.
  --keep-db               Datenbank am Ende nicht löschen.
  --json                  Maschinenlesbare Ausgabe statt Tabellen.
  -h, --help              Diese Hilfe

Exit-Codes:
  0  gemessen, alle Invarianten halten
  1  Bedienfehler oder Abbruch
  2  Eine Invariante ist gebrochen: Aufgabe doppelt vergeben, Anforderung
     doppelt vergeben oder Audit-Kette kaputt.

Langsam ist KEIN Fehler. Dieses Skript beendet sich nie wegen einer Perzentile.
`;

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_INVARIANT = 2;

const DEFAULTS = {
  agents: 12,
  projects: 20,
  tasks: 2000,
  approvals: 50,
  auditEvents: 20000,
  workers: 4,
  claimTasks: 500,
  queueRequests: 500,
  pollRounds: 50,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const positive = (name, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`Option ${name} braucht eine nicht-negative ganze Zahl (bekommen: ${raw}).`);
    }
    return value;
  };
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
      case "--keep-db":
        opts.keepDb = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--agents":
        opts.agents = positive(arg, needsValue(arg));
        break;
      case "--projects":
        opts.projects = positive(arg, needsValue(arg));
        break;
      case "--tasks":
        opts.tasks = positive(arg, needsValue(arg));
        break;
      case "--approvals":
        opts.approvals = positive(arg, needsValue(arg));
        break;
      case "--audit-events":
        opts.auditEvents = positive(arg, needsValue(arg));
        break;
      case "--workers":
        opts.workers = positive(arg, needsValue(arg));
        break;
      case "--claim-tasks":
        opts.claimTasks = positive(arg, needsValue(arg));
        break;
      case "--queue-requests":
        opts.queueRequests = positive(arg, needsValue(arg));
        break;
      case "--poll-rounds":
        opts.pollRounds = positive(arg, needsValue(arg));
        break;
      default:
        throw new Error(`Unbekannte Option: ${arg}`);
    }
  }
  if (opts.workers < 1) throw new Error("--workers muss mindestens 1 sein.");
  if (opts.agents < 1) throw new Error("--agents muss mindestens 1 sein.");
  if (opts.claimTasks > opts.tasks) {
    throw new Error(`--claim-tasks (${opts.claimTasks}) kann nicht größer sein als --tasks (${opts.tasks}).`);
  }
  if (opts.queueRequests > opts.tasks) {
    throw new Error(`--queue-requests (${opts.queueRequests}) kann nicht größer sein als --tasks (${opts.tasks}).`);
  }
  return opts;
}

function say(message) {
  console.log(`[ironcrew-load-test] ${message}`);
}

function fail(message, code = EXIT_ERROR) {
  console.error(`[ironcrew-load-test] ${message}`);
  process.exit(code);
}

/** Minimal fixed-width table — same shape as ironcrew-migrate.mjs, stays greppable. */
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
 * Nearest-rank percentile. Not interpolated: with a few hundred samples the
 * interpolated value is a number that was never measured, and an operator
 * comparing two runs is better served by one that was.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function stats(label, samples, wallMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    label,
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    wallMs,
    perSec: wallMs > 0 ? (sorted.length / wallMs) * 1000 : null,
  };
}

const fmtMs = (v) => (v === null ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1));
const fmtRate = (v) => (v === null ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(1));

function fileSizes(dbPath) {
  const sizeOf = (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  const main = sizeOf(dbPath);
  const wal = sizeOf(`${dbPath}-wal`);
  const shm = sizeOf(`${dbPath}-shm`);
  return { main, wal, shm, total: main + wal + shm };
}

const mib = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MiB`;

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

  // A load test writes thousands of fabricated rows. Pointing it at a database
  // that already exists would be indistinguishable from pointing it at
  // production, so it refuses rather than asking.
  let tempDir = null;
  let dbPath;
  if (opts.db) {
    dbPath = path.resolve(opts.db);
    if (fs.existsSync(dbPath)) {
      fail(
        `Die Datei ${dbPath} gibt es schon.\n` +
          "            Der Lasttest schreibt erfundene Daten und legt deshalb immer eine neue\n" +
          "            Datenbank an. Anderen Pfad wählen oder --db weglassen.",
      );
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } else {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-load-test-"));
    dbPath = path.join(tempDir, "loadtest.sqlite");
  }

  const measurements = [];
  const notes = [];
  const invariants = [];
  const record = (label, samples, wallMs) => {
    const s = stats(label, samples, wallMs);
    measurements.push(s);
    return s;
  };

  // --- schema ---------------------------------------------------------------
  //
  // Exactly the two calls server/server-main.ts makes, in that order. The
  // migration runner alone is not enough: migration 0000 ALTERs tables that
  // applyBaseSchema() creates.
  const { applyBaseSchema } = await import(SRC.baseSchema);
  const { allMigrations } = await import(SRC.registry);
  const { runMigrations } = await import(SRC.runner);

  const db = await openDb(dbPath);
  const schema = timed(() => {
    applyBaseSchema(db);
    runMigrations(db, allMigrations);
  });
  // Progress lines go to stdout, so under --json they would sit in front of the
  // document and break every parser. There they are simply not printed.
  const progress = (message) => {
    if (!opts.json) say(message);
  };
  progress(`Datenbank: ${dbPath}`);
  progress(`Schema angelegt: ${allMigrations.length} Migrationen in ${schema.ms.toFixed(0)} ms`);

  // --- stores ---------------------------------------------------------------
  const { newId } = await import(SRC.ids);
  const { appendAuditEvent, verifyAuditChain, listAuditEvents } = await import(SRC.audit);
  const { TaskStore } = await import(SRC.taskStore);
  const { ProjectStore } = await import(SRC.projectStore);
  const { RunRequestStore } = await import(SRC.runRequestStore);
  const { NotificationStore } = await import(SRC.notificationStore);
  const { DecisionStore } = await import(SRC.decisionStore);
  const { ApprovalReviewStore } = await import(SRC.approvalReviewStore);
  const { ApprovalEngine } = await import(SRC.approvalPolicy);

  const taskStore = new TaskStore(db);
  const projectStore = new ProjectStore(db);
  const queueStore = new RunRequestStore(db);
  const notificationStore = new NotificationStore(db);
  const decisionStore = new DecisionStore(db);
  const reviewStore = new ApprovalReviewStore(db);
  const approvals = new ApprovalEngine(db);

  // --- seed -----------------------------------------------------------------
  //
  // Companies, vessels, talents and agents have no store of their own — the
  // orchestrator writes them inline — so these four inserts mirror
  // server/ironcrew/domain/test-db.ts#seedAgent. Everything with a store goes
  // through the store.
  const companyId = newId("cmp");
  db.prepare("INSERT INTO crew_companies (id, name, slug) VALUES (?,?,?)").run(
    companyId,
    "Lasttest GmbH",
    `loadtest-${companyId}`,
  );
  const vesselId = newId("vsl");
  db.prepare("INSERT INTO crew_vessels (id, company_id, key, label, runtime_provider) VALUES (?,?,?,?,?)").run(
    vesselId,
    companyId,
    "mock",
    "mock (Lasttest)",
    "mock",
  );
  const agentIds = [];
  for (let i = 0; i < opts.agents; i++) {
    const talentId = newId("tal");
    db.prepare("INSERT INTO crew_talents (id, company_id, key, professional_role) VALUES (?,?,?,?)").run(
      talentId,
      companyId,
      `rolle-${i}`,
      `Rolle ${i}`,
    );
    const agentId = newId("agt");
    db.prepare(
      `INSERT INTO crew_agents (id, company_id, key, display_name, vessel_id, talent_id)
       VALUES (?,?,?,?,?,?)`,
    ).run(agentId, companyId, `agent-${i}`, `Agent ${i}`, vesselId, talentId);
    agentIds.push(agentId);
  }
  progress(`Firma angelegt: ${opts.agents} Agenten`);

  const projectIds = [];
  {
    const samples = [];
    const t0 = performance.now();
    for (let i = 0; i < opts.projects; i++) {
      const r = timed(() =>
        projectStore.create({
          companyId,
          title: `Projekt ${i}`,
          key: `projekt-${i}`,
          summary: `Lasttest-Projekt ${i}`,
          ownerAgentId: agentIds[i % agentIds.length],
        }),
      );
      samples.push(r.ms);
      projectIds.push(r.value.id);
    }
    record("project.create", samples, performance.now() - t0);
  }

  const taskIds = [];
  {
    const samples = [];
    const t0 = performance.now();
    for (let i = 0; i < opts.tasks; i++) {
      const r = timed(() =>
        taskStore.create({
          companyId,
          projectId: projectIds.length ? projectIds[i % projectIds.length] : null,
          title: `Aufgabe ${i}`,
          description: `Beschreibung der Aufgabe ${i}. `.repeat(4),
          acceptanceCriteria: ["läuft", "ist dokumentiert"],
          priority: ["low", "normal", "high", "urgent"][i % 4],
          riskLevel: ["low", "medium", "high"][i % 3],
          createdBy: "ceo",
          correlationId: newId("corr"),
        }),
      );
      samples.push(r.ms);
      taskIds.push(r.value.id);
    }
    record("task.create", samples, performance.now() - t0);
  }
  progress(`Aufgaben angelegt: ${taskIds.length}`);

  // Approvals, with a quorum on every second one so migration 0023's column and
  // the review table are actually loaded rather than merely present.
  {
    const requestMs = [];
    const reviewMs = [];
    const t0 = performance.now();
    for (let i = 0; i < opts.approvals; i++) {
      const approval = timed(() =>
        approvals.request(
          companyId,
          {
            approvalType: i % 2 === 0 ? "bank_transfer" : "production_deployment",
            requestedBy: agentIds[i % agentIds.length],
            summary: `Freigabe ${i}`,
            riskLevel: "high",
            impact: "Lasttest",
            rollbackPlan: "Backup zurückspielen",
          },
          { taskId: taskIds[i % Math.max(taskIds.length, 1)] ?? null },
        ),
      );
      requestMs.push(approval.ms);

      const required = i % 2 === 0 ? 2 : 1;
      if (required > 1) reviewStore.setRequiredApprovals(approval.value.id, required, { actorId: "usr_loadtest" });
      for (let r = 0; r < required; r++) {
        const review = timed(() =>
          reviewStore.record({
            approvalId: approval.value.id,
            reviewerId: `usr_pruefer_${r}`,
            verdict: "approved",
            reason: "Lasttest",
          }),
        );
        reviewMs.push(review.ms);
      }
    }
    const wall = performance.now() - t0;
    record("approval.request", requestMs, wall);
    record("approval.review (Quorum)", reviewMs, wall);
  }

  // A handful of notifications and decisions, because the Command Center reads
  // both on every poll and an empty table is not a measurement.
  for (let i = 0; i < 200; i++) {
    notificationStore.create({
      companyId,
      kind: "approval_pending",
      severity: i % 10 === 0 ? "critical" : "info",
      title: `Hinweis ${i}`,
      body: "Lasttest",
    });
    decisionStore.create({
      companyId,
      title: `Entscheidung ${i}`,
      decision: "so und nicht anders",
      rationale: "Lasttest",
      decidedBy: "ceo",
      projectId: projectIds.length ? projectIds[i % projectIds.length] : null,
    });
  }

  // --- Command Center poll, chain still short -------------------------------
  //
  // Measured twice, before and after the audit table is filled. The dashboard
  // read calls verifyAuditChain() over the WHOLE table (server/ironcrew/api/
  // routes.ts, GET /api/crew/dashboard), so the difference between these two
  // numbers is not noise — it is the cost of the audit log on every poll.
  const pollRound = () => {
    // The eight reads src/ironcrew/CommandCenterView.tsx#refresh() fires in
    // parallel. Sequential here because one connection serialises them anyway.
    const agents = db.prepare("SELECT * FROM crew_agents WHERE company_id = ? ORDER BY key").all(companyId);
    const tasks = taskStore.list(companyId, { limit: 200 });
    const pending = approvals.listPending(companyId);
    const projects = projectStore.list(companyId);
    const notifications = notificationStore.list(companyId, { limit: 100 });
    const unread = notificationStore.countUnread(companyId);
    const decisions = decisionStore.list(companyId, { limit: 100 });
    const counts = db
      .prepare("SELECT status, COUNT(*) AS n FROM crew_tasks WHERE company_id = ? GROUP BY status")
      .all(companyId);
    const chain = verifyAuditChain(db, companyId);
    return { agents, tasks, pending, projects, notifications, unread, decisions, counts, chain };
  };

  const measurePoll = (label) => {
    const samples = [];
    const chainOnly = [];
    const t0 = performance.now();
    for (let i = 0; i < opts.pollRounds; i++) {
      samples.push(timed(pollRound).ms);
      chainOnly.push(timed(() => verifyAuditChain(db, companyId)).ms);
    }
    const wall = performance.now() - t0;
    record(label, samples, wall);
    return chainOnly;
  };

  const auditRowsBefore = db
    .prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE company_id = ?")
    .get(companyId).n;
  const chainBefore = measurePoll(`commandcenter.poll (${auditRowsBefore} Audit-Zeilen)`);
  record(
    "audit.verifyChain (klein)",
    chainBefore,
    chainBefore.reduce((a, b) => a + b, 0),
  );

  // --- claim contention -----------------------------------------------------
  {
    const readyMs = [];
    const t0 = performance.now();
    for (let i = 0; i < opts.claimTasks; i++) {
      readyMs.push(timed(() => taskStore.transition(taskIds[i], "ready", { actorId: "ceo" })).ms);
    }
    record("task.transition (inbox→ready)", readyMs, performance.now() - t0);
  }

  const workers = [];
  const sendPhase = (message) =>
    Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            worker.once("message", (reply) => (reply.ok ? resolve(reply) : reject(new Error(reply.error))));
            worker.once("error", reject);
            worker.postMessage(message);
          }),
      ),
    );

  for (let i = 0; i < opts.workers; i++) {
    workers.push(
      new Worker(fileURLToPath(selfUrl), {
        env: process.env,
        workerData: { dbPath, companyId, agentId: agentIds[i % agentIds.length], workerIndex: i },
      }),
    );
  }

  let claimReplies = [];
  let queueReplies = [];
  try {
    const claimT0 = performance.now();
    claimReplies = await sendPhase({
      phase: "claim",
      idleRounds: 3,
      maxRounds: Math.max(50, opts.claimTasks * 2),
    });
    const claimWall = performance.now() - claimT0;
    record(
      "task.claim (Konkurrenz)",
      claimReplies.flatMap((r) => r.claimMs),
      claimWall,
    );
    record(
      "task.findClaimable",
      claimReplies.flatMap((r) => r.findMs),
      claimWall,
    );
    record(
      "run.create",
      claimReplies.flatMap((r) => r.runMs),
      claimWall,
    );

    // --- run-request queue --------------------------------------------------
    {
      const samples = [];
      const t0 = performance.now();
      for (let i = 0; i < opts.queueRequests; i++) {
        samples.push(
          timed(() => queueStore.enqueue({ companyId, taskId: taskIds[i], requestedBy: "ceo", maxAttempts: 3 })).ms,
        );
      }
      record("runrequest.enqueue", samples, performance.now() - t0);
    }

    const queueT0 = performance.now();
    queueReplies = await sendPhase({
      phase: "queue",
      idleRounds: 3,
      maxRounds: Math.max(50, opts.queueRequests * 2),
    });
    const queueWall = performance.now() - queueT0;
    record(
      "runrequest.claimNext (Konkurrenz)",
      queueReplies.flatMap((r) => r.claimMs),
      queueWall,
    );
    record(
      "runrequest.complete",
      queueReplies.flatMap((r) => r.completeMs),
      queueWall,
    );
  } finally {
    for (const worker of workers) worker.postMessage({ phase: "stop" });
    await Promise.all(workers.map((w) => new Promise((resolve) => w.once("exit", resolve))));
  }

  // --- audit chain appends --------------------------------------------------
  {
    const samples = [];
    const t0 = performance.now();
    for (let i = 0; i < opts.auditEvents; i++) {
      samples.push(
        timed(() =>
          appendAuditEvent(db, {
            companyId,
            actorType: "agent",
            actorId: agentIds[i % agentIds.length],
            action: "run.event",
            entityType: "task",
            entityId: taskIds[i % taskIds.length],
            taskId: taskIds[i % taskIds.length],
            details: { schritt: i, notiz: "Lasttest-Ereignis", token: "sk-geheim-wird-redigiert" },
          }),
        ).ms,
      );
    }
    record("audit.append", samples, performance.now() - t0);
  }

  const auditRowsAfter = db
    .prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE company_id = ?")
    .get(companyId).n;
  const chainAfter = measurePoll(`commandcenter.poll (${auditRowsAfter} Audit-Zeilen)`);
  record(
    "audit.verifyChain (voll)",
    chainAfter,
    chainAfter.reduce((a, b) => a + b, 0),
  );

  {
    const samples = [];
    const t0 = performance.now();
    for (let i = 0; i < Math.min(opts.pollRounds, 50); i++) {
      samples.push(timed(() => listAuditEvents(db, companyId, { limit: 100 })).ms);
    }
    record("audit.list (100)", samples, performance.now() - t0);
  }

  // --- invariants -----------------------------------------------------------
  //
  // The only reasons this script may exit non-zero after a successful run.

  const allClaims = claimReplies.flatMap((r) => r.claims);
  const claimsByTask = new Map();
  for (const claim of allClaims) {
    const list = claimsByTask.get(claim.taskId) ?? [];
    list.push(claim);
    claimsByTask.set(claim.taskId, list);
  }
  const doubleClaims = [...claimsByTask.entries()].filter(([, list]) => list.length > 1);
  invariants.push({
    key: "task.claim eindeutig",
    ok: doubleClaims.length === 0,
    detail:
      doubleClaims.length === 0
        ? `${allClaims.length} Claims, kein Task zweimal vergeben`
        : `${doubleClaims.length} Task(s) mehrfach vergeben, z. B. ${doubleClaims[0][0]}`,
  });

  // Second, independent view of the same question: the audit log itself. A
  // double claim that the workers somehow failed to notice would still be two
  // 'task.claimed' entries on one task.
  const auditDoubles = db
    .prepare(
      `SELECT task_id, COUNT(*) AS n FROM crew_audit_events
        WHERE company_id = ? AND action = 'task.claimed' GROUP BY task_id HAVING n > 1`,
    )
    .all(companyId);
  invariants.push({
    key: "task.claimed im Audit eindeutig",
    ok: auditDoubles.length === 0,
    detail:
      auditDoubles.length === 0
        ? "kein Task mit zwei Claim-Einträgen"
        : `${auditDoubles.length} Task(s) mit mehreren Claim-Einträgen`,
  });

  // A claimed task must hold exactly the run id of the worker that won it.
  let lockMismatches = 0;
  for (const [taskId, list] of claimsByTask) {
    const row = taskStore.get(taskId);
    if (!row || row.execution_run_id !== list[0].runId) lockMismatches++;
  }
  invariants.push({
    key: "Lock gehört dem Gewinner",
    ok: lockMismatches === 0,
    detail: lockMismatches === 0 ? `${claimsByTask.size} Locks geprüft` : `${lockMismatches} Lock(s) fremd besetzt`,
  });

  const allQueueClaims = queueReplies.flatMap((r) => r.claimed);
  const queueSeen = new Set();
  const queueDoubles = [];
  for (const claim of allQueueClaims) {
    if (queueSeen.has(claim.requestId)) queueDoubles.push(claim.requestId);
    queueSeen.add(claim.requestId);
  }
  invariants.push({
    key: "runrequest.claimNext eindeutig",
    ok: queueDoubles.length === 0,
    detail:
      queueDoubles.length === 0
        ? `${allQueueClaims.length} Anforderungen gezogen, keine doppelt`
        : `${queueDoubles.length} Anforderung(en) doppelt gezogen`,
  });

  const chain = verifyAuditChain(db, companyId);
  invariants.push({
    key: "Audit-Kette",
    ok: chain.valid,
    detail: chain.valid
      ? `${chain.checked} Einträge, Kette geschlossen`
      : `gebrochen bei seq ${chain.brokenAtSeq}: ${chain.reason}`,
  });

  const integrity = db.prepare("PRAGMA integrity_check").get();
  const integrityOk = Object.values(integrity ?? {})[0] === "ok";
  invariants.push({
    key: "PRAGMA integrity_check",
    ok: integrityOk,
    detail: String(Object.values(integrity ?? {})[0] ?? "—"),
  });

  const busyTotal = claimReplies.reduce((sum, r) => sum + r.busy, 0) + queueReplies.reduce((sum, r) => sum + r.busy, 0);
  const lostTotal = claimReplies.reduce((sum, r) => sum + r.lost, 0);
  notes.push(`${lostTotal} verlorene Claim-Versuche (erwartet: der Verlierer sieht changes=0 und geht weiter)`);
  notes.push(`${busyTotal} Versuche mit SQLITE_BUSY (Wartezeit über busy_timeout, kein Fehler)`);

  // Two sizes, because they answer two different questions. Live: what is on
  // disk while the service runs, WAL included. At rest: what a checkpointed
  // database costs, which is the number to compare against a disk quota and
  // roughly what a backup archive will hold.
  const sizesLive = fileSizes(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const sizesRest = fileSizes(dbPath);
  db.close();

  // --- report ---------------------------------------------------------------

  const rowCounts = {};
  {
    const reopened = await openDb(dbPath);
    for (const table of [
      "crew_agents",
      "crew_projects",
      "crew_tasks",
      "crew_approvals",
      "crew_approval_reviews",
      "crew_run_requests",
      "crew_runs",
      "crew_audit_events",
      "crew_notifications",
      "crew_decisions",
    ]) {
      rowCounts[table] = reopened.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    reopened.close();
  }

  const broken = invariants.filter((i) => !i.ok);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          database: dbPath,
          options: opts,
          schemaMs: schema.ms,
          migrations: allMigrations.length,
          rows: rowCounts,
          bytes: { live: sizesLive, checkpointed: sizesRest },
          measurements,
          invariants,
          notes,
          ok: broken.length === 0,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("");
    // Ops/s is that operation's count divided by the wall clock of the phase it
    // ran in, so for the worker phases it is the aggregate over all workers —
    // which is the figure that answers "does the box keep up", not the figure a
    // single thread would have managed on its own.
    console.log(
      renderTable(
        ["Operation", "n", "p50 ms", "p95 ms", "p99 ms", "max ms", "Ops/s"],
        measurements.map((m) => [
          m.label,
          m.n,
          fmtMs(m.p50),
          fmtMs(m.p95),
          fmtMs(m.p99),
          fmtMs(m.max),
          fmtRate(m.perSec),
        ]),
      ),
    );
    console.log("");
    console.log(
      renderTable(
        ["Tabelle", "Zeilen"],
        Object.entries(rowCounts).map(([t, n]) => [t, n]),
      ),
    );
    console.log("");
    say(
      `Datenbank im Betrieb: ${mib(sizesLive.main)} + WAL ${mib(sizesLive.wal)} = ${mib(sizesLive.total)}; ` +
        `nach Checkpoint: ${mib(sizesRest.total)}`,
    );
    say(
      `Das bei ${rowCounts.crew_tasks} Aufgaben, ${rowCounts.crew_runs} Läufen und ` +
        `${rowCounts.crew_audit_events} Audit-Zeilen.`,
    );
    console.log("");
    console.log(
      renderTable(
        ["Invariante", "Ergebnis", "Details"],
        invariants.map((i) => [i.key, i.ok ? "ok" : "GEBROCHEN", i.detail]),
      ),
    );
    console.log("");
    for (const note of notes) say(note);
  }

  if (tempDir && !opts.keepDb) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (!opts.json) say("Temporäre Datenbank gelöscht (--keep-db behält sie).");
  } else if (!opts.json) {
    say(`Datenbank bleibt liegen: ${dbPath}`);
  }

  if (broken.length > 0) {
    console.error("");
    console.error(
      `[ironcrew-load-test] ABBRUCH: ${broken.length} Invariante(n) gebrochen: ` + broken.map((i) => i.key).join(", "),
    );
    console.error(
      "[ironcrew-load-test] Das ist kein Performance-Problem. Eine doppelt vergebene Aufgabe bedeutet\n" +
        "                    zwei Agenten auf derselben Arbeit, eine gebrochene Audit-Kette bedeutet, dass\n" +
        "                    die Protokollierung nicht mehr aussagt, was passiert ist.",
    );
    return EXIT_INVARIANT;
  }
  return EXIT_OK;
}

if (isMainThread) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      fail(err?.stack ?? err?.message ?? String(err));
    });
}
