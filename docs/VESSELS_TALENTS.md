# Vessels and Talents

An agent used to carry everything on one row: what it is competent for, what
it may do, how it sounds, and which runtime executes it. Two consequences,
both felt daily:

- **The role "CTO" was defined once per agent, not once.** Fourteen agents,
  fourteen private copies of the same role, no reuse and no way to fix all of
  them at once.
- **An agent was welded to one runtime.** Moving a role from Claude Code to
  Codex meant redefining the role, because the runtime was a column on the
  same row as the role.

So migration `0011` splits the row into the two things it was conflating. An
agent is now a **Vessel × Talent placed in an org**.

## The shape of it

```text
  crew_vessels    the execution container — which runtime, how long,
        │         how often, how many at once
        │
  crew_agents     what is genuinely the agent's own: department, live
        │         status, whether it is the EA — and the pairing
        │
  crew_talents    the capability package — professional role, policy,
                  persona, and the skills it draws on
```

Several agents share one vessel; several agents may share one talent. Neither
half knows about the other, which is the point: a role can move between
runtimes without being redefined, and a runtime can be retuned without
touching anybody's role.

## What a vessel governs

| Column             | Default  | What it decides                                   |
| ------------------ | -------- | ------------------------------------------------- |
| `runtime_provider` | `mock`   | which registered `AgentRuntime` executes a run    |
| `model`            | `''`     | model override; empty means the runtime's default |
| `timeout_ms`       | `600000` | how long one run may take                         |
| `max_retries`      | `1`      | how often the queue may try again after a failure |
| `max_concurrency`  | `1`      | how many runs this vessel may have in flight      |

That is the whole of a vessel's authority: **how long and how often a run may
take, and where it executes**. Not what it may do.

## What a vessel deliberately does not govern

**No permission mode. No sandbox setting. No tool allowlist.** Not in the
table, not in `VesselInput`, and not as a field someone should add later.

CLI permission modes come from a `SandboxGrant` that names the
`ApprovalRequest` it was minted from, is scoped to a company, a runtime and
optionally a single task, and is hard-capped at four hours regardless of its
stated expiry (`THREAT_MODEL.md` **T-01**). A vessel column saying `elevated`
would be a second route to elevation that no approval ever authorised — and,
unlike a grant, it would never expire. Elevation would become a setting
someone ticks once and forgets, which is exactly the upstream behaviour the
permission policy exists to undo.

This is why `VesselStore.update()` is not a column-spreader. It walks a fixed
map of known fields rather than the caller's object, so an unexpected key
arriving in a JSON body — `permission_mode`, `allowed_tools` — is ignored
rather than smuggled into the `SET` clause. The allowlist is the mechanism,
not the comment above it.

The same split runs the other way: a **talent** says what an agent may do
(`policy_json`), and never says how long a run may take.

## How each column actually reaches a run

A settings table nobody reads is decoration. Each of the four columns has one
place where it takes effect, in `CompanyOrchestrator#executeTask()`.

### `model` → the runtime and the run row

The vessel's model is normalised to `undefined` when empty, then passed both
to `RunStore.create()` and into the runtime's `startRun()`. Empty means
"whatever the runtime defaults to"; passing `""` through instead would ask a
runtime to use a model called `""`, which fails in a way that looks like a
broken account rather than a blank field.

### `timeout_ms` → an `AbortSignal` both runtimes honour

The timeout is an `AbortController` whose signal is handed to the runtime.
`CliAdapterRuntime` kills its process tree on it and `MockRuntime` stops
iterating, so the cap is enforced by the thing doing the work rather than by a
watchdog that can only notice afterwards.

Two details that are not obvious:

- The timer is **unref'd**. A finished run must not hold the process open for
  the remaining nine minutes of its vessel's timeout, which is precisely what
  an un-unref'd timer would do to a server trying to shut down.
- A timeout is **named**, not left as an abort. From inside the runtime an
  abort is opaque, so the failure event says
  `Zeitlimit des Vessels erreicht (600000 ms)` — actionable, because the
  answer is to raise the limit or split the task, where "aborted" is not. A
  runtime that ends its stream quietly on abort is caught afterwards, so a
  timed-out run never looks like a clean finish waiting for review.

A missing vessel falls back to ten minutes rather than to no limit: a run is
never unbounded in time.

