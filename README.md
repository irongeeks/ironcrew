# IronCrew

A self-hosted, local-first **multi-agent company OS**. You are the owner and
CEO. You talk to one Executive Assistant, who triages, plans, delegates to a
crew of specialist agents, and reports back with a result you accept or send
for revision.

Built as a fork of [OctoOffice](https://github.com/Chepko932/OctoOffice)
(Apache-2.0), with a governance-grade control plane added alongside it:
atomic task claiming, an approval engine that technically blocks high-risk
actions, budget enforcement, a hash-chained audit log, and a vendor policy that
is enforced in the backend rather than hidden in the UI.

> **Status: Phase 2 (Company OS) complete.** The CEO slice runs end to end on
> a real, permission-aware `CliAdapterRuntime` (Claude Code, Codex, Gemini)
> alongside MockRuntime, and goals, projects, Kanban, meetings, an Obsidian
> memory, and Discord/Telegram/email notifications are all built and tested —
> 3,600+ tests across the server and client suites. A live task run through
> an _authenticated_ CLI login is still the operator's own manual step (no
> CLI login exists in this development environment). See
> [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for an honest,
> test-backed breakdown of what is and is not built.

## Quick start

```bash
git clone https://github.com/irongeeks/ironcrew.git
cd ironcrew
pnpm install
cp .env.example .env          # set API_AUTH_TOKEN to a long random value
pnpm dev                      # http://127.0.0.1:8800
```

Complete the setup wizard, then open the **COMMAND** tab.

No provider login is required to try it — MockRuntime exercises the whole flow.
Full instructions: [Linux](docs/LINUX_INSTALL.md) · [macOS](docs/MACOS_INSTALL.md).

## What it does

```text
CEO ──► Executive Assistant ──► triage ──► task ──► delegation
                                                       │
                                                       ▼
                                    agent + runtime ──► run events
                                                       │
CEO ◄── summary ◄── review ◄────────────────────────────┘
```

- **One point of contact.** You write to the EA. She classifies every message
  (question, task, project, incident, sensitive request…), asks only when the
  signal is genuinely weak, and delegates by department.
- **Sensitive work is blocked, not executed.** A payment, a tax filing, a
  contract, a production deployment — the EA creates an approval request and
  says plainly that she has _not_ acted. Only you decide.
- **Everything is on the record.** One correlation id spans your message, the
  task, every run, every event and every audit entry.

## Screenshots

The Command Center — a live Kanban board, decision inbox and CEO chat, all
backed by the same REST API this README describes elsewhere:

![Command Center board](docs/screenshots/command-center-board.png)

<details>
<summary>More views (decision inbox, projects, org chart, secrets)</summary>

Decision inbox — notifications and the append-only decision log:

![Decision inbox](docs/screenshots/command-center-inbox.png)

Projects, traced back to the goal they serve:

![Projects](docs/screenshots/command-center-projects.png)

Org chart, grouped by department:

![Org chart](docs/screenshots/command-center-orgchart.png)

Password-manager integration — only ever a reference (provider + item), never
a value; the "nicht erreichbar" badges here are honest, since neither `bw`
nor `pass-cli` is installed on this particular machine:

![Secrets](docs/screenshots/command-center-secrets.png)

</details>

## Design commitments

These are enforced in code and covered by tests, not just documented.

| Commitment                     | How                                                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Policy beats persona**       | Persona, professional role and policy are three separate columns. A character pack may change display name and portrait — nothing else. Attempts to reach policy through a skin are rejected loudly. |
| **No agent approves anything** | `may_approve` is typed as the literal `false`. Approval is the human owner's alone.                                                                                                                  |
| **No double work**             | Task claiming is a compare-and-set on `status_version`; exactly one of N concurrent workers wins. Verified with a 25-way concurrency test.                                                           |
| **No unbounded agents**        | CLI permission bypass flags are never default. `elevated` requires an owner-approved, ≤4h sandbox grant, re-validated at every invocation, with a guard immediately before `spawn()`.                |
| **No secrets in logs**         | Pattern-based redaction applied _before_ storage, including across stdout chunk boundaries.                                                                                                          |
| **Deny by default**            | Vendor policy and per-agent tool access both refuse anything not explicitly allowed. The blocklist always beats the allowlist.                                                                       |
| **No invented numbers**        | Every dashboard figure names its source and read time. Subscription runtimes record quota events, not a fabricated price.                                                                            |
| **No silent failure**          | A rate limit is its own event, not a generic error. A budget stop is HTTP 402; an approval block is 403. The UI shows both.                                                                          |
| **Tamper-evident record**      | The audit log is append-only and hash-chained; `verifyAuditChain()` locates the first broken link.                                                                                                   |

## Vendor policy

`config/vendor-policy.yaml` decides which model vendors may be used, and
`server/ironcrew/policy/vendor-policy.ts` enforces it in the backend. A
blocked model is refused with **403** by the same code path the executor uses,
so the UI cannot offer something the backend would reject.

Allowed by default: `openai/*`, `anthropic/*`, `google/*`, `mistralai/*`,
`meta-llama/*`. Blocked by default including aliases: DeepSeek, Qwen/Alibaba,
Moonshot/Kimi, MiniMax, Zhipu/GLM, Baichuan, Yi, StepFun, Hunyuan, Doubao,
ERNIE, SenseTime, iFlytek, InternLM, TeleAI. Talent Market and WeChat endpoints
are blocked. Telemetry is off.

## The crew

Fourteen seed agents across thirteen departments, defined in
`config/agents.seed.yaml`. Each has a professional role, a policy, and a
cosmetic persona — kept strictly apart.

The public repository ships **original archetype names** and no copyrighted
assets. Private naming and portraits go in
`config/private/character-pack.local.yaml` and `data/private-assets/`, both
gitignored.

## Commands

```bash
pnpm dev            # development server with hot reload
pnpm test           # unit and integration tests
pnpm test:api       # server suite
pnpm test:web       # frontend suite
pnpm test:e2e       # Playwright
pnpm build          # type check and bundle
pnpm lint
```

## Documentation

| Document                                                                                            | Contents                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)                                              | what is built, what is not, with test evidence                                             |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                                                      | layers, module map, invariants, data flow                                                  |
| [`docs/UPSTREAM_ANALYSIS.md`](docs/UPSTREAM_ANALYSIS.md)                                            | what was taken from OctoOffice, OneManCompany and Paperclip, and what was deliberately not |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)                                                      | trust boundaries, findings, mitigations, residual risk                                     |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)                                                          | schema and why it is shaped that way                                                       |
| [`docs/PROVIDER_AUTH.md`](docs/PROVIDER_AUTH.md)                                                    | runtime authentication and permission modes                                                |
| [`docs/MAIL.md`](docs/MAIL.md)                                                                      | mailboxes, per-agent grants, and why incoming mail is never a CEO message                  |
| [`docs/MESSENGER.md`](docs/MESSENGER.md)                                                            | two-way Telegram/Discord, pairing, and who may speak as the CEO                            |
| [`docs/CHANGE_PROPOSALS.md`](docs/CHANGE_PROPOSALS.md)                                              | an agent proposes file changes, the owner approves, then they apply                        |
| [`docs/MARKETPLACES.md`](docs/MARKETPLACES.md)                                                      | installing skills and MCP servers, and the trust boundary that gates it                    |
| [`docs/NETWORKING.md`](docs/NETWORKING.md)                                                          | Tailscale/Headscale status + remote workers over the tailnet                               |
| [`docs/RUNNER_PROTOCOL.md`](docs/RUNNER_PROTOCOL.md)                                                | the runtime interface and event model                                                      |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                                                                | what comes next                                                                            |
| [`docs/LINUX_INSTALL.md`](docs/LINUX_INSTALL.md) · [`docs/MACOS_INSTALL.md`](docs/MACOS_INSTALL.md) | installation                                                                               |
| [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md)                                                | the original OctoOffice README, for inherited features                                     |

## Licence and attribution

Apache-2.0. IronCrew is a fork of OctoOffice, Copyright (c) Joshua
Dormann, used under Apache-2.0 with the licence preserved.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the full attribution,
the list of modified files, and what was learned (but not copied) from
OneManCompany, Paperclip and Honcho.
