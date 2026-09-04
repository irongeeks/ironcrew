# Threat Model

Scope: a self-hosted, local-first IronCrew run by a single owner (the
CEO) on Linux or macOS, orchestrating AI agents that hold real credentials and
can touch real systems.

## Trust boundaries

```text
  Owner (CEO)  ── browser ──►  Control Plane  ──►  Runner  ──►  CLI runtime / API
                                    │                 │
                                    ▼                 ▼
                                 SQLite          Workspace, secrets
```

1. **Browser ↔ control plane.** Session cookie or bearer token, CSRF, security
   headers, rate limiting (inherited from upstream, `server/security/`).
2. **Control plane ↔ runner.** The runner holds credentials; the control plane
   must not.
3. **Runner ↔ external world.** The highest-risk boundary: an agent with tools
   can read files, run commands and reach the network.
4. **Agent output ↔ everything else.** Agent output is untrusted data, not
   instruction.

## Findings and mitigations

### T-01 — Unbounded CLI capability (upstream, fixed) — **Critical**

Upstream OctoOffice hardcoded `--dangerously-skip-permissions` (Claude Code)
and `--yolo` (Codex, Gemini) into _every_ invocation, on both spawn paths. Any
prompt injection, any confused agent, any mis-scoped task therefore ran with an
unbounded capability surface. The upstream tests asserted these flags as
required, so the behaviour was locked in.

**Mitigation.** `server/ironcrew/policy/runtime-permissions.ts`. Three modes;
`restricted` is the default. `elevated` requires a `SandboxGrant` that names the
`ApprovalRequest` it came from, is scoped to a company, runtime and optionally a
single task, and is hard-capped at 4 hours regardless of its stated expiry.
`resolvePermissionMode()` fails **closed** — an invalid, expired or mis-scoped
grant silently degrades to `restricted` rather than raising an error a caller
might swallow. `assertArgsMatchMode()` runs immediately before `spawn()` and
rejects argv carrying a bypass flag the resolved mode does not authorise,
covering hand-assembled argv.

_Residual risk:_ **elevation is not reachable in production at all**, and the
missing half is the writing one. The read side is wired: `executeNextTask()`
looks up a live grant with `SandboxGrantStore.findLive()` and resolves the mode
through `resolvePermissionMode()`, auditing the result. But nothing ever mints a
grant — `mintFromApproval()` has no callers outside its own tests, no code path
creates an approval of type `sandbox_elevation`, and there is no route by which
an owner could raise one. `findLive()` therefore always returns nothing and every
dispatch resolves `restricted`. That is the safe direction, and it is the mode
the system would fall back to anyway, but it means the elevation path is
untested by use rather than merely unused. Tracked in
`IMPLEMENTATION_STATUS.md`.

### T-02 — Prompt injection escalating privilege — **High**

Content an agent reads (a web page, a customer email, a repository file) may
contain instructions. If persona or role text could grant capability, injected
text could too.

**Mitigation.** Capability lives only in `policy_json`, never in persona or
prompt text. A character pack may override five cosmetic fields and nothing
else; `applyCharacterPack()` throws on any attempt to reach policy, tools, role
or forbidden traits. Tool access is deny-by-default against an allowlist. The
generated prompt states policy _after_ persona and declares it overriding.
High-risk actions are gated by the approval engine, which is enforced in code
rather than by asking the model nicely.

_Residual risk:_ an agent can still produce misleading text for the CEO to read.
The mitigation is that the agent cannot _act_ on it without a gate.

### T-03 — Two workers doing the same task — **High**

Upstream claimed tasks with an unguarded `UPDATE ... WHERE id = ?` and relied on
in-process `Map`/`Set` state for mutual exclusion. Correct only while exactly
one process exists — not across a restart, a crash, or a second worker. Double
execution of a task that sends an email or touches production is a real-world
incident, not just wasted tokens.

**Mitigation.** `TaskStore.claim()` is a compare-and-set carrying the observed
`status_version` and the lock predicate in the `WHERE` clause, verified by
`changes === 1`. Locks are released and recovered only while naming the owning
run, so a late reaper cannot clear a fresh owner's lock. Covered by a 25-way
concurrent claim test and an explicit late-reaper regression test.

### T-04 — Credential disclosure through logs and events — **High**

Agent stdout, tool output, error messages and event payloads all flow into the
database, the websocket and the UI. A single leaked key in a log line is a
compromise.

**Mitigation.** `server/ironcrew/security/redaction.ts`, applied on the way
_into_ storage rather than on the way out, so a database dump cannot become a
credential dump. Redaction is pattern-based rather than value-based, because
matching only known values misses exactly the credentials the process never
loads. `StreamRedactor` handles the case a naive per-chunk regex gets wrong: a
secret split across two stdout chunks.