### `max_retries` → the queue's attempt budget

`enqueueRun()` sets the run request's `max_attempts` to `max_retries + 1` —
plus one, because the first go is not a retry. An operator raising retries on
a flaky runtime changes how hard the queue tries without touching the queue.
See [`RUN_QUEUE.md`](./RUN_QUEUE.md) for what an attempt is, and for the
distinction between a run that failed and a run that never started.

### `max_concurrency` → admission by rank at dispatch

Five agents sharing one Claude Code vessel are five agents sharing one CLI
account and one rate limit. Starting all five at once is how that account gets
throttled, so the vessel admits by seat.

The check asks **"how many runs on this vessel are ahead of me?"**, not "how
many runs are there?":

```sql
SELECT COUNT(*) AS ahead
  FROM crew_runs r
  JOIN crew_agents a ON a.id = r.agent_id
 WHERE a.vessel_id = ?
   AND r.status IN ('queued','running')
   AND COALESCE(r.heartbeat_at, r.created_at) > ?      -- not stale
   AND r.rowid < (SELECT rowid FROM crew_runs WHERE id = ?)
```

**Why rank and not a count.** Counting before inserting is a read-then-write.
Two dispatchers, for two different agents sharing one vessel, would both read
"one seat free" and both take it. Here the run row is already committed before
the question is asked, so both dispatchers see both rows and order them the
same way: the earlier one is admitted, the later one backs off. The database
resolves the race instead of the timing of two callers.

**Why `rowid`.** Ordering is by SQLite's insertion order, not by `created_at`,
which is only millisecond-precise. Two runs created in the same millisecond
would need a tiebreak, and `id` is random — so the tiebreak would decide by
coin flip which of them counts as first. A cap that admits or refuses the same
situation differently on different runs is worse than no cap, because nobody
can reproduce it.

**Why staleness matters.** A run row says `running` until something writes
otherwise, and a process killed mid-run writes nothing. Without the
five-minute staleness window, one crash would permanently consume a seat on a
vessel whose whole purpose is to cap concurrency — the limit would ratchet
down to zero over time and no error would ever say why. Every persisted event
calls `runs.heartbeat()`, so five minutes of total silence is well past
anything a live run produces.

Refusal is fail-closed and identical in shape to the agent lock one layer in:
the agent lock and the task lock are released, the run is cancelled, and the
task returns to `ready` with the reason recorded — so it is picked up again as
soon as a seat frees, rather than sitting claimed by a run that never
happened.

## What a talent carries

| Column                                           | Meaning                                   |
| ------------------------------------------------ | ----------------------------------------- |
| `professional_role`, `role_summary`, `seniority` | what the agent is competent for           |
| `policy_json`                                    | what the agent may do — **authoritative** |
| `persona_json`                                   | how it sounds — **cosmetic only**         |
| `skills_json`                                    | installed skills it draws on, by name     |

