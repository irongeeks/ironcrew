# Architecture

IronCrew is a self-hosted, local-first multi-agent company OS. It is a
fork of OctoOffice (Apache-2.0) with a new governance-grade control plane
grafted alongside the existing runtime.

## Layers

```text
┌──────────────────────────────────────────────────────────────┐
│ Web (React + TypeScript + Vite)                              │
│ Command Center · CEO Chat · Kanban · Decision Inbox          │
│ Agent Roster · Run Timeline                                  │
└─────────────────────────────┬────────────────────────────────┘
                              │ REST /api/crew  +  WebSocket
┌─────────────────────────────▼────────────────────────────────┐
│ Control Plane (server/ironcrew)                           │
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

Rather than untangle that first, the IronCrew control plane is built
**alongside** it. `server/ironcrew/` depends on exactly two things:

- a `node:sqlite` `DatabaseSync` handle, and
- a `broadcast(type, payload)` function.

It never imports `runtimeContext`. The consequences are concrete:

- It is testable headlessly, without booting the server.
- All 2493 upstream tests kept passing throughout the work.
- The upstream tables are untouched; migration `0002` only adds `ic_*` tables.
- A later consolidation can move upstream features onto this control plane
  incrementally, rather than as a big-bang rewrite.

## Module map

| Path                                            | Responsibility                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/ironcrew/domain/task-state.ts`          | Task and agent state machines. Pure, no I/O.                                                                                                                                                               |
| `server/ironcrew/domain/task-store.ts`          | Task persistence, atomic claiming, dependencies, orphan recovery.                                                                                                                                          |
| `server/ironcrew/domain/audit.ts`               | Append-only hash-chained audit log.                                                                                                                                                                        |
| `server/ironcrew/domain/crew-config.ts`         | Persona / role / policy separation and its enforcement.                                                                                                                                                    |
| `server/ironcrew/domain/sql.ts`                 | Typed row helpers for `node:sqlite`.                                                                                                                                                                       |
| `server/ironcrew/policy/vendor-policy.ts`       | Which models and providers may be used.                                                                                                                                                                    |
| `server/ironcrew/policy/runtime-permissions.ts` | CLI permission modes and sandbox grants.                                                                                                                                                                   |
| `server/ironcrew/policy/approval-policy.ts`     | Approval requests and the blocking gate.                                                                                                                                                                   |
| `server/ironcrew/policy/budget-engine.ts`       | Budget scopes, thresholds, pre- and post-spend enforcement.                                                                                                                                                |
| `server/ironcrew/runtime/run-events.ts`         | Normalised run protocol and `AgentRuntime`.                                                                                                                                                                |
| `server/ironcrew/runtime/run-store.ts`          | Run and event persistence, redaction, sequencing.                                                                                                                                                          |
| `server/ironcrew/runtime/mock-runtime.ts`       | MockRuntime.                                                                                                                                                                                               |
| `server/ironcrew/orchestrator/triage.ts`        | EA message classification and routing.                                                                                                                                                                     |
| `server/ironcrew/orchestrator/company.ts`       | The CEO → EA → task → run → review flow, plus every provider registry (secrets, memory, notification channels, mail providers, marketplace sources) and their fan-out/dispatch logic.                      |
| `server/ironcrew/api/routes.ts`                 | REST surface under `/api/crew`.                                                                                                                                                                            |
| `server/ironcrew/security/redaction.ts`         | Secret redaction for logs, events and streams.                                                                                                                                                             |
| `server/ironcrew/domain/meeting-store.ts`       | Meetings — moderator, bounded rounds, budget (`docs/UPSTREAM_ANALYSIS.md`'s anti-god-object design).                                                                                                       |
| `server/ironcrew/memory/`                       | `MemoryProvider` contract + `ObsidianProvider` (a real vault of markdown files) — the first memory backend.                                                                                                |
| `server/ironcrew/secrets/`                      | `SecretProvider` contract + Vaultwarden/Proton Pass — a `SecretRef` never carries a value.                                                                                                                 |
| `server/ironcrew/mail/`                         | `MailProvider` contract + IMAP, JMAP, Microsoft 365 and Gmail. Mailboxes are granted to agents n:n; incoming mail becomes an `inbox` task, never a CEO message (docs/MAIL.md).                             |
| `server/ironcrew/marketplace/`                  | `MarketplaceSource` contract + catalog, MCP registry, Claude-Code plugin and Git adapters, plus the installer that is the trust boundary between third-party JSON and this machine (docs/MARKETPLACES.md). |
| `server/ironcrew/notify/`                       | `NotificationChannel` contract + Discord/Telegram/email — best-effort fan-out for the decision inbox — and, in the other direction, the `MessengerChannel` contract + Telegram/Discord inbound (docs/MESSENGER.md). |
| `server/ironcrew/domain/messenger-pairing-store.ts` | Who may talk to the EA over chat, and with what authority. Deny by default; role `owner` reaches the CEO path (docs/MESSENGER.md).                                                                      |
| `server/ironcrew/domain/change-proposal-store.ts`   | Proposed file changes: approval-gated, hash-checked, path-contained, all-or-nothing (docs/CHANGE_PROPOSALS.md).                                                                                          |
| `server/ironcrew/domain/external-event-store.ts`    | One record per arrival from outside, deduplicated by `(source, external id)`, with seen/handled separated and replay.                                                                                    |
| `server/ironcrew/domain/agent-lock-store.ts`        | The per-agent run lease — one agent, one run in flight. Compare-and-set in the `WHERE` clause, guarded release, fail-closed.                                                                             |
| `server/ironcrew/network/tailscale-provider.ts` | Tailscale/Headscale status (`tailscale status --json`).                                                                                                                                                    |
| `server/ironcrew/domain/remote-worker-store.ts` | SSH-over-tailnet worker registry for Tier0/customer networks.                                                                                                                                              |
| `src/ironcrew/`                                 | Command Center UI.                                                                                                                                                                                         |

## Key invariants

These are enforced in code and covered by tests, not merely documented.

1. **One control plane, one truth.** Task status lives in `crew_tasks.status`.
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
POST /api/crew/chat
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

POST /api/crew/tasks/execute-next
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

POST /api/crew/tasks/:id/accept   → task → done,  EA reports to the CEO
POST /api/crew/tasks/:id/revise   → task → ready, re-run
```

## Storage

SQLite via `node:sqlite` (Node 22 builtin — no native dependency), WAL mode,
`foreign_keys = ON`. Schema changes go through the versioned migration runner
in `server/modules/bootstrap/migrations/`, which has a startup auto-scan that
fails loudly if a migration file exists but was never registered.

PostgreSQL is deliberately **not** an MVP requirement. Every IronCrew
business table already carries `company_id`, so multi-tenancy and a Postgres
adapter are additive later rather than a schema rewrite.

## What is not built yet

See `IMPLEMENTATION_STATUS.md` for the exhaustive, test-backed list. In
short: `CliAdapterRuntime` now drives real CLI runtimes end-to-end (Phase
1.5), and Phase 2's Company OS — goals, projects, Kanban, dependencies, the
decision inbox, the org chart, bounded meetings, an Obsidian `MemoryProvider`,
and Discord/Telegram/email notification fan-out — is built and tested, as are
mailboxes (IMAP/JMAP/M365/Gmail with per-agent grants) and marketplaces for
skills and MCP servers. What remains: a tool registry with risk-classed
approvals, a native runner daemon (so the control plane and the runtime stop
sharing a process), and the business packs (MSP, Web Agency, Finance, Legal,
Knowledge) — all Phase 3+.
