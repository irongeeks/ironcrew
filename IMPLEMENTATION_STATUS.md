# Implementation Status

Honest state of Iron Command OS. Nothing is listed as done unless it is
implemented **and** covered by a passing test. Anything verified only by design
review, or not verifiable in this environment, is said so explicitly.

Last updated: end of the Phase 0 + Phase 1 session.

## Verification summary

| Check           | Result                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm test:api` | **201 files / 2834 tests passed** (upstream baseline 190/2493)                                               |
| `pnpm test:web` | **53 files / 294 tests passed** (upstream baseline 52/270)                                                   |
| `pnpm build`    | passes (`tsc -b && vite build`)                                                                              |
| `pnpm lint`     | 0 errors; 441 warnings, all pre-existing upstream (Iron Command code contributes 0)                          |
| Playwright E2E  | Iron Command CEO workflow spec — API scenarios pass; browser scenarios need `PW_CHROMIUM_PATH` in this image |
| Manual live run | verified against a running server (see below)                                                                |

Iron Command's own suites: **341 tests** across policy, domain, runtime,
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
| 6. A runtime executes the task             | **done with MockRuntime**; real CLI runtimes not yet driven by this control plane (see gaps) |
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

- **The Iron Command control plane does not yet drive the real CLI runtimes.**
  It runs MockRuntime. The upstream execution path still handles real CLI
  agents — now with safe permission defaults, but outside the new orchestrator.
  Bridging the two is the single most valuable next step.
- **Sandbox grants are not threaded through the upstream execution path.** That
  path always resolves to `restricted`, which is safe but means elevation is
  not reachable in production yet.
- **No `agy` CLI adapter.** The upstream Antigravity adapter is HTTP-based.
- **OpenRouter transport is not wired.** The vendor policy and provider-routing
  block are implemented and tested; the HTTP client is not.
- **No native runner daemon.** Control plane and runtime share a process, so the
  credential boundary in `docs/THREAT_MODEL.md` T-05 is a design commitment, not
  an enforced one.
- **Live CLI runtimes are unverified.** No Claude Code, Codex or `agy` login
  exists in this environment, so real-runtime execution is documented as an open
  manual test rather than claimed.

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

`docs/RUNNER_PROTOCOL.md`, `docs/MEMORY.md`, `docs/MCP_AND_TOOLS.md`,
`docs/SECURITY_OPERATIONS.md`, `docs/LINUX_INSTALL.md`,
`docs/MACOS_INSTALL.md`, `docs/BACKUP_RESTORE.md`, `docs/ROADMAP.md`.
systemd and launchd templates are not written.

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
| Provider health UI                                                 | **partial** — health/auth in the runtime contract, no UI panel |
| MockRuntime plus one real CLI runtime                              | **partial** — MockRuntime done; real runtime unverified        |
| Start, streaming, cancel, error state                              | **met** for MockRuntime                                        |
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
| Playwright E2E for the CEO workflow                                | **met**                                                        |
| Secret redaction tests                                             | **met**                                                        |
| Recovery-after-crash tests                                         | **met** — orphan recovery and restart persistence              |

## Next technically sensible step

Bridge the Iron Command orchestrator to the real CLI runtimes: implement an
`AgentRuntime` that wraps the existing upstream adapters, thread the resolved
`SandboxGrant` through `spawnCliAgent`, and normalise the six upstream
`AdapterStreamEvent` types onto the seventeen-type run protocol. That turns the
MockRuntime slice into a real one without touching anything else.
