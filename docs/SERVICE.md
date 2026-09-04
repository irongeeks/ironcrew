# Running IronCrew as a service

Everything IronCrew does on its own used to need a caller. The run queue
drained when someone pressed a button, mailboxes were polled while the Command
Center was open, messenger channels when somebody asked. That is a program you
operate, not a service you run — and the requirement is a service, with
nobody's console open.

Two halves make that true: **systemd**, so the machine keeps the process
alive, and the **scheduler**, so the process does something while nobody is
watching. The first is documented where it lives; the second is documented
here.

## systemd

Do not hand-copy a unit file. The repository ships one, plus an idempotent
installer:

| File                          | What it is                                            |
| ----------------------------- | ----------------------------------------------------- |
| `deploy/ironcrew.service`     | the systemd unit — hardened, journald, restart limits |
| `deploy/ironcrew.env.example` | every environment variable the server reads           |
| `scripts/install-service.sh`  | the installer that wires the two together             |

`deploy/README.md` has the install, update, backup and uninstall procedure and
`docs/LINUX_INSTALL.md` has the same in the context of a first installation.
Neither is repeated here.

Two properties of the unit matter for what follows: it sends **SIGTERM** and
waits up to 30 seconds before SIGKILL, and it logs to **journald** rather than
to a file. Both are what the scheduler below is written against.

## The scheduler

`server/ironcrew/scheduler/scheduler.ts` is the timer that stands in for the
person who used to press the buttons. It is deliberately a small, boring
primitive rather than a job framework: no persistence, no distribution, no
cron expressions, no catch-up for missed ticks. The durable state lives in the
run queue ([`RUN_QUEUE.md`](./RUN_QUEUE.md)) — that is what survives a restart.
This loop only decides _when to look_.

### The jobs

`server/ironcrew/scheduler/crew-jobs.ts` is the list of things worth doing on
a timer, and the reasoning for each interval. **Five are registered on every
install; `audit-ship` makes six when a sink is configured.**

| job          | default | what it does                                                                    |
| ------------ | ------- | ------------------------------------------------------------------------------- |
| `run-queue`  | 15 s    | `drainRunQueue()` — turns queued run requests into runs, at most 3 per tick     |
| `routines`   | 60 s    | `runDueRoutines()` — fires each routine whose `next_run_at` has passed          |
| `mailboxes`  | 60 s    | `pollDueMailboxes()` — asks mailboxes whose own interval elapsed for new mail   |
| `messengers` | 20 s    | polls every registered messenger channel                                        |
| `audit-ship` | 60 s    | **only when a sink is configured** — carries new audit entries off the box      |
| `sweep`      | 300 s   | releases agent locks and run-request leases nobody released, and prunes the queue |

**`run-queue` at 15 seconds** because this interval _is_ the latency between
"the EA delegated something" and "an agent starts on it" — the responsiveness
a person actually feels. The limit of three per tick is not timidity: an
unbounded drain that started every queued run at once would defeat both the
agent lock and the vessel's concurrency cap by making them fight over a
hundred simultaneous dispatches instead of a handful.

**`routines` at 60 seconds** because a minute is the finest interval a routine
can have, so looking more often would only burn cycles — and looking less often
would quietly make "every 5 minutes" mean something else. This is the job that
runs work with nobody present, which is why `docs/THREAT_MODEL.md` **T-16**
spends its first mitigation on what a routine can and cannot reach.

**`mailboxes` at 60 seconds** because the mailbox rows carry their own poll
interval and `listPollable()` honours it. This only decides how often that
question gets asked, so it can be frequent without meaning "poll every mailbox
every minute".

**`messengers` at 20 seconds** because a chat message should not sit for
minutes — someone is waiting for a reply — but each tick is a real API call
per channel. One unreachable channel is caught inside the job rather than left
to the scheduler: a throw would be handled, but it would also skip every
channel after the one that failed.

**`audit-ship` at 60 seconds, and only when there is somewhere to ship to.**
The point of carrying the audit chain off the box is that a compromise of the
box cannot quietly rewrite its own record, so every second an entry sits only
in the local database is a second an attacker could still remove it unnoticed.
A minute keeps that window small while staying well clear of hammering a
collector. When no sink is configured the job is **not registered at all**
rather than registered as a permanent no-op: `GET /api/crew/scheduler` is a
list of what this service is actually doing, and an entry that reports "nothing
to do" every minute for the life of the installation teaches people to stop
reading it. Configuration and sink kinds are in
[`AUDIT_SHIPPING.md`](./AUDIT_SHIPPING.md).

**`sweep` at 5 minutes** because it is housekeeping. Nothing breaks if it is
late: both the agent lock and the run request treat an expired lease as
expired whether or not anyone swept it. Sweeping only makes the state legible,
and turns "did a drain die?" into a number.

