# Provider Authentication

IronCrew never stores, copies or exports a provider's OAuth token. It
uses the official CLI's own credential store, held by the operating system user
that owns it, and reads only _status_.

## The rule

```text
The control plane may know:   installed · authenticated · healthy · rate limited
                              a non-identifying account hint (e.g. a plan name)

The control plane must NOT:   read, copy, export or persist an OAuth token
                              use a subscription token as a generic API key
                              mount the owner's home directory into a container
```

`AuthStatus` in `server/ironcrew/runtime/run-events.ts` encodes this by
contract: booleans, a method enum, and an optional `accountHint` that must never
carry an email address or a token.

## Permission modes

Every CLI invocation resolves a permission mode before argv is built.
See `docs/THREAT_MODEL.md` T-01 for why this exists.

| Mode                     | Meaning                          | Claude Code                      | Codex                       | Gemini                      | Antigravity (`agy`)              |
| ------------------------ | -------------------------------- | -------------------------------- | --------------------------- | --------------------------- | -------------------------------- |
| `restricted` _(default)_ | no destructive tool use          | _(no bypass flag)_               | `--sandbox read-only`       | `--approval-mode default`   | `--sandbox`                      |
| `workspace_write`        | writes confined to the workspace | _(no bypass flag)_               | `--sandbox workspace-write` | `--approval-mode auto_edit` | `--sandbox`                      |
| `elevated`               | permission bypass                | `--dangerously-skip-permissions` | `--yolo`                    | `--approval-mode yolo`      | `--dangerously-skip-permissions` |

`agy` publishes exactly two levels on the command line — its default
(`request-review`, which in headless mode means nothing gets approved) and
`--dangerously-skip-permissions` (`always-proceed`). Finer rules live in its
own `settings.json`, not in argv, so its two non-elevated modes deliberately
produce the same flags. Inventing a middle flag that does not exist would read
as policy and enforce nothing.

`elevated` is reachable **only** through a `SandboxGrant` that:

- names the `ApprovalRequest` the owner decided,
- is scoped to a company, a set of runtimes and optionally one task,
- has an expiry hard-capped at 4 hours regardless of what it claims, and
- is re-validated at every invocation, not once at issue time.

`resolvePermissionMode()` fails closed: an invalid, expired, cross-company,
wrong-runtime or wrong-task grant degrades to `restricted`.
`assertArgsMatchMode()` runs immediately before `spawn()` and throws if argv
carries a bypass flag the resolved mode does not authorise.

**Status: wired end-to-end.** `SandboxGrantStore.mintFromApproval()` is the
only path to a grant — reachable solely from an _approved_ `sandbox_elevation`
`ApprovalRequest`. `CompanyOrchestrator.executeNextTask()` looks up a live
grant (`SandboxGrantStore.findLive()`) for the task about to run and asks
`resolvePermissionMode()` to resolve it; the resolver, not the lookup, stays
the sole authority and still fails closed on any mismatch. The resolved mode
and its grant id (if any) are persisted on the run row and audited as their
own `permission.resolved` event, independent of the grant's own
mint/revoke audit trail.

> **Flag names must be capability-detected.** The table above reflects the flags
> those CLIs published at the time of writing. A runtime must verify against
> `--help` output for the installed version rather than assuming. Policy (which
> mode) and detection (which flag) are deliberately separate concerns.

## Claude Code (subscription)

- Uses the officially installed `claude` CLI and the login already stored by the
  OS user. IronCrew never touches `~/.claude` credentials.
- Version detection via `claude --version`.
- Streaming JSON is used. Session resume is not — none of the wrapped
  adapters (claude, codex, gemini) currently expose a resume flag to
  `CliAdapterRuntime`, so `capabilities().sessionResume` reports `false`
  honestly rather than aspirationally, and `resumeRun()` degrades to a fresh
  run rather than silently losing context differently.