_Residual risk:_ a novel credential format with no distinctive shape, embedded
in text, is not detectable by pattern. Known values are redacted additionally
when available.

### T-05 — Credential theft from the control plane — **High**

Mounting the owner's home directory into a container to give an agent its CLI
logins would expose SSH keys, browser profiles and every other credential.

**Mitigation (design).** The runner abstraction keeps CLI logins with the OS
user that owns them; the control plane receives capabilities and status, never
tokens. `authStatus()` returns booleans and a non-identifying account hint by
contract. Only `SecretRef` values are stored in the database — never plaintext.

_Residual risk:_ the native runner daemon is not implemented yet
(`IMPLEMENTATION_STATUS.md`). Today the control plane and the runtime share a
process, so this boundary is a design commitment rather than an enforced one.

### T-06 — Undetected tampering with the record — **Medium**

A local-first product stores everything in one SQLite file the owner can edit.
Perfect integrity is not achievable; _detection_ is.

**Mitigation.** `crew_audit_events` is append-only (the module exposes no update
or delete) and hash-chained per company over canonical JSON. `verifyAuditChain()`
locates the first broken link and distinguishes a tampered entry from a deleted
one. Every governance decision — approvals, budget blocks, claims, transitions,
elevation — writes an entry.

_Residual risk:_ an attacker with write access to the database file can rewrite
the entire chain from scratch. Off-box audit shipping would close this and is
out of MVP scope.

### T-07 — Unwanted vendor exposure — **Medium**

Company policy forbids Chinese-vendor models, SDKs and telemetry. A UI filter
is not a control: the API, a config edit, or an OpenRouter fallback would
bypass it.

**Mitigation.** `server/ironcrew/policy/vendor-policy.ts` is enforced in the
backend and is the only place that answers "may I use this model?". Deny by
default; the blocklist always wins over the allowlist, so widening
`allowed_families` cannot re-enable a blocked vendor. Matching normalises the
id and also checks the resolved upstream provider, so re-hosted aliases
(`openai/deepseek-v3-distill`, an allowed model routed through a blocked host)
are caught. OpenRouter requests pin `only`/`order` to allowed providers and set
`allow_fallbacks: false`. Talent-market and WeChat endpoints are blocked.
Telemetry is off.

### T-08 — Budget exhaustion — **Medium**

A looping agent can burn a month's budget in an hour.

**Mitigation.** Two enforcement points: `assertRunPermitted()` before dispatch
and re-evaluation after each cost event, with the strictest covering scope
winning. Spend is INTEGER micros, so accumulation does not drift. Subscription
runtimes record quota events with `cost_micros = 0` rather than an invented
figure.

_Residual risk:_ a single very expensive request can overshoot a limit, since
cost is known only after the fact. Per-request estimation is future work.

### T-09 — SSRF and egress abuse — **Medium**

Inherited from upstream (`server/security/ssrf.ts`, `safe-fetch.ts`), plus the
vendor policy's blocked-endpoint list. A full egress allowlist for the runner
is Phase 3.

### T-10 — Incoming mail acting as the owner — **High**

Anyone can send the company an email. If that text reached the CEO message
path, a stranger could delegate work, trigger approvals, and speak with the
owner's authority — the same escalation as T-02, but reachable by anyone who
knows an address.

**Mitigation.** Triaged mail is never routed through `handleCeoMessage()`.
It becomes a task with `status: "inbox"` — never `ready`, so it does not enter
the claimable queue and no agent picks it up on its own — with the body quoted
under an explicit third-party marker and `createdBy: "mailbox:<id>"`. The EA's
`triage()` is used purely as a classifier for risk level and sensitivity,
never as an instruction interpreter. Covered by orchestrator tests asserting
both that the status is `inbox` and that delegation-shaped wording produces no
runs.

Since a task description is not inert — it becomes the `# Aufgabe` section of
an agent's prompt when the task is run — every attacker-reachable field also
goes through `server/ironcrew/policy/untrusted-content.ts` on the way in:

- **Chat-template control tokens are stripped.** `<|im_start|>`,
  `<|start_header_id|>`, `<start_of_turn>`, `[INST]`, `<<SYS>>` and a line
  beginning `Human:` are forged turn boundaries, not text. Ordinary prose
  containing the same words is left alone; a sentence about a "Human: Readable
  Export" survives intact.
- **Invisible characters are removed** — zero-width marks, bidi overrides, C0/C1
  controls. These let a payload be present for the model and absent for the
  human reading the same mail, and the same override turns an attachment named
  `invoice<RLO>fdp.exe` into something that reads as `invoice.pdf`, which is why
  filenames are sanitised in `attachment-store.ts` too.
