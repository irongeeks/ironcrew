# Implementation Status

Honest state of Iron Command OS. Nothing is listed as done unless it is
implemented **and** covered by a passing test. Anything verified only by design
review, or not verifiable in this environment, is said so explicitly.

Last updated: Phase 1 completion — real CLI runtime bridge, permission
elevation wired end-to-end, Provider Health UI.

## Verification summary

| Check           | Result                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:api` | **207 files / 2952 tests passed** (upstream baseline 190/2493)                                                                                            |
| `pnpm test:web` | **53 files / 297 tests passed** (upstream baseline 52/270)                                                                                                |
| `pnpm build`    | passes (`tsc -b && vite build`)                                                                                                                           |
| `pnpm lint`     | 0 errors; 441 warnings, all pre-existing upstream (Iron Command code contributes 0)                                                                       |
| Playwright E2E  | **10/10 passed** — the Iron Command CEO workflow spec, API and browser (set `PW_CHROMIUM_PATH` on images shipping Chromium but not chrome-headless-shell) |
| Manual live run | verified against a running server (see below)                                                                                                             |

Iron Command's own suites: **479 tests** across policy, domain, runtime,
orchestrator, API and UI.

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

| Step                                       | Status                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1. CEO opens the web interface             | **done**                                                                                     |
| 2. Modern command-center UI (no pixel art) | **done** — 24 UI tests                                                                       |
| 3. Seed crew loaded                        | **done** — 14 agents from `config/agents.seed.yaml`                                          |
| 4. CEO writes to the EA                    | **done**                                                                                     |
| 5. EA creates a task and delegates it      | **done** — 35 triage + 31 orchestrator tests                                                 |
| 6. A runtime executes the task             | **done** — MockRuntime and `CliAdapterRuntime` (claude/codex/gemini) both registered and executable; a live task run against an authenticated real CLI is an open manual test (see gaps) |
| 7. Run events appear live                  | **done** — persisted, sequenced, broadcast                                                   |
| 8. Figure and board status change          | **done** — status derived server-side                                                        |
| 9. Result lands in review                  | **done**                                                                                     |
| 10. EA summarises for the CEO              | **done**                                                                                     |
| 11. CEO accepts or requests revision       | **done**                                                                                     |
| 12. Nothing lost after restart             | **done** — explicit restart test                                                             |

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

## Known gaps — not implemented

Listed plainly so nothing here is mistaken for working software.

### Runtime

- **`CliAdapterRuntime` bridges the normalised `AgentRuntime` contract onto the
  upstream CLI adapters** (`server/ironcommand/runtime/cli-adapter-runtime.ts`).
  `server-main.ts` registers it for every CLI-transport adapter this install
  builds (claude, codex, gemini today) alongside MockRuntime, so the Iron
  Command orchestrator can drive a real CLI session, not only MockRuntime.
  Argv-array spawning, separate stdout/stderr capture, redaction before
  emission, idle/hard timeouts, process-group cancellation and rate-limit
  detection are implemented and tested against a real spawned child process
  (a purpose-built protocol-accurate fixture, not a mock of the runtime
  itself) — see `cli-adapter-runtime.test.ts`.
- **Sandbox grants are threaded through the Iron Command orchestrator.**
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
  environment.** No Claude Code, Codex or Gemini *login* exists in this
  sandbox (`healthCheck()`/`authStatus()` against the actually-installed
  `claude` binary here correctly report it unauthenticated). What **is**
  verified here: `CliAdapterRuntime` genuinely detects the real `claude` CLI
  installed in this environment (version, installed state) — see
  `"genuinely detects the real Claude Code CLI installed in this
  environment"` in `cli-adapter-runtime.test.ts` — and drives a real child
  process end-to-end against the protocol fixture. Running an actual task
  through a logged-in CLI is the user's own manual verification step.

### Company OS

- Goals and goal ancestry: tables exist, no UI or orchestration.
- Projects and milestones: tables exist, minimal surface.
- Kanban drag & drop with server-side validation: the board is read-only; state
  changes go through the API, never the frontend alone.
- Meetings, org chart, decisions UI, coaching, evaluations: not started.
- Discord: not started.
- Routines, schedules, heartbeats: not started (upstream has its own scheduler).

### Memory

- `MemoryProvider`, the Obsidian vault writer and the Honcho adapter are **not
  implemented**. `ic_memory_refs` exists to hold provenance when they arrive.
  `docs/MEMORY.md` is not written yet.

### Tools and secrets

- Tool registry, MCP registry, web search, Playwright tool: not started.
- `SecretProvider` (OS keychain, Proton Pass): not implemented. `SecretRef` is
  modelled in the schema and honoured by redaction.

