# The run queue

"This should run" and "this is running" used to be the same moment. A task
became `ready`, and then waited for someone to call
`POST /api/crew/tasks/execute-next`. The intent to run existed only as a task
status plus the hope that a caller would come along.

That was tolerable while the only ingress was a human typing into the Command
Center, because the human pressing the button _was_ the scheduler. It stopped
being tolerable when mail and chat became ingresses. A message arriving at
three in the morning creates a task that nothing picks up — and the agent-start
lock made the gap visible, because a task dispatched while its agent is busy is
put back to `ready` and forgotten again.

So the intent gets a row of its own (migration `0016`).

## The shape of it

```text
  an ingress            enqueueRun()  →  crew_run_requests (queued)
        │
  the scheduler         claimNext()   →  running, lease held
        │
        ├─ the run finished           →  done
        ├─ the run failed             →  queued with backoff, or dead
        └─ the run never started      →  queued, attempt given back
```

## Why not just poll the task table

A task status says what a task _is_. It cannot say how often we have tried to
run it, when we may try next, or which attempt failed and why.

Overloading `ready` with all of that would mean either extra columns on
`crew_tasks` that only the scheduler understands, or a scheduler that cannot
back off, cannot stop after N attempts, and retries a permanently broken task
forever at full speed. **Retry state belongs to the attempt, not to the work.**

## One live request per task, as a schema guarantee

```sql
CREATE UNIQUE INDEX idx_crew_run_requests_live
  ON crew_run_requests(task_id)
  WHERE status IN ('queued','running');
```

That partial index is the important line in the migration. Two ingresses can
easily ask for the same task at once — a mail poll and a manual retry, say —
and the resulting double run would be exactly the collision the agent lock
exists to prevent, one layer earlier. A convention would drift; an index
cannot.

`enqueue()` therefore **inserts blind and lets the index decide**. A
select-then-insert would leave a window in which two callers both see nothing
and both write. The unique violation is the expected answer here, not an
error: the loser looks up the winner's row and reports it with `isNew: false`,
so a caller acting on `isNew` never dispatches the same task twice. A short
retry loop covers the narrow case where the live request finishes between the
collision and the lookup — then there is genuinely no live row, and a fresh
one is wanted.

Finished rows sit **outside** the index deliberately, so a task can be re-run
after its first request completed. History is kept rather than deleted: a
failed attempt is evidence, and removing it hides the reason someone is asking
why nothing happened.

## Statuses

| status      | meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `queued`    | waiting to be claimed, once `not_before` has passed              |
| `running`   | claimed, lease held                                              |
| `done`      | the run finished and the task moved on                           |
| `failed`    | allowed by the schema; nothing ever parks a row here — see below |
| `dead`      | attempts exhausted — a human has to look                         |
| `cancelled` | withdrawn before it ran                                          |

`failed` exists in the `CHECK` constraint but the store never rests a row in
it: a failed attempt either goes back to `queued` with backoff or ends as
`dead`. A resting `failed` row would sit outside the live index (so it does
not block a new request), outside the claim query (so nothing picks it up) and
outside `prune` (so nothing ever clears it) — a state with no exit.

## The lease is the same lease as everywhere else

Claiming is a compare-and-set with the condition in the `WHERE` clause, and
the hold is a **lease with an expiry**, not a lock. That is deliberately the
same shape as `TaskStore.claim()` and `AgentLockStore.acquire()`: three places,
one answer to the same question. A fourth answer is how subtle bugs get in.

```sql
UPDATE crew_run_requests
   SET status = 'running', attempts = attempts + 1,
       lease_owner = ?, lease_expires_at = ?
 WHERE id = ? AND status = ? AND attempts = ? AND not_before <= ?
   AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
```

The candidate query is only a shortlist of twenty; the decision is that
guarded `UPDATE`, which pins the status and the attempt count that were
observed. Of two drains looking at the same head, exactly one sees
`changes === 1` and the other walks on to the next candidate — rather than
re-querying from scratch and ping-ponging over one row while the queue behind
it waits.

`claimNext` also reclaims a `running` row whose lease expired, without waiting
for a sweep. A drain that died mid-run leaves a row nobody owns, and waiting
for `sweepExpired` to notice would mean waiting for a caller that may itself be
the process that died. The sweep still runs (see [`SERVICE.md`](./SERVICE.md))
because it makes the same recovery legible: an operator gets a number instead
of a guess about how many drains died holding a lease. A `running` row with no
expiry counts as expired — it is owned by nobody, and leaving it would be
leaving it forever.