- **The body is fenced** between `<<<EXTERNAL_UNTRUSTED_CONTENT …` and
  `END_EXTERNAL_UNTRUSTED_CONTENT>>>`, naming the sender and stating that the
  contents are data. The fence is **unforgeable**: markers occurring inside the
  content are removed before wrapping, so content cannot close its own fence
  and continue as trusted text. Two tests assert exactly that attack.
- **Subject and sender are flattened to one sanitised line**, so neither can
  introduce header lines of its own into the block it sits among.
- A mail that needed sanitising is audited as `mail.sanitized` with a count —
  never the offending text, which would put the payload into the log meant to
  be kept clean of it — and the task itself says so, so an operator sees that
  someone tried.

_Residual risk:_ fencing is not obedience. A model can still be talked into
following instructions inside a boundary it can see; what the fence guarantees
is that the model sees an accurate picture — attacker text inside a boundary it
could not break — rather than attacker text wearing the conversation's own
syntax. The defences that actually hold are the structural ones above. And a
task in the inbox still displays attacker-authored text to the owner: it is
quoted, sanitised and attributed, but social engineering against a human reader
is outside what a state machine can prevent.

### T-11 — Mailbox credentials in the database — **Medium** (accepted trade-off)

Mailbox credentials are stored encrypted (AES-256-GCM, keyed from
`OAUTH_ENCRYPTION_SECRET`) rather than as a `SecretRef` into a password
manager. This is a deliberate departure from "secrets in the database:
references only", chosen so a mailbox can be connected without requiring
Vaultwarden or Proton Pass, and so OAuth refresh tokens can be rotated
automatically.

**What it costs.** Anyone holding both the database file and the encryption
key can read mailbox credentials. On a single-owner, local-first host that is
the same person who can read the mailbox anyway; on a shared or backed-up
host it is a real exposure, and backups of `ironcrew.sqlite` (or
`octooffice.sqlite`, on an installation older than the rename) must be treated
as credential material.

**What limits it.** `MailboxRow` omits the credentials column entirely and
every query names its columns explicitly, so a mailbox row cannot be
serialised into a response with its password attached — the value is never in
the object. Decryption happens in exactly one place
(`CompanyOrchestrator#mailContext`), so plaintext never outlives the call that
needed it. Audit entries for mail carry recipient and subject, never bodies or
credentials. See `docs/MAIL.md`.

### T-12 — Installing someone else's code from a marketplace — **High**

A marketplace entry names a command IronCrew would spawn, or content it would
write. A catalog is third-party JSON that can change between two page loads;
treating it as trusted would be remote code execution by design.

**Mitigation.** Four checks in `marketplace-installer.ts`, the single point
where catalog data meets the disk:

1. A launcher allowlist (`npx`, `uvx`, `node`, `python`, …). Anything else is
   refused with the command named. Adding a server by hand through the MCP
   settings route is unaffected — that is the owner's decision about their own
   machine; a stranger's catalog is not.
2. `McpServerConfigSchema`, the same validation the hand-add route runs:
   shell metacharacters rejected, metadata endpoints blocked.
3. Installing a skill executes nothing — the Markdown is fetched and written;
   the source repository is not cloned, installed or run.
4. Path containment on the skill directory, plus the 512 KB content cap.

Installs are recorded with the manifest as served, so what the owner approved
stays readable after the source changes. Marketplace servers are registered
with `autoConnect: false`: the owner decides when a stranger's server first
runs, not the install click. Every source fetch goes through `safeFetch`
(T-09), so a mistyped URL cannot reach a metadata endpoint.

_Residual risk:_ an allowed launcher can still fetch and run arbitrary code
(`npx` installs from npm). The allowlist bounds _how_ a server starts, not
what the package it names then does — running third-party MCP servers is a
trust decision the owner makes, and the exact command is shown in the UI
before installing so it is made knowingly.

### T-13 — Inbound chat as an unauthenticated ingress — **High**

The messenger integration adds a new ingress, and an ingress without an
identity check is an open door. A Telegram bot token or a Discord channel id
is not a secret in any meaningful sense: anyone who finds the bot can message
it, and message text arriving over chat looks exactly like message text
arriving from the owner. This is T-10 again, reachable by anyone who can find
a bot rather than anyone who knows an address.

**Mitigation.** Deny by default, decided by a human who can see who is asking:

- Every inbound message is resolved to a row in `crew_messenger_pairings`
  before anything else happens. No row, no access — the same posture the
  mailbox grants take.
- An unknown sender produces a `pending` row and a six-digit code, and that
  code is the only thing they get back. No task, no EA turn, nothing routed.
  The owner accepts the request in the Command Center, where the sender's
  (sanitised) display name and channel are visible next to the decision.
