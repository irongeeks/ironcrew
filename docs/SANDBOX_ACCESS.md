# Explicit sandbox exceptions

The default CLI permission mode remains restricted. A sandbox exception is a
separate, critical-risk owner decision for **one task, assigned agent, project,
normalized project workspace, CLI provider and one run**. Supported providers are
Claude Code, Codex and Antigravity. It is not a company-wide permission switch.

## Owner workflow

1. Configure the project's absolute workspace and assign its task to an agent.
   The requested provider must match the runtime configured in that agent's profile.
2. Open **Sandbox-Ausnahmen**, select a ready/review task and CLI provider, and
   explain why the exception is necessary. The window is 1–240 minutes.
3. The task is parked at `approval_required`. Inspect the concrete workspace,
   duration, reason and risk in the existing approval inbox. Submit the required
   owner reviews; the normal configured quorum still applies.
4. A successful decision creates the scoped grant and makes the task ready for
   the persistent run queue. The first matching run atomically consumes it.
5. Revoke the exception in the same panel to stop an active elevated run. Expiry
   also stops it. Neither operation rolls back filesystem changes already made.

An actual active Owner account is required. Anonymous/bootstrap access, a forged
approval object, an operator-only vote, a pending decision or an approval without
recorded quorum cannot create effective elevation. The browser has endpoints to
request, list and revoke exceptions; it cannot mint or consume grants.

## Persistence and boundaries

The proposed action stores a versioned, validated scope. The backend rechecks the
persisted approval, its deadline, owner vote, quorum, current task assignment,
project workspace and provider before minting and again before consumption.
Changing the task, agent, project, workspace or runtime invalidates the exception.
Revoked, expired and consumed approvals are never reminted. Repeated consumption
for the same existing run is idempotent; a different run cannot reuse it, including
after restart. A retry that needs elevation requires another explicit exception.

Migration `0029-crew-sandbox-consumption.ts` adds the consumed run and timestamp.
Request, decision, mint, permission resolution, consumption and revocation are
recorded in the existing audit trail. No CLI login credentials are read or copied.

The native runner receives the grant ID and absolute expiry in its authenticated
v2 run context. Elevated jobs missing either field, expired jobs and windows over
four hours are rejected before calling a runtime. A runner-local timer aborts the
runtime and invokes `cancelRun` when the window ends, independently of control
plane timers. The runner still enforces its configured workspace root. A runner
trusts its authenticated control plane for the database approval decision; the
wire grant ID is an audit reference, not a standalone bearer credential.

CLI permission-bypass flags are not an operating-system sandbox. Use a dedicated
runner account with restricted OS access and an isolated project workspace. The
exception authorizes the CLI bypass explicitly; it does not promise rollback,
containment of already-started external actions or token-limit bypass.

## Verification

Offline regression tests cover real owner/quorum decisions, task parking,
restart/idempotence, single-run consumption, revoked/expired approval and grants,
company/task/agent/project/provider/workspace mismatches, forged approval data,
API role guards, UI request/revoke behavior, wire forwarding and autonomous
native-runner expiry. Runtime tests use fixture processes and in-memory transports;
no provider credentials, paid calls or production changes are required.
