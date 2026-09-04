# Business Packs

What a trade adds to the company — the departments, the posts, the tools, the
routines, and the systems it talks to.

## Why packs exist

Every IronCrew installation is seeded with the same thirteen departments and
fourteen posts. That is a company, but it is not _your_ company: an MSP needs
a service desk and someone who watches backups; a web agency needs lead
qualification and SEO; neither needs the other's org chart.

A pack is that difference, expressed once and installed by key.

## What a pack is — and is not

A pack is **code in this repository**, reviewed like code. There is no remote
pack source, no download, no publisher. `crew_marketplaces` already covers
"fetch something from elsewhere and run it" and carries its own threat model
(T-12); a second such surface would double the attack surface for a feature
nobody asked for.

Not to be confused with `server/packs/` — those are _workflow_ packs inherited
from upstream: multi-phase pipelines with gates. Business packs live in
`server/ironcrew/packs/`. Two concepts, two words, two directories.

## The three rules

**1. Reuse, never overwrite.** Every object is matched by key first. A
department you already have is used as it stands; a post whose key is taken is
left alone. A pack adds what is missing — it does not redefine what your
company already decided.

**2. Register, never grant.** A pack's tools land in `crew_tools` so they _can_
be granted. `ToolStore.resolve()` still fails closed until an owner grants them
(`docs/TOOLS.md`). A pack that granted its own tools would be a pack deciding
what agents may do, and that decision is the owner's — the same reason
`may_approve` is a literal `false`.

**3. Suggest, never start.** Routines install **disabled**. A pack that began
firing routines the moment it was installed would spend your money on work you
have not read yet. Enabling one is a decision, and it is one click.

## Uninstalling is not the mirror image

Objects acquire history, so removal is precise rather than symmetrical:

| Object     | On uninstall                        | Why                                                                                                                                                     |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routine    | deleted                             | It holds a schedule and a pointer to its last task. Nothing is lost.                                                                                    |
| Tool       | **disabled, never deleted**         | Deleting would orphan every grant an owner made — the same reason `syncMcpTools` disables a vanished MCP server.                                        |
| Post       | deleted **only if it never worked** | No task, no run, no grant. Otherwise it stays: `ON DELETE SET NULL` would quietly turn "Keel did this" into "somebody did this" across the whole board. |
| Department | deleted **only if empty**           |                                                                                                                                                         |

What stayed behind is part of the answer, not an afterthought. A remover that
silently leaves things behind is worse than one that says so; a remover that
silently destroys history is worse than both.

An object created before any pack existed is never claimed and never removed:
`crew_pack_objects` is a receipt of what _this installation_ created, and
uninstall reads the receipt rather than re-deriving from the current
definition. A definition is code, and code changes.

## The packs

### `msp` — MSP / IT operations

Service desk, Linux and virtualisation, Windows/AD/M365, network, backup and
monitoring.

- **New department:** `service-desk`. The other four posts sit in the seeded
  `infrastructure` department, which already reads "Proxmox, Windows, Linux,
  Netzwerk, M365, Betrieb".
- **Posts:** Relay (service desk), Pylon (Linux/virtualisation), Bastion
  (Windows/AD/M365), Lattice (network), Vigil (backup and monitoring).
- **Tools:** `proxmox.inventory`, `proxmox.backup-status`, `rmm.agents`,
  `rmm.alerts`, `rmm.patch-status`, `unifi.devices`, `unifi.clients` — all
  risk class `read`.
- **Routines:** morning alert triage (daily), backup verification (weekly),
  patch and EOL review (monthly).
- **Integrations:** Proxmox VE, Tactical RMM, UniFi Network.

**On Tier 0.** This pack ships no domain-admin automation, and that is
deliberate. An RMM key that can run a script can run it on every managed
endpoint at once; a domain admin credential in an agent's hands has undone the
customer's entire security model. Every tool here only looks. Bastion — the
post whose subject matter _is_ Tier 0 — carries the lowest risk ceiling in the
pack.

### `web-agency` — web agency

Lead qualification, proposals, SEO, site delivery.

- **New departments:** none. Leads and proposals are `sales`, SEO is
  `marketing`, delivery is `engineering` — the seeded org chart is an agency's
  org chart.
- **Posts:** Kestrel (leads), Quill (proposals), Crest (SEO), Mason (delivery).
- **Tools:** none new. `web.search`, `browser.read` and `browser.interact` are
  already built in.
- **Integrations:** none.
- **Routines:** weekly site and SEO check, daily lead follow-up sweep — the
  follow-up drafts, it does not send.

Search Console, Analytics, uptime monitoring and a CRM were considered and
left out. An integration without an adapter is a settings entry that can never
turn green.

### `finance-de` — finance (Germany)

Incoming invoice checks, receivables, receipt matching, cash forecast, VAT
return preparation.

- **Posts:** Assay (incoming invoices, §14 UStG), Recoup (receivables and
  dunning drafts), Tally (receipt matching), Tide (cash forecast), Levy (UStVA
  preparation).
- **Tools:** `lexware.vouchers`, `lexware.invoice` — read.
- **Integration:** Lexware Office.
- **Routines:** open items daily, receipt matching monthly, UStVA quarterly.

**Nothing here books, pays or files.** `POST /v1/invoices?finalize=true` would
produce a _legal_ document in your books — gap-free number, tax statement, a
place in the GoBD trail you are liable for, undeletable except by a further
cancelling document. The roadmap's payment approval queue is an approval queue
precisely because the decision is the owner's (T-01). UStVA preparation is
preparation for your Steuerberater, not tax advice.

### `legal-de` — contracts and deadlines

