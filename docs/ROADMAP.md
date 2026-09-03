# Roadmap

Current state is in `IMPLEMENTATION_STATUS.md`. This is what comes next and why
in that order.

## Done — Phase 0 and Phase 1

- Vendor policy, enforced in the backend
- Unsafe CLI permission defaults removed; sandbox grants tied to approvals
- Secret redaction across logs, events and streams
- Company-scoped domain schema with atomic claiming and a hash-chained audit log
- Task and agent state machines
- Normalised run protocol and MockRuntime
- Approval and budget engines
- EA triage, seed crew, persona/role/policy separation
- REST API, live events, Command Center UI
- The CEO → EA → task → run → review → CEO slice, end to end

## Next — Phase 1.5: make the slice real

**Bridge the orchestrator to the real CLI runtimes.** This is the single most
valuable next step, because everything else is already built around it.

1. Implement `UpstreamCliRuntime implements AgentRuntime`, wrapping the existing
   `server/adapters/*`.
2. Map the six upstream `AdapterStreamEvent` types onto the seventeen-type run
   protocol (table in `docs/RUNNER_PROTOCOL.md`).
3. Thread the resolved `SandboxGrant` from `ic_sandbox_grants` through
   `spawnCliAgent`, so `elevated` becomes reachable — currently the upstream
   path always resolves to `restricted`, which is safe but means an approved
   elevation has no effect.
4. Capability-detect flags per installed CLI version rather than assuming them.
5. Wire `StreamRedactor` into the live stdout/stderr path.

**Definition of done:** the same E2E spec passes with a real Claude Code or
Codex login, and the run history shows the permission mode each run actually
had.

## Phase 2 — Company OS

- Goals and goal ancestry in the context builder
- Projects, milestones, project detail view
- Kanban drag & drop with server-side validation (state changes must never be
  frontend-only)
- Task dependencies and blockers in the UI
- Decision inbox as a first-class view
- Org chart and agent detail
- Meetings with a **moderator**, bounded rounds and a budget — explicitly not
  the O(participants × rounds) "token grab" pattern (see
  `docs/UPSTREAM_ANALYSIS.md`)
- Action items from meetings become real tasks
- Obsidian vault as the first `MemoryProvider`
- Discord as an optional notification channel

## Phase 3 — Runtimes and tools

- All four runtimes stable: Claude Code, Codex, Antigravity (`agy`), OpenRouter
- Native runner daemon, so CLI logins stay with their OS user and the control
  plane never holds a token (`docs/RUNNER_PROTOCOL.md`)
- MCP registry: stdio and streamable HTTP, per-agent and per-project scopes,
  secret injection only in the runner, full tool-call auditing
- Tool registry with risk classes and approval policies
- Web search behind a `SearchProvider` (SearXNG, Brave)
- Playwright browser tool in an isolated profile, with submit/purchase/publish
  gated behind approval
- `SecretProvider`: OS keychain first, then Proton Pass
- Rate-limit-aware scheduler with a persistent queue
- Routines and heartbeats — every routine produces a visible task or run, never
  an invisible background action

## Phase 4 — Business packs

- **MSP / IT Operations** — Proxmox, Windows/AD, Linux, M365/Entra, UniFi,
  Tactical RMM, backup and monitoring, Tier-0 separation, jumphost and
  outbound-only customer runners
- **Web Agency** — leads, demo sites, proposals, SEO, hosting, conversion
- **Finance** — Lexware Office, incoming/outgoing invoices, receipt matching,
  payment approval queue, cash forecast, quarterly UStVA preparation
- **Legal** — contract analysis, clause comparison, risk matrix, deadlines
- **Knowledge** — Obsidian, Nextcloud, Paperless-ngx, Drive, M365

Every integration ships behind a feature flag as a real adapter. No fake
buttons.

## Phase 5 — Production hardening

- Authentik OIDC, multiple human reviewers
- Multi-company (the schema already carries `company_id` everywhere)
- Optional PostgreSQL adapter
- Backup and restore procedures, tested
- External audit-log shipping, so tampering is not merely detectable but
  preserved off-box
- Security review and load testing
- Upgrade and migration strategy

## Deliberately not planned

- Gamified XP mechanics
- Agents modifying their own core code
- Promotion based on an LLM's self-assessment
- Any Chinese-vendor model, SDK, marketplace or telemetry service
- Automatic connection to the OneManCompany Talent Market
- Automatic download of unvetted community agents or skills
