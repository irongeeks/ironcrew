# Roadmap

Current state is in `IMPLEMENTATION_STATUS.md`. This is what comes next and why
in that order.

## Done — Phase 0, Phase 1 and Phase 1.5

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
- **Phase 1.5, "make the slice real":** `CliAdapterRuntime implements AgentRuntime`
  is registered for every CLI-transport adapter this install builds (claude,
  codex, gemini today) alongside MockRuntime; the resolved `SandboxGrant` is
  threaded through so an approved elevation actually reaches the CLI call.
  What's still open here: a live task run through an *authenticated* real
  CLI login is the user's own manual verification — no CLI login exists in
  this development environment (see `IMPLEMENTATION_STATUS.md`).

## Done — Phase 2: Company OS

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
- Obsidian vault as the first `MemoryProvider` (`server/ironcrew/memory/`) —
  real markdown files with YAML frontmatter, written and read from a
  configured vault, full-text search over what it wrote
- Notification channels for the decision inbox — Discord (Incoming Webhook),
  Telegram (Bot API) and email (SMTP), fanned out best-effort on every
  notification; grew beyond the original Discord-only scope on request

### Also shipped alongside Phase 2, not originally scoped here

Requested mid-stream and built with the same standard (domain → orchestrator
→ API → UI, each layer tested) as everything above:

- **Password-manager integration** — `SecretRef`/`SecretProvider` for
  Vaultwarden and Proton Pass; a secret's value is never stored, only where
  it lives, resolved live in memory at the moment of use
  (`server/ironcrew/secrets/`).
- **File attachments** — task-, project- or general-scoped, content-addressed
  blob storage on disk (`server/ironcrew/domain/attachment-storage.ts`).
- **Renamed Iron Command OS → IronCrew** — directory paths, symbols, DB table
  and index prefixes (with an upgrade migration), WS event names, the REST
  API base path, all UI/doc text.
- **Tailscale/Headscale network status** (`server/ironcrew/network/`) and a
  **remote-worker registry over the tailnet**
  (`server/ironcrew/domain/remote-worker-store.ts`) for Tier0 environments
  and customer networks reachable over SSH. Routing actual agent task
  *execution* to a remote worker (rather than just registering and testing
  reachability) is a natural follow-up, not yet built.

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
