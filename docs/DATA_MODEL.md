# Data Model

All Iron Command tables are prefixed `ic_` and live alongside the upstream
OctoOffice tables. They are created by migration
`server/modules/bootstrap/migrations/0002-iron-command-domain.ts`.

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

| Table            | Purpose     | Notable columns                          |
| ---------------- | ----------- | ---------------------------------------- |
| `ic_companies`   | The company | `slug` (unique), `owner_name`, `locale`  |
| `ic_departments` | Departments | unique `(company_id, key)`, `sort_order` |
| `ic_agents`      | Agents      | see below                                |

### `ic_agents` — the three-layer separation

The product's central invariant is expressed structurally, in three separate
columns that are never merged:

| Layer             | Column                                           | Meaning                                     |
| ----------------- | ------------------------------------------------ | ------------------------------------------- |
| Professional role | `professional_role`, `role_summary`, `seniority` | what the agent is competent for             |
| Policy            | `policy_json`                                    | what the agent may do — **authoritative**   |
| Persona skin      | `persona_json`, `display_name`                   | how it looks and sounds — **cosmetic only** |

`status` is one of the ten agent states and is **derived** server-side from the
work an agent holds (`deriveAgentStatus()`), never self-reported. This is why a
UI figure cannot disagree with the control plane.

`policy_json` is Zod-validated on read; `may_approve` is typed as the literal
`false`, so no configuration can grant an agent approval authority.

## Work

| Table                  | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `ic_goals`             | Company goals, self-referential via `parent_id` for goal ancestry |
| `ic_projects`          | Projects, optionally linked to a goal and a workspace path        |
| `ic_tasks`             | Tasks — the heart of the system                                   |
| `ic_task_dependencies` | Blocker edges                                                     |

### `ic_tasks`

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

`ic_task_dependencies` has `UNIQUE (company_id, task_id, depends_on_id, kind)`
and `CHECK (task_id <> depends_on_id)`; cycles are rejected in application code
by walking existing edges before inserting.

## Execution

| Table           | Purpose                         |
| --------------- | ------------------------------- |
| `ic_runs`       | One execution attempt of a task |
| `ic_run_events` | The normalised event stream     |

`ic_runs` carries `permission_mode` and `sandbox_grant_id`, so the capability
surface a run actually had is part of the permanent record. `next_event_seq`
allocates event sequence numbers via `UPDATE … RETURNING`, with
`UNIQUE (run_id, seq)` as the backstop.

`ic_run_events` stores the payload **already redacted**, plus `redacted` and
`redaction_rules`, so the fact that redaction occurred is itself recorded
rather than silently applied.

Event types: `run.started`, `message.delta`, `message.completed`,
`tool.requested`, `tool.started`, `tool.completed`, `tool.failed`,
`subagent.spawned`, `subagent.completed`, `approval.required`, `usage.updated`,
`artifact.created`, `rate_limit.detected`, `run.waiting`, `run.completed`,
`run.failed`, `run.cancelled`.

## Conversation

| Table              | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `ic_conversations` | CEO↔EA, CEO↔agent, agent↔agent, meeting      |
| `ic_messages`      | Messages, with `triage_json` on CEO messages |

`triage_json` preserves the classification decision, which is what powers the
"why was this classified this way?" view.

## Governance

| Table               | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `ic_approvals`      | Approval requests and owner decisions                 |
| `ic_decisions`      | Recorded company decisions with rationale             |
| `ic_budgets`        | Budget policies per scope and window                  |
| `ic_cost_events`    | The spend ledger                                      |
| `ic_sandbox_grants` | CLI permission elevations, always tied to an approval |
| `ic_audit_events`   | Append-only, hash-chained audit log                   |

`ic_budgets` is unique on `(company_id, scope_type, scope_id, window_kind)`, so
setting a budget updates rather than duplicating. Scopes: `company`, `agent`,
`project`, `task`, `runtime`, `provider`.

`ic_cost_events.kind` distinguishes `usage` from `quota`. A subscription runtime
has no per-call price, so its consumption is recorded as a `quota` event with
`cost_micros = 0` — token counts are still captured, but no monetary figure is
invented for a dashboard to display.

### `ic_audit_events`

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

| Table              | Purpose                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ic_memory_refs`   | Provenance for vault notes and Honcho entries: `kind` distinguishes fact / preference / hypothesis / summary, with `confidence` and `sensitivity` |
| `ic_notifications` | Decision inbox and outbound channels                                                                                                              |

## Indexes

Every hot path is indexed on `(company_id, …)`:

- `idx_ic_tasks_company_status`, `idx_ic_tasks_project`, `idx_ic_tasks_agent`
- `idx_ic_tasks_lock` on `(status, lock_expires_at)` for orphan sweeps
- `idx_ic_runs_task`, `idx_ic_runs_heartbeat`
- `idx_ic_run_events_run` on `(run_id, seq)` for ordered replay
- `idx_ic_cost_company_month`, `idx_ic_cost_agent`, `idx_ic_cost_project`
- `idx_ic_audit_company`, `idx_ic_audit_entity`

## Migration policy

Schema changes go through the versioned runner. Each migration runs in its own
transaction and is fatal on failure. A startup auto-scan throws if a
`NNNN-*.ts` file exists on disk but was never registered in `registry.ts`,
which catches the common "forgot to register it" bug before it reaches
production.
