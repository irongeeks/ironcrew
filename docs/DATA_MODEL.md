# Data Model

All IronCrew tables are prefixed `crew_` and live alongside the upstream
OctoOffice tables. The base schema (companies through audit events) is
created by migration `0002-iron-crew-domain.ts`; everything since —
milestones, secrets, attachments, remote workers, meetings, mailboxes,
marketplaces, vessels and talents, the agent run lease, external events,
change proposals, messenger pairings, the run queue — arrived as
additive migrations `0003`–`0016`, listed in `registry.ts` and applied in
order at startup. `0006` is the one exception: it renamed every table from
this project's original `ic_` prefix to `crew_` in place (see
`docs/UPSTREAM_ANALYSIS.md`), which is also why this file no longer matches
its own migration filename above.

Conventions:

- Identifiers are prefixed strings (`task_…`, `run_…`) so they are
  self-describing in logs and audit trails.
- Timestamps are INTEGER epoch milliseconds.
- Money is INTEGER **micros** (1e-6 of the company currency), so accumulated
  spend never drifts through floating point.
- **Every business table carries `company_id`** from day one. The MVP runs one
  company, but retrofitting a tenant key later means touching every index and
  every query.

## Tenancy and org

| Table              | Purpose              | Notable columns                          |
| ------------------ | -------------------- | ---------------------------------------- |
| `crew_companies`   | The company          | `slug` (unique), `owner_name`, `locale`  |
| `crew_departments` | Departments          | unique `(company_id, key)`, `sort_order` |
| `crew_agents`      | Agents               | see below                                |
| `crew_vessels`     | Execution containers | migration `0011`, see below              |
| `crew_talents`     | Capability packages  | migration `0011`, see below              |

### `crew_agents` — Vessel × Talent placed in an org

An agent used to carry everything on its own row: its role, its policy, its
persona and its runtime. Migration `0011` splits that in two, because the row
was conflating two different things — the role "CTO" was defined once per
agent rather than once, and an agent was welded to one runtime.

What is left on `crew_agents` is what is genuinely the agent's own: its
`department_id`, `display_name`, `status`, `is_executive_assistant`, the run
lease (below) — and the pairing, `vessel_id` and `talent_id`. The moved
columns were **dropped**, not left behind: two places claiming to say what an
agent's role is would drift the first time someone wrote to the wrong one.

`status` is one of the ten agent states and is **derived** server-side from the
work an agent holds (`deriveAgentStatus()`), never self-reported. This is why a
UI figure cannot disagree with the control plane.

### `crew_talents` — the three-layer separation

The product's central invariant is expressed structurally, in three separate
columns that are never merged — now on the talent, so a role is defined once
and worn by as many agents as the org needs:

| Layer             | Column                                           | Meaning                                   |
| ----------------- | ------------------------------------------------ | ----------------------------------------- |
| Professional role | `professional_role`, `role_summary`, `seniority` | what the agent is competent for           |
| Policy            | `policy_json`                                    | what the agent may do — **authoritative** |
| Persona skin      | `persona_json`                                   | how it sounds — **cosmetic only**         |

`policy_json` is Zod-validated on read; `may_approve` is typed as the literal
`false`, so no configuration can grant an agent approval authority.
`skills_json` names installed skills (`crew_marketplace_installs`) rather than
carrying them. `seniority` is one of `chief_of_staff`, `executive`, `lead`,
`senior`. Unique on `(company_id, key)`.

### `crew_vessels` — the execution container

| Column             | Default  | What it decides                                   |
| ------------------ | -------- | ------------------------------------------------- |
| `runtime_provider` | `mock`   | which registered `AgentRuntime` executes a run    |
| `model`            | `''`     | model override; empty means the runtime's default |
| `timeout_ms`       | `600000` | how long one run may take (`CHECK > 0`)           |
| `max_retries`      | `1`      | the run queue's attempt budget, `+ 1`             |
| `max_concurrency`  | `1`      | how many runs this vessel may have in flight      |

Note what is **absent, and stays absent**: no permission mode, no sandbox
setting, no tool allowlist. Permission modes come only from a `SandboxGrant`
minted from an approved `ApprovalRequest` and capped at four hours
(`THREAT_MODEL.md` T-01); a vessel column saying `elevated` would be a second
route to elevation that no approval authorised and that never expires. A
vessel governs how long and how often a run may take, never what it may do.