- Subscription limits are respected — there is no attempt to work around them.
- A rate limit surfaces as a `rate_limit.detected` event and moves the run to
  `waiting`, never a generic failure.
- Default concurrency: **1**.

UI shows: installed / authenticated / healthy / rate limited, plus setup
instructions when not authenticated. No token, ever.

## OpenAI Codex (ChatGPT login)

- "OpenAI OAuth" means the **official Codex CLI login with a ChatGPT account**,
  not an API key.
- The application must not read the OAuth token or reuse it as an OpenAI API
  key.
- Setup is `codex login`; on headless hosts, the device/browser flow the
  installed CLI itself offers.
- Machine-readable JSON streaming is used where available.
- Default concurrency: **2**.

## Google Antigravity

- Uses the official `agy` CLI and its cached login.
- No reading or copying of OAuth credentials.
- Capability detection via `agy --help` and `agy models`.
- Default concurrency: **2**.

Headless invocation, from the published documentation
(<https://antigravity.google/docs/cli/headless/>):

```
agy [--model <slug>] [--effort low|medium|high] --sandbox --output-format stream-json -p "<prompt>"
```

**The prompt goes in a flag, and that is not a preference.** `-p` takes the
prompt as an argument and ignores stdin; stdin only carries prompts under
`--input-format stream-json`, which needs a different framing on both ends. So
the adapter declares `promptDelivery: "flag"` and the runtime appends it —
after the permission guard has run, so that a prompt merely mentioning
`--yolo` is treated as the data it is.

Output is NDJSON: one `init` event, a `step_update` per step, a `result` per
turn. Finished steps become tool-use events, a `SUCCESS` result becomes the
agent's message, any other status becomes an error. The `result.usage` object
is passed through as metadata but not interpreted: its field names are not
documented, and reporting invented token counts is worse than reporting none.

_Status: implemented as a CLI adapter (`server/adapters/antigravity.ts`). It
replaces an inherited HTTP stub that pointed at a non-existent endpoint,
returned no events and always reported failure. Not yet verified against a
real `agy` binary — no Antigravity login exists in this environment, so live
verification stays a manual test alongside the other CLIs._

## Password managers (SecretRef resolution)

Registering a secret in IronCrew (Settings → Zugangsdaten) never stores its
value — only a `SecretRef` (provider + item locator, `server/ironcrew/secrets/secret-ref.ts`).
Resolving that ref to its live value happens on demand, in memory, and is
never persisted. Both providers wrap the vendor's own CLI (argv array only,
timeouts — the same posture as the CLI runtime adapters above) and are
registered unconditionally at startup; `GET /api/crew/secret-providers`
(the Settings UI's provider panel) reports honestly whether each is actually
reachable, rather than hiding one that isn't configured.

- **Vaultwarden** (self-hosted, Bitwarden-protocol-compatible) — via the
  official `bw` CLI. Set `VAULTWARDEN_SERVER_URL` to your instance, then
  authenticate the server process non-interactively: `bw login --apikey`
  using the `BW_CLIENTID`/`BW_CLIENTSECRET` env vars `bw` itself reads, and
  either keep an already-unlocked `BW_SESSION` in the environment or set
  `BW_PASSWORD` so IronCrew can unlock on first use.
- **Proton Pass** — via the official `pass-cli`
  (<https://protonpass.github.io/pass-cli/>). Authenticate headlessly with
  `PROTON_PASS_PERSONAL_ACCESS_TOKEN` + `pass-cli login`; a container
  deployment should also set `PROTON_PASS_KEY_PROVIDER=fs` (or `=env` with
  `PROTON_PASS_ENCRYPTION_KEY`). A stored ref's `itemRef` is
  `"<shareId>:<itemId>"` — IDs, not names, so a later rename in the vault
  can't silently break it.

- **OS-Schlüsselbund** — via `secret-tool` (libsecret) auf Linux oder
  `security` auf macOS. Ein `itemRef` ist `"dienst"` oder `"dienst:konto"`,
  weil das genau das ist, was beide Werkzeuge entgegennehmen.

  **Auf einem Server ist das die falsche Wahl**, und zwar nicht als Detail,
  sondern als Grundsatz: libsecret braucht einen laufenden Daemon und eine
  entsperrte Collection. Ein Dienst, der beim Boot startet, hat weder das eine
  noch das andere — ein Keychain-Ref scheitert dann mitten in einem Lauf statt
  bei der Einrichtung. `testConnection()` prüft deshalb den Session-Bus und
  sagt es vorher. Auf einer Workstation ist der Schlüsselbund dagegen die
  richtige Voreinstellung: Das Geheimnis ist bereits durch die Anmeldung
  geschützt, die der Betreiber ohnehin vornimmt.

None of the three providers has been exercised against a real
`bw`/`pass-cli`/`secret-tool` install in this project's CI — verify against
your actual deployment before relying on one in production.

## OpenRouter

- The API key is referenced as a `SecretRef`, never stored in plaintext or in an
  agent profile.
- The model catalogue is fetched dynamically, cached, and **filtered through the
  vendor policy server-side** before it is offered anywhere.
- Every request carries a provider routing block built by
  `buildOpenRouterProviderPolicy()`:

```json
{
  "only": ["OpenAI", "Anthropic", "Google", "..."],
  "order": ["OpenAI", "Anthropic", "Google", "..."],
  "allow_fallbacks": false
}
```

For a task flagged sensitive it additionally pins:

```json
{ "data_collection": "deny", "zdr": true, "allow_fallbacks": false }
```

- Because `allow_fallbacks` is false and `only` is pinned, a request cannot
  silently fall back to a provider outside the allowlist.
- Default concurrency: configurable, initially 6–8.

_Status: policy and routing-block construction are implemented and tested; the
OpenRouter transport itself is not wired yet._

## Vendor policy

`config/vendor-policy.yaml` is the single source of truth, enforced in
`server/ironcrew/policy/vendor-policy.ts` and validated with Zod at load.

- **Deny by default** — a model matching no allowed family is refused.
- **The blocklist always wins**, so widening `allowed_families` cannot
  re-enable a blocked vendor.
- Matching normalises the model id _and_ checks the resolved upstream provider,
  so a re-hosted alias or an allowed-looking model routed through a blocked host
  is still refused.
- `POST /api/crew/vendor-policy/check` returns **403** for a denied model. This is
  the same call the execution path makes, so the UI cannot present a model as
  usable that the backend would refuse.

Allowed by default: `openai/*`, `anthropic/*`, `google/*`, `mistralai/*`,
`meta-llama/*`.

Blocked by default, including aliases and variants: DeepSeek, Qwen/Alibaba,
Moonshot/Kimi, MiniMax, Zhipu/GLM/Z.ai, Baichuan, Yi/01.AI, StepFun, Tencent
Hunyuan, ByteDance/Doubao, Baidu ERNIE, SenseTime, iFlytek, InternLM, TeleAI.

Also blocked: the OneManCompany Talent Market and WeChat endpoints. Telemetry
is off.

## Routing profiles

Business logic never names a concrete model. It names an abstract profile —
`fast`, `balanced`, `deep_reasoning`, `coding`, `research`, `legal_research`,
`finance`, `vision`, `long_context` — which the administrator maps to runtimes
and models.

A fallback is permitted only when company policy allows it, the data-protection
class and vendor policy are satisfied, the cost limit is not exceeded, and the
target is genuinely suitable. A task must never silently drop onto an
unsuitable model.

## Rate limits

On detection: emit `rate_limit.detected`, move the runtime to `rate_limited`,
show the reset time when known, hold the task in a persistent queue, and offer
or apply a policy-permitted fallback. The CEO is notified only when an SLA or
deadline is actually at risk. Retries use exponential backoff with jitter —
never aggressive retry.
