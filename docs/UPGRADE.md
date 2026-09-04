# Upgrading

An upgrade is not one thing moving. It is three, and they move at different
speeds:

| Part                | Where it lives                     | Moves when                    |
| ------------------- | ---------------------------------- | ----------------------------- |
| The checkout        | `/opt/ironcrew`                    | you `git pull`                |
| The database schema | `DB_PATH`                          | the service next starts       |
| The runner daemon   | the same checkout, its own process | you restart `ironcrew-runner` |

Every upgrade problem in this system is one of those three being at a
different version from the others. This document is about keeping them
together, and about what to do on the day they are not.

Read [`BACKUP.md`](./BACKUP.md) first if you have not. The backup step below is
not a precaution, it is the rollback plan — see [Rollback](#rollback).

## How migrations work here

`server/modules/bootstrap/migrations/registry.ts` is the single list of
migrations that exist. `runner.ts` is the single piece of code that applies
them. Nothing else — not the CLI in `scripts/`, not a test helper — has its own
copy of either.

Four properties follow, and each one changes what an upgrade can and cannot do.

**Forward-only.** The `Migration` interface in `migration-types.ts` has
`version`, `description` and `up(db)`. There is no `down()`. Not "there is one
but we do not use it" — the field does not exist, so no migration in this
repository can be reversed by running code. Read [Rollback](#rollback) before
you plan an upgrade around the assumption that it can.

**Additive.** Migrations add tables and columns and are written to be
idempotent: `CREATE TABLE IF NOT EXISTS`, and `ALTER TABLE ... ADD COLUMN`
guarded by `hasColumn()` because SQLite has no `ADD COLUMN IF NOT EXISTS`. The
few that must rewrite a table (`0001`, `0006`) set `managesOwnTransaction` and
use the rename–create–copy–drop pattern, because SQLite wants
`PRAGMA foreign_keys` toggled outside a transaction.

**Applied by high-water mark, not by set difference.** The runner selects
`version > MAX(applied version)`. A registered migration whose number sits
_below_ that mark is never applied and never will be — it is not queued, it is
skipped forever. This is the trap when two branches are merged: both add a
migration, one gets the lower number, and on a database that already ran the
higher one the lower is silently dead. A new migration always takes a new,
higher number.

**Self-checking at import.** `registry.ts` validates itself when it is loaded:
ascending order, no duplicate versions, and an auto-scan of its own directory
that throws if a `NNNN-*.ts` file exists on disk but is missing from
`MIGRATION_ENTRIES`. The message names the file. This fires at server start, so
a forgotten registry entry is a refusal to boot rather than a table that
quietly never appears.

### Seeing it from outside

`scripts/ironcrew-migrate.mjs` is a thin shell over the same registry and
runner. It re-executes itself under `tsx`, so plain `node` works from a rescue
shell with no flag to remember.

```bash
node scripts/ironcrew-migrate.mjs status --db /opt/ironcrew/data/ironcrew.sqlite
node scripts/ironcrew-migrate.mjs check  --db /opt/ironcrew/data/ironcrew.sqlite
node scripts/ironcrew-migrate.mjs apply  --db /opt/ironcrew/data/ironcrew.sqlite --dry-run
```

`status` prints the table of applied, pending, skipped and unknown versions.
`check` says nothing when all is well and exits non-zero when it is not — it is
meant for a pre-start check, and its exit codes are its contract:

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | in order                                                             |
| 1    | operator error, or the database cannot be read                       |
| 2    | the database is **newer** than this build — the code was rolled back |
| 3    | a registered migration would be silently skipped (the trap above)    |
| 4    | with `--strict` only: migrations are pending                         |

Code 2 is the reason `check` exists. An old build against a new schema does not
crash; it starts, does not recognise the columns it has never heard of, and
writes happily into a database it does not understand. Nothing complains until
much later.

**`apply` is not the everyday path.** The service applies pending migrations
itself on start. Run `apply` by hand only with the service stopped, and only
after a backup — it refuses without `--force` and says so.

### Two different things are called "migrate"

Do not confuse them.

| Command                             | What it does                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `node scripts/ironcrew-migrate.mjs` | SQLite schema: the registry above                                                 |
| `pnpm run migrate:v1.0.5`           | `scripts/auto-apply-v1.0.5.mjs` — rewrites `.env` and `AGENTS.md` in the checkout |

The second is a configuration migration, not a schema one. `pnpm start` runs it
as a `prestart` hook, which is exactly why the systemd unit does **not** use
`pnpm start`: the hook writes into the checkout, and `ProtectSystem=strict`
forbids that. On a systemd installation you run it yourself, as the service
user, during the update.

## The upgrade procedure

The order matters. Every step assumes the default layout from
`deploy/README.md`: checkout at `/opt/ironcrew`, database at
`/opt/ironcrew/data/ironcrew.sqlite`, service user `ironcrew`.

### 1. Back up — before anything else

```bash
sudo -u ironcrew node /opt/ironcrew/scripts/ironcrew-backup.mjs \
  --db /opt/ironcrew/data/ironcrew.sqlite \
  --out /var/backups/ironcrew \
  --keep 14
```

This runs `VACUUM INTO` and then `PRAGMA integrity_check` on the snapshot, so
it is safe against a running service and fails rather than writing a corrupt
archive. Note the archive path it prints; you will need it if step 6 goes
wrong.

Your nightly cron backup is not a substitute. It is up to 24 hours old, and the
thing you may need to undo is the change you are about to make.

The environment file is deliberately **not** in the archive. Copy
`/etc/ironcrew/ironcrew.env` and, if you run the runner, `/etc/ironcrew/runner.env`
somewhere safe yourself — see `BACKUP.md`.

### 2. Stop both services

```bash
sudo systemctl stop ironcrew
sudo systemctl stop ironcrew-runner   # only if you installed the runner unit
```

Stop the control plane first. It is the side that sends jobs; stopping the
runner underneath a live control plane turns every in-flight run into a failure
that has to be cleaned up afterwards.

`TimeoutStopSec=30` in the unit gives SQLite a chance to close cleanly after
SIGTERM. Wait for `systemctl status ironcrew` to report `inactive (dead)`
before continuing.

### 3. Pull and install

```bash
cd /opt/ironcrew
git rev-parse --short HEAD          # note this: it is what a rollback checks out
sudo -u ironcrew git pull
sudo -u ironcrew pnpm install
sudo -u ironcrew pnpm run migrate:v1.0.5   # config migration, see above
sudo -u ironcrew pnpm build                # the web bundle; the server runs from source via tsx
```

`pnpm build` builds the front end. There is no compiled server bundle — the
unit runs `node --import tsx server/index.ts` straight from the checkout.

### 4. Look at the schema before it changes

```bash
sudo -u ironcrew node scripts/ironcrew-migrate.mjs status \
  --db /opt/ironcrew/data/ironcrew.sqlite
```

Read the "offen" (pending) count and the list. This is the moment to notice
that an upgrade you thought was cosmetic carries four schema changes.

If you would rather apply them under your own eyes than have the first start do
it, do that now, with the service stopped:

```bash
sudo -u ironcrew node scripts/ironcrew-migrate.mjs apply \
  --db /opt/ironcrew/data/ironcrew.sqlite --force
```

Otherwise skip it: the next start applies them, in the same code path, one
transaction per migration.

### 5. Refresh the unit files

```bash
sudo scripts/install-service.sh
```

Idempotent, and it never overwrites `/etc/ironcrew/ironcrew.env`. It only
re-templates the unit; if `deploy/ironcrew.service` did not change in this
release it says so and does nothing.

It installs the **control plane unit only**. The runner unit is not covered —
see [Known gaps](#known-gaps) for what to do by hand.

New releases sometimes add environment variables, and the installer will not
add them to your env file — it never touches an existing one. Ask the release
what it changed, rather than comparing your file against the example (which
would list every optional variable you have deliberately left unset):

```bash
git diff <previous-ref>..HEAD -- deploy/ironcrew.env.example
```

Note the previous commit or tag in step 3, before pulling, so you have
something to put on the left.

### 6. Start, runner first

```bash
sudo systemctl start ironcrew-runner   # if installed
sudo systemctl start ironcrew
journalctl -u ironcrew -f
```

Runner first, so the control plane finds it already listening on its socket
rather than probing an absent one on its first job.

Watch the log until you see the migrations applied and `scheduler started`.
Until the scheduler line appears, the company answers HTTP but does nothing on
its own.

### 7. Verify

See [After the upgrade](#after-the-upgrade). Do not consider the upgrade
finished because the process is running.

## Rollback

**There is no down migration. Rolling back the code does not roll back the
database.**

That is not an omission to be fixed later; it is the consequence of the
`Migration` interface having no `down()`. Every "rollback" in this system is
one of exactly two things:

### Rolling back only the code, when the schema did not change

If the release you are undoing added no migrations —
`ironcrew-migrate.mjs status` showed no pending versions before the upgrade,
and shows none skipped after — then a `git checkout` of the previous tag,
`pnpm install`, `pnpm build` and a restart is a genuine rollback. Confirm it
first:

```bash
sudo -u ironcrew node scripts/ironcrew-migrate.mjs check \
  --db /opt/ironcrew/data/ironcrew.sqlite
```

Exit code 0 means this build may touch this database. **Exit code 2 means it
may not** — the database has been migrated by a newer build, this one does not
know the schema in front of it, and it would start and write anyway. That is
the case the next section is for.

### Rolling back a schema change: restore the backup

There is no other path. The sequence:

```bash
sudo systemctl stop ironcrew ironcrew-runner
sudo -u ironcrew node scripts/ironcrew-backup.mjs --inspect <archive>   # right date? integrityOk?
sudo -u ironcrew node scripts/ironcrew-backup.mjs \
  --restore <archive> --db /opt/ironcrew/data/ironcrew.sqlite --force
cd /opt/ironcrew && sudo -u ironcrew git checkout <previous-tag>
sudo -u ironcrew pnpm install && sudo -u ironcrew pnpm build
sudo -u ironcrew node scripts/ironcrew-migrate.mjs check --db /opt/ironcrew/data/ironcrew.sqlite
sudo systemctl start ironcrew-runner ironcrew
```

`--force` does not delete the current database: it is moved aside as
`.pre-restore-<timestamp>`. That file is your way back from a wrong archive.

**Everything written since that backup is gone.** Tasks, runs, approvals,
audit entries, incoming mail. That is the real cost of a forward-only schema,
and it is why step 1 of the procedure is a backup taken minutes before the
change rather than last night's.

The practical consequence for planning: an upgrade is only as reversible as
its backup is recent. Take one immediately before, and do not upgrade at the
end of a working day when the last hour of company activity is the part you
cannot afford to lose.

## After the upgrade

Five checks, in ascending order of how much they tell you.

**1. The process is up and is the version you think.**

```bash
systemctl status ironcrew ironcrew-runner
curl -s localhost:8790/api/health
```

`/api/health` is deliberately unauthenticated and returns `version` from
`package.json`. (`app` reads `IronCrew`. On a build older than the rename it
reads `OctoOffice` instead — that is the previous product name in the payload,
not a sign that the wrong build is running.)

**2. The migration state is what you expected.**

```bash
sudo -u ironcrew node scripts/ironcrew-migrate.mjs status \
  --db /opt/ironcrew/data/ironcrew.sqlite
```

Pending must be 0. Nothing must be listed as `ÜBERSPRUNGEN` (skipped) or
`UNBEKANNT` (unknown) — the first means a migration will never run, the second
means this database has seen a newer build than the one now running.

**3. The auto-scan passed.** You get this one for free: if a migration file had
been added without a registry entry, the service would not have started at all,
and the journal would carry
`Migration file NNNN-….ts exists on disk but is not registered in registry.ts`.
A successful start _is_ the auto-scan's result. If the service failed to start,
look for that line before anything else.

**4. The audit chain is intact.** The strongest single statement that the
database came through the upgrade unaltered — every audited row is hashed into
a chain, so a changed byte breaks it:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:8790/api/crew/dashboard | grep auditChainValid
```

`GET /api/crew/audit` returns the full `chain` object, including the sequence
number of the first broken link. The Command Center's dashboard shows the same
flag.

Note that `pnpm run audit:verify` does **not** answer this question — it
verifies a different chain, in a log file. See [Known gaps](#known-gaps).

**5. The integrations still reach the systems they name.** Installed business
packs declare integrations, and each has a probe that makes one real call:

```
GET  /api/crew/packs                                the catalogue and what is configured
POST /api/crew/packs/:key/integrations/:key/test    probe one integration
```

In the Command Center: **Gewerke** in the top bar. This catches the case a
process check never will — a release that renamed an environment variable, so
the service starts perfectly and every Proxmox call fails.

For the CLI runtimes, `GET /api/crew/runtimes` runs `capabilities`, `health`
and `auth` for each registered runtime. It is an on-demand panel rather than
something to poll — each entry shells out to its own CLI to ask for a version —
and it is reachable from the agent detail dialog.
This is the check that catches a runner problem, and it is the subject of the
next section.

**A smoke test, if you want one beyond the checks above.** `pnpm run test:api`
runs the server unit suite against the checkout — it does not touch your
database and does not need the service running, so it is safe to run on the box
after an upgrade. `pnpm run openapi:check` verifies the shipped contract still
matches the routes. `pnpm run test:e2e:smoke` exists but drives a browser
against a dev server and is not meant for a production host.

## Version skew: the runner is a separate process

The runner is its own systemd unit, its own OS user and its own trust domain
(`deploy/ironcrew-runner.service`, `docs/RUNNER_PROTOCOL.md`). It holds the CLI
logins so the control plane never does. The price of that separation is that
**you can restart one and forget the other**, and the two then speak different
versions of the protocol.

### What actually happens

The wire is NDJSON over a Unix socket, and every message carries `v`.
`RUNNER_PROTOCOL_VERSION` is a single constant in
`server/ironcrew/runner/protocol.ts`, currently **1**, compiled into both
sides. `decodeMessage()` rejects any message whose `v` does not equal it:

```
Protocol version 2 does not match this build's 1.
Update the control plane and the runner together.
```

Concretely, on a mismatch:

- The runner's server destroys the socket on the first bad line, before the
  handshake completes.
- The control plane's `openSession()` gets no `hello-ok` and raises
  `RunnerUnavailableError`.
- Every CLI runtime is a `RunnerRuntime` when `IRONCREW_RUNNER_SOCKET` is set,
  so **every agent run fails**, immediately, with an unavailable runtime. The
  control plane itself stays up and the UI stays responsive, which is exactly
  what makes this easy to misdiagnose as "the agents are broken".
- `GET /api/crew/runtimes` reports `health.healthy: false` with the version
  message in `detail`, and `auth.setupHint` asks whether the `ironcrew-runner`
  service is running. That is where the answer is.

The failure is loud and fail-closed — no job is ever executed against a
protocol the other side did not agree to — but it is only visible where you
look for it.

### What to do about it

**Restart both units in the same maintenance window, from the same checkout.**
Both units have `WorkingDirectory=/opt/ironcrew` and run the code in it, so a
single `git pull` moves both; what does not happen automatically is the
restart. That is the whole hazard: one `systemctl restart ironcrew` and a
runner that has been running since last month.

The version the runner process is actually executing is the version of the
checkout at the moment it started. After an upgrade:

```bash
systemctl show ironcrew ironcrew-runner -p ActiveEnterTimestamp
```

If the runner's timestamp predates the `git pull`, it is running the old code
whatever the checkout says.

Two related hazards worth naming:

- **`RUNNER_PROTOCOL_VERSION` is currently 1 and has never been raised**, so
  today no released pair actually mismatches. Do not read that as "the risk is
  theoretical" — read it as "the first time it is raised, every installation
  that restarts one unit and not the other will lose every run until someone
  looks at `/api/crew/runtimes`."
- **The runner and the control plane read different environment files**
  (`/etc/ironcrew/runner.env` and `/etc/ironcrew/ironcrew.env`), and
  `IRONCREW_RUNNER_TOKEN` and `IRONCREW_RUNNER_SOCKET` must agree in both. A
  release that changes the default socket path, or an upgrade in which you edit
  only one file, produces the same "runner unavailable" symptom for a
  completely different reason. The token is compared in constant time and a
  mismatch is reported as an authentication failure, not a version one.

## What Phase 5 changed about upgrading

Three things. All are additive, none locks anybody out, and each has one
consequence for the procedure above.

### Approval quorum (migration 0023)

Adds the table `crew_approval_reviews` and one column,
`crew_approvals.required_approvals INTEGER NOT NULL DEFAULT 1
CHECK (required_approvals >= 1)`.

Every approval that predates the migration takes the default and behaves
exactly as before: one owner, one decision. Nothing that was decidable becomes
undecidable.

The upgrade consequence is the reverse direction. Once you raise an approval to
`required_approvals = 2`, that approval needs two _distinct_ people —
`UNIQUE (approval_id, reviewer_id)` makes it structural, and a second click
from the same person is refused by the database. **Before you roll back to a
build without migration 0023, be aware that the older code does not know the
column**; the reviews table stays behind and the quorum stops being enforced.
That is one more reason a rollback means restoring the backup, not just
checking out the old tag.

### OIDC identities (migration 0024)

Adds `crew_oidc_identities (issuer, subject) PRIMARY KEY`. It creates no rows
and changes no existing table. An installation with no OIDC configuration never
reads it, and password login is untouched — so this migration cannot lock
anybody out of an upgrade.

What it changes for an operator: if you configure SSO after upgrading, keep at
least one password login working. The day the identity provider is
misconfigured is the day somebody has to sign in and fix it, and
`crew_users.password_hash` stays `NOT NULL` precisely so that account still
exists. An unknown directory subject is refused by name rather than
auto-provisioned; see `docs/IDENTITY.md`.

### Audit shipping

`server/ironcrew/audit/audit-shipper.ts` walks the hash chain forward in `seq`
order and hands entries to an off-box sink (`FileAuditSink`, `HttpAuditSink`),
so a truncation of the local table becomes detectable rather than merely
self-consistent.

It keeps its cursor in the `settings` key-value table under
`ironcrew.audit_shipper.cursor.<namespace>.<companyId>`, not in a migration, so
it adds nothing to a schema upgrade. Losing the cursor causes re-shipping —
duplicates, which a receiver deduplicates on `(company_id, seq)` — never a
hole.

**It is not wired to anything yet.** See [Known gaps](#known-gaps).

## Capacity: will the upgraded box still cope?

`scripts/ironcrew-load-test.mjs` builds a throwaway database with the real
schema, fills it with a company of a configurable size, and drives the real
domain layer: task claiming from concurrent workers, the run-request queue,
audit appends, and the eight reads an open Command Center makes.

```bash
node scripts/ironcrew-load-test.mjs                       # defaults
node scripts/ironcrew-load-test.mjs --tasks 20000 --audit-events 200000 --json
```

It refuses to touch an existing database file, exits non-zero only when a
correctness invariant breaks (a task claimed twice, a broken audit chain) and
never merely because it was slow.

The one result worth knowing before an upgrade that will grow the audit log:
**the dashboard read verifies the entire audit chain on every call.** On this
repository's reference run the Command Center poll took ~19 ms at 2,400 audit
rows and ~199 ms at 24,000 — it is linear in the size of the audit log, and the
Command Center makes that call every refresh. If your installation has been
running for a year, run the load test with `--audit-events` set to your actual
row count before deciding the box is fine.

## Known gaps

Written down rather than described as if they worked.

1. **`ironcrew-migrate.mjs apply` cannot create a database from nothing.**
   Migration `0000` alters tables that `applyBaseSchema()` creates, and only
   `server/server-main.ts` calls that. Against a brand-new empty file, `apply`
   fails with `no such table: subtasks` and exits 1. A first installation must
   be bootstrapped by starting the service, not by the CLI. `status` on such a
   file is honest — it says the database has no `schema_migrations` — but the
   failure mode of `apply` is not explained by its message.

2. **`pnpm run audit:verify` does not verify the database audit chain.** It
   runs `scripts/verify-security-audit-log.mjs`, which checks a separate
   hash chain in `$LOGS_DIR/security-audit.ndjson`. `BACKUP.md` step 4 presents
   it as the check on a restored database; it is not. Worse, logs are
   deliberately excluded from backups, so after a restore onto a fresh machine
   the command exits 1 with `log file not found`. The `crew_audit_events` chain
   has **no offline CLI** — `verifyAuditChain()` is reachable only through
   `GET /api/crew/audit` and `GET /api/crew/dashboard`, which means the server
   must be running, which means you have already started the build you were
   trying to verify first.

3. **`scripts/install-service.sh` cannot install the runner unit.**
   `SERVICE_NAME` is hardcoded to `ironcrew` and there is no flag to select the
   other unit, so `deploy/ironcrew-runner.service` must be copied to
   `/etc/systemd/system/` and `daemon-reload`ed by hand — and re-copied after
   any release that changes it. `deploy/README.md` does not mention the runner
   at all. Until this is fixed, add to your own upgrade checklist:
   `sudo cmp deploy/ironcrew-runner.service /etc/systemd/system/ironcrew-runner.service`
   and copy it over if it differs.

4. **Nothing calls the audit shipper.** `AuditShipper` and both sinks are
   implemented and tested, but no scheduler job constructs one, no environment
   variable configures a sink, and no route exposes its status. The module's own
   header says it is written for `scheduler/crew-jobs.ts`; it is not registered
   there. Off-box audit preservation is therefore a library in this build, not a
   feature — treat `docs/THREAT_MODEL.md`'s note that off-box shipping "would
   close this" as still open.

5. **There is no pre-start migration check in the unit.**
   `ironcrew-migrate.mjs check` was written for exactly that
   (`ExecStartPre=`), and its exit codes are documented as a contract, but
   `deploy/ironcrew.service` does not use it. The protection against "old code,
   new database" therefore only exists if you run the command yourself, as
   step 4 and the rollback section tell you to.

6. **No version is recorded in the database.** `schema_migrations` records
   schema versions; nothing records which application version last opened the
   file. `check` infers a rollback from unknown migration versions, which works
   only when the rollback crossed a migration. A code-only rollback leaves no
   trace at all.

7. **`deploy/README.md` still describes backups as "stop the service and `tar`
   the data directory".** That predates `scripts/ironcrew-backup.mjs` and its
   online snapshot. Follow `BACKUP.md`.