- **Posts:** Vellum (contract analysis and risk matrix), Prism (clause
  comparison), Sundial (deadlines and notice periods).
- **Tools:** none. **Integrations:** none.
- **Routine:** weekly deadline sweep with a 90-day look-ahead — notice periods
  run in months, so the horizon is what prevents a missed deadline, not the
  frequency.

The honest answer here was "no new tools": contracts already arrive through
attachments, prior agreements live in memory, and the built-ins cover reading
both. Not legal advice; contract text is untrusted input, and an instruction
found inside a PDF gets quoted, never followed.

### `knowledge` — documents and archive

- **Posts:** Cairn (archivist — proposes filing, deletes nothing), Quarry
  (researcher — cites document, date and location, and says "not found"
  instead of filling in from general knowledge).
- **Tools:** `paperless.search`, `nextcloud.browse` — read.
- **Integrations:** Paperless-ngx, Nextcloud. Obsidian is **not** an
  integration here: it already exists as a MemoryProvider
  (`OBSIDIAN_VAULT_PATH`). Two switches for one feature is two places to look
  when it is off.
- **Routine:** weekly sweep for unfiled documents.

Every document this pack reads is untrusted content.

## Integrations

All six are **read-only**, and none of them is loaded unless its environment
variables are set.

| Integration    | Environment                                                 | Adapter                          |
| -------------- | ----------------------------------------------------------- | -------------------------------- |
| Proxmox VE     | `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET`   | `integrations/proxmox.ts`        |
| Tactical RMM   | `TACTICAL_RMM_URL`, `TACTICAL_RMM_API_KEY`                  | `integrations/tactical-rmm.ts`   |
| UniFi Network  | `UNIFI_URL`, `UNIFI_API_KEY`, `UNIFI_SITE` (optional)       | `integrations/unifi.ts`          |
| Lexware Office | `LEXWARE_OFFICE_API_KEY`, `LEXWARE_OFFICE_URL` (optional)   | `integrations/lexware-office.ts` |
| Paperless-ngx  | `PAPERLESS_URL`, `PAPERLESS_TOKEN`                          | `integrations/paperless-ngx.ts`  |
| Nextcloud      | `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD` | `integrations/nextcloud.ts`      |

### No fake buttons

The roadmap's line for this phase is "every integration ships behind a feature
flag as a real adapter — no fake buttons". That is only true if three lists
agree: what the packs declare, what adapters exist, and what the composition
root registers.

- `catalog.test.ts` asserts the first two agree, and that every declared
  integration names at least one required environment variable — an
  integration with no env would be one that is always "on", which is the one
  thing a feature flag must never be.
- The third is visible at runtime: `GET /api/crew/packs` reports
  `configured: true` only when `server-main.ts` actually constructed an
  adapter, which happens only when the variables are set. The Command Center
  then shows _which_ variables are missing instead of a switch that fails when
  pressed.

### What "read-only" buys, and what it does not

Read-only is not a comment; it is the absence of the methods. None of these
adapters has a create, update or delete path, and several tests assert the
prototype surface to keep it that way. A prompt injection that reaches one of
these adapters can read what the credential can read — that is the residual
risk, and it is why the tool registry classes them all `read` and why an owner
still has to grant them per agent.

What it does **not** buy: a read-only credential is still a credential. A
Proxmox token that can list every guest tells an attacker your entire estate.
Scope the tokens at the vendor's end — a Proxmox `PVEAuditor` role, an RMM key
with only the permissions its role needs — and put them in a vault rather than
in the environment where you can (`docs/IDENTITY.md`, `mcp-secrets.ts` for the
same argument applied to MCP).

### Verified against the vendors' docs, not against live systems

Each adapter is written against the vendor's published API, and its tests
assert the request it builds and the mapping it performs — a wrong URL or a
dropped auth header fails a test. **None has been run against a live instance
from this repository.** That is the same honest limit the CLI adapters carry
(`docs/PROVIDER_AUTH.md`), and `testConnection()` is what an operator runs on
day one to find out. The Command Center's "Verbindung prüfen" button is that
call.

Two findings worth repeating from building them:

- **Lexware Office moved.** `api.lexoffice.io` was retired in December 2025;
  the adapter defaults to `api.lexware.io`, and a test pins that so nobody
  restores the dead host. Its rate limit is 2 requests per second across all
  endpoints, and its documented 403 body echoes the `Authorization` header
  back — which is why no adapter here ever puts a response body into an error
  message.
- **Tactical RMM's alert list is a `PATCH`.** The filter travels in the body.
  It looks like a write and is not; the adapter says so at length, because the
  next reader will otherwise "fix" it.

## Using them

```
GET  /api/crew/packs                                  the catalogue + what is configured
GET  /api/crew/packs/:key                             the full definition, before installing
POST /api/crew/packs/:key/install                     owner only
POST /api/crew/packs/:key/uninstall                   owner only
POST /api/crew/packs/:key/integrations/:key/test      probe one integration
```

In the Command Center: **Gewerke** in the top bar.

Installing changes the org chart, hires posts and registers tools, so it is an
owner's decision — the same line drawn around everything that hands out
authority (`docs/IDENTITY.md`).

## Adding a pack

1. Write `server/ironcrew/packs/definitions/<key>.ts` with
   `defineBusinessPack({...})`. The schema is strict; an agent naming a
   department nothing defines fails at import.
2. Add it to `BUSINESS_PACKS` in `catalog.ts`.
3. If it needs a new integration: write the adapter in `integrations/`,
   add its key to `INTEGRATION_ADAPTERS`, and register it behind its
   environment variables in `server-main.ts`. Skip any of those three and a
   test fails — which is the point.
