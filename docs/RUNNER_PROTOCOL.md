# Runner Protocol

How the control plane talks to the thing that actually executes agent work.

> **Status.** `embedded` and `native-daemon` are implemented and tested
> (`server/ironcrew/runner/`, including a round trip over a real Unix
> socket). `remote-daemon` — the outbound-only connection for a VPS or a
> customer network — is still design.

## Why a runner abstraction at all

The control plane may run in a container. The official CLI runtimes hold the
owner's real logins. Giving the container those logins by mounting the owner's
home directory would expose SSH keys, browser profiles and every other
credential in it — see `docs/THREAT_MODEL.md` T-05.

So the runner is a separate trust domain:

```text
Control Plane                            Runner
─────────────                            ──────
holds: tasks, policy, audit              holds: CLI logins, workspaces
knows: capabilities, status, events      knows: how to execute
                          ──── job ────►
                          ◄─── events ──
never receives an OAuth token
```

## Transports

| Mode            | Status      | Use                                                                          |
| --------------- | ----------- | ---------------------------------------------------------------------------- |
| `embedded`      | implemented | local development; runtime in the control plane process                      |
| `native-daemon` | implemented | Linux/macOS; a dedicated OS user owns the CLI logins and the MCP credentials |
| `remote-daemon` | design      | VPS, server tank, isolated customer networks                                 |

### Switching between them

One variable. With `IRONCREW_RUNNER_SOCKET` set, every CLI runtime the
control plane registers is a `RunnerRuntime` that forwards to the daemon;
without it they run inline. The orchestrator sees the same `AgentRuntime`
either way and cannot tell the difference — which is what makes the security
property cost nothing.

Without a runner, `deploy/ironcrew.service` has to move `HOME` to
`/var/lib/ironcrew` so the control plane's own account can hold CLI
credentials. With one, that stops being necessary: the credentials live with
`ironcrew-runner` and the control plane never has them.

### The wire

NDJSON over a Unix socket — one message per line, `{ v, kind, … }`. Not a
binary framing and not an RPC library: a protocol an operator can read with
`nc` at three in the morning is worth more than the saved bytes, and the
message rate is events from a handful of runs.

A **Unix socket rather than a localhost port** because access control is then
the filesystem's: the socket is `0660`, owned by the runner user, group-shared
with the service user. A TCP port on localhost is reachable by every process
on the machine — including anything an agent itself starts, which would make
the isolation decorative. The shared token on top is defence in depth, not the
primary control, and is compared in constant time.

### What the runner refuses

- **A workspace outside its root.** `IRONCREW_RUNNER_WORKSPACE_ROOT` is
  checked with `realpath`, not a string prefix, so a symlink inside the root
  pointing out of it does not pass. A runner that trusted the path the
  control plane sent would turn a bug there into filesystem access under the
  account that holds the logins.
- **A job for a runtime it does not have.** Reported at the handshake, so it
  reads as "this runner cannot do that" rather than as a mysterious failure
  inside a run.
- **A wrong token**, without revealing its length.

### MCP servers on the runner

An MCP server is usually a process with an API key in its environment. That
key must not live in the control plane's database — so the server runs on the
runner too, and the protocol carries three more messages for it:

| Message          | Direction | Purpose                                             |
| ---------------- | --------- | --------------------------------------------------- |
| `mcp-connect`    | → runner  | start (or restart) a server; answers with its tools |
| `mcp-call`       | → runner  | run one tool; answers with the connector result     |
| `mcp-disconnect` | → runner  | stop it                                             |

`mcp-connect` sends the **stored config, references intact**. A config value
may be either a literal or a pointer into a vault:

```json
{ "$secret": { "provider": "vaultwarden", "itemRef": "GitHub MCP", "field": "password" } }
```

A pointer is not a credential, so it may be stored, logged and shown in the
UI. The runner resolves it as its own OS user, against its own vault session,
immediately before starting the server. The value is never sent back: the
control plane sees tools and tool results, and nothing else.

Which side runs a given server is decided by the config, not by a setting: a
server whose values are all literals runs inline as before; one that
references the vault runs on the runner, and says so (`needsRunner` in its
status) rather than failing later as an authentication error. Without a
runner configured, starting such a server is refused with a message that
names `IRONCREW_RUNNER_SOCKET` — an operator should not have to guess that
the missing piece is a daemon.

The servers are **daemon-scoped, not connection-scoped**. The control plane
opens one connection per request, so a server tied to a connection would be
spawned and killed for every tool call. They stop on `mcp-disconnect` or when
the daemon stops — which is also what keeps a credential from outliving the
vault entry it came from.

### What always happens

**A run always ends.** Every failure across the boundary — the connection
dropping mid-run, the daemon dying, a protocol error, an idle timeout, even a
runner that ends a job without a terminal event — produces `run.failed` or
`run.cancelled` on the control-plane side. A `startRun` generator that merely
stopped would leave the orchestrator's `for await` waiting, the task
`running` and the agent locked until its lease expired minutes later.

Locally minted events carry `seq: -1`: the runner owns the sequence for a run,
and inventing a number in its space could collide with one it already used.

**A dropped connection cancels what it started.** A CLI process still running
for a control plane that is no longer listening spends money and holds a
workspace for nothing.

The native runner:

- runs under a dedicated OS user,
- uses that user's officially stored CLI logins,
- reports only capabilities and status to the control plane,
- receives jobs over an authenticated connection,
- executes only inside assigned workspaces,
- returns normalised events,
- **never transmits an OAuth token to the control plane.**