- The code is short-lived, cleared on accept, and absent from the audit entry
  that records the request. It proves nothing on its own; it is a handle for
  pointing at the right stranger.
- A blocked sender gets nothing at all — not even the courtesy of knowing they
  are blocked, which would only tell them to try from another account.
- **Control tokens are stripped at the channel boundary**, inside `poll()`,
  before an `InboundMessage` reaches any caller — so a channel that forgot the
  strip would be indistinguishable from one that did it, from the outside.
- Anything that is not the owner is **fenced**: a guest message becomes an
  `inbox` task with the body wrapped by `wrapUntrusted()` naming its sender,
  classified by `triage()` as a classifier and never as an instruction
  interpreter (T-10).
- Identity is matched on the provider's `senderId`, never on `senderName`,
  which the sender chooses and can change at will.
- Every message is recorded in `crew_external_events` before it is acted on,
  so a redelivery — which both providers can produce — is recognised rather
  than answered twice.

_Residual risk:_ the same one T-10 carries. A pending pairing request shows
attacker-chosen display text to the owner; it is sanitised, flattened and
attributed, but social engineering against a human reader is outside what a
state machine can prevent. And polling is pulled rather than pushed, so an
unpolled channel is silent rather than queued — a gap in availability, not in
authorisation.

### T-14 — Granting owner authority over a chat app — **High**

Role `owner` on a pairing reaches `handleCeoMessage()`, which treats its text
as the owner speaking and can delegate work immediately. That is the feature —
it is how the owner talks to their own EA from a phone — and it is also the
risk: a compromised, borrowed or handed-over phone becomes CEO access to the
company, with no further gate between a chat message and delegated work.

**Mitigation.** The grant is a deliberate, visible, reversible act:

- It is **only ever granted by the owner** in the Command Center, on a pending
  request they can see, and never earned by a first message.
- `role` is a column with a `CHECK` constraint, not a branch someone has to
  remember — an operator can look at who holds CEO authority rather than
  reconstruct it.
- Every grant, revoke and block is a **distinct audited action**:
  `messenger.owner_granted` is not the same entry as
  `messenger.pairing_accepted`, and `messenger.pairing_revoked` (which records
  the `previousRole` it took away) is not the same entry as
  `messenger.pairing_blocked`. "I do not want to hear from this person" and
  "this person may no longer speak for me" are different statements and stay
  distinguishable in the log.
- **Unblocking returns a pairing to `pending`, never to what it was.**
  Un-refusing a sender is a different decision from re-granting them CEO
  authority, and the second must never ride along with the first: the owner
  accepts again, choosing the role again.
- Nothing else can promote a pairing. Accepting a blocked row is refused
  (409) rather than silently unblocking it.

_Residual risk:_ once granted, the authority is as good as the owner's own,
bounded only by what `handleCeoMessage()` can do and by every gate downstream
of it (approvals, budgets, permission modes). Chat-app account security is the
owner's, and a paired device is a credential — which is why the pairing list
in the Command Center is meant to be read occasionally, not set once.

### T-15 — An agent writing files directly — **High**

An agent that can write files can write any file: its own prompt, a CI
configuration, a deploy script, something outside the workspace entirely.
There is no useful middle ground between "may write" and "may not" unless
someone sees the write before it happens, which is why file-touching
capability otherwise stays switched off.

**Mitigation.** `change-proposal-store.ts` makes a write a proposal an owner
decides on. Four rules, each with an obvious failure in its absence:

1. **No approval, no apply.** `apply()` refuses unless the proposal is
   `approved`, and there is deliberately **no force flag** — a gate with a
   bypass is not a gate. The orchestrator re-reads the approval rather than
   trusting the proposal row, so a decision reversed or expired after the
   fact still stops the write.
2. **The expected hash must still match.** Every file carries the hash it had
   when proposed; a mismatch is refused, a `create` whose target now exists is
   refused, an `update` whose file is gone is refused. An approval granted
   against one state of the world does not describe what would happen in
   another.
3. **Path containment, re-checked at apply.** Absolute paths and `..` are
   refused, and the **real path of the containing directory** is resolved and
   re-tested against the real workspace root — which is what catches a
   symlinked directory that passes every string test and writes elsewhere.
4. **All or nothing.** Files are validated first and written second, so one
   conflicting file means nothing at all is written and the workspace is left
   exactly as it was. Applying an applied proposal is a no-op, so a retry
   cannot write twice.

The audit log records the whole lifecycle — created, approved, rejected,
applied, apply_failed, superseded — with paths and reasons, and **never file
contents**: an audit log is not a place to duplicate a repository.

