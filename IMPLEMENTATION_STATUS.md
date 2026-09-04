# Implementation Status

Honest state of IronCrew. Nothing is listed as done unless it is
implemented **and** covered by a passing test. Anything verified only by design
review, or not verifiable in this environment, is said so explicitly.

Last updated: mailboxes and marketplaces — any number of IMAP/JMAP/Microsoft
365/Gmail mailboxes granted to agents n:n with per-mailbox polling and
triage, and marketplaces for installing skills and MCP servers from four
kinds of source. Before that: Phase 2's Company OS (goals, projects, Kanban,
task dependencies, decision inbox, org chart, bounded meetings, an Obsidian
`MemoryProvider`, Discord/Telegram/email notification fan-out) plus
password-manager integration, file attachments, the IronCrew rebrand, and
Tailscale + remote workers over the tailnet.

## Verification summary

| Check           | Result                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:api` | **235 files / 3527 tests passed**                                                                                                                                                                           |
| `pnpm test:web` | **53 files / 364 tests passed**                                                                                                                                                                             |
| `pnpm build`    | passes (`tsc -b && vite build`)                                                                                                                                                                             |
| `pnpm lint`     | 0 errors; 441 warnings, all pre-existing upstream (IronCrew code contributes 0)                                                                                                                             |
| Playwright E2E  | **10/10 passed** — the IronCrew CEO workflow spec, API and browser (set `PW_CHROMIUM_PATH` on images shipping Chromium but not chrome-headless-shell); not re-run this phase, no CEO-slice behavior changed |
| Manual live run | verified against a running server (see below)                                                                                                                                                               |

IronCrew's own suites have grown from the Phase 1 baseline (479 tests) to
well over a thousand across policy, domain, memory, notify, secrets,
network, runtime, orchestrator, API and UI — every feature below names its
own test count.

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
- **Sandbox grants are threaded through the IronCrew orchestrator.**
  `CompanyOrchestrator.executeNextTask()` looks up a live `SandboxGrant` via
  `SandboxGrantStore.findLive()` and resolves the run's real permission mode
  through `resolvePermissionMode()` — no longer hardcoded to `restricted`.
  Elevation is reachable end-to-end: owner approves a `sandbox_elevation`
  request → a scoped, time-boxed grant is minted → the next matching task
  dispatch resolves `elevated` and audits the decision. `resolvePermissionMode()`
  remains the sole authority and still fails closed on any mismatch.
- **No `agy` CLI adapter.** The upstream Antigravity adapter is HTTP-based.
- **OpenRouter transport is not wired.** The vendor policy and provider-routing
  block are implemented and tested; the HTTP client is not.
- **No native runner daemon.** Control plane and runtime share a process, so the
  credential boundary in `docs/THREAT_MODEL.md` T-05 is a design commitment, not
  an enforced one. `CliAdapterRuntime` is written to be runnable inside such a
  daemon later without a contract change — it only depends on the `CliAdapter`
  interface — but nothing runs it out-of-process today.
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