### Business packs

- MSP, Web Agency, Finance, Legal, Knowledge: not started. The approval types
  and seed roles that anticipate them exist.

### Docs still to write

`docs/MEMORY.md`, `docs/MCP_AND_TOOLS.md`, `docs/SECURITY_OPERATIONS.md`,
`docs/LINUX_INSTALL.md`, `docs/MACOS_INSTALL.md`, `docs/BACKUP_RESTORE.md`,
`docs/ROADMAP.md`. systemd and launchd templates are not written.
(`docs/RUNNER_PROTOCOL.md` was written during Phase 1 — this list had gone
stale.)

---

## MVP acceptance criteria

Measured against section 29 of the master prompt.

| Criterion                                                          | Status                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `pnpm install` / `dev` / `test` / `build`                          | **met**                                                        |
| Docker Compose for the control plane                               | inherited from upstream (`compose.yaml`), not re-verified      |
| Linux and macOS install guides                                     | **not met** — not written                                      |
| No pixel style, modern command center                              | **met**                                                        |
| Responsive, 2D fallback                                            | **met** (DOM-only; no WebGL scene exists to fall back from)    |
| Figure status matches backend state                                | **met** — derived server-side                                  |
| Kanban, agent detail, CEO chat reachable                           | **met**; projects and org chart **not met**                    |
| Provider health UI                                                 | **met** — `GET /api/ic/runtimes` + Command Center agent-detail dropdown with a health marker per registered runtime |
| MockRuntime plus one real CLI runtime                              | **met** (implementation) — `CliAdapterRuntime` registered for claude/codex/gemini and driven end-to-end against a real child process; a live task run through an authenticated CLI is the user's own manual verification (no login exists in this environment) |
| Start, streaming, cancel, error state                              | **met** for MockRuntime and `CliAdapterRuntime` alike (same `AgentRuntime` contract, same test coverage pattern) |
| Persistent run history                                             | **met**                                                        |
| Rate limit detected, not swallowed                                 | **met**                                                        |
| No tokens in logs                                                  | **met** — 35 redaction tests                                   |
| CEO → EA → delegation → agent → review → CEO                       | **met**                                                        |
| Revision works                                                     | **met**                                                        |
| Blocker and approval work                                          | **met**                                                        |
| Restart loses no task                                              | **met**                                                        |
| Obsidian vault read/written                                        | **not met**                                                    |
| Memory search                                                      | **not met**                                                    |
| Honcho optional, failure non-blocking                              | **not met**                                                    |
| High-risk action blocked until approved                            | **met**                                                        |
| Budgets stop runs reliably                                         | **met**                                                        |
| Atomic assignment prevents double work                             | **met**                                                        |
| Audit shows the full flow                                          | **met**                                                        |
| Blocked model families unusable via UI _and_ API                   | **met**                                                        |
| No OpenRouter fallback outside the allowlist                       | **met** in policy construction; transport not wired            |
| No Talent Market / WeChat traffic                                  | **met** — endpoint blocklist                                   |
| No telemetry                                                       | **met**                                                        |
| Unit tests: state machines, policies, routing, event normalisation | **met**                                                        |
| Integration tests: task / run / approval                           | **met**; memory **not met**                                    |
| Playwright E2E for the CEO workflow                                | **met** — 10/10                                                |
| Secret redaction tests                                             | **met**                                                        |
| Recovery-after-crash tests                                         | **met** — orphan recovery and restart persistence              |

## Next technically sensible step

Phase 1 is now complete against the acceptance criteria above, including a
real, registered, permission-aware CLI runtime alongside MockRuntime. Two
things remain before that's exercised in anger:

1. **The user's own manual live-CLI verification.** No Claude Code, Codex or
   Gemini login exists in this environment. Start the server on a machine
   that has one of those CLIs logged in, register/select that runtime for an
   agent (Command Center → agent detail → Runtime), send the EA a message,
   and confirm a real run streams events, appears in `GET /api/ic/runtimes`
   as authenticated, and reaches `done`.
2. **A native runner daemon**, so the control plane and the runtime stop
   sharing a process and `docs/THREAT_MODEL.md` T-05's credential boundary
   becomes enforced rather than a design commitment. `CliAdapterRuntime`
   already depends only on the `CliAdapter` interface, not on running
   in-process, so this is additive rather than a rewrite.

Beyond that, the largest unimplemented surface is Company OS itself —
goals, projects, meetings, memory — all deliberately out of Phase 1's scope
and listed under "Known gaps" above.