Both pairings are `ON DELETE RESTRICT`. Deleting a vessel or talent agents
still hold fails loudly rather than silently stripping them of their role or
deleting people because a role was tidied away. See
`docs/VESSELS_TALENTS.md`.

## Work

| Table                    | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `crew_goals`             | Company goals, self-referential via `parent_id` for goal ancestry                  |
| `crew_projects`          | Projects, optionally linked to a goal and a workspace path                         |
| `crew_milestones`        | Project milestones, `sort_order` for the detail view's ordering (migration `0003`) |
| `crew_tasks`             | Tasks — the heart of the system                                                    |
| `crew_task_dependencies` | Blocker edges                                                                      |

### `crew_tasks`

```text
status              inbox | planned | ready | assigned | running | waiting |
                    blocked | review | approval_required | done | failed | cancelled
status_version      INTEGER  — CAS token, bumped on every transition
status_reason       why the last transition happened

execution_run_id    ─┐
execution_locked_at  ├─ the execution lock triple
lock_expires_at     ─┘

parent_task_id      self-FK, parent/child task trees
correlation_id      one id spanning message → task → runs → audit
risk_level          low | medium | high | critical
sensitive           0 | 1  — routed through the approval engine
acceptance_criteria JSON array of strings
```

**Why `status_version` exists.** Claiming and transitioning are compare-and-set
operations that carry the observed version in the `WHERE` clause. Two concurrent
writers cannot both succeed; the loser sees zero affected rows and returns
`null` rather than throwing, so there is no retry storm.

**Why the lock is released by run id.** `releaseLock()` and `recoverOrphaned()`
always name the run they observed holding the lock. Without that, a reaper
acting on stale information would clear a lock a fresh owner had already taken.

`crew_task_dependencies` has `UNIQUE (company_id, task_id, depends_on_id, kind)`
and `CHECK (task_id <> depends_on_id)`; cycles are rejected in application code
by walking existing edges before inserting.

## Execution

| Table             | Purpose                         |
| ----------------- | ------------------------------- |
| `crew_runs`       | One execution attempt of a task |
| `crew_run_events` | The normalised event stream     |

`crew_runs` carries `permission_mode` and `sandbox_grant_id`, so the capability
surface a run actually had is part of the permanent record. `next_event_seq`
allocates event sequence numbers via `UPDATE … RETURNING`, with
`UNIQUE (run_id, seq)` as the backstop.

`crew_run_events` stores the payload **already redacted**, plus `redacted` and
`redaction_rules`, so the fact that redaction occurred is itself recorded
rather than silently applied.

Event types: `run.started`, `message.delta`, `message.completed`,
`tool.requested`, `tool.started`, `tool.completed`, `tool.failed`,
`subagent.spawned`, `subagent.completed`, `approval.required`, `usage.updated`,
`artifact.created`, `rate_limit.detected`, `run.waiting`, `run.completed`,
`run.failed`, `run.cancelled`.

## Conversation

| Table                | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `crew_conversations` | CEO↔EA, CEO↔agent, agent↔agent, meeting      |
| `crew_messages`      | Messages, with `triage_json` on CEO messages |

`triage_json` preserves the classification decision, which is what powers the
"why was this classified this way?" view.

## Governance

| Table                 | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `crew_approvals`      | Approval requests and owner decisions                 |
| `crew_decisions`      | Recorded company decisions with rationale             |
| `crew_budgets`        | Budget policies per scope and window                  |
| `crew_cost_events`    | The spend ledger                                      |
| `crew_sandbox_grants` | CLI permission elevations, always tied to an approval |
| `crew_audit_events`   | Append-only, hash-chained audit log                   |

`crew_budgets` is unique on `(company_id, scope_type, scope_id, window_kind)`, so
setting a budget updates rather than duplicating. Scopes: `company`, `agent`,
`project`, `task`, `runtime`, `provider`.

`crew_cost_events.kind` distinguishes `usage` from `quota`. A subscription runtime
has no per-call price, so its consumption is recorded as a `quota` event with
`cost_micros = 0` — token counts are still captured, but no monetary figure is
invented for a dashboard to display.