| constant               | value  | why                                                                                            |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `DEFAULT_LEASE_TTL_MS` | 15 min | longer than a typical run; short enough that a crash does not park a request for a working day |
| `DEFAULT_DEFER_MS`     | 30 s   | "the agent was busy" resolves in about the time one run takes                                  |

A run that outlives its lease calls `renew()`. A `false` from `renew` means
the request was taken, finished or cancelled underneath — the caller has been
displaced and should stop, not retry through it.

## Failed is not the same as never started

This distinction is the reason the queue exists at all. `drainRunQueue()` has
three outcomes per request:

| outcome     | what happened                                         | the attempt     |
| ----------- | ----------------------------------------------------- | --------------- |
| `completed` | the run finished; the task moved to review or waiting | spent, and fine |
| `failed`    | the run happened and went wrong                       | **spent**       |
| `deferred`  | the run never started — agent busy, vessel full       | **given back**  |

A drain that claims a request and then finds the agent already holds its run
lease, or the vessel at its concurrency limit, **has not tried to run
anything**: nothing was dispatched, no runtime was asked, no money was spent.
Letting that burn an attempt would dead-letter a perfectly good task for the
sole reason that the company was busy — which is precisely the moment the
queue is supposed to be useful. So `defer()` undoes the claim's increment and
puts the row back with a short delay. **Attempts count runs, not claims.**

The increment still happens at _claim_ time rather than at failure time, and
that is not an inconsistency: a request whose run hangs the process must not
be retried forever. For that case the attempt is spent, and correctly so.

An exception escaping the drain itself is treated as a failure, not a defer.
`executeTask` already catches what the runtime does; an exception above it is
the drain's own breakage, which will break again next tick — and the dead
letter is how that becomes visible instead of looping.

## Backoff

`backoffMs(attempt)` — 1-based, deterministic, capped:

```text
30s → 1m → 2m → 4m → 8m → 15m → 15m → …
```

Doubling from 30 seconds, capped at 15 minutes, and **without jitter**. Jitter
spreads a thundering herd; there is one drain per company, so there is no herd
to spread. What jitter would cost is real: a caller that can predict the next
attempt can also test it and explain it to an operator asking when this will
try again.

An overflowing exponent becomes `Infinity`, which the cap absorbs unchanged.

## Dead letter means "this needs a human"

When `attempts >= max_attempts`, `fail()` writes `dead` instead of requeueing,
records `finished_at`, and appends `run_request.dead_lettered` to the audit
log. Nothing in the store quietly revives such a row.

The attempt budget comes from the agent's vessel: `max_retries + 1`, since the
first go is not a retry (see [`VESSELS_TALENTS.md`](./VESSELS_TALENTS.md)).
With the default `max_retries = 1` that is two attempts — a transient failure
gets a second chance, a broken one stops.

The audit entry carries `attempts` and `maxAttempts` and **not** the error
text. `last_error` stays on the row: it can quote run output, and the audit
log is read by people who are not entitled to a run's content. The same
reticence applies at the other end — `run_request.enqueued` records who asked
and with what budget, never the task's title or description. That a run was
asked for is the audit's business; what the work is about is not.

Claims are deliberately **not** audited at all. One drain tick every fifteen
seconds would drown the log in entries nobody reads, and what the run did is
audited anyway.

## Cancelling

`cancel()` withdraws a request, and it cancels a `running` one too rather than
refusing. We cannot reach into a drain that is already working — but the point
of cancelling is that the _result_ must not be acted on, and that we can
guarantee: the row goes terminal immediately, and `complete()` refuses a
`cancelled` row both before the write and in its `WHERE` clause, so a late
finish is rejected instead of silently undoing the cancellation. Leaving the
row `running` and hoping the drain checks back is the weaker guarantee,
because a crashed drain never checks back.

Cancelling twice is a no-op. Cancelling something that already finished is
refused — there is nothing left to withdraw.

## Who enqueues, and who does not

| ingress                         | what it creates                     |
| ------------------------------- | ----------------------------------- |
| the EA delegating a CEO request | task → `ready` **+ a run request**  |
| the CEO requesting a revision   | task → `ready` **+ a run request**  |
| incoming mail                   | an `inbox` task, **no run request** |
| a guest's chat message          | an `inbox` task, **no run request** |

"Queued for execution" used to be a hope. It is now a row that outlives the
process, so work delegated at three in the morning is still waiting to be
picked up at eight.