All of them are safe to skip, safe to run late, and safe to run twice in a row.
That is not an accident — it is the property that lets the loop stay this
simple. Anything needing exactly-once execution belongs in the run queue,
which has leases and attempts for precisely that reason.

### The guarantees

**A job never overlaps itself.** A tick arriving while the previous one is
still running is skipped, not queued behind it. Two concurrent mailbox polls
would race on the same "already seen" bookkeeping and could create the same
task twice; two concurrent drains would fight over the same leases. Skipping
is the only safe answer and also the honest one: a job that cannot keep up
with its interval will not be helped by running it twice as often. The same
rule covers the manual `runNow()` path, so triggering a job by hand while it
is already running is as safe as a tick arriving early.

**A failing job never stops the loop.** An unreachable IMAP server is a
Tuesday, not a reason for the queue to stop draining. The error is counted,
logged at `warn`, and the job is rescheduled.

**Timers do not hold the process open.** Every timer is `unref`'d. A pending
five-minute interval that keeps the event loop alive turns `systemctl stop`
into a ninety-second wait for SIGKILL.

**SIGTERM stops the loop before exit.** The signal handler clears the timers
and _awaits_ whatever is mid-flight before the process exits. That matters: a
drain killed between claiming a request and recording its outcome leaves a
lease to expire, which is recoverable but wastes the next fifteen minutes on
recovery that was never needed.

Re-arming happens **after** a run finishes, not on a fixed interval, so a slow
job cannot accumulate a backlog of timers behind itself. First ticks are
spread deterministically across the interval rather than all firing at boot —
a service that opens four network connections the moment it starts looks like
a thundering herd to whatever is on the other end — and deterministically, so
a restart behaves the same way twice.

### Configuration

| variable                                | default | effect                                              |
| --------------------------------------- | ------- | --------------------------------------------------- |
| `IRONCREW_SCHEDULER`                    | `on`    | master switch; `off`, `0`, `false`, `no` disable it |
| `IRONCREW_SCHEDULER_QUEUE_SECONDS`      | 15      | `run-queue` interval                                |
| `IRONCREW_SCHEDULER_ROUTINE_SECONDS`    | 60      | `routines` interval                                 |
| `IRONCREW_SCHEDULER_MAIL_SECONDS`       | 60      | `mailboxes` interval                                |
| `IRONCREW_SCHEDULER_MESSENGER_SECONDS`  | 20      | `messengers` interval                               |
| `IRONCREW_SCHEDULER_AUDIT_SHIP_SECONDS` | 60      | `audit-ship` interval (no effect without a sink)    |
| `IRONCREW_SCHEDULER_SWEEP_SECONDS`      | 300     | `sweep` interval                                    |

These set the **cadence** only. Whether `audit-ship` exists at all is decided
by `IRONCREW_AUDIT_SINK` ([`AUDIT_SHIPPING.md`](./AUDIT_SHIPPING.md)), not by
its interval variable.

The intervals are read **in seconds** and converted internally; fractional
values are allowed and rounded to milliseconds.

**Default is on.** A service that has to be switched on to do anything is a
service that will be found switched off. `off` is for the cases where it
genuinely must not run: a second instance sharing one database, or a developer
who does not want their laptop polling a live mailbox.

**An unusable value is ignored, not applied.** A blank, non-numeric, zero or
negative interval falls back to the default and says so:

```json
{
  "level": 40,
  "module": "ironcrew-scheduler",
  "name": "IRONCREW_SCHEDULER_QUEUE_SECONDS",
  "value": "15s",
  "msg": "ignoring unusable scheduler interval"
}
```

A typo must not silently become a one-millisecond loop hammering the database.
Note the shape of the mistake this catches: `15s` is not a number, so the
value is refused rather than parsed as 15.

### What changes when the scheduler is off

The server still starts, still serves the Command Center, still answers every
`/api/crew` endpoint, and still executes a run when someone asks for one
explicitly. What stops is everything it would have done on its own:

- **the run queue is never drained.** Requests still accumulate — the EA still
  records the intent to run when it delegates — but nothing claims them, so no
  agent starts on anything.
- **every routine stops.** This is the one that surprises people, so it is
  stated flatly: `IRONCREW_SCHEDULER=off` switches off **all** recurring work.
  A routine still shows as `enabled` in the Command Center and its
  `next_run_at` still sits in the past, because nothing is wrong with the
  routine — nothing is asking whether it is due. No task is created, no
  `routine.fired` audit entry is written, and `run_count` never moves. There
  is no catch-up when the scheduler comes back: a missed firing is missed, not
  queued. If you want one routine off, disable that routine
  (`POST /api/crew/routines/:id/enabled`); the master switch is the wrong
  instrument for it.
- **mailboxes are never polled.** Mail sits on the server until someone calls
  `POST /api/crew/mailboxes/poll-due`.
- **messenger channels are never polled.** Nothing an owner writes over
  Telegram or Discord is seen until someone calls the poll endpoint.
