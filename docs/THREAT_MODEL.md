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

_Residual risk:_ the resolved grant is not yet threaded from the approval store
through the upstream execution path — that path currently always resolves to
`restricted`, which is safe but means elevation is not yet reachable in
production. Tracked in `IMPLEMENTATION_STATUS.md`.

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
host it is a real exposure, and backups of `octooffice.sqlite` must be treated
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

## Explicitly out of scope for the MVP

- Multi-user authorisation (single owner only; OIDC is Phase 5).
- Protecting the owner from themselves — the owner can edit configs and the
  database directly, by design in a local-first product.
- Defending against a compromised host OS.
- Supply-chain attacks on npm dependencies beyond the existing lockfile,
  `pnpm.overrides` and gitleaks configuration.

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
| Sandbox grant lifetime      | ≤ 4 hours, tied to an approval                                               |