_Residual risk:_ approval fatigue. A proposal touching forty files is approved
by reading a summary, and the owner's attention is the last check in the
chain. The contents are always one request away
(`GET /api/crew/change-proposals/:id`), and the approval summary deliberately
lists every path so the size of what is being approved cannot be hidden.

### T-16 — Background execution with no human present — **High**

Every other finding in this document assumes someone was there. Until the
scheduler existed, they were: a run happened because a person pressed a
button, so a mis-scoped task, a runaway loop or an injected instruction had a
witness within seconds.

The scheduler removes the witness. It drains the run queue every fifteen
seconds, polls mailboxes and chat channels on their own timers, and does so at
three in the morning as readily as at noon. **Anything that reaches the queue
runs, unattended.** That is the entire point of running IronCrew as a service,
and it means the question is no longer "who authorised this run" but "what can
reach the queue at all".

**Mitigation.** Four layers, each answering a different half of the question.

1. **Only delegated work is enqueued.** `enqueueRun()` has exactly four
   callers, all of them in `server/ironcrew/orchestrator/company.ts`, and each
   one traces back to something the owner set in motion:

   | caller                | `requestedBy`         | what put it there                    |
   | --------------------- | --------------------- | ------------------------------------ |
   | approval released     | the deciding owner    | the owner opened a gate              |
   | EA delegation         | the requesting human  | the owner asked the EA for something |
   | **a routine firing**  | `routine:<id>`        | a timer the owner created            |
   | revision requested    | the reviewing owner   | the owner sent work back             |

   External ingresses do not enqueue. Incoming mail (T-10) and a guest's chat
   message (T-13) become `inbox` tasks, which never enter the claimable queue
   — so a stranger's text cannot start a run while nobody is watching, no
   matter how it is phrased. The queue drains what the owner asked for; the
   inbox holds what the world sent.

   **The routine caller is the one that matters here**, and it deserves saying
   out loud rather than being counted quietly: it is the only caller with no
   human in the room at the moment it fires. A routine set to run daily fires
   at three in the morning as readily as at noon, which is precisely the
   condition this finding is about. Four things bound it:

   - **A routine is created by a signed-in person**, not by an agent and not by
     anything that arrives from outside. `POST /api/crew/routines` sits behind
     the same guard as every other mutation (operator or owner —
     `methodGuard`), and the instruction it will run is fixed at that moment.
     A routine cannot be authored by the work it produces.
   - **A pack's routines install disabled.** Rule 3 of the pack framework — "a
     pack suggests work, it does not start it" — is `enabled: false` in
     `pack-installer.ts`, so installing the MSP pack at 17:00 does not put a
     new unattended run on the queue overnight. Somebody has to switch each one
     on deliberately.
   - **A firing cannot double-fire.** `RoutineStore.claimDue()` advances
     `next_run_at` inside the same `UPDATE` that claims the row, guarded on the
     value it read (`WHERE id = ? AND enabled = 1 AND next_run_at = ?`). Two
     overlapping scheduler ticks cannot both take the same routine; the loser
     sees zero changed rows and does nothing. Same shape as the run queue's
     claim and the agent lock — the database decides, not a flag in memory.
   - **A sensitive routine is still parked behind an approval.** Its
     instruction goes through the same triage as a request typed into the chat,
     and a sensitive one becomes an `approval_required` task rather than a run
     request. A timer is not a way around the gate; see mitigation 2.

   What the routine caller does _not_ have is a second pair of eyes on the
   instruction between the moment it was written and each of the hundreds of
   times it fires. That is the residual risk of the feature, not a defect in
   it, and it is the reason a routine produces a **visible task** rather than
   performing an action directly (`docs/TOOLS.md`): every firing leaves a row
   on the board, an audit entry (`routine.fired`) and a cost record, so a
   misfiring routine is discoverable the next morning rather than only by the
   damage it did.
2. **Sensitive work is still gated by an approval.** Triage classifies before
   anything is queued, and a sensitive or high-risk request becomes an
   `approval_required` task rather than a run request. The gate is unchanged
   by the scheduler: no approval, no run, whether or not a person is at the
   console. Elevation is likewise unreachable without a `SandboxGrant` minted
   from an approved request and capped at four hours (T-01).
3. **The vessel caps time and concurrency.** An unattended run is bounded by
   `timeout_ms` — enforced as an `AbortSignal` the runtimes honour, with a
   ten-minute fallback so a run is never unbounded in time — and by
   `max_concurrency`, so a night of queued work cannot fan out into fifty
   simultaneous CLI sessions against one account
   (`docs/VESSELS_TALENTS.md`).
4. **The dead letter stops an infinite retry loop.** A request spends an
   attempt only when a run actually happened; enough failures and it becomes
   `dead` and waits for a human, rather than retrying a permanently broken
   task forever at full speed. Backoff between attempts is exponential and
   capped (`docs/RUN_QUEUE.md`).

