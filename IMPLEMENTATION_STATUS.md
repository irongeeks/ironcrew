# Implementation Status

Honest state of IronCrew. Nothing is listed as done unless it is
implemented **and** covered by a passing test. Anything verified only by design
review, or not verifiable in this environment, is said so explicitly.

## Current Company OS completion branch — 2026-09-05

PR #18 is merged at `1e441e4`; PR #19 is merged on `main` at
`e365cfb9bdd887d1a77570749edd84b3374229a4`. The merged tree is unchanged from
verified revision `ebfad74`. [PR #20](https://github.com/irongeeks/ironcrew/pull/20)
is merged at `36a71db`; its tree matches tested head `4eec70b`.
[MASTER_PROMPT_COVERAGE.md](docs/MASTER_PROMPT_COVERAGE.md) maps the exact scope.

Implemented additions include the outbound runner fleet, scoped sandbox approvals
and one-run grants, private character lifecycle and animation, optional GLB profile
previews, owner-reviewed coaching, project planning, and native deployment tooling.
These additions do not establish completion of every master-prompt requirement.

Consolidated evidence for `ebfad74`:

- [CI 33947377635](https://github.com/irongeeks/ironcrew/actions/runs/33947377635)
  passed quality/build gates, **5,085 backend tests (1 skipped), 592 frontend tests,
  40 script tests and 76 browser tests (4 existing skips)**. Browser coverage includes
  the private spritesheet lifecycle, GLB preview and project planning.
- [Platform CI 33947377630](https://github.com/irongeeks/ironcrew/actions/runs/33947377630)
  passed native Linux/macOS checks and actual Docker startup, restart, persistent
  data and backup/restore checks, plus SBOM/license gates. These are controlled CI
  installations, not a deployment to the operator's production host.
- The license gate tracks inherited exceptions; an inventory baseline does not
  grant commercial permission for inherited Remotion components.

Routing profiles are implemented separately: nine versioned profiles, owner UI/API,
agent bindings, actual task/meeting dispatch, explicit fallback, persistent route
selection and original/selected budget and concurrency enforcement. Focused checks
passed **73 backend and 199 frontend tests**, both typechecks, ESLint, formatting and
production build. These are overlapping module suites, not additional aggregate counts.
Full routing evidence at `4eec70b`: [CI 33949377702](https://github.com/irongeeks/ironcrew/actions/runs/33949377702) passed **5,114 backend tests (1 skipped), 599 frontend tests, 40 script tests and 78 browser tests (3 existing skips)**. [Platform CI 33949377720](https://github.com/irongeeks/ironcrew/actions/runs/33949377720) passed Linux/macOS and Docker persistence/restore gates. See [RUNTIME_ROUTING.md](docs/RUNTIME_ROUTING.md).

The living-office change is merged in [PR #21](https://github.com/irongeeks/ironcrew/pull/21)
at `e7c928b`, with the same tree as verified head `0893311`. It adds furnished
department rooms, connected halls, room focus and bounded ambient walking/encounters.
[CI 33950692947](https://github.com/irongeeks/ironcrew/actions/runs/33950692947)
passed 5,114 backend tests (1 skipped), 617 frontend tests, 40 script tests and
80 browser tests (3 existing skips). [Platform 33950692948](https://github.com/irongeeks/ironcrew/actions/runs/33950692948)
passed all Linux/macOS, Docker and supply-chain gates. Actual browser screenshots
of the overview, focused department and responsive layouts were inspected.
See [LIVING_OFFICE.md](docs/LIVING_OFFICE.md).

Career levels and task reviews are implemented in [PR #22](https://github.com/irongeeks/ironcrew/pull/22):
owner-approved Junior/Senior/Lead, actual department-routing and independent-review
runs, root-task budget attribution and immutable work/reviewer model evidence.
UI shows per-agent and per-model means, counts, difficulty and revision context
without automatic promotion. The integrated local frontend run passed 627 tests;
41 focused career backend tests and the canonical owner-approval flow passed.
On `963db68`, [CI 33950807360](https://github.com/irongeeks/ironcrew/actions/runs/33950807360)
passed the complete 5,156 backend tests (1 skipped), 627 frontend tests and 40
script tests; quality/build and [platform gates](https://github.com/irongeeks/ironcrew/actions/runs/33950807364)
also passed. The same revision passed **82 browser tests (4 existing conditional skips)**,
including all new profile/roster, saved configuration, stale revision, self-rating
and mobile roster cases. Actual profile, configuration and mobile screenshots were
inspected. The final follow-up labels professional roles readably and hardens native vault
watching after a macOS directory-event regression. The final
exact-revision browser/CI evidence and merge state are recorded in PR #22.
The native watcher correction on `115f951` passed [CI 33951716893](https://github.com/irongeeks/ironcrew/actions/runs/33951716893)
with **5,159 backend tests (1 skipped), 627 frontend tests, 40 script tests and
83 browser tests (3 existing conditional skips)**. [Platform 33951716900](https://github.com/irongeeks/ironcrew/actions/runs/33951716900)
passed every gate, including all 15 watcher tests on macOS. The final UI correction
preserves unsaved department setup during unchanged-revision live refreshes; its
regression and final merge evidence are linked from PR #22.

See [CAREER_REVIEWS.md](docs/CAREER_REVIEWS.md) for setup and limits.

Actual CLI subscriptions, mTLS customer networks, OIDC, Honcho, mail and business
providers require separately documented operator tests. Services were not installed,
accounts were not modified, and no production system was deployed in this session.
See [SECURITY_OPERATIONS.md](docs/SECURITY_OPERATIONS.md) and
[BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) for concrete start/recovery steps.

## Shared foundation and PR #18 baseline — 2026-09-05

Office, Kanban and CEO chat use one persisted company domain and authenticated live
updates. Retry, cooldown, workspace propagation and stale-worker fencing are implemented.
The following additions now have implementation and focused regression coverage:

| Area                 | Implemented scope                                                                                                                   | Details                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Characters           | 20 original full-body skins; profile selection; private portrait/full-body uploads and previews; copyable external-generator prompt | [Characters](docs/CHARACTERS.md)                 |
| CLI runtimes         | Bounded version/help/auth probes; capability-gated real resume; initial session persistence; safe restart/revision matching         | [CLI acceptance](docs/CLI_RUNTIME_ACCEPTANCE.md) |
| OpenRouter           | Incremental SSE, usage/rate-limit events, scoped tool calls, schema validation, approvals, audit and per-request vendor policy      | [OpenRouter](docs/OPENROUTER_RUNTIME.md)         |
| Memory               | Obsidian default plus optional Honcho hybrid, local fallback, classified sync, persistent retry/deletion and source metadata        | [Memory](docs/MEMORY.md)                         |
| Native/remote runner | Per-run OpenRouter SecretRef resolution; scoped workspace tools; explicit mTLS endpoint supporting start/resume/cancel              | [Runner protocol](docs/RUNNER_PROTOCOL.md)       |

These foundation features were already present in [PR #18](https://github.com/irongeeks/ironcrew/pull/18).
The consolidated evidence above supersedes its earlier test totals. Real CLI login,
provider billing, managed Honcho and remote production deployment remain operator
acceptance tasks. The complete master-prompt MVP is **not yet verified**.

The phase tables and counts below are historical milestone records. Their earlier
“done” labels describe that milestone's implementation scope, not current consolidated
checks or proof that every master-prompt requirement is complete. The current scope
and remaining limits in this document take precedence over those historical notes.

Previous milestone: **Phase 5 — production hardening.** Approval quorums
(`crew_approval_reviews`, four eyes on a dangerous gate), Authentik OIDC beside
the password login, the audit chain shipped off the box to a file or HTTP sink,
a tested backup/restore path, a load test, and the upgrade runbook. Before that:
**Phase 4** (five business packs and seven read-only integrations) and
**Phase 3** (tool and MCP registries with risk classes, web search, the
Playwright browser tool, the OS-keychain `SecretProvider`, the persistent run
queue and scheduler, routines, the OpenRouter runtime, the native runner daemon,
and Antigravity as a real CLI adapter), plus **identity** (accounts, roles,
sessions, and a real `usr_…` in the audit log).

Mailboxes, marketplaces and earlier Company OS features remain in place;
their historical coverage is listed below, subject to the current review notes.

## Historical verification summary (before these corrections)

Re-measured on this checkout, not carried forward from a previous phase.

| Check           | Result                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:api` | **293 files / 4812 tests passed, 1 skipped**                                                                                                                                                                |
| `pnpm test:web` | **59 files / 528 tests passed**                                                                                                                                                                             |
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
  `company_id`, which makes it look like configuration. It is not: a large
  number of statements in `domain/` select or update by `WHERE id = ?` alone,
  safe today only because one company exists — with two, any of them will
  happily act on another company's row when handed its id. The scoping that
  does exist lives in the layers above as hand-written comparisons after the
  read, which is a convention, and a convention is what a new store method
  forgets. `crew_users`, `crew_sessions`, `crew_tool_grants` and
  `crew_oidc_identities` have no `company_id` at all, so multi-company would
  first have to decide whether a person belongs to a company or to the box.
  Doing it properly means the company predicate becomes structural — in the
  query builder or the schema, not in the callers. Worth doing before a second
  company exists, never after.
- **PostgreSQL: no, and the obstacle is not the SQL dialect.** Every store
  method is synchronous, and so is every caller — orchestrator, scheduler,
  route handlers — over hundreds of files importing `node:sqlite`. There is no
  mainstream synchronous PostgreSQL driver for Node, so an "adapter" means
  making every call site async and colouring every function above it. The
  atomic claim, the audit chain's read-then-insert and the transaction
  discipline are all correct _because_ there is one synchronous connection;
  each would need re-proving under a pool. This is a rewrite of the persistence
  layer wearing the word "adapter".

  `docs/ROADMAP.md` carries the exact counts that were measured when this
  decision was taken. They are not restated here, because a number copied
  between documents is a number nobody will re-measure.

---

## Current limits and remaining acceptance

- **Real provider acceptance:** execute the documented [CLI procedure](docs/CLI_RUNTIME_ACCEPTANCE.md)
  as the dedicated runner user with an official CLI login. Confirm start, streaming,
  cancellation, revision/resume and persisted review history. The automated process
  fixtures do not prove compatibility with every installed CLI version or account.
  `agy` is usable only when the installed official executable exposes the required
  capabilities; its existence, login and supported flags are not assumed.
- **OpenRouter:** provider-side usage/billing, actual tool behavior and credentials
  need an operator run. Tool executors expose only their explicitly granted scoped
  operations; arbitrary shell or business writes are not enabled by tool calling.
  Native provider session resume is not available for OpenRouter.
- **Honcho:** optional v3 transport and hybrid behavior are implemented and tested
  with controlled servers. Real managed/self-hosted deployment acceptance is open.
  Unclassified, confidential and restricted memory is not automatically exported;
  ordinary search stays local unless semantic retrieval is explicitly classified.
- **Remote runners:** the direct mTLS endpoint and outbound WSS fleet support
  authenticated dispatch, scoped enrollment, capacity selection, persisted leases,
  revocation and recovery. Fleet sessions stay pinned to their original worker.
  Fleet mTLS enrollment, automatic certificate issuance, file synchronization,
  fleet MCP and HA are not implemented. Controlled TLS tests do not establish a
  production customer-network or certificate deployment. See [RUNNER_FLEET.md](docs/RUNNER_FLEET.md).
- **Character assets:** 20 original SVG figures, private images, live status
  spritesheets, assignment/reuse and owner-controlled physical deletion are
  implemented. Referenced files require explicit detachment; failed deletion has
  persisted recovery markers. Optional GLB profile previews support bounded,
  self-contained, untextured/uncompressed geometry and animations; the office stays
  2D. Browser CI covers these flows. Image/animation generation remains an external
  user action, not an integrated generation service. See [CHARACTERS.md](docs/CHARACTERS.md).
- **Sandbox elevation:** owner/quorum approval now mints an expiring, scoped,
  single-run grant with atomic consumption, revocation and runner-side expiry
  cancellation. Restricted execution remains the default. OS isolation and egress
  must also be configured on the target runner; an approval is not an OS sandbox.
  See [SANDBOX_ACCESS.md](docs/SANDBOX_ACCESS.md).
- **Business integrations:** existing mail, Sevdesk and business-pack code is
  preserved. The read-only business adapters do not prove live tenant behavior or
  add payments, filings, external promises or production changes.
- **Coaching:** owner-reviewed, versioned guidance, sourced notes and deterministic
  evaluation of stored evidence are implemented. They do not prove that proposed
  guidance improves future model performance or authorize automatic promotion.
- **Deployment:** systemd/launchd rendering and install tooling, security operations
  and backup/restore instructions are implemented and platform CI passed. Dedicated
  users, keychains, egress, certificates and actual service installation remain
  target-host responsibilities.
- **Routing:** nine owner-editable profiles and actual dispatch are implemented.
  Real model capabilities, login and usage need account acceptance.
- **Remaining product work:** complete live business KPIs need connected sources;
  multi-company product acceptance, PostgreSQL and HA remain future work.
- **Audit:** offline verification detects changed rows and sequence holes. Tail
  truncation requires an independent backup or shipped copy for comparison.

## MVP acceptance overview

This table distinguishes implemented behavior from installation/account acceptance.
The linked routing, building and career runs above identify each tested revision.
The PR links carry final browser and merge results; provider-account acceptance remains separate.

| Criterion                                                      | Current evidence and limit                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install/dev/test/build, Linux/macOS guides                     | Linux/macOS and actual Docker startup/restart/persistence/restore passed platform CI; target-host installation remains operator acceptance.       |
| Modern responsive office, no pixel style                       | Original 2D figures, accessible DOM controls, keyboard navigation and reduced-motion support; no WebGL requirement.                               |
| One company state across office, Kanban, profiles and CEO chat | Canonical domain IDs, persisted updates and authenticated SSE; focused integration/UI coverage.                                                   |
| Character choice and private assets                            | 20 originals, private asset lifecycle, spritesheets and bounded GLB profile previews; backend and browser flows passed.                           |
| MockRuntime plus real CLI adapters                             | Mock flow and spawned protocol fixtures covered; installed official CLI capability detection implemented; authenticated real run pending.         |
| Streaming, cancel, errors and rate limits                      | CLI and OpenRouter event parsing, timeouts, cancellation and durable cooldown coverage; actual provider behavior still needs acceptance.          |
| Session and restart recovery                                   | Initial session IDs persisted with workspace; matching sessions resume after restart/revision; mismatches cannot reuse a session.                 |
| CEO → EA → delegation → review → accept/revise                 | Implemented with integration and passing browser coverage, including structured project planning; actual model quality needs operator acceptance. |
| Task ownership, dependencies and approvals                     | Atomic claims, lease renewal, stale-worker fencing and structured approval gates implemented and covered.                                         |
| Budgets and audit                                              | Existing hard-stop and audit paths retained; scoped tool execution records authorization/results.                                                 |
| Obsidian read/write/search and provenance                      | Default local vault, bounded context and metadata implemented.                                                                                    |
| Optional Honcho with non-blocking failure                      | Implemented hybrid fallback, persisted outbox, classified retrieval and deletion; live account acceptance pending.                                |
| Native SecretRefs and remote transport                         | Runner resolves OpenRouter keys per run; TLS/client-certificate/token boundaries covered in controlled tests; real deployment pending.            |
| Vendor restrictions and permitted fallback                     | Backend policy applied per request and continuation; no unapproved model/provider fallback.                                                       |
| Full master-prompt MVP                                         | **Not yet verified**; remaining acceptance and implementation limits above are explicit.                                                          |

## Next technically sensible step

1. Configure department leads and model bindings through Team & Leistung, then
   validate actual model output on a small representative set of bounded tasks.
   The PR links above record the controlled automated acceptance.
2. Perform an authenticated CLI acceptance run through the dedicated native runner,
   including revision/resume after a control-plane restart. Keep account credentials
   in the official CLI store and record only redacted events and result evidence.
3. Validate one configured OpenRouter SecretRef, optional Honcho endpoint and the
   chosen remote transport on the target host with bounded tasks and controlled data.
4. Rehearse backup/restore with the operator's actual configuration and encryption
   secret on an isolated target; CI has already exercised the packaged fixture flow.
5. Prioritize remaining product scope from the coverage matrix and those acceptance
   results, including live business sources and optional future infrastructure.

## Versioned releases and updates — 2026-09-05

The release change continues the existing package version from 2.7.0 to 2.8.0;
this is the first GitHub release for this repository, not evidence of earlier
published IronCrew versions. It adds exact-commit CI/platform publication gates,
source archives and checksums, a digest-linked production image, explicit native
and Docker maintenance tools, and read-only stable release information in Settings.

Native updates use real Git tag/commit verification and a separate build worktree;
backup, failed preparation and partial-swap recovery are covered by regression
checks. Docker updates retain the existing project/mount identity and persist a
private recovery record. The web process cannot apply updates or restart itself.
See [RELEASES.md](docs/RELEASES.md) for installation, first-update bootstrap and
recovery procedures. Runtime account acceptance remains a target-host step.

Local integration checks: 84 script tests, 632 frontend tests and 11 release
route/discovery tests pass, as do both TypeScript checks, ESLint and the versioned
production build. The Docker updater smoke uses a local registry fixture while
executing actual Compose stop, archive, start, SQL persistence and failure recovery.
The final aggregate CI, Docker updater verification and first publication are
recorded in the release PR and GitHub Actions; no production operator host has
been updated by this change.
