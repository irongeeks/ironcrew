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
  What's still open here: a live task run through an _authenticated_ real
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
  _execution_ to a remote worker (rather than just registering and testing
  reachability) is a natural follow-up, not yet built.
- **Mailboxes** — any number of real mailboxes over IMAP, JMAP, Microsoft 365
  Exchange Online or Gmail, granted to agents n:n (an agent may hold several
  mailboxes, a mailbox may be worked by several agents), with per-mailbox
  polling and auto-triage. Incoming mail becomes an `inbox` task quoted as
  third-party content, never a CEO message (`docs/MAIL.md`).
- **Marketplaces for skills and MCP servers** — four source kinds (a JSON
  catalog, the official MCP registry, a Claude-Code `marketplace.json`, or a
  Git repository), installed into the infrastructure that already exists:
  McpManager's settings row for servers, `custom-skills/` for skills. The
  installer is the trust boundary — a launcher allowlist, the same schema the
  hand-add route uses, and installing a skill executes nothing
  (`docs/MARKETPLACES.md`).

## Phase 3 — Runtimes and tools

**Mostly shipped.** What landed, and what is honestly still open:

- **Tool registry with risk classes and approval policies** — shipped.
  `crew_tools` says what the server can perform, `crew_tool_grants` says who
  may; registering grants nothing. An `external` tool is gated by omission
  (`docs/TOOLS.md`).
- **Web search behind a `SearchProvider`** — shipped. SearXNG and Brave, with
  results stripped at the boundary and fenced before they may reach a prompt.
- **Playwright browser tool in an isolated profile** — shipped, with a
  deny-by-default host allowlist and `submit` classified as external even
  when the form looks like a search box.
- **`SecretProvider`: OS keychain** — shipped, with the caveat enforced in
  code that a headless service should use Vaultwarden or Proton Pass instead
  (`docs/PROVIDER_AUTH.md`).
- **Rate-limit-aware scheduler with a persistent queue** — shipped
  (`docs/RUN_QUEUE.md`, `docs/SERVICE.md`).
- **Routines** — shipped. Every routine produces a visible task; none acts
  directly (`docs/TOOLS.md`).
- **MCP per-agent and per-project scopes** — shipped, by putting MCP servers
  in the same registry behind the same grants rather than in a second
  permission system.
- **OpenRouter runtime** — shipped. The first runtime that is not a CLI; the
  vendor policy is enforced inside it, because one key reaches hundreds of
  models from dozens of vendors.
- **Native runner daemon** — shipped (`docs/RUNNER_PROTOCOL.md`). CLI logins
  live with the runner's own OS user; the control plane never holds one.
- **MCP secret injection in the runner** — shipped. An MCP server's `env` and
  `headers` may name a vault item instead of carrying a value, and the runner
  resolves it at start (T-18). Doing it in the control plane would only have
  moved the plaintext from the database into the process that must not hold
  it.
- **MCP streamable-HTTP transport** — shipped alongside it, since it is the
  same config path and the same header credentials. `sse` still works;
  servers deployed against the older transport should not need a redeploy to
  upgrade IronCrew.

- **Antigravity (`agy`)** — shipped as a CLI adapter, replacing an inherited
  HTTP stub that pointed at an endpoint that does not exist, dropped every
  event and always reported failure. Its flags come from the published
  headless-mode documentation, not from guessing. Like every other CLI here,
  it is unverified against a real binary in this environment — that stays a
  manual test (`docs/PROVIDER_AUTH.md`).

Phase 3 is done. Two things it turned up, both open and both honest about
their size:

- **Identity is built but not wired.** `UserStore` and `SessionStore` exist,
  with password hashing, roles and expiring sessions, and are tested. Nothing
  calls them: `/api/crew` has no login, no session middleware and no role
  guard, and the audit log still records the constant `"ceo"` as the actor.
  On a single-operator machine behind loopback that is defensible; the moment
  a second person or a tailnet address is involved it is not. Wiring it means
  a login route, middleware, role guards on the mutating routes, and threading
  the real actor into every `actorId` — a change that touches every route, not
  a switch to flip.
- **A flag-delivery adapter used to run with no prompt.** Found while building
  the `agy` adapter: `CliAdapterRuntime` only ever wrote the prompt to stdin,
  and the CLIs that take it as a flag (`agy`, OpenClaw) ignore stdin. Fixed,
  with a test that spawns a real process and reads back the argv it was given.
  The lesson is the general one: a contract with two branches needs a test on
  the branch nobody uses yet.

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
