# Implementation Status

Honest state of IronCrew. Nothing is listed as done unless it is
implemented **and** covered by a passing test. Anything verified only by design
review, or not verifiable in this environment, is said so explicitly.

Last updated: **Phase 5 — production hardening.** Approval quorums
(`crew_approval_reviews`, four eyes on a dangerous gate), Authentik OIDC beside
the password login, the audit chain shipped off the box to a file or HTTP sink,
a tested backup/restore path, a load test, and the upgrade runbook. Before that:
**Phase 4** (five business packs and seven read-only integrations) and
**Phase 3** (tool and MCP registries with risk classes, web search, the
Playwright browser tool, the OS-keychain `SecretProvider`, the persistent run
queue and scheduler, routines, the OpenRouter runtime, the native runner daemon,
and Antigravity as a real CLI adapter), plus **identity** (accounts, roles,
sessions, and a real `usr_…` in the audit log).

Everything from mailboxes and marketplaces back through Phase 2's Company OS is
still true and is summarised in the tables below; it has simply stopped being
the newest thing.

## Verification summary

Re-measured on this checkout, not carried forward from a previous phase.

| Check           | Result                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:api` | **293 files / 4810 tests passed, 1 skipped**                                                                                                                                                                |
| `pnpm test:web` | **59 files / 515 tests passed**                                                                                                                                                                             |
| `pnpm build`    | passes (`tsc -b && vite build`)                                                                                                                                                                             |
| `pnpm lint`     | 0 errors; 448 warnings, all pre-existing upstream (IronCrew code contributes 0)                                                                                                                             |
| Playwright E2E  | **10/10 passed** — the IronCrew CEO workflow spec, API and browser (set `PW_CHROMIUM_PATH` on images shipping Chromium but not chrome-headless-shell); not re-run this phase, no CEO-slice behavior changed |
| Manual live run | verified against a running server (see below)                                                                                                                                                               |

`pnpm run openapi:check` is deliberately **not** in this table. It validates the
34 operations in `docs/openapi.json`, prints a count of roughly 197 routes it
found in code and not in the spec, and exits 0 either way — the shipped spec
covers the inherited upstream surface and describes no `/api/crew` route at all.
It is not a contract gate and `docs/UPGRADE.md` says so at length.

IronCrew's own suites have grown from the Phase 1 baseline (479 tests) to
several thousand across policy, domain, memory, notify, secrets, network,
runtime, packs, runner, scheduler, audit, auth, orchestrator, API and UI —
every feature below names its own test count.

### Verified against a live server

Started with `DB_PATH=… API_AUTH_TOKEN=… npx tsx server/index.ts` and driven
over HTTP:

- Company seeded: 13 departments, 14 agents, exactly 1 executive assistant,
  `may_approve === false` for every agent.
- CEO → EA → task → delegation → run (MockRuntime, 10 events) → review →
  accept → `done`.
- Sensitive request (`"Bitte ueberweise 4.500 EUR …"`) classified sensitive,
  task parked in `approval_required`, **not delegated and not executed**, with
  a pending `bank_transfer` approval.
- Vendor policy over HTTP: `anthropic/claude-sonnet-4` → 200;
  `deepseek/*`, `qwen/*`, `z-ai/glm-4.6`, `moonshotai/kimi-k2`, and an unknown
  vendor → **403**.
- Audit chain valid across the whole flow.
- Command Center rendered with live data (screenshots in the PR).

---

## Phase 0 — Audit and foundation

| Item                                       | Status              |
| ------------------------------------------ | ------------------- |
| Upstream baseline established and measured | **done**            |
| `docs/UPSTREAM_ANALYSIS.md`                | **done**            |
| `docs/ARCHITECTURE.md`                     | **done**            |
| `docs/THREAT_MODEL.md`                     | **done**            |
| `docs/DATA_MODEL.md`                       | **done**            |
| `docs/PROVIDER_AUTH.md`                    | **done**            |
| `THIRD_PARTY_NOTICES.md`                   | **done**            |
| Vendor policy, backend-enforced            | **done** — 44 tests |
| Unsafe runtime defaults removed            | **done** — 23 tests |
| Secret redaction                           | **done** — 35 tests |
| Build and tests green                      | **done**            |

## Phase 1 — Vertical slice

| Step                                       | Status                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. CEO opens the web interface             | **done**                                                                                                                                                                                 |
| 2. Modern command-center UI (no pixel art) | **done** — 24 UI tests                                                                                                                                                                   |
| 3. Seed crew loaded                        | **done** — 14 agents from `config/agents.seed.yaml`                                                                                                                                      |
| 4. CEO writes to the EA                    | **done**                                                                                                                                                                                 |
| 5. EA creates a task and delegates it      | **done** — 35 triage + 31 orchestrator tests                                                                                                                                             |
| 6. A runtime executes the task             | **done** — MockRuntime and `CliAdapterRuntime` (claude/codex/gemini) both registered and executable; a live task run against an authenticated real CLI is an open manual test (see gaps) |
| 7. Run events appear live                  | **done** — persisted, sequenced, broadcast                                                                                                                                               |
| 8. Figure and board status change          | **done** — status derived server-side                                                                                                                                                    |
| 9. Result lands in review                  | **done**                                                                                                                                                                                 |
| 10. EA summarises for the CEO              | **done**                                                                                                                                                                                 |
| 11. CEO accepts or requests revision       | **done**                                                                                                                                                                                 |
| 12. Nothing lost after restart             | **done** — explicit restart test                                                                                                                                                         |

### Governance

| Item                                                  | Status                                       |
| ----------------------------------------------------- | -------------------------------------------- |
| Task state machine (12 states, validated transitions) | **done** — 22 tests                          |
| Atomic task claiming                                  | **done** — 33 tests incl. 25-way concurrency |
| Orphan recovery                                       | **done**                                     |
| Approval engine blocking high-risk actions            | **done** — 29 tests                          |
| Budget engine with warn + hard stop                   | **done**                                     |
| Hash-chained audit log                                | **done** — tamper and deletion detection     |
| Persona / role / policy separation                    | **done** — 29 tests                          |
| Normalised run protocol + MockRuntime                 | **done** — 29 tests                          |
| REST API + live events                                | **done** — 32 tests                          |

---

## Phase 2 — Company OS

| Item                                              | Status                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goals + goal ancestry in the context builder      | **done** — 21 domain tests                                                                                                                                                          |
| Projects, milestones, project detail view         | **done** — 28 domain tests                                                                                                                                                          |
| Kanban drag & drop, server-side validated         | **done** — every board move is a real `POST .../status`; the UI applies nothing locally, only what the API returns (task-store's 38 transition tests back every legal/illegal move) |
| Task dependencies and blockers in the UI          | **done**                                                                                                                                                                            |
| Decision inbox + notifications                    | **done** — 6 decision-store + 10 notification-store tests                                                                                                                           |
| Org chart + agent detail                          | **done**                                                                                                                                                                            |
| Meetings — moderator, bounded rounds, budget      | **done** — 20 domain tests; structurally bounded, not just by convention (see `docs/UPSTREAM_ANALYSIS.md`)                                                                          |
| Meeting action items become real tasks            | **done** — idempotent (converting twice never duplicates)                                                                                                                           |
| Obsidian vault, the first `MemoryProvider`        | **done** — 11 memory-store + 9 obsidian-provider tests; real markdown files, real full-text search                                                                                  |
| Notification channels — Discord, Telegram, email  | **done** — 13 channel tests (4 Discord + 5 email + 4 Telegram); best-effort fan-out, audited either way                                                                             |
| REST API + Command Center UI for all of the above | **done** — 114 route tests, 94 orchestrator tests, 68 Command Center UI tests                                                                                                       |

### Also shipped alongside Phase 2 — requested mid-stream, not in the original scope

| Item                                                      | Status                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Password-manager integration (`SecretRef` + providers)    | **done** — 18 secret-store + 14 Vaultwarden + 16 Proton Pass tests; a value is never stored, only resolved live                |
| File attachments (task/project/general)                   | **done** — 17 attachment-store + 7 attachment-storage tests; content-addressed blobs on disk                                   |
| Rename Iron Command OS → IronCrew                         | **done** — paths, symbols, DB table/index prefixes (with an upgrade migration), WS event names, API base path, all UI/doc text |
| Tailscale/Headscale network status                        | **done** — 7 tests                                                                                                             |
| Remote workers over the tailnet (Tier0/customer networks) | **done** — 10 tests; registering and testing SSH reachability, not yet routing task execution there                            |

### Mailboxes and marketplaces — requested after Phase 2, built to the same standard

| Item                                                             | Status                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mailbox schema, encrypted credentials, n:n agent grants          | **done** — 31 mailbox-store tests, including one asserting no message body column exists and one asserting a password never appears in a serialised row                                                                                                |
| `MailProvider` — IMAP, JMAP, Microsoft 365, Gmail                | **done** — 36 provider tests (9 IMAP + 10 JMAP + 9 M365 + 8 Gmail), all against injected transports: real code paths, no sockets                                                                                                                       |
| Mailbox orchestration: grants, polling, untrusted-mail triage    | **done** — 17 orchestrator tests; incoming mail becomes an `inbox` task, never a CEO message (`docs/THREAT_MODEL.md` T-10), asserted both by status and by "no runs were started"                                                                      |
| Per-mailbox polling and auto-triage switches                     | **done** — auto-triage without polling is refused by a schema `CHECK`, not just by the UI                                                                                                                                                              |
| Mail REST API + Command Center UI                                | **done** — 14 route tests, 14 UI tests; credentials are never echoed back, an ungranted agent gets 403 rather than 400                                                                                                                                 |
| Marketplace sources — catalog, MCP registry, Claude plugins, Git | **done** — 27 adapter tests; every fetch defaults to `safeFetch`                                                                                                                                                                                       |
| Marketplace installer (skills + MCP servers)                     | **done** — 23 installer tests; launcher allowlist, `McpServerConfigSchema`, path containment, and installing a skill executes nothing (`docs/THREAT_MODEL.md` T-12)                                                                                    |
| Marketplace store + orchestration                                | **done** — 16 store + 14 orchestrator tests; provenance survives deleting its source                                                                                                                                                                   |
| Marketplace REST API + Command Center UI                         | **done** — 14 route tests, 13 UI tests; 502 for a broken catalog, 422 for a refused install, 400 only for a bad request                                                                                                                                |
| Untrusted-content wrapping + control-token stripping             | **done** — 23 policy tests + 3 mail-triage + 4 attachment-filename tests; the fence is unforgeable (two tests assert the close-your-own-fence and open-a-nested-fence attacks), and ordinary business mail is asserted byte-identical after sanitising |

Docs: `docs/MAIL.md`, `docs/MARKETPLACES.md`.

Two things worth stating plainly rather than burying:

1. **Mailbox credentials are stored encrypted in the database**, not as a
   `SecretRef`. That is a deliberate departure from "secrets in the database:
   references only", made on request so a mailbox can be connected without a
   password manager and so OAuth tokens can rotate. The cost is written down
   in `docs/THREAT_MODEL.md` T-11 rather than left implicit.
2. **An MCP server offered only over streamable-http is not listed** by the
   registry adapter, because this codebase's MCP connector speaks stdio and
   SSE. Listing it would produce an entry that installs and then never
   connects.

   **Still true, and now for a narrower reason.** Phase 3 taught the MCP
   _connector_ streamable HTTP — `transport: "http"` is a first-class option
   in `mcp-config.ts`, and `sse` stays so a server deployed against the older
   transport needs no redeploy. But the **marketplace registry adapter** was
   not updated with it: `mcp-registry-source.ts` still accepts only
   `stdio` packages and `sse` remotes and skips everything else. So a
   streamable-HTTP-only server can be added by hand and will work, and will
   still not appear in the marketplace listing. That is now an oversight rather
   than a limitation — a small one, and written down instead of left for
   somebody to find.

---

## Phase 3 — Runtimes and tools

| Item                                                  | Status                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool registry with risk classes and approval policies | **done** — 32 tool-store tests. `crew_tools` says what the server can perform, `crew_tool_grants` says who may; registering grants nothing and an `external` tool is gated by omission (`docs/TOOLS.md`)                           |
| MCP servers in the same registry, per-agent/-project  | **done** — one permission system, not a second one beside it; a grant may be scoped to a single project                                                                                                                            |
| MCP streamable-HTTP transport                         | **done** — `sse` still works, so a server deployed against the older transport needs no redeploy to upgrade                                                                                                                        |
| Web search behind a `SearchProvider` (SearXNG, Brave) | **done** — 43 tests; results stripped at the boundary and fenced before they may reach a prompt                                                                                                                                    |
| Playwright browser tool in an isolated profile        | **done** — 35 tests; deny-by-default host allowlist, and `submit` is classified `external` even when the form looks like a search box                                                                                              |
| `SecretProvider`: OS keychain                         | **done** — alongside Vaultwarden and Proton Pass, with the caveat enforced in code that a headless service should not use it (no session, no D-Bus) — `docs/PROVIDER_AUTH.md`                                                      |
| Persistent run queue + scheduler                      | **done** — 62 run-request-store + 38 scheduler tests; leases, attempts, exponential backoff and a dead letter (`docs/RUN_QUEUE.md`, `docs/SERVICE.md`)                                                                             |
| Routines — recurring work that becomes a visible task | **done** — 22 orchestrator tests. A routine creates a task; it never acts directly, so every firing is on the board, in the audit log and against the budget. `claimDue()` advances `next_run_at` inside the claim statement       |
| **OpenRouter runtime**                                | **done** — 20 tests. The first runtime that is not a CLI. The vendor policy is enforced _inside_ it, because one key reaches hundreds of models from dozens of vendors, blocked ones included                                      |
| **Native runner daemon**                              | **done** — 56 tests. `server/runner-main.ts` + `server/ironcrew/runner/`, its own OS user, its own home, a `0660` Unix socket, and `deploy/ironcrew-runner.service`. T-05/T-17's credential boundary is now enforced, not promised |
| MCP secret injection in the runner                    | **done** — an MCP server's `env`/`headers` may name a vault item; the runner resolves it at start, as its own user. Doing this in the control plane would only have moved the plaintext into the process that must not hold it     |
| **Antigravity (`agy`) as a real CLI adapter**         | **done** — 18 tests, replacing an inherited HTTP stub that pointed at a nonexistent endpoint, dropped every event and always reported failure. Flags come from the published headless-mode docs, not from guessing                 |
| Identity — accounts, roles, sessions                  | **done** — 102 auth tests. Three roles, expiring revocable sessions, a login gate, and a real `usr_…` in the audit log instead of the constant `"ceo"` (`docs/IDENTITY.md`, T-19)                                                  |

**The runner is why three entries above moved.** Until it existed, the control
plane and the runtimes shared a process, so the CLI logins sat with the same
service that parses mail, accepts messages from paired strangers and serves
HTTP. Now they do not. The orchestrator sees the same `AgentRuntime` contract
either way and cannot tell the difference, which is what made the security
property cost nothing at the call sites.

**A bug this phase turned up, worth recording.** `CliAdapterRuntime` only ever
wrote the prompt to stdin — and the CLIs that take it as a flag (`agy`,
OpenClaw) ignore stdin, so a flag-delivery adapter ran with no prompt at all.
Found while building the `agy` adapter, fixed, and covered by a test that
spawns a real process and reads back the argv it was given. The general lesson:
a contract with two branches needs a test on the branch nobody uses yet.

**Installed by an operator, not automatic.** The runner is a second systemd
unit and `scripts/install-service.sh` does not install it — `deploy/README.md`
now carries the manual procedure. An install that skips it works, but keeps the
credentials in the control plane.

---

## Phase 4 — Business packs

Five packs and seven read-only integrations (330 tests across
`server/ironcrew/packs/`). Full detail in `docs/BUSINESS_PACKS.md`.

| Pack                | What it adds                                                                          | Integrations                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| MSP / IT Operations | service desk, Linux/virtualisation, Windows/AD/M365, network, backup/monitoring posts | Proxmox VE, Tactical RMM, UniFi                                              |
| Web Agency          | leads, proposals, SEO, delivery                                                       | none — `web.search` and the browser tool already exist, and the pack says so |
| Finance (DE)        | incoming invoices, receivables, receipt matching, cash forecast, UStVA preparation    | Lexware Office **or** sevDesk                                                |
| Legal (DE)          | contract analysis, clause comparison, deadlines                                       | none — contracts arrive as attachments                                       |
| Knowledge           | archivist and researcher                                                              | Paperless-ngx, Nextcloud                                                     |

**Three framework rules, and they are the interesting part**, each enforced by
a test rather than by convention:

1. **Reuse never overwrites.** Installing a pack onto a company that already
   has a matching department or post adopts it; it does not rewrite what an
   owner configured.
2. **Registering is not granting.** A pack declares tool keys. Whether an agent
   may use one is a separate, explicit grant.
3. **A routine does not start itself.** Pack routines install `enabled: false`.
   A pack suggests work; switching it on is a decision.

**"No fake buttons" is a test, not a promise.** `catalog.test.ts` asserts that
every integration a pack declares has an adapter module and names at least one
required environment variable, and `GET /api/crew/packs` reports an integration
as configured only when the composition root actually built its adapter.

**Deliberately not in Phase 4:** no write path anywhere — no VM restart, no
password reset, no patch push, no invoice creation, no payment. Each is a
credential whose blast radius is the whole estate or the company's own books,
and a write belongs behind an approval rather than behind an environment
variable (T-20). No Tier-0 automation. No M365/Entra or Drive adapter, both
being large OAuth surfaces rather than an API key.

**Not verified against live systems.** Every adapter is written against the
vendor's published API with tests over the request it builds; none has run
against a real Proxmox cluster or Lexware tenant from this repository. Same
honest limit as the CLI adapters — `testConnection()` is the day-one check.

---

## Phase 5 — Production hardening

| Item                                               | Status                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple human reviewers on one approval           | **done** — 16 approval-review-store tests. `crew_approval_reviews`, one row per person per approval, quorum stored on the approval it guards. `UNIQUE (approval_id, reviewer_id)` makes four eyes structurally four eyes                                                   |
| Authentik / generic OIDC beside the password login | **done** — Authorization Code with PKCE, ID tokens verified against the issuer's JWKS, `none` and `HS*` refused by construction, an unlinked subject failing closed. The password login stays: the day the directory is down is the day somebody has to sign in and fix it |
| External audit-log shipping                        | **done** — 36 audit tests. A file or HTTP sink, drained every 60 s by the `audit-ship` scheduler job, cursor advancing only over entries the sink accepted and a partial acceptance always a prefix (`docs/AUDIT_SHIPPING.md`)                                             |
| Backup and restore, tested                         | **done** — 24 tests. `scripts/ironcrew-backup.mjs`, `VACUUM INTO` snapshot plus `PRAGMA integrity_check` on the result, so it is safe against a running service (`docs/BACKUP.md`)                                                                                         |
| Load testing                                       | **done** — `scripts/ironcrew-load-test.mjs`; real domain layer, real file, real concurrent writers, non-zero exit only for a broken invariant and never for a slow percentile. It found the dashboard re-hashing the whole audit chain on every poll, now fixed            |
| Upgrade and migration strategy                     | **done** — `scripts/ironcrew-migrate.mjs` and `docs/UPGRADE.md`, whose "Known gaps" section names where the documented path is not yet backed by code                                                                                                                      |
| Security review over the whole diff                | **done** — closed two quorum bypasses and four smaller gaps                                                                                                                                                                                                                |

**The quorum is per approval, not per installation, and only ever goes up.** A
company-wide two-person rule would make every routine approval wait for
somebody with nothing to add and would be switched off within a fortnight —
including for the payment. It is raised on the request that deserves it
(`POST /approvals/:id/quorum`, owner only). N to proceed, one to stop.

**The chain and the copy answer different questions.** The hash chain proves
nobody edited the record. Only the off-box copy survives somebody deleting it.
That is why shipping is a separate mechanism rather than a stronger hash.

### Two things Phase 5 said no to, with the numbers

- **Multi-company: not done, and not "just turn it on".** The schema carries
  `company_id`, which makes it look like configuration. It is not: **109
  statements in `domain/` select or update by `WHERE id = ?` alone**, safe today
  only because one company exists. `crew_users`, `crew_sessions`,
  `crew_tool_grants` and `crew_oidc_identities` have no `company_id` at all.
  Doing it properly means the company predicate becomes structural — in the
  query builder or the schema, not in the callers. Worth doing before a second
  company exists, never after.
- **PostgreSQL: no.** **1,501 synchronous `prepare(...).run/get/all` call
  sites**, 327 `DatabaseSync` annotations, 222 files importing `node:sqlite`,
  and no mainstream synchronous PostgreSQL driver for Node — so an "adapter"
  means making all 1,501 sites async and colouring every function above them.
  The atomic claim, the audit chain's read-then-insert and the transaction
  discipline are all correct _because_ there is one synchronous connection.
  This is a rewrite of the persistence layer wearing the word "adapter".

---

## Known gaps — not implemented

Listed plainly so nothing here is mistaken for working software.

### Runtime

- **`CliAdapterRuntime` bridges the normalised `AgentRuntime` contract onto the
  upstream CLI adapters** (`server/ironcrew/runtime/cli-adapter-runtime.ts`).
  `server-main.ts` registers it for every CLI-transport adapter this install
  builds (claude, codex, gemini today) alongside MockRuntime, so the Iron
  Command orchestrator can drive a real CLI session, not only MockRuntime.
  Argv-array spawning, separate stdout/stderr capture, redaction before
  emission, idle/hard timeouts, process-group cancellation and rate-limit
  detection are implemented and tested against a real spawned child process
  (a purpose-built protocol-accurate fixture, not a mock of the runtime
  itself) — see `cli-adapter-runtime.test.ts`.
- **Sandbox elevation is half-built, and the half that exists is the reading
  one. Elevation is not reachable in production.** This entry previously
  claimed the path worked end to end. It does not, and the difference matters
  enough to spell out which half is which:

  **What is there.** `CompanyOrchestrator.executeNextTask()` looks up a live
  grant with `SandboxGrantStore.findLive()` and resolves the run's permission
  mode through `resolvePermissionMode()`, then writes a `permission.resolved`
  audit entry with the mode, the reason code and the grant id. The resolver
  itself is complete and is the sole authority: it re-validates company,
  provider, task scope and expiry, hard-caps any grant at four hours, and fails
  **closed** to `restricted` on every mismatch rather than raising an error a
  caller might swallow (23 tests). `SandboxGrantStore.mintFromApproval()` is
  written, refuses anything that is not a genuinely approved
  `sandbox_elevation` approval, and is covered by 22 tests.

  **What is missing is every caller on the writing side.**
  `mintFromApproval()` has **no callers outside its own tests**. Nothing in the
  product ever creates an approval of type `sandbox_elevation` — the type is
  declared in `ALWAYS_APPROVAL_REQUIRED`, but `approvalTypeFor()` never returns
  it and no other call site passes it. There is no `POST /approvals` route by
  which an owner could raise one; approvals are raised by the system when an
  agent attempts something risky, and no code path attempts elevation.

  **The consequence.** `findLive()` therefore always finds nothing, and every
  task dispatch in this build resolves `restricted`. **It fails safe** — that
  is the mode the system would want anyway, and the audit entry is written
  honestly — but "restricted" here is the absence of a feature, not the
  outcome of a decision. An owner cannot grant elevation, and no agent can run
  with the dangerous flags. Anyone reading `docs/THREAT_MODEL.md` T-01's
  mitigation should read its residual-risk note with it.

  What it would take: a route or UI action that raises a `sandbox_elevation`
  approval, and a call to `mintFromApproval()` on the approved branch of
  `decideApproval()`. Both sides of the contract already exist; nothing joins
  them.

- **A live task run against an authenticated real CLI is unverified in this
  environment.** No Claude Code, Codex or Gemini _login_ exists in this
  sandbox (`healthCheck()`/`authStatus()` against the actually-installed
  `claude` binary here correctly report it unauthenticated). What **is**
  verified here: `CliAdapterRuntime` genuinely detects the real `claude` CLI
  installed in this environment (version, installed state) — see
  `"genuinely detects the real Claude Code CLI installed in this
environment"` in `cli-adapter-runtime.test.ts` — and drives a real child
  process end-to-end against the protocol fixture. Running an actual task
  through a logged-in CLI is the user's own manual verification step.

### Company OS

Goals, projects/milestones, Kanban, task dependencies, the decision inbox,
org chart, meetings and meeting action items are all **done** — see the
Phase 2 table above. What's still genuinely not started:

- Coaching, performance evaluations: not started.
- Routines, schedules, heartbeats: not started (upstream has its own scheduler).
- Routing actual agent task _execution_ to a remote worker over the tailnet —
  the registry and reachability test exist, dispatch does not.

### Memory

`MemoryProvider` is implemented, with Obsidian as its first real backend
(`server/ironcrew/memory/`) — see the Phase 2 table above. Not built: a
second provider (Honcho was deliberately not built alongside it — see
`docs/UPSTREAM_ANALYSIS.md`), and `docs/MEMORY.md` is still unwritten.

### Tools and secrets

- Tool registry, MCP registry, web search, Playwright tool: not started.
- `SecretProvider` is implemented for Vaultwarden and Proton Pass (see the
  Phase 2 table above) — an OS-keychain provider is not built. `SecretRef` is
  modelled in the schema and honoured by redaction.

### Business packs

- MSP, Web Agency, Finance, Legal, Knowledge: not started. The approval types
  and seed roles that anticipate them exist.

### Docs still to write

`docs/MEMORY.md`, `docs/MCP_AND_TOOLS.md`, `docs/SECURITY_OPERATIONS.md`,
`docs/BACKUP_RESTORE.md`. systemd and launchd templates are not written.
(`docs/LINUX_INSTALL.md`, `docs/MACOS_INSTALL.md`, `docs/ROADMAP.md` and
`docs/NETWORKING.md` are written; this list had gone stale.)

---

## MVP acceptance criteria

Measured against section 29 of the master prompt.

| Criterion                                                          | Status                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` / `dev` / `test` / `build`                          | **met**                                                                                                                                                                                                                                                        |
| Docker Compose for the control plane                               | inherited from upstream (`compose.yaml`), not re-verified                                                                                                                                                                                                      |
| Linux and macOS install guides                                     | **met** — `docs/LINUX_INSTALL.md`, `docs/MACOS_INSTALL.md`                                                                                                                                                                                                     |
| No pixel style, modern command center                              | **met**                                                                                                                                                                                                                                                        |
| Responsive, 2D fallback                                            | **met** (DOM-only; no WebGL scene exists to fall back from)                                                                                                                                                                                                    |
| Figure status matches backend state                                | **met** — derived server-side                                                                                                                                                                                                                                  |
| Kanban, agent detail, CEO chat reachable                           | **met**; projects, org chart, meetings, memory, secrets, attachments and network status are too — each behind its own topbar dialog                                                                                                                            |
| Provider health UI                                                 | **met** — `GET /api/crew/runtimes` + Command Center agent-detail dropdown with a health marker per registered runtime                                                                                                                                          |
| MockRuntime plus one real CLI runtime                              | **met** (implementation) — `CliAdapterRuntime` registered for claude/codex/gemini and driven end-to-end against a real child process; a live task run through an authenticated CLI is the user's own manual verification (no login exists in this environment) |
| Start, streaming, cancel, error state                              | **met** for MockRuntime and `CliAdapterRuntime` alike (same `AgentRuntime` contract, same test coverage pattern)                                                                                                                                               |
| Persistent run history                                             | **met**                                                                                                                                                                                                                                                        |
| Rate limit detected, not swallowed                                 | **met**                                                                                                                                                                                                                                                        |
| No tokens in logs                                                  | **met** — 35 redaction tests                                                                                                                                                                                                                                   |
| CEO → EA → delegation → agent → review → CEO                       | **met**                                                                                                                                                                                                                                                        |
| Revision works                                                     | **met**                                                                                                                                                                                                                                                        |
| Blocker and approval work                                          | **met**                                                                                                                                                                                                                                                        |
| Restart loses no task                                              | **met**                                                                                                                                                                                                                                                        |
| Obsidian vault read/written                                        | **met** — real markdown files with YAML frontmatter, written/read through `ObsidianProvider`                                                                                                                                                                   |
| Memory search                                                      | **met** — full-text search over what `ObsidianProvider` itself wrote, with snippet extraction                                                                                                                                                                  |
| Honcho optional, failure non-blocking                              | **not met** — deliberately not built alongside Obsidian; `MemoryProvider` is registry-based (like `SecretProvider`), so a second provider is additive whenever it's wanted (see `docs/UPSTREAM_ANALYSIS.md`)                                                   |
| High-risk action blocked until approved                            | **met**                                                                                                                                                                                                                                                        |
| Budgets stop runs reliably                                         | **met**                                                                                                                                                                                                                                                        |
| Atomic assignment prevents double work                             | **met**                                                                                                                                                                                                                                                        |
| Audit shows the full flow                                          | **met**                                                                                                                                                                                                                                                        |
| Blocked model families unusable via UI _and_ API                   | **met**                                                                                                                                                                                                                                                        |
| No OpenRouter fallback outside the allowlist                       | **met** in policy construction; transport not wired                                                                                                                                                                                                            |
| No Talent Market / WeChat traffic                                  | **met** — endpoint blocklist                                                                                                                                                                                                                                   |
| No telemetry                                                       | **met**                                                                                                                                                                                                                                                        |
| Unit tests: state machines, policies, routing, event normalisation | **met**                                                                                                                                                                                                                                                        |
| Integration tests: task / run / approval / memory                  | **met**                                                                                                                                                                                                                                                        |
| Playwright E2E for the CEO workflow                                | **met** — 10/10                                                                                                                                                                                                                                                |
| Secret redaction tests                                             | **met**                                                                                                                                                                                                                                                        |
| Recovery-after-crash tests                                         | **met** — orphan recovery and restart persistence                                                                                                                                                                                                              |

## Next technically sensible step

Phase 1, Phase 1.5 and Phase 2 are now complete against the acceptance
criteria above — the CEO slice runs on a real, registered, permission-aware
CLI runtime alongside MockRuntime, and the whole Company OS (goals through
notification channels) is built, tested and reachable from the Command
Center. What's still open:

1. **The user's own manual live-CLI verification.** No Claude Code, Codex or
   Gemini login exists in this environment. Start the server on a machine
   that has one of those CLIs logged in, register/select that runtime for an
   agent (Command Center → agent detail → Runtime), send the EA a message,
   and confirm a real run streams events, appears in `GET /api/crew/runtimes`
   as authenticated, and reaches `done`.
2. **A native runner daemon**, so the control plane and the runtime stop
   sharing a process and `docs/THREAT_MODEL.md` T-05's credential boundary
   becomes enforced rather than a design commitment. `CliAdapterRuntime`
   already depends only on the `CliAdapter` interface, not on running
   in-process, so this is additive rather than a rewrite.
3. **Routing actual task execution to a remote worker** over the tailnet —
   the registry and reachability test exist (`testRemoteWorker()`), dispatch
   does not.

Beyond that, the largest unimplemented surface is Phase 3+: the MCP
registry, a risk-classed tool registry, and the business packs (MSP, Web
Agency, Finance, Legal, Knowledge) — all listed under "Known gaps" above.
