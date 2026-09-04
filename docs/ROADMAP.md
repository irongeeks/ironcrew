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

- **Identity — shipped** (`docs/IDENTITY.md`, T-19). Accounts, three roles,
  expiring revocable sessions, a login gate in the Command Center, and a real
  `usr_…` in the audit log instead of the constant `"ceo"`. An installation
  with no accounts still works exactly as before: the switch happens when the
  first account is created, checked per request rather than at startup, so
  updating changes nothing until an operator decides it should.

  What is deliberately not in it: no SSO, no per-object permissions, and no
  second factor. Each would be a dependency or a permission system in its own
  right, and none of the three is what a self-hosted single-operator install
  is missing today.

- **A flag-delivery adapter used to run with no prompt.** Found while building
  the `agy` adapter: `CliAdapterRuntime` only ever wrote the prompt to stdin,
  and the CLIs that take it as a flag (`agy`, OpenClaw) ignore stdin. Fixed,
  with a test that spawns a real process and reads back the argv it was given.
  The lesson is the general one: a contract with two branches needs a test on
  the branch nobody uses yet.

## Phase 4 — Business packs

Shipped (`docs/BUSINESS_PACKS.md`). Five packs, seven read-only integrations,
and a pack framework whose three rules are the interesting part: reuse never
overwrites, registering is not granting, and a routine does not start itself.

- **MSP / IT Operations** — a service desk plus Linux/virtualisation,
  Windows/AD/M365, network, and backup/monitoring posts; Proxmox VE, Tactical
  RMM and UniFi as read-only adapters.
- **Web Agency** — leads, proposals, SEO, delivery. No new tools and no
  integrations, and the pack says so: `web.search` and the browser tools are
  already built in.
- **Finance (DE)** — incoming invoices, receivables, receipt matching, cash
  forecast, UStVA preparation; Lexware Office **or** sevDesk, both read-only.
  A German small business keeps its books in one or the other, essentially
  never both, and which one was decided long before IronCrew arrived — so the
  pack declares both and the environment decides which adapter is built. The
  two are deliberately not merged behind one abstract `bookkeeping.invoice`
  key: a grant against "whichever system happens to be configured" would change
  meaning on the day of a migration, when both tenants are briefly live.
- **Legal (DE)** — contract analysis, clause comparison, deadlines. No tools,
  no integrations: contracts already arrive through attachments.
- **Knowledge** — archivist and researcher; Paperless-ngx and Nextcloud
  read-only, with Obsidian already present as a MemoryProvider.

"Every integration ships behind a feature flag as a real adapter. No fake
buttons." That is now a test, not a promise: `catalog.test.ts` asserts that
every integration a pack declares has an adapter module and names at least one
required environment variable, and `GET /api/crew/packs` reports an
integration as configured only when the composition root actually built its
adapter.

What Phase 4 deliberately does **not** contain, and why:

- **No write path anywhere.** No VM restart, no password reset, no patch push,
  no invoice creation, no payment. Each is a credential whose blast radius is
  the whole estate or the company's own books; a write belongs behind an
  approval, not behind an environment variable (T-20).
- **No Tier-0 automation, no jumphost orchestration.** The MSP pack ships
  findings and prepared changes. Handing an agent domain-admin credentials
  would undo the customer's security model, which is the thing an MSP is paid
  to protect.
- **No M365/Entra or Drive adapter.** Both are large OAuth surfaces rather
  than an API key, and an OAuth app registration is a decision an operator
  makes once with consequences — worth its own piece of work rather than an
  eighth adapter written the same afternoon.
- **Not verified against live systems.** Every adapter is written against the
  vendor's published API with tests over the request it builds; none has run
  against a real Proxmox cluster or Lexware tenant from this repository. Same
  honest limit as the CLI adapters; `testConnection()` is the day-one check.

## Phase 5 — Production hardening — **shipped**

- **Multiple human reviewers.** `crew_approval_reviews`, one row per person
  per approval, with the quorum on the approval it guards rather than in a
  settings page — a company-wide two-person rule makes every routine approval
  wait for somebody with nothing to add and gets switched off within a
  fortnight, including for the payment. `UNIQUE (approval_id, reviewer_id)`
  makes four eyes structurally four eyes. N to proceed, one to stop.
  (docs/IDENTITY.md, THREAT_MODEL T-21.)