- **the audit chain never leaves the box** — if a sink is configured at all.
  Entries are still written and still hash-chained locally, so nothing is lost
  and tampering is still detectable; what stops is the off-box copy that would
  survive somebody deleting the local one. The backlog is not lost either: the
  cursor stays where it was and the next drain ships everything since.
- **no lease is ever swept.** Expired leases are still treated as expired by
  everything that reads them, so nothing breaks; the rows just stay untidy.

Stated plainly: **the server answers HTTP, and nothing runs, polls, fires or
drains on its own.** One line in the log says which mode you are in.

## Erste Inbetriebnahme

A checklist an admin can follow once, in order.

**1. Install.**

```bash
sudo git clone https://github.com/irongeeks/ironcrew.git /opt/ironcrew
cd /opt/ironcrew && sudo pnpm install && sudo pnpm build
sudo scripts/install-service.sh
```

The installer creates the service user, the data directories and
`/etc/ironcrew/ironcrew.env` (mode 600, never overwriting an existing file),
templates the unit and runs `daemon-reload`. It deliberately starts nothing.

**2. Configure.**

```bash
sudoedit /etc/ironcrew/ironcrew.env
```

At minimum `OAUTH_ENCRYPTION_SECRET`. Leave `IRONCREW_SCHEDULER` at its
default unless a second instance shares this database. Set the interval
variables only if you have a reason — the defaults are the reasoning above.

**3. Start.**

```bash
sudo systemctl enable --now ironcrew
```

**4. Verify.**

```bash
systemctl status ironcrew            # active (running), no restart loop
journalctl -u ironcrew -f            # follow
```

Three lines prove the state of the loop, all under
`"module":"ironcrew-scheduler"`:

| log line                                             | means                                          |
| ---------------------------------------------------- | ---------------------------------------------- |
| `scheduler started` with a `jobs` array               | the loop is armed; see the expected list below |
| `IronCrew scheduler disabled via IRONCREW_SCHEDULER` | the switch is off — nothing will run by itself |
| `scheduled job failed`                               | one job threw; the loop is still running       |

`scheduler started` is the one to look for. On a default install its `jobs`
array reads:

```json
{ "module": "ironcrew-scheduler", "jobs": ["run-queue", "routines", "mailboxes", "messengers", "sweep"], "msg": "scheduler started" }
```

**Five entries, and `routines` among them.** With an audit sink configured
there are six, with `audit-ship` between `messengers` and `sweep`. Count them:
a missing `routines` means no recurring work will happen tonight, and that is
not visible anywhere else until the morning it did not happen. If it is absent
and the disabled line is present instead, the environment file says `off`.

The same list is available over HTTP as `GET /api/crew/scheduler`, which
answers `{"enabled":true,"jobs":[…]}` — `enabled:false` is a real answer there
rather than a 404, so the Command Center can say "switched off" instead of
showing an empty list that looks like a broken page. Unlike `/api/health` it is
behind the session guard once any account exists, so the journal line above is
the check that always works from a shell.

**5. Prove it is doing work.** The jobs log only when something happened — an
idle company produces no lines at all, which is correct but indistinguishable
from a dead loop at a glance. Give it something to do and watch for the
outcome:

```bash
journalctl -u ironcrew -f | grep -F 'run queue drained'
```

Send the EA a request in the Command Center that it can delegate. Within one
`run-queue` interval:

```json
{ "module": "ironcrew-scheduler", "claimed": 1, "completed": 1, "failed": 0, "deferred": 0, "msg": "run queue drained" }
```

`claimed` counts what the drain took, and the other three say what became of
it — `deferred` is not a failure, it means the agent or the vessel was busy
and the request went back on the queue with its attempt returned
([`RUN_QUEUE.md`](./RUN_QUEUE.md)). The other jobs announce themselves the
same way when they find something, and only then: `routines fired`,
`mailboxes polled`, `messenger polled`, `audit entries shipped off box`, and
`queue housekeeping` from the sweep. Silence from a job is "nothing was due",
not "the job is missing" — which is why the `jobs` array at startup, not the
absence of a line, is how you tell a job is registered.

**6. Confirm a clean stop.**

```bash
sudo systemctl restart ironcrew
```

`shutting down` followed by `scheduler stopped`, and the unit back to active
within a couple of seconds. A restart that takes 30 seconds and ends in
SIGKILL means something is holding the event loop open — that is a bug, not a
configuration problem.

## Related

- [`RUN_QUEUE.md`](./RUN_QUEUE.md) — what the `run-queue` job drains, and what
  survives a restart.
- [`VESSELS_TALENTS.md`](./VESSELS_TALENTS.md) — the timeout and concurrency
  caps every scheduled run is subject to.
- `deploy/README.md` — install, update, backups, uninstall.
- `THREAT_MODEL.md` **T-16** — background execution with no human present.