The switch is documented rather than hidden: `IRONCREW_SCHEDULER=off` leaves a
server that answers HTTP and does nothing on its own, which is the right
posture for a second instance sharing one database
(`docs/SERVICE.md`).

_Residual risk:_ everything the owner legitimately delegates still runs
without a witness, and the audit log is read after the fact rather than
before. A task that was correctly authorised and turns out to be wrong will
have run by the time anyone looks. Time and concurrency bound the damage;
they do not prevent it. Lowering `IRONCREW_SCHEDULER_QUEUE_SECONDS` shortens
the window in which a human could intervene and raising it lengthens the
delay before legitimate work starts — there is no setting that gives both.

## Explicitly out of scope for the MVP

- Multi-user authorisation (single owner only; OIDC is Phase 5).
- Protecting the owner from themselves — the owner can edit configs and the
  database directly, by design in a local-first product.
- Defending against a compromised host OS.
- Supply-chain attacks on npm dependencies beyond the existing lockfile,
  `pnpm.overrides` and gitleaks configuration.

### T-17 — The control plane holding the owner's CLI logins — **High**

The official CLI runtimes authenticate as the owner. Claude Code, Codex and
the rest keep their credentials under `$HOME`, and a process that can run them
can read them.

Until the runner existed, that process was the control plane — the same one
that parses incoming mail, accepts chat messages from paired strangers,
installs skills from marketplaces and serves an HTTP API. Every one of those
is an ingress, and each is one bug away from the account that pays for the
models and can act as the owner elsewhere. It is also why
`deploy/ironcrew.service` has to move `HOME` to `/var/lib/ironcrew`: without
that, `ProtectHome=true` would leave the service with no usable home at all,
and the alternative (`ProtectHome=read-only`) would hand it every credential,
SSH key and browser profile on the machine.

**Mitigation.** The runner is a separate trust domain, not a separate module.

1. **Its own OS user, its own home, its own unit.** `ironcrew-runner` holds
   the CLI logins under `/var/lib/ironcrew-runner`. The control plane's
   account cannot read them — the operating system enforces that, not a
   convention in this codebase.
2. **The socket's permissions are the access control.** `0660`, owned by the
   runner user, group-shared with the service user. A localhost TCP port
   would be reachable by every process on the box, including anything an
   agent itself starts, which would make the separation decorative. The
   shared token is defence in depth and is compared in constant time.
3. **No token ever crosses the wire.** The protocol carries capabilities,
   health, `AuthStatus` and normalised events. `AuthStatus` is booleans and a
   non-identifying hint by contract, and the runner rebuilds it field by field
   before sending — so a future field that carried a secret would have to be
   added deliberately, in the one place that is about leaving the trust
   domain.
4. **The runner refuses a workspace outside its root**, checked with
   `realpath` rather than a string prefix. A runner that trusted the path it
   was handed would turn a bug in the control plane into arbitrary file
   access under the account that holds the credentials — which is the exact
   thing this entry exists to prevent, arriving by the back door.

**Residual risk.** The runner still executes whatever the control plane asks
it to, so a compromised control plane can still spend the owner's tokens and
run agent work. What it cannot do is _take_ the credentials. That is a real
reduction, not an elimination, and it is the honest description: the runner
bounds the blast radius, it does not remove the trust.

### T-18 — MCP credentials in the settings table — **High**

An MCP server is configured with an `env` (stdio) or `headers` (HTTP) map, and
in practice that is where its API key goes: a GitHub token, a Jira password, a
customer's API credential. Those configs live in the `settings` table as JSON.
A literal value there is a plaintext credential in the database — the exact
thing this document forbids everywhere else, arriving through a config form.

It cannot be fixed by resolving the reference in the control plane. That only
moves the plaintext from the database into the memory of the process that
parses mail, accepts chat messages and serves an HTTP API — the process T-17
exists to keep credential-free.

**Mitigation.**

1. **A value is either a literal or a reference.** `{"$secret": {"provider",
"itemRef", "field"}}` names where the secret lives. A reference is not
   sensitive: it may be stored, logged and shown in the UI.
2. **The runner resolves it, and the runner runs the server.** A config
   carrying references is started on the runner, as its own OS user, against
   its own vault session. `mcp-connect` sends the config with its references
   intact; the control plane receives tools and tool results
   (`docs/RUNNER_PROTOCOL.md`).
3. **Without a runner it is refused, by name.** The control-plane connector
   has no resolver, so it fails before starting anything, with a message
   naming `IRONCREW_RUNNER_SOCKET`. A config that silently started with a
   reference object stringified into an environment variable would surface
   hours later as an authentication error nobody could trace back.