- **Authentik OIDC beside the password login.** Authorization Code with PKCE
  against a generic issuer; ID tokens verified against the issuer's JWKS with
  `none` and `HS*` refused by construction. An unlinked subject fails closed.
  The password login stays, because the day the directory is down is the day
  somebody has to sign in and fix it. (docs/IDENTITY.md.)
- **External audit-log shipping.** A file or HTTP sink, drained every 60
  seconds, cursor advancing only over entries the sink accepted and a partial
  acceptance always a prefix. The chain proves nobody edited the record; only
  the off-box copy survives somebody deleting it. (docs/AUDIT_SHIPPING.md.)
- **Backup and restore, tested.** `scripts/ironcrew-backup.mjs`, `VACUUM INTO`
  snapshot. (docs/BACKUP.md.)
- **Load testing.** `scripts/ironcrew-load-test.mjs` — real domain layer, real
  file, real concurrent writers, non-zero exit only for a broken invariant and
  never for a slow percentile. It found the dashboard re-hashing the whole
  audit chain on every poll, now fixed.
- **Upgrade and migration strategy.** `scripts/ironcrew-migrate.mjs` plus
  docs/UPGRADE.md, whose "known gaps" section names where the documented path
  is not yet backed by code.
- **Security review** over the whole diff.

### Multi-company — **not done, and not "just turn it on"**

The schema carries `company_id` on the domain tables, which made this look
like a configuration change. It is not, and the reason is worth writing down
so nobody re-reaches the optimistic conclusion:

- **109 statements in `domain/` select or update by `WHERE id = ?` alone.**
  They are safe today because one company exists. With two, any of them will
  happily act on another company's row when handed its id.
- The scoping that does exist lives in the layers above, as hand-written
  comparisons after the read. That is a convention, and a convention is
  exactly what a new store method forgets.
- **`crew_users`, `crew_sessions`, `crew_tool_grants` and
  `crew_oidc_identities` have no `company_id` at all.** Accounts, sessions,
  tool grants and directory identities are installation-wide by construction.
  Multi-company would have to decide whether a person belongs to a company or
  to the box, and every answer changes the identity model.
- `decideApproval`, `acceptReview`, `requestRevision` and `ToolStore.grant`
  reach caller-supplied ids with no company check.

Doing this properly means the company predicate becomes structural — in the
query builder or the schema, not in the callers — and that is a change to
every store. Worth doing before a second company exists, never after.

### PostgreSQL — **no, and the number says why**

This one is not close, and the obstacle is not the SQL dialect:

- **1,501 synchronous `prepare(...).run/get/all` call sites**, 327
  `DatabaseSync` annotations, 222 files importing `node:sqlite`.
- Every store method is synchronous, and so is every caller — the
  orchestrator, the scheduler, the route handlers. There is no mainstream
  synchronous PostgreSQL driver for Node, so an adapter means making all 1,501
  sites `async` and colouring every function above them.
- The atomic task claim, the audit chain's read-then-insert, and the
  single-connection transaction discipline are all correct _because_ there is
  one synchronous connection. Each would need re-proving under a connection
  pool.
- 149 uses of `unixepoch()`, 62 `PRAGMA`s, 12 `AUTOINCREMENT`s and the
  `VACUUM INTO` backup would each need a translation.

The honest position: this is a rewrite of the persistence layer wearing the
word "adapter". A self-hosted single-operator box does not need it, and the
load test says why — 400 tasks, 511 runs and 5,420 audit entries in 5 MiB,
with the claim path at 1 ms p50 under four concurrent writers. SQLite is not
the thing that will fall over first. Revisit if and only if multi-company
lands and a real installation outgrows one file.

## Deliberately not planned

- Gamified XP mechanics
- Agents modifying their own core code
- Promotion based on an LLM's self-assessment
- Any Chinese-vendor model, SDK, marketplace or telemetry service
- Automatic connection to the OneManCompany Talent Market
- Automatic download of unvetted community agents or skills
