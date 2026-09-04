# Upstream Analysis

Assessment of the three reference projects, and what IronCrew took from
each. Written after reading the code, not the READMEs.

## Method

- OctoOffice v2.7.0 (`0e69d0b`) was cloned, installed and its test suite run
  **before** any modification, to establish a real baseline rather than an
  assumed one.
- OneManCompany and Paperclip were cloned as gitignored references under
  `.references/` and read for design, not copied.

**Verified upstream baseline (before any IronCrew change):**

| Check           | Result                        |
| --------------- | ----------------------------- |
| `pnpm install`  | ok                            |
| `pnpm test:api` | 190 files / 2493 tests passed |
| `pnpm test:web` | 52 files / 270 tests passed   |
| `pnpm build`    | ok                            |

This is a healthy codebase. That finding is what justified forking it rather
than starting over.

---

## 1. OctoOffice — the base

**Stack.** Node 22, Express 5, `node:sqlite` (`DatabaseSync`), `ws`, React 19 +
Vite, Pixi.js for the pixel-art office. ~192k LOC across `server/` and `src/`.
Local-first, single user. Apache-2.0.

**What it already does well, and IronCrew keeps:**

- A real versioned migration runner (`server/modules/bootstrap/migrations/`)
  with a `schema_migrations` table, per-migration transactions, fatal-on-failure
  semantics, and a startup auto-scan that catches unregistered migration files.
- WAL mode, `foreign_keys = ON`, busy-timeout tuning (`server/db/runtime.ts`).
- `node:sqlite` rather than a native driver, so there is no build-time native
  dependency.
- Argv-array process spawning (`adapter.buildArgs()` returns `string[]`,
  spawned via `spawn(args[0], args.slice(1))`) rather than shell string
  concatenation, with a deliberate stdin fallback on Windows to avoid
  metacharacter injection.
- A hash-chained append-only security audit log for message ingress
  (`modules/bootstrap/security-audit.ts`) with a verification script.
- A websocket hub with per-type coalescing and queue caps, so a chatty run
  cannot flood clients.

**The critical finding — unsafe runtime defaults.**

Every CLI adapter hardcoded a permission bypass into every invocation:

| File                                                 | Flag                             |
| ---------------------------------------------------- | -------------------------------- |
| `server/adapters/claude.ts:17`                       | `--dangerously-skip-permissions` |
| `server/adapters/codex.ts:18`                        | `--yolo`                         |
| `server/adapters/gemini.ts:17`                       | `--yolo`                         |
| `server/modules/workflow/core/cli-tools.ts:62,70,89` | both, on the second spawn path   |

The upstream adapter tests asserted these as _required base flags_, so the
behaviour was locked in by the test suite. This is the single highest-impact
issue found and is fixed in `fix(security): remove hardcoded permission-bypass
flags from CLI runtimes`.

**The other significant gaps** (all addressed in Phase 1):

1. **No atomic task claiming.** `execution-start-task.ts` claims with an
   unguarded `UPDATE tasks SET status='in_progress' WHERE id = ?`. Mutual
   exclusion relies on in-process `Map`/`Set` state (`activeProcesses`,
   `taskLaunchLocks`), which is correct only while exactly one process exists —
   not across a restart, a second worker, or a crash.
2. **No tenancy.** Zero occurrences of `company_id` anywhere in `server/`.
   Retrofitting a tenant key later means touching every index and query.
3. **No first-class approvals table.** Approval state is smeared across
   `tasks.workflow_meta_json`, `project_review_decision_states` and
   `review_round_decision_states`. There is no generic "block this action until
   approved" gate.
4. **No cost model.** Budgets are per-run token ceilings enforced by killing the
   child process. No price table, no per-agent/project/period rollup, no
   soft-warn versus hard-stop.
5. **Partial audit.** The hash chain covers message ingress and task creation
   only. Agent spawns, settings changes, secret access and approvals are not
   audited.
6. **Schema is hybrid.** A 504-line ad-hoc `CREATE TABLE IF NOT EXISTS` blob
   (`base-schema.ts`) with two `try { ALTER TABLE } catch {}` blocks, alongside
   only two real migrations.
7. **Runtime god-object.** `runtimeContext` is a `Record<string, any>` mutated
   by ~10 `Object.assign` calls and papered over with a deferred proxy. There is
   no injectable service layer to attach policy, audit or budget interceptors to.