For remote runners the connection is outbound-only, with mTLS or short-lived
enrolment tokens, so a customer network never needs an inbound hole.

## The interface

```ts
interface AgentRuntime {
  readonly id: string;
  readonly type: string;
  capabilities(): Promise<RuntimeCapabilities>;
  healthCheck(): Promise<RuntimeHealth>;
  authStatus(): Promise<AuthStatus>;
  startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent>;
  resumeRun?(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent>;
  cancelRun(runId: string): Promise<void>;
}
```

`startRun` returns an `AsyncIterable`, so back-pressure is the consumer's:
the orchestrator persists each event before requesting the next, which is what
makes "the database never lags behind the UI" true rather than aspirational.

### `RunContext`

```ts
{
  companyId, projectId, taskId, runId, agentId,
  correlationId,          // spans message → task → runs → audit
  workspacePath,          // the only directory this run may touch
  permissionMode,         // restricted | workspace_write | elevated
  redactValues?,          // literal secrets to scrub from this run's output
  signal?                 // AbortSignal for cancellation
}
```

Every field is mandatory context, not decoration. An event that cannot be
attributed to a company, task, run and correlation id cannot be audited.

## The event model

Seventeen types, identical for every runtime:

```text
run.started        message.delta       message.completed
tool.requested     tool.started        tool.completed      tool.failed
subagent.spawned   subagent.completed
approval.required  usage.updated       artifact.created
rate_limit.detected
run.waiting        run.completed       run.failed          run.cancelled
```

Each persisted event carries `event_id`, `company_id`, `project_id`, `task_id`,
`run_id`, `agent_id`, a per-run monotonic `seq`, `timestamp`, `correlation_id`,
a typed payload, and redaction metadata.

`rate_limit.detected` is deliberately its own type. Collapsing it into
`run.failed` is how a rate limit becomes an unexplained failure and a task gets
retried into the same wall.

### Sequencing

Sequence numbers come from `UPDATE crew_runs SET next_event_seq = next_event_seq + 1
… RETURNING`, so two concurrent emitters cannot receive the same number.
`UNIQUE (run_id, seq)` is the backstop. Ordered replay is therefore exact.

## Mandatory runtime behaviour

Every runtime, including future ones, must:

- detect its own version rather than assume one,
- **capability-detect flags** (e.g. from `--help`) rather than assume they exist,
- report auth status without ever emitting a secret,
- stream incrementally,
- terminate cleanly on cancel, killing the whole process group,
- support session resume where the underlying tool does,
- honour a timeout,
- emit heartbeats so orphan detection works,
- detect rate limits and surface reset times when known,
- retry with exponential backoff **and jitter** — never aggressively,
- emit usage events (and cost events where a real price exists),
- stay inside its assigned workspace,
- capture stdout and stderr separately,
- redact before emitting,
- pass arguments as an argv array — **never** shell string concatenation.

## Liveness and recovery

A run writes `heartbeat_at` as events flow. A task's claim carries
`lock_expires_at`.

- `RunStore.findStale()` finds runs that are active but silent.
- `TaskStore.findOrphaned()` finds tasks whose lock expired while still
  `assigned` or `running` — the signature of a worker that died.
- `recoverOrphaned(taskId, observedRunId)` returns the task to `ready`, but
  **only** while the lock still belongs to the run the reaper observed. This is
  what stops a slow reaper from stealing a lock a fresh owner has since taken.

Recovery is idempotent and audited. A recovered task is claimable again
immediately.

## Cancellation

`cancelRun(runId)` marks the run cancelled; the generator checks between
events and emits `run.cancelled` rather than stopping abruptly, so the event
stream always has a terminal event. An `AbortSignal` on `RunContext` does the
same thing from the caller's side. Both paths are tested.

## Bridging the upstream adapters

`CliAdapterRuntime` (`server/ironcrew/runtime/cli-adapter-runtime.ts`) is
this bridge. It takes a `CliAdapter` — argv building and stream parsing stay
the adapter's own job, since that's the part that actually knows each CLI's
wire protocol — and supplies everything the normalised contract adds on top:
redaction, rate-limit detection, idle/hard timeouts, process-group
cancellation, and this mapping. The upstream adapters emit six event types
(`output`, `tool_use`, `subtask_created`, `subtask_done`, `error`,
`token_usage`); `mapAdapterEvent()` maps them onto the seventeen-type
protocol:

| Upstream          | Normalised                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `output`          | `message.delta`                                                                                 |
| `tool_use`        | `tool.requested` + `tool.started`                                                               |
| `subtask_created` | `subagent.spawned`                                                                              |
| `subtask_done`    | `subagent.completed`                                                                            |
| `token_usage`     | `usage.updated`                                                                                 |
| `error`           | (no wrapped adapter emits this today) folded into the stderr tail that surfaces on `run.failed` |

A rate limit is detected from raw stdout/stderr text via `detectRateLimit()`
(regex + reset-time extraction), not from an upstream event type none of the
wrapped adapters emit, and surfaces as `rate_limit.detected` followed by
`run.waiting` rather than a generic failure. Process exit maps to
`run.completed`, or `run.failed` with the stderr tail attached when the exit
code is non-zero, a hard/idle timeout fired, or output was truncated at
`maxOutputBytes`.

`CliAdapterRuntime` is registered for every CLI-transport adapter
(`server/server-main.ts`, alongside MockRuntime) so the orchestrator can
select it per agent (`PATCH /api/crew/agents/:id/runtime`) and see its live
capabilities/health/auth (`GET /api/crew/runtimes`, the Command Center's
Provider Health affordance in the agent-detail dialog).