The three-layer separation is unchanged in meaning; only where it is stored
has moved. `seniority` is constrained to `chief_of_staff`, `executive`,
`lead`, `senior` — the vocabulary `config/agents.seed.yaml` already speaks,
deliberately not the legacy collab modules' `team_leader | senior | junior |
intern`, which is a different field about a different thing.

`TalentStore` insists on two things. **Policy and persona are given as
objects, never as strings**, so the store serialises them and no reader
downstream has to defend against a parse failure. And **their contents never
reach the audit log**: the chain answers "who changed which talent, when", and
key, role and the names of the changed fields carry that. A persona is prose
and a policy is a permission set; neither belongs in a log read by whoever can
read logs.

## Reading an agent back

An agent row no longer carries its role or its runtime, but a _resolved_ agent
still has both — that is what an agent is, once the pairing is followed. So
`domain/agent-resolution.ts` provides the one join, and every read goes
through it. The joined columns keep their original names on purpose:
`professional_role` still means what it always meant, and a consumer asking an
agent for its role should not have to know which table answers.

It is a `LEFT JOIN` with `COALESCE`, not an `INNER JOIN`. An agent whose
talent or vessel is somehow missing still appears — visibly, with defaults —
so a broken pairing shows up in the org chart as an agent to fix, rather than
as an agent that silently vanished from every list.

## Deleting a vessel or talent an agent still holds is refused

The foreign keys are `ON DELETE RESTRICT`, not `CASCADE` and not `SET NULL`.
Cascading would delete people because a role was tidied away; nulling would
silently strip agents of their role and leave them running on defaults nobody
chose. Both are worse than an error.

SQLite answers a restricted delete with a bare `FOREIGN KEY constraint
failed`, which tells the owner nothing, so the stores check first and name the
blockers:

```text
Das Vessel "claude-code" wird noch von 3 Agent(en) verwendet (cto, dev, qa).
Weise diese Agenten zuerst einem anderen Vessel zu.
```

The raw constraint is still caught behind that check, for the case where an
agent is bound between the lookup and the `DELETE` — so a constraint error
never reaches the API either way. Deleting something that does not exist is a
no-op, not an error: the caller's intent already holds.

## Rebinding

Two ways an agent changes its pairing, and both re-check tenancy:

- `PATCH /api/crew/agents/:id/runtime` moves the agent into the vessel for
  that runtime provider, creating it if this company has none. The talent it
  carries is untouched — the same role really does run somewhere else, rather
  than being redefined there.
- `setAgentPairing()` rebinds vessel, talent or both. Both ids are re-checked
  against the company **before anything is written**, because the foreign keys
  alone would not catch it: `crew_vessels.id` is unique across the whole
  database, so binding an agent to _another company's_ vessel is a perfectly
  valid FK and a complete tenancy break. The check has to live where the
  company is known.

## REST surface

| Method   | Path                            | Notes                                                     |
| -------- | ------------------------------- | --------------------------------------------------------- |
| `GET`    | `/api/crew/vessels`             | each vessel with the agents using it                      |
| `POST`   | `/api/crew/vessels`             | `key`, `runtimeProvider`, and the optional limits         |
| `PATCH`  | `/api/crew/vessels/:id`         | omitted fields stay as they are; `key` cannot be changed  |
| `DELETE` | `/api/crew/vessels/:id`         | `409` while agents still hold it — the message names them |
| `GET`    | `/api/crew/talents`             | same shape                                                |
| `GET`    | `/api/crew/talents/seniorities` | the allowed values, so the UI does not hardcode them      |
| `POST`   | `/api/crew/talents`             | `key`, `professionalRole`, optional policy/persona/skills |
| `PATCH`  | `/api/crew/talents/:id`         |                                                           |
| `DELETE` | `/api/crew/talents/:id`         | `409` while agents still hold it                          |
| `POST`   | `/api/crew/agents/:id/pairing`  | `vesselId`, `talentId`, or one of the two                 |

The vessel endpoints accept no authority fields, and that is enforced twice:
the request schema has none, and the store patches through a column allowlist,
so a body carrying `permission_mode` or `allowed_tools` changes nothing rather
than being rejected with a message that implies such a field could exist. A
test asserts both — that the PATCH is a no-op, and that `crew_vessels` still
has no such column afterwards.

`GET /api/crew/agents` continues to expose `vesselId`, `vesselKey`,
`runtimeProvider`, `talentId`, `talentKey` and `skills`, so a client that only
wants to _show_ the pairing needs none of the endpoints above.

## What the migration did

`0011` derives the new shape from the old one before dropping anything, inside
the migration runner's transaction, so a failure at any point leaves the old
shape intact.

- **One talent per agent**, keyed by the agent's own key. Each of the seed
  crew has a role of its own, and inventing shared talents by comparing JSON
  would merge two roles that merely look alike today. Agents that should share
  a talent can be pointed at one afterwards — that is the capability this
  migration creates, not a guess it should make.
- **One vessel per distinct runtime provider in use**, which is the grouping
  that actually exists in the data.
- **The moved columns are dropped, not left behind.** Keeping them would leave
  two places claiming to say what an agent's role is, and they would drift the
  first time someone wrote to the wrong one. `runtime_profile` went with them:
  it was stored, passed around and served over the API without ever being read
  by anything. It was meant to be the vessel and never became one; the vessel
  exists now, so the placeholder goes.

See `THREAT_MODEL.md` **T-01** for why the permission mode is not a vessel
column, and [`RUN_QUEUE.md`](./RUN_QUEUE.md) for what the timeout, the retries
and the concurrency cap do once work is queued.