### `crew_audit_events`

```text
seq          INTEGER   monotonic per company, UNIQUE (company_id, seq)
prev_hash    sha256 of the preceding entry
entry_hash   sha256 over canonical JSON of this entry + prev_hash
details_json deep-redacted before storage
```

Append-only by construction: the module exposes no update or delete.
`verifyAuditChain()` recomputes the chain and reports the first divergence,
distinguishing a tampered entry from a deleted one (a sequence gap). This makes
tampering _detectable_, which is the achievable property for a single-file
local-first deployment — see `docs/THREAT_MODEL.md` T-06.

## Memory and notifications

| Table                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crew_memory_refs`   | Provenance for vault notes: `kind` distinguishes fact / preference / hypothesis / summary, with `confidence` and `sensitivity`. `provider` + `external_id` locate the real content (an Obsidian markdown file, for the "obsidian" `MemoryProvider`) — this table never stores the content itself, only where it lives; see `server/ironcrew/memory/` and `docs/UPSTREAM_ANALYSIS.md`'s Honcho note for why a second provider was deliberately not built alongside it |
| `crew_notifications` | The decision inbox's feed. `crew_notifications`' own doc-comment calls out "Discord fan-out" — as of `server/ironcrew/notify/`, that fan-out is real and covers Discord, Telegram and email, best-effort, on every notification this table's own `create()` persists                                                                                                                                                                                                 |

## Meetings

| Table                       | Purpose                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `crew_meetings`             | One meeting: moderator, `max_rounds`, `budget_micros`/`spent_micros`, `status` |
| `crew_meeting_participants` | Who's in the meeting — the moderator is always included                        |
| `crew_meeting_turns`        | One row per turn (one participant's contribution for one round)                |
| `crew_meeting_action_items` | Follow-ups from a meeting; `task_id` once converted to a real task             |

Migration `0008`. A meeting's turns are deliberately bounded two ways —
`max_rounds` caps total turns regardless of participant count (one round is
one turn, not every participant every round), and each turn's prompt only
ever includes a bounded recent-turns window, never the whole transcript —
specifically to avoid the upstream meetings god-object's documented
O(participants × rounds) "token grab" pattern (`docs/UPSTREAM_ANALYSIS.md`).
A meeting turn is dispatched through the same `AgentRuntime`/`BudgetEngine`
path task execution uses but is **not** persisted through `crew_runs` (which
requires a real `task_id`) — only the turn's outcome lands in
`crew_meeting_turns`.

## Secrets, attachments and remote workers

| Table                 | Purpose                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `crew_secrets`        | A `SecretRef` — provider (`vaultwarden`/`protonpass`) + item locator, **never a value** (migration `0004`) |
| `crew_attachments`    | Task-, project- or general-scoped file metadata; `storage_key` is content-addressed (migration `0005`)     |
| `crew_remote_workers` | SSH-over-tailnet worker registry for Tier0/customer environments (migration `0007`)                        |

`crew_secrets` is the DB half of the password-manager integration — the
value itself is resolved live, in memory, at the moment of use
(`server/ironcrew/secrets/`) and never written here or to a log. Attachment
bytes live on disk under a content-addressed key
(`server/ironcrew/domain/attachment-storage.ts`); `crew_attachments` only
ever carries the key, filename and scope. `crew_remote_workers` stores an SSH
target (host, user, key path) reachable over Tailscale/Headscale, not a
credential — the private key itself stays a file path on the server's own
filesystem, never database content.

## Mailboxes

| Table                   | Purpose                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `crew_mailboxes`        | One connected mailbox (IMAP/JMAP/M365/Gmail) plus its two behaviour switches (migration `0009`) |
| `crew_mailbox_agents`   | The n:n grant table — which agents may `read` or also `send` (migration `0009`)                 |
| `crew_mailbox_messages` | Metadata of messages already seen, for de-duplication and triage provenance (migration `0009`)  |

Two schema decisions carry meaning:

- `credentials_encrypted` holds an AES-256-GCM blob, **not** a `SecretRef` —
  the one deliberate exception to "references only", documented as an accepted
  trade-off in `docs/THREAT_MODEL.md` T-11. `MailboxRow` omits this column
  entirely, so a mailbox row cannot be serialised into a response with its
  password attached.
- `CHECK (auto_triage = 0 OR poll_enabled = 1)` — auto-triage without polling
  would silently do nothing, so the schema refuses to store it rather than
  leaving the rule to the UI.

`crew_mailbox_messages` stores **metadata only**: subject, sender, dates, ids.
Message bodies are never copied into the database; they are read from the
mailbox on demand. See `docs/MAIL.md`.

## Marketplaces

| Table                       | Purpose                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `crew_marketplaces`         | A source for skills and MCP servers, plus the outcome of its last sync (migration `0010`) |
| `crew_marketplace_installs` | What was installed, from where, by whom and when (migration `0010`)                       |

The installed artefacts themselves are **not** here: MCP servers live in the
`settings` row `"mcp_servers"` that `McpManager` owns, skills in
`custom-skills/<name>/`. These tables add provenance to infrastructure that
already exists rather than a second source of truth that drifts.

`marketplace_id` is `ON DELETE SET NULL`: removing a source must not erase the
record of what it put on this machine. Catalog entries are never cached —
they are third-party JSON read live. See `docs/MARKETPLACES.md`.

## The agent run lease

Migration `0012` adds two columns to `crew_agents` rather than a table of its
own, matching where the task lock already lives so the two are read and
reasoned about the same way:

| Column                | Meaning                                                      |
| --------------------- | ------------------------------------------------------------ |
| `run_lock_run_id`     | The run holding the lease. Release is **guarded on this id** |
| `run_lock_expires_at` | A lease, not a lock — an expired one is reclaimable          |

`crew_tasks` already stops two workers claiming the same task. This stops the
other collision: two _different_ tasks dispatched to the same agent at once.
An agent holds a workspace, a CLI session and a budget, and two concurrent
runs share all three — they interleave writes in one working tree, and each
clears the pre-dispatch budget gate without seeing the other's spend, so a
limit checked twice concurrently is a limit enforced once.

The mechanics deliberately mirror `TaskStore.claim()`: the condition lives in
the `WHERE` clause so the database decides, the guard on `run_lock_run_id`
stops a late reaper clearing a fresh owner's lease, and failure is closed —
no lease, no run, and the task goes back to `ready` rather than sitting
claimed by a run that never happened.

## External events

| Table                  | Purpose                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `crew_external_events` | Every arrival from outside, recorded once, with what was done about it (`0013`) |

`UNIQUE (company_id, source_kind, source_id, external_id)` is the whole
mechanism: `crew_mailbox_messages` already did this for mail, and this is the
general form for every ingress. Seeing an event a second time is a lookup
rather than a duplicate task — `delivery_count` rises instead, so a source
redelivering endlessly is visible rather than silent.

`handled_at` and `handler` separate **seen** from **processed**, which is not
pedantry: a process that dies between recording and acting leaves an event
recorded and unhandled, and that is exactly what `unhandled()` finds.

`payload_json` holds the event **as received**, because replay is the point —
re-fetching from a source is often impossible once a poll window has moved on.
It is therefore third-party content, sanitised at the ingress and never on the
way out, and prunable by `received_at` (handled rows only: an unhandled event
is outstanding work).

## Change proposals

| Table                        | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `crew_change_proposals`      | One proposed set of file changes and its status (migration `0014`) |
| `crew_change_proposal_files` | Path, operation, content and hashes per file (migration `0014`)    |

`approval_id` references `crew_approvals`: nothing reaches the disk until that
approval is approved. `workspace_path` is the root every file must resolve
inside, re-checked at apply time.

`expected_sha256` records what a file looked like **when proposed**; a file
whose hash no longer matches is refused at apply, because an approval granted
against one state of the world does not describe what would happen in another.
`applied_sha256` records what was actually written. See
`docs/CHANGE_PROPOSALS.md`.

## Messenger pairings

| Table                     | Purpose                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `crew_messenger_pairings` | Who may talk to the EA over chat, and with what authority (`0015`) |

`role` is authority, not a label: `owner` reaches `handleCeoMessage()` and
speaks with the CEO's authority, `guest` is routed like incoming mail. Both
are constrained by `CHECK`, so an operator can look at who holds CEO access
rather than reconstruct it from code.

`status` is `pending` until the owner accepts in the Command Center — no row
and no acceptance means no access, the same deny-by-default posture the
mailbox grants take. `pairing_code` is short-lived (`code_expires_at`) and
cleared to `''` on accept. `chat_id` is separate from `sender_id` because a
channel and a person are not the same thing: several people can write in one
Discord channel. `UNIQUE (company_id, channel_kind, sender_id)` means a second
account is a second row, paired on its own. See `docs/MESSENGER.md`.

## The run queue

| Table               | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `crew_run_requests` | The durable intent to run a task, and every attempt at it (`0016`) |

A task status says what a task _is_. It cannot say how often we have tried to
run it, when we may try next, or which attempt failed and why — so the attempt
gets a row of its own rather than extra columns on `crew_tasks` that only the
scheduler understands.

The partial unique index is the guarantee, not a convention:

```sql
CREATE UNIQUE INDEX idx_crew_run_requests_live
  ON crew_run_requests(task_id) WHERE status IN ('queued','running');