**Consequence for IronCrew's design.** Because of (7), the IronCrew
control plane is deliberately _additive_: `server/ironcrew/` takes only a
database handle and a broadcast function. It does not reach into
`runtimeContext`, which is why it is testable headlessly and why 2493 upstream
tests kept passing throughout.

---

## 2. OneManCompany — the company model

Python 3.12, FastAPI, LangGraph. Apache-2.0. **No code copied** — the
architecture rules forbid a Python sidecar.

**Worth taking:**

- **EA as the root of the task tree.** Every CEO request enters through the
  Executive Assistant, which classifies before it delegates. IronCrew
  implements this in `orchestrator/triage.ts` + `orchestrator/company.ts`.
- **An explicit transition table** (`core/task_lifecycle.py::VALID_TRANSITIONS`)
  rather than free-form status strings → `domain/task-state.ts`.
- **The three-way split** of persona ("talent") from runtime limits ("vessel")
  from tool permissions (`core/tool_registry.py::ToolMeta`). This is the single
  most reusable idea in the repository and became IronCrew's
  persona/policy/role separation.
- **Review against observed evidence** (`core/task_verification.py`): the
  reviewer is shown the actual tool-call log, not the worker's self-report.
  Noted for Phase 2.

**Deliberately not taken:**

- The **meeting "token grab"**: every participant burns a full LLM call each
  round just to answer YES/NO about whether they want to speak. That is
  O(participants × rounds) cost with no convergence guarantee and no moderator.
- The **hardcoded five-founder org** (`CEO_ID="00001"` … `CSO_ID="00005"`) and
  the physical-office simulation where a meeting can be _denied_ because no room
  is free. IronCrew keeps org shape data-driven in `config/`.
- **"No database — everything is YAML on disk."** It produced a 309 KB
  `routes.py` and a 191 KB `vessel.py` with pervasive function-local imports to
  break cycles. IronCrew keeps operational state in SQLite and reserves
  Markdown for what humans actually edit.

---

## 3. Paperclip — governance and reliability

TypeScript, PostgreSQL + Drizzle, Node ≥24. **MIT.** No code copied — the
storage engine differs — but the mechanics were studied closely and
reimplemented for SQLite.

**Atomic claiming.** Paperclip does _not_ use `SELECT … FOR UPDATE SKIP LOCKED`.
It uses a guarded compare-and-set:

```sql
UPDATE heartbeat_runs SET status='running', started_at=…
 WHERE id = :runId AND status = 'queued' RETURNING *
```

The loser gets zero rows and simply drops out. IronCrew's
`TaskStore.claim()` is the same idea on SQLite, checking `changes === 1`.
SQLite serialises writers, so no `SKIP LOCKED` equivalent is needed.

**The lock triple and release-if-owner.** `checkout_run_id` /
`execution_run_id` / `execution_locked_at` on the task row, and critically:
locks are never cleared unconditionally, always `WHERE execution_run_id =
:theRunIObserved`. This prevents a late reaper from clearing a fresh owner's
lock — a subtle bug IronCrew has an explicit regression test for.

**Two-point budget enforcement.** A pre-dispatch `getInvocationBlock()` walking
company → agent → project, plus post-spend `evaluateCostEvent()` that opens a
soft or hard incident and pauses the scope. IronCrew mirrors this in
`policy/budget-engine.ts`.

**Optimistic concurrency.** `issues.status_version` as a CAS token, plus an
append-only `status_decisions` table with a sha256 digest over canonical JSON.
IronCrew adopted both ideas: `crew_tasks.status_version` and the hash-chained
`crew_audit_events`.

**Worth noting.** Paperclip's own `activity_log` is _not_ tamper-evident — no
hash chain, append-only by convention only. IronCrew's audit log is chained
from the start, which is a deliberate improvement rather than a port.

---

## 4. Honcho — memory

AGPL-3.0. Treated strictly as an optional external service behind the
`MemoryProvider` interface. Its server code is deliberately **not** vendored,
which keeps the AGPL's source-provision obligations with the Honcho deployment
rather than with this repository. See `docs/MEMORY.md`.

---

## 5. Resulting implementation order

1. Vendor policy, enforced in the backend.
2. Remove the unsafe runtime defaults (highest severity finding).
3. Secret redaction, since everything after this logs and streams.
4. Company-scoped domain schema with the lock triple and `status_version`.
5. Task state machine and atomic claiming.
6. Normalised run protocol plus MockRuntime, so the slice is testable with no
   CLI logins present.
7. Approval and budget engines.
8. EA triage, seed crew, persona/policy separation.
9. REST + live events.
10. Command Center UI.
