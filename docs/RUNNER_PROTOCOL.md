# Runner Protocol

How the control plane talks to the thing that actually executes agent work.

> **Status.** The `AgentRuntime` interface, the normalised event model,
> MockRuntime and `CliAdapterRuntime` — the bridge onto the upstream CLI
> adapters described below — are implemented and tested. The `native-daemon`
> and `remote-daemon` transports described below are **design, not code** —
> see `IMPLEMENTATION_STATUS.md`. Today the control plane and the runtime
> share a process (`embedded`).

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

| Mode            | Status      | Use                                                     |
| --------------- | ----------- | ------------------------------------------------------- |
| `embedded`      | implemented | local development; runtime in the control plane process |
| `native-daemon` | design      | Linux/macOS; a dedicated OS user owns the CLI logins    |
| `remote-daemon` | design      | VPS, server tank, isolated customer networks            |

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