4. **A failed resolution names the key and the vault item, never the value.**
   An error message is the one place a secret leaks without anyone noticing —
   it travels into logs, into the UI, and often into a bug report.
5. **The resolved values live as long as the connection.** A disconnected
   connector holding one is a leak waiting for a heap dump; stopping the
   daemon stops every MCP server it started.

**Residual risk.** The MCP server itself receives the credential — that is the
point of it — so a malicious or compromised MCP server still has what it was
given. What changes is that neither the database nor the control plane ever
holds it, and revoking the vault item is enough to end its access at the next
start. Servers configured with literals are unchanged and still run inline:
this bounds where credentials may live, it does not stop an operator from
pasting one in.

### T-19 — An audit log that names nobody — **Medium**

Every entry in `crew_audit_events` named the constant `"ceo"`, because that
was the only actor the system had. The chain was intact, the hashes verified,
and the log could still not answer the one question it exists for: who did
this. A log like that is worse than none, because it looks like
accountability while providing it only for the case where there is exactly one
person and they never dispute anything.

**Mitigation.**

1. **Accounts, roles and sessions**, wired to `/api/crew`
   (`docs/IDENTITY.md`). `actor_id` is a real `usr_…` for anything a
   signed-in person does.
2. **The constant survives only where it is true**: an installation with no
   accounts, and work with no person behind it (the scheduler, a routine, the
   messenger owner path). It is the honest answer there, not a placeholder.
3. **Approving stays the owner's alone** (T-01), and so does everything else
   that hands out authority — a vault secret, a tool grant, a chat pairing
   that reaches the CEO path. An operator runs the company; an owner decides
   what the company may do.
4. **Disabling an account ends its sessions now**, not at the end of a
   seven-day TTL: the session resolver re-reads the account on every request.

**Residual risk.** The pre-identity regime is a real gap for as long as an
installation stays in it: a shared password names nobody, and this change does
not force anyone out of it. What it does is make leaving it a two-minute job
and make the log say plainly which regime it was written under. There is also
no second factor: a stolen session cookie or password is full access at that
account's role until it is revoked.

### T-20 — A business pack's credentials — **High**

A business pack exists to talk to the systems a trade runs on, and those are
the systems that matter: an RMM that can execute on every managed endpoint, a
hypervisor that can stop every VM, the accounting system that holds the
company's books. Handing an agent any of those is handing a prompt injection
the same thing — and the injection arrives, reliably, in a scanned invoice or
a contract PDF (T-02).

**Mitigation.**

1. **Every shipped adapter is read-only, by construction rather than by
   convention.** There is no create, update or delete method to call; several
   adapters assert their own prototype surface in tests so a future addition
   is a deliberate act with a failing test in front of it. All pack tools are
   registered at risk class `read`.
2. **Presence is still not permission.** A pack registers its tools; it never
   grants them. `ToolStore.resolve()` fails closed until an owner grants a
   tool to an agent, a talent or a project (T-01, `docs/TOOLS.md`).
3. **Installing a pack is an owner's decision.** It hires posts, changes the
   org chart and registers tools — the same line drawn around everything that
   hands out authority (T-19).
4. **A routine never starts itself.** Pack routines install disabled, so
   nothing recurring begins until a human switches it on (T-16).
5. **No credential ever reaches a log or an error message.** Adapters build
   messages from status codes and hosts, never from response bodies — because
   Lexware Office's own documented 403 body echoes the `Authorization` header
   back, and that is not the only vendor that does. Each adapter has a test
   that drives every failure path and asserts the credential appears in none
   of them.
6. **The environment is the feature flag.** An adapter that was not configured
   is not constructed, so there is nothing to call and the API says so.

**Residual risk.** A read-only credential is still a credential: a Proxmox
token that can list every guest describes the whole estate to anyone who
obtains it, and an agent granted `rmm.agents` can read every customer's
inventory. Scope the tokens at the vendor's end (a `PVEAuditor` role, an RMM
key limited to its role) rather than relying on this side alone. And these
adapters live in the control plane's environment, not in a vault — the same
argument that moved MCP credentials to SecretRefs (T-18) applies here and has
not been made yet.

### T-21 — One compromised owner account decides everything — **High**

Identity (T-19) gave the installation accounts, roles and a name in the audit
log. It did not change how many people it takes to open a gate: one. Every
approval this system has ever raised — a sandbox elevation (T-01), a payment,
a Tier-0 change on a customer's network — was one click by one account. So
whoever holds that account holds every gate the product has, and there is no
step at which a second human would have noticed. The same single point applies
without an attacker: the one owner reads a summary wrong at 23:40, or is on
holiday when the decision cannot wait.

