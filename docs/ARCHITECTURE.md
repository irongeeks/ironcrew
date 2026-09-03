# Architecture

Iron Command OS is a self-hosted, local-first multi-agent company OS. It is a
fork of OctoOffice (Apache-2.0) with a new governance-grade control plane
grafted alongside the existing runtime.

## Layers

```text
┌──────────────────────────────────────────────────────────────┐
│ Web (React + TypeScript + Vite)                              │
│ Command Center · CEO Chat · Kanban · Decision Inbox          │
│ Agent Roster · Run Timeline                                  │
└─────────────────────────────┬────────────────────────────────┘
                              │ REST /api/ic  +  WebSocket
┌─────────────────────────────▼────────────────────────────────┐
│ Control Plane (server/ironcommand)                           │
│ Orchestrator · Task State Machine · Atomic Claiming          │
│ Approval Engine · Budget Engine · Vendor Policy              │
│ Permission Policy · Redaction · Hash-chained Audit           │
└─────────────────────────────┬────────────────────────────────┘
                              │ normalised Run Protocol
┌─────────────────────────────▼────────────────────────────────┐
│ Runtime Layer                                                │
│ MockRuntime (shipped) · Claude Code / Codex / Gemini via the │
│ upstream adapters · OpenRouter (planned)                     │
└──────────────────────────────────────────────────────────────┘
```

## The central design decision: additive, not a rewrite

Upstream's `runtimeContext` is a `Record<string, any>` mutated by ~10
`Object.assign` calls and papered over with a deferred proxy. There is no
injectable service layer to attach policy, audit or budget interceptors to.

Rather than untangle that first, the Iron Command control plane is built
**alongside** it. `server/ironcommand/` depends on exactly two things:

- a `node:sqlite` `DatabaseSync` handle, and
- a `broadcast(type, payload)` function.

It never imports `runtimeContext`. The consequences are concrete:

- It is testable headlessly, without booting the server.
- All 2493 upstream tests kept passing throughout the work.
- The upstream tables are untouched; migration `0002` only adds `ic_*` tables.
- A later consolidation can move upstream features onto this control plane
  incrementally, rather than as a big-bang rewrite.

## Module map

| Path                                               | Responsibility                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `server/ironcommand/domain/task-state.ts`          | Task and agent state machines. Pure, no I/O.                      |
| `server/ironcommand/domain/task-store.ts`          | Task persistence, atomic claiming, dependencies, orphan recovery. |
| `server/ironcommand/domain/audit.ts`               | Append-only hash-chained audit log.                               |
| `server/ironcommand/domain/crew-config.ts`         | Persona / role / policy separation and its enforcement.           |
| `server/ironcommand/domain/sql.ts`                 | Typed row helpers for `node:sqlite`.                              |
| `server/ironcommand/policy/vendor-policy.ts`       | Which models and providers may be used.                           |
| `server/ironcommand/policy/runtime-permissions.ts` | CLI permission modes and sandbox grants.                          |
| `server/ironcommand/policy/approval-policy.ts`     | Approval requests and the blocking gate.                          |
| `server/ironcommand/policy/budget-engine.ts`       | Budget scopes, thresholds, pre- and post-spend enforcement.       |
| `server/ironcommand/runtime/run-events.ts`         | Normalised run protocol and `AgentRuntime`.                       |
| `server/ironcommand/runtime/run-store.ts`          | Run and event persistence, redaction, sequencing.                 |
| `server/ironcommand/runtime/mock-runtime.ts`       | MockRuntime.                                                      |
| `server/ironcommand/orchestrator/triage.ts`        | EA message classification and routing.                            |
| `server/ironcommand/orchestrator/company.ts`       | The CEO → EA → task → run → review flow.                          |
| `server/ironcommand/api/routes.ts`                 | REST surface under `/api/ic`.                                     |
| `server/ironcommand/security/redaction.ts`         | Secret redaction for logs, events and streams.                    |
| `src/ironcommand/`                                 | Command Center UI.                                                |

## Key invariants

These are enforced in code and covered by tests, not merely documented.

1. **One control plane, one truth.** Task status lives in `ic_tasks.status`.
   The UI derives everything from it; nothing is stored client-side.

2. **No state change without a valid transition.** `assertTransition()` runs
   before every write. `done` and `cancelled` are terminal; `failed` is not,
   because the CEO may request a revision.

3. **No double work.** Claiming is a compare-and-set carrying the observed
   `status_version` and the lock predicate in the `WHERE` clause. Exactly one
   of N concurrent claimants wins; the rest get `null`, not an exception.

4. **No lock stolen by a late reaper.** Locks are released and recovered only
   with `WHERE execution_run_id = <the run I observed>`.

5. **No action without an actor and a correlation id.** Every audit entry
   carries both; one correlation id spans a CEO message, its task, its runs and
   its audit entries.

6. **Policy beats persona.** Persona, professional role and policy are three
   separate columns. A character pack may override only cosmetic fields and is
   rejected loudly otherwise.

7. **No agent approves anything.** `may_approve` is typed as the literal
   `false`. Approval is the human owner's alone.

8. **No secrets in logs, events or dumps.** Everything crossing the runner
   boundary passes through redaction, including across chunk boundaries.

9. **Deny by default.** Both the vendor policy and per-agent tool access reject
   anything not explicitly allowed.

10. **No silent failure.** A rate limit is its own event, not a generic error.
    A budget stop is HTTP 402. An approval block is 403. The UI shows them.

## Data flow: a CEO request end to end

```text
POST /api/ic/chat
  │
  ├─ triage()                       classify; incident and sensitive outrank all
  ├─ audit: ceo.message_received
  ├─ TaskStore.create()             audit: task.created
  │
  ├─ sensitive?  ──► ApprovalEngine.request()
  │                  task → approval_required        (NOT executed)
  │                  audit: approval.requested
  │
  └─ otherwise ──►  pickAgent() → task → assigned → ready

POST /api/ic/tasks/execute-next
  │
  ├─ BudgetEngine.assertRunPermitted()      pre-dispatch gate → 402 if blocked
  ├─ RunStore.create()
  ├─ TaskStore.claim()                      CAS; audit: task.claimed
  ├─ task → running
  │
  ├─ for await (event of runtime.startRun())
  │     ├─ redact → sequence → persist → broadcast
  │     ├─ usage.updated      → BudgetEngine.recordCost()
  │     └─ approval.required  → ApprovalEngine.request()
  │
  ├─ TaskStore.releaseLock()                only if still the owner
  └─ task → review | waiting | failed

POST /api/ic/tasks/:id/accept   → task → done,  EA reports to the CEO
POST /api/ic/tasks/:id/revise   → task → ready, re-run
```

## Storage

SQLite via `node:sqlite` (Node 22 builtin — no native dependency), WAL mode,
`foreign_keys = ON`. Schema changes go through the versioned migration runner
in `server/modules/bootstrap/migrations/`, which has a startup auto-scan that
fails loudly if a migration file exists but was never registered.

PostgreSQL is deliberately **not** an MVP requirement. Every Iron Command
business table already carries `company_id`, so multi-tenancy and a Postgres
adapter are additive later rather than a schema rewrite.

## What is not built yet

See `IMPLEMENTATION_STATUS.md`. In short: the Iron Command control plane does
not yet drive the real CLI runtimes (the upstream execution path still does
that, now with safe permission defaults), and memory, MCP registry, native
runner daemon, Discord and the business packs are Phase 2+.
