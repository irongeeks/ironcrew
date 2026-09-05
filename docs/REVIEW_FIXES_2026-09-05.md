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

## Verification

- Frontend: **562 passed**, 62 files.
- Backend: **4,842 passed** in the final broad run; one pre-existing process-start
  race failed under parallel load. That test was corrected to wait for actual
  readiness and its complete **7-test suite then passed**. Combined final-code
  coverage: **4,843 backend cases**. Six real Unix-socket cases cannot run in this
  environment and were excluded explicitly on the final local run; one existing
  skip remains. They are retained in the normal CI suite.
- Scripts: **22 passed**.
- TypeScript and Vite production build: passed.
- Full ESLint: no errors; 448 inherited warnings in the earlier full run.
  Changed files also receive a final scoped lint/format check.
- Playwright: **75 tests discovered in 21 files**, including office interaction,
  live external updates, mobile navigation and 390/768/1440/1920px captures.
  The available browser rejects localhost with `ERR_BLOCKED_BY_CLIENT`; these
  browser tests were not run locally. CI no longer ignores E2E failures and
  retains screenshots/traces under its test artifact.
- `docs/screenshots/crew-office-illustration.png` is a static render of the actual
  SVG scene with explicit test states. It verifies drawing geometry and crowded
  room layouts. It is **not** a browser screenshot or a real agent run.

## Remaining master-prompt gaps

A complete real-runtime MVP acceptance still requires an authenticated CLI run
on the target Linux/macOS host: CEO message, configured project workspace,
streaming, cancellation, restart/recovery, review, revision and acceptance.
No provider login or external customer action was performed in this session.

OpenRouter streaming/tool calling, dynamic CLI flag/capability discovery and
session resume, Honcho/Hybrid memory, actual remote-worker task dispatch and
3D assets remain separate work. The current office intentionally delivers the
requested modern 2D spatial view. CLI auth status is honest but unverified.
OpenRouter's production key is still configured through the existing environment
integration; full runner-only SecretRef resolution is not completed here.

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

The next acceptance step is the full browser suite and one authenticated native
CLI workflow on the intended host. Do not equate MockRuntime success with a
validated subscription login or production deployment.