```

At most one unfinished request per task. Two ingresses asking for the same
task at once is the normal case, and the resulting double run would be exactly
the collision the agent lock exists to prevent, one layer earlier. Finished
rows are deliberately outside the index, so a task can be re-run — and the
failed attempt is kept, because it is the evidence for why nothing happened.

`lease_owner` / `lease_expires_at` are a **lease, not a lock**, mirroring
`TaskStore.claim()` and the agent run lease above: the condition sits in the
`WHERE` clause so the database decides, and a drain that crashes mid-run does
not strand the request. `attempts` is incremented at claim time and given back
by `defer()` when the run never started — a busy agent must not dead-letter
healthy work. `not_before` carries the backoff; `status` is constrained by
`CHECK` to `queued | running | done | failed | dead | cancelled`, where `dead`
means the attempts are spent and a human has to look. See
`docs/RUN_QUEUE.md`.

## Indexes

Every hot path is indexed on `(company_id, …)`:

- `idx_crew_tasks_company_status`, `idx_crew_tasks_project`, `idx_crew_tasks_agent`
- `idx_crew_tasks_lock` on `(status, lock_expires_at)` for orphan sweeps
- `idx_crew_runs_task`, `idx_crew_runs_heartbeat`
- `idx_crew_run_events_run` on `(run_id, seq)` for ordered replay
- `idx_crew_cost_company_month`, `idx_crew_cost_agent`, `idx_crew_cost_project`
- `idx_crew_audit_company`, `idx_crew_audit_entity`
- `idx_crew_mailboxes_company`, `idx_crew_mailboxes_poll` on `(poll_enabled, last_polled_at)`
- `idx_crew_mailbox_agents_agent`, `idx_crew_mailbox_agents_mailbox` (the n:n join, both directions)
- `idx_crew_marketplaces_company`, `idx_crew_marketplace_installs_source`
- `idx_crew_agents_run_lock` on `(run_lock_run_id, run_lock_expires_at)` for lease sweeps
- `idx_crew_external_events_source`, `idx_crew_external_events_unhandled`,
  `idx_crew_external_events_received` — the two scans that must not walk the
  table are "what still needs handling" and "what is old enough to prune"
- `idx_crew_change_proposals_company` on `(company_id, status)`, `idx_crew_change_proposals_task`
- `idx_crew_messenger_pairings_company` on `(company_id, channel_kind, status)`
- `idx_crew_vessels_company` on `(company_id, runtime_provider)`,
  `idx_crew_talents_company` on `(company_id, professional_role)`,
  `idx_crew_agents_vessel`, `idx_crew_agents_talent` — the pairing, read in
  both directions: resolving an agent, and finding who blocks a deletion
- `idx_crew_run_requests_live` — the partial unique index that _is_ the
  one-live-request-per-task guarantee, not merely an optimisation
- `idx_crew_run_requests_claimable` on
  `(company_id, status, not_before, created_at)` — the drain's own query,
  oldest eligible first, run every 15 seconds and therefore the one index that
  must never be missed

## Migration policy

Schema changes go through the versioned runner. Each migration runs in its own
transaction and is fatal on failure. A startup auto-scan throws if a
`NNNN-*.ts` file exists on disk but was never registered in `registry.ts`,
which catches the common "forgot to register it" bug before it reaches
production.
