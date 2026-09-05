# IronCrew: integrated office and execution corrections

This change implements the findings from the 5 September review against the
supplied Iron Command OS master prompt, retaining the IronCrew name and existing
Mail/Sevdesk additions. It evolves the existing application; it does not claim
that every phase of the original master prompt is finished.

## Implemented

- Modern 2D office inside the dashboard: original vector people and desks,
  department labels/filtering, meeting room and decision area. Position and
  animation follow canonical backend state. Fit/100% controls, keyboard actions,
  reduced motion and an accessible list work without WebGL.
- Office, Tasks and Command use one mounted canonical company view. Selecting a
  person's task or its Kanban card opens the same task ID, with original run
  history and events. Legacy tools remain explicitly labelled; there is no
  bidirectional replication into legacy task tables.
- Mobile CEO entry and global New Mission focus the canonical composer. Drafts
  survive Office/Tasks/Command navigation. Revision submits the CEO's concrete
  instructions instead of a hardcoded sentence.
- Authenticated company SSE connects REST mutations and scheduler events to the
  frontend. Session revocation and company boundaries are checked. Reconnect
  reloads persisted state; token deltas do not refetch every panel.
- Failed tasks resume only after their queue deadline; rate limits preserve the
  run ID, queued intent and cooldown across restart. Other tasks on the affected
  runtime respect the cooldown. Approval waiting is not automatically resumed.
- Manual execution uses the same queue claim/settlement as scheduled execution.
  Queue, task and agent leases renew during work; stale workers cannot overwrite
  a successor's task, events, locks or queue settlement.
- Project workspace paths reach the runtime. Filesystem runtimes fail with an
  explicit error if no absolute path is configured. No invented `/tmp` path.
- OpenRouter requests actually include the provider allowlist and fallback
  policy, plus ZDR/data-collection restrictions for sensitive or unclassified
  work. Cancellation aborts requests; timeout includes response-body consumption.
- CLI installation is labelled as unverified authentication, not a proven login.
  Missing/failed dashboard data never produces an Audit OK label.
- The audit redaction test uses an injected failing transport, so it sends no
  request to `collector.invalid`. Database rename tests use the installed loader
  directly instead of npx/CLI IPC. Process-kill tests wait for readiness and exit
  events instead of assuming startup has finished after a sleep.

## Follow-up: employee figures and runtime integration

- Twenty original vector characters can be previewed and assigned per employee.
  Private portrait/full-body uploads are normalized to WebP behind authenticated
  company-scoped routes. Appearance overrides never modify professional roles,
  capabilities or permissions. The prompt builder accepts free character references
  and supplies transparent-background, size and foot-baseline instructions.
  See [Characters](CHARACTERS.md).
- Official CLI help/version/auth probes and normalized native streaming now drive
  capability detection. Persisted session IDs resume only for matching task, agent,
  runtime, model, permission mode and workspace; CEO revision notes reach the run.
- OpenRouter streams text and bounded tool rounds, validates tool arguments, enforces
  grants and provider policy per round, and persists tool audit events. Hard budgets
  are checked after usage as well as before dispatch.
- Native runners resolve OpenRouter SecretRefs just in time. Scoped read/list tools,
  start/resume/cancel and optional mutually authenticated TLS dispatch are implemented.
  Control Plane and runner must be upgraded together to protocol v2.
- Obsidian is the local knowledge source. Optional Honcho uses a persistent retry
  outbox, redacted provenance, explicit sensitivity rules and deletion reconciliation.
  A Honcho outage preserves the local workflow. Run summaries remain labelled as
  AI-derived, unreviewed memory; they are not inferred owner preferences.

## Follow-up verification

- Local frontend: **569 tests passed**. Scripts: **26 passed**, including Docker
  packaging checks. Frozen lockfile validation passed with pinned pnpm 10.30.1.
- TypeScript, production build and ESLint passed; 447 inherited lint warnings remain.
- Backend regression suites include session continuity, real local TLS, native
  usage acknowledgement, streamed hard stops, tool approval binding and memory privacy.
- The updated CI results and browser screenshots are attached to
  [PR #18](https://github.com/irongeeks/ironcrew/pull/18). Local Unix listener and browser
  restrictions are unchanged; Docker is not installed, so packaging checks are not
  represented as a successful container build or deployment.
- Docker now includes the shared runtime catalog and configuration. Private assets
  and the vault use the existing persistent data volume and are excluded from images.

## Previous milestone verification

- GitHub CI on `12f4c5b`: **4,849 backend**, **562 frontend**, and **22 script
  tests passed** (one existing backend skip). The CI run also verifies the six
  real Unix-socket cases blocked by local EPERM.
- GitHub quality job: security audit, formatting, lint, OpenAPI check, TypeScript
  and Vite production build passed. The existing lint warnings remain.
- First browser run: **71 passed, 3 existing skips, 1 failed**. The failure was a
  new test expecting a nonexistent cancelled column. The corrected test now
  verifies an external ready-to-blocked transition and removal after cancellation,
  with the cancelled history still retained by the API.
- Browser captures at **390/768/1440/1920px** passed and were inspected. They also
  exposed desktop height-fit and task-label spacing issues addressed in the
  follow-up correction. Final checks and downloadable Playwright artifacts are
  attached to [PR #18](https://github.com/irongeeks/ironcrew/pull/18).
- The local browser rejects localhost with `ERR_BLOCKED_BY_CLIENT`; no local
  browser acceptance is claimed. E2E failures are no longer ignored by CI.
- `docs/screenshots/crew-office-illustration.png` is a static render of the actual
  SVG scene with explicit test states. It verifies drawing geometry and crowded
  room layouts. It is **not** a browser screenshot or a real agent run.

## Remaining master-prompt gaps

A complete real-runtime MVP acceptance still requires an authenticated CLI run
on the target Linux/macOS host: CEO message, configured project workspace,
streaming, cancellation, restart/recovery, review, revision and acceptance.
No provider login or external customer action was performed in this session.

The follow-up implements the previous streaming, session, hybrid-memory,
runner-only secrets and explicit remote-dispatch gaps. Authenticated production
acceptance is still open: none of Claude, Codex, agy or Gemini is installed in this
execution environment, and no real OpenRouter/Honcho account was used. Tests use
injected transports, fixture CLIs and genuine local TLS connections.

Outbound enrollment and dynamic runner-fleet scheduling, 3D/GLB character uploads
and animation-frame imports remain future work. Custom images currently move with
the office figure and receive live state overlays; they are not automatically
rigged or animated by an image model. The generator produces a copyable prompt;
image creation happens in the user's selected image model.

## Start and verify

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev:local
# Open http://127.0.0.1:8800; OFFICE is the shared company floor.
```

Use the existing .env configuration; new installations follow README setup.
Configure a real project workspace before selecting a filesystem CLI runtime.

```bash
corepack pnpm run test:web --run
corepack pnpm run test:api --run
corepack pnpm run test:scripts
corepack pnpm build
corepack pnpm test:e2e
```

For the target-host acceptance, follow [CLI runtime acceptance](CLI_RUNTIME_ACCEPTANCE.md)
and [runner setup](RUNNER_PROTOCOL.md). Do not equate MockRuntime success with a
validated subscription login or production deployment.