**Mitigation.**

1. **A quorum per approval, not per installation, and it only ever goes up.**
   `required_approvals` lives on the approval row. A company-wide two-person
   rule would make every routine approval wait for somebody with nothing to
   add, and would be switched off within a fortnight — including for the
   payment. The quorum is raised on the request that deserves it
   (`POST /approvals/:id/quorum`, owner only).

   Three refusals, and the first exists because a security review over this
   branch demonstrated its absence end to end: **a quorum cannot be lowered.**
   The threat here is one compromised owner account, so if that same account
   could send `{ required: 1 }` and then approve, the mitigation would cost an
   attacker exactly one extra request, and the chain would record it
   afterwards — detection, not prevention. It also cannot be changed once
   anybody has voted (that moves the goalposts under the people already
   counted), nor after the decision (that rewrites what the decision required,
   in the one place that must not be rewritable). Lowering a quorum set in
   error is deliberately not an API operation: the approval can be rejected
   and raised again, which leaves both acts in the chain where a silent
   correction would leave neither.

2. **Four eyes are structurally four eyes.** `crew_approval_reviews` carries
   `UNIQUE (approval_id, reviewer_id)`. A double submit, a retried request or
   a refreshed tab cannot satisfy a two-person rule alone — the database
   refuses it, and the API answers 409 rather than letting the second click
   through.
3. **Every path to a decision goes through the vote.** The same review found
   `decideChangeProposal` calling `approvals.decide()` directly, so an owner
   could demand four eyes on a deploy script, watch the panel confirm
   "0 von 2", approve alone and write the files — with the tally still
   reporting `outstanding: 2` afterwards. It now goes through `reviewApproval`
   like every other verdict. The rule this restates is T-15's: a gate with a
   bypass is not a gate, and a bypass justified by "this caller's own gate has
   already run" deserves the question _which_ gate — because here the answer
   was this one.
4. **One rejection is decisive, and needs no quorum of its own.** A reviewer
   who has spotted the wrong destination IBAN stops the payment immediately,
   whatever the approval count already stood at. Requiring agreement to act is
   prudence; requiring agreement to refrain is a defect, and would mean a
   dangerous change proceeding because the colleague who would have agreed was
   on holiday.
5. **The tally is recomputed, never latched.** There is no "quorum reached"
   flag, so a rejection arriving after the second approval blocks just as
   firmly as one arriving before it. No window exists in which the gate has
   been declared open and can no longer be shut.
6. **Each reviewer is named individually in the audit chain.** Every verdict
   appends with that person's own `usr_…`; `approval.quorum_reached` lists who
   agreed. An investigation can ask "who waved this through" and get people,
   not an account shared by a role.

**Residual risk.** Nothing raises the quorum automatically. An approval only
needs two people if somebody — or some future code path — asked for two, and
today that is a human pressing a button on the approval card. A rule such as
"every `bank_transfer` above an amount needs two" would need the amount as a
number the approval does not carry, and deriving it from the summary text
would be a gate that fails open on a formatting change. There is also still no
second factor behind either account (T-19), so two stolen sessions defeat a
quorum of two; and an installation with one owner cannot satisfy a quorum of
two at all, which is a deadlock rather than a compromise but is just as
stopping — the ceiling of five exists so a typo cannot create one silently.

## Non-negotiable defaults

| Setting                     | Value                                                                        |
| --------------------------- | ---------------------------------------------------------------------------- |
| CLI permission mode         | `restricted`                                                                 |
| Tool access                 | deny by default, allowlist per agent                                         |
| Vendor policy               | deny by default, blocklist wins                                              |
| `may_approve` for any agent | `false`, typed as a literal                                                  |
| Telemetry                   | off                                                                          |
| Secrets in the database     | references only, never values — except mailbox credentials, encrypted (T-11) |
| Incoming mail               | `inbox` task, never the CEO path (T-10)                                      |
| Marketplace MCP servers     | allowlisted launcher, `autoConnect: false` (T-12)                            |
| Inbound chat                | no pairing, no access; `owner` role granted by the owner only (T-13, T-14)   |
| Agent file writes           | approved proposal, path-contained, hash-checked, all-or-nothing (T-15)       |
| Sandbox grant lifetime      | ≤ 4 hours, tied to an approval                                               |
| Background execution        | only delegated work is enqueued; `inbox` tasks never are (T-16)              |
| CLI credentials             | held by the runner's own OS user; the control plane never sees one (T-17)    |
| MCP credentials             | references in the config; resolved by the runner at start (T-18)             |
| Audit actor                 | the signed-in user's id; "ceo" only where nobody has a name (T-19)           |
| Business-pack integrations  | read-only adapters, registered only from the environment (T-20)              |
