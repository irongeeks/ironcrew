# Carrying the audit log off the box

`crew_audit_events` is an append-only hash chain. Every entry carries the hash
of the one before it, so an edit anywhere in the record breaks every link after
it and `verifyAuditChain()` says where.

That proves nobody _edited_ the record. It does not prove nobody _deleted_ it,
and it never could. Whoever owns the machine owns the file: they can drop the
table, truncate it, or — with a little more care — recompute the whole chain
around a removed entry and produce a shorter, quieter record that verifies
perfectly. A chain that exists only on the machine it describes is a chain that
machine's owner controls.

So a copy leaves, continuously, to somewhere the box's own credentials do not
reach.

## What it is not

It is not a replacement for the local chain, and it is not a log-forwarding
feature. This ships `crew_audit_events`: the decisions, the approvals, who
signed what.

Three things check three different chains, and confusing them wastes an
incident:

| Command                    | Checks                                                |
| -------------------------- | ----------------------------------------------------- |
| `pnpm run audit:verify`    | the NDJSON security log under `$LOGS_DIR`             |
| `pnpm run audit:verify:db` | `crew_audit_events` in a database file, offline       |
| this feature               | carries `crew_audit_events` off the box, continuously |

The offline verifier proves the rows present are unedited. Only the off-box
copy answers the question it cannot: whether rows were removed from the end,
which leaves neither a broken link nor a hole.

It is also not a backup. `scripts/ironcrew-backup.mjs` takes a consistent
snapshot of the whole database so you can restore it. This takes one table,
one line per entry, somewhere you cannot un-take it from. They answer different
questions and neither substitutes for the other.

## Switching it on

Off by default, configured by presence, like every other integration:

```
IRONCREW_AUDIT_SINK=file
IRONCREW_AUDIT_FILE=/mnt/audit-archive/ironcrew.ndjson
```

or

```
IRONCREW_AUDIT_SINK=http
IRONCREW_AUDIT_URL=https://collector.intern.example/ingest
IRONCREW_AUDIT_TOKEN=…
```

`IRONCREW_AUDIT_SINK` names the kind explicitly. Nothing is inferred from a
stray URL, and a value that is neither `file` nor `http` (nor empty, nor `off`)
refuses to start rather than quietly disabling itself. A sink named without its
target does the same. A half-configured audit sink that ships nothing is worse
than none at all, because somebody believes they have a copy.

The token lives in exactly one place: an `Authorization` header inside the
sink. It is never interpolated into a URL, a log line or a status response, and
a test asserts it appears in none of them — including in the message a failing
probe produces, which is where a credential usually escapes.

**Point it somewhere genuinely off-box.** A file sink aimed at the same disk
buys nothing: the attacker who can delete the table can delete that file in the
same breath. A mounted volume the box can write but not delete from, an NFS
export with append-only semantics, a collector on another machine, a second
IronCrew — any of those is the point. The same disk is theatre.

## What it does on a timer

The `audit-ship` scheduler job runs every 60 seconds when a sink is configured,
and does not exist at all when none is. Every second an entry sits only in the
local file is a second an attacker could still remove it unnoticed, so the
interval is short; a batch carries up to 200 entries and one tick may ship 20
batches, which is 4,000 entries of headroom per minute — far more than this
system writes in an hour.

`IRONCREW_SCHEDULER_AUDIT_SHIP_SECONDS` overrides it.

## The cursor, and why it only ever moves over accepted entries

The last seq known to be off-box lives in the `settings` table, under a key
that includes a namespace so two sinks cannot share one cursor. (Two shippers
on one cursor would each see only the entries the other had not claimed,
leaving a hole in both copies.)

The cursor advances only over entries the sink actually accepted, and a partial
acceptance is a **prefix**, never a subset: entry N+1 is not recorded as
shipped unless N was. Everything about the failure paths leans the same way:

- **HTTP, non-2xx:** nothing is counted. We cannot know how many lines the far
  side persisted, so the whole batch is retried next tick. A duplicate is
  something the receiver drops by `(company_id, seq)`; a guessed partial
  success is a hole nobody can reconstruct.
- **File, partial write:** entries are written one at a time and only completed
  ones counted. A batch that dies after three leaves the cursor on entry three.
  A failure _inside_ an entry leaves a torn half-line, which we accept: the
  torn entry is re-shipped in full, so a reader sees one broken line followed
  by the complete entry. Truncating back to the last good newline would be
  tidier and is exactly the operation this module refuses to build — it never
  removes bytes from an audit archive.
- **A lost cursor** falls back to 0 and re-ships. Duplicates, again the
  harmless direction.

A gap _below_ the cursor — rows missing under the first unshipped entry — is
reported as a warning and never treated as fatal. The shipper carries on from
where it is. It is also exactly the shape a tampering attempt has, which is why
it is said out loud in the log rather than silently skipped.

## Watching it

```
GET  /api/crew/audit/shipping        where the copy stands
POST /api/crew/audit/shipping/test   probe the sink            owner only
POST /api/crew/audit/shipping/run    drain the backlog now     owner only
```

The status reports `configured: false` with a sentence rather than a 404 when
no sink is set up: an operator on that page is asking "is my audit log leaving
this machine?", and a 404 answers a different question. It is readable by any
signed-in user — how far behind the archive is, is not a secret.

The probe posts an empty NDJSON body. It proves the endpoint, the network path
and the token without writing a fake entry, because an audit archive containing
test rows is an audit archive nobody trusts. It answers `200` with `ok: false`
when the collector is unreachable: that is a status a page displays, not a
failure of the request that asked.

A failing sink is logged at `warn` on every tick it stays broken. A sink that
has been unreachable for a day is the one thing an operator must not discover
from the archive being empty when they finally need it.

## Verifying the local chain, and why the dashboard no longer does

`verifyAuditChain()` recomputes every hash for the company. That is necessary —
a chain is only sound end to end — and ruinous on a poll: measured at 8 ms with
820 audit rows and 39 ms with 5,420, linear in a table that only grows, while
an open Command Center asks for the dashboard on every refresh. A year-old
installation would re-hash hundreds of thousands of rows several times a
minute.

So `GET /api/crew/dashboard` serves a cached answer no older than 60 seconds
and reports `auditChainCheckedAt` alongside it, instead of implying the check
was taken just now. `GET /api/crew/audit` still verifies for real on every
call, because that request _is_ somebody asking the question, and it refreshes
the cache so the panel beside it does not show a staler answer.

This is a smaller loss than it looks. A full local verification catches an edit
that did not fix the hashes — a careless one. An attacker who owns the box can
recompute the chain and pass every local check there is. The off-box copy is
what catches that, which is why re-hashing on a timer was a poor trade at any
interval.

## Known gaps

- **One sink, not a list.** The cursor namespace exists so a second could be
  added without the two treading on each other, but nothing constructs a
  second today.
- **No signature on the shipped copy.** The entries carry their own chain
  hashes, so a reader can verify the copy is internally consistent, but nothing
  proves _this installation_ produced it. A collector that accepts NDJSON from
  anyone accepts forged NDJSON from anyone.
- **No alert channel.** A broken sink goes to the log at `warn`. It does not
  raise a notification in the decision inbox, which is where an operator would
  actually see it.