What is _not_ enqueued matters just as much. External mail and chat land as
`inbox` tasks, which never enter the claimable queue and are never enqueued —
so nothing a stranger writes can start a run while nobody is watching. See
[`MAIL.md`](./MAIL.md), [`MESSENGER.md`](./MESSENGER.md) and
`THREAT_MODEL.md` **T-10**, **T-13** and **T-16**.

## What a restart recovers, and what it does not

**Recovered**, because it is a row:

- Every `queued` request, with its `attempts`, `max_attempts`, `not_before`
  and `last_error` intact. The backoff clock is a timestamp, not a timer, so a
  restart neither resets nor skips it.
- Every `running` request whose drain died: the lease expires and the next
  `claimNext` takes it over, at the cost of the attempt that was already
  counted.

**Not recovered:**

- **The run itself.** A process killed mid-run leaves a `crew_runs` row saying
  `running` and a task holding a lock. The vessel's staleness window stops that
  consuming a concurrency seat forever, and `recoverOrphanedTasks()` exists to
  clean it up — but nothing calls it on a timer today, so an orphaned task
  needs a nudge. (The queue's own half of this _is_ handled: `sweepExpired()`
  runs on the `sweep` job, so the request is reclaimed even though the run row
  it left behind is not tidied.)
- **A lease that has not yet expired.** A request claimed one second before
  the process died waits out the remaining lease — up to fifteen minutes —
  before anything reclaims it. That is the price of a lease over a lock, and
  it is deliberate: the alternative is a drain that cannot tell a slow run from
  a dead one.
- **Mailbox and messenger cursors**, which live in memory. A restart can
  produce a redelivery; `crew_external_events` is what makes that a lookup
  rather than a duplicate task.
- **Missed ticks.** The scheduler has no catch-up: it decides _when to look_,
  and the queue is what remembers. Nothing is lost by a tick that never
  happened, because the row is still there on the next one.

Finished requests are kept for thirty days. The `sweep` job drops `done`,
`dead` and `cancelled` rows older than that; unfinished ones never, since that
would erase the intent to run without anything having run. Thirty days is long
enough that "why did nothing happen last week?" is still answerable from the
queue itself, and short enough that the table does not become an append-only
log of every run the company ever made — the audit chain keeps the decisions,
this table only keeps the mechanics. `IRONCREW_SCHEDULER_SWEEP_SECONDS` changes
how often the sweep looks, not how long rows live.

## REST surface

| Method | Path                             | Notes                                                    |
| ------ | -------------------------------- | -------------------------------------------------------- |
| `GET`  | `/api/crew/run-queue`            | optional `?status=` and `?limit=`; adds the task title   |
| `POST` | `/api/crew/run-queue/:id/cancel` | `409` if the request already finished                    |
| `POST` | `/api/crew/run-queue/drain`      | the same drain the scheduler runs, with `?limit`         |
| `GET`  | `/api/crew/scheduler`            | `{enabled, jobs}`; `enabled:false` means the loop is off |
| `POST` | `/api/crew/scheduler/:name/run`  | runs one job now; `409` when the scheduler is off        |

There is deliberately no endpoint that enqueues an arbitrary task. Work reaches
the queue by being delegated (see _Who enqueues_ above), and an endpoint that
skipped that step would be a way to run a task nobody assigned to anyone.

## Related

- [`VESSELS_TALENTS.md`](./VESSELS_TALENTS.md) — where `max_attempts`, the
  timeout and the concurrency cap come from.
- [`SERVICE.md`](./SERVICE.md) — the scheduler that drains this queue, its
  intervals and its switches.
- `THREAT_MODEL.md` **T-16** — what it means that all of this happens with
  nobody watching.


## Execution recovery corrections (2026-09-05)

A failed task is transitioned back to `ready` only when its retry request has
actually been claimed after `not_before`. Pending/rejected/expired approvals
block automatic revival. Rate limits keep the request queued with the original
run ID and a persisted cooldown; a new orchestrator can continue it after restart.
Other tasks on the same runtime respect that cooldown. Cancelled tasks cannot
be revived by the queue.

The task's project `workspace_path` is passed to execution (an explicit caller
workspace still takes precedence). Filesystem runtimes fail with a recorded
error if no absolute workspace is configured. Only runtimes explicitly declaring
`workspaceRequired: false`, such as the mock and text-only OpenRouter adapter,
can operate without one. The former invented temporary directory is gone.
