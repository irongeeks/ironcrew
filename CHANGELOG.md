# Changelog

## Unreleased — 2026-09-05

- Add runtime-generated EA project plans, owner review, atomic task trees and hard budget ceilings.
- Prevent board/review/revision paths from bypassing pending action approvals.
- Connect outbound TLS runner fleets with scoped enrollment, credential rotation, capacity leases and session affinity.
- Bind sandbox exceptions to one owner-approved runtime/task/workspace and enforce expiry in the native runner.
- Add versioned coaching, objective run-evidence checks and approved guidance in task/meeting context.
- Manage private character assets with audited deletion/recovery, status spritesheets and optional GLB previews.
- Add Linux/macOS service tooling, Docker persistence/restore tests and SBOM/license gates.
- Preserve caller-relative paths in the backup CLI and bound its test process groups.

- Update the production image decoder to patched sharp 0.35.4 after the CI audit
  identified inherited libvips vulnerabilities in the earlier development version.

- Add modern vector office with canonical crew/task IDs, workspace desks,
  meetings, approval zone, fit/zoom, keyboard navigation and reduced motion.
- Share Office, Tasks and CEO chat state; fix mobile entry and global mission action.
- Add authenticated company SSE, burst batching and persisted reload on reconnect.
- Recover failed runs after backoff and persist rate-limit continuation across restart.
- Pass project workspaces to runtimes; fail clearly when a filesystem runtime has none.
- Enforce OpenRouter provider allowlists in real requests; cancel in-flight requests
  and retain timeouts until response bodies are consumed.
- Stop presenting CLI installation as confirmed authentication.
- Show unknown audit state when data is unavailable; expose original task/run history
  and submit concrete CEO revision instructions.
- Preserve existing mail, Sevdesk and other business integrations.
- Add 20 original full-body character skins, profile selection, authenticated private
  portrait/full-body uploads, previews and a copyable prompt for external image models.
  Appearance changes do not grant roles, skills or permissions.
- Probe installed CLI versions, supported flags and safe auth-status commands;
  resume supported native sessions across retries/revisions and restarts, scoped to
  the same task, agent, runtime, model, permission mode and workspace.
- Parse OpenRouter SSE incrementally, including text, tool calls, usage and rate limits;
  enforce grants, argument schemas, audit and vendor policy on tool continuations.
- Add optional Honcho hybrid memory with Obsidian fallback, sensitivity gates,
  durable write/delete retries and provenance-aware retrieval.
- Resolve OpenRouter SecretRefs inside the native runner per run; support scoped
  workspace tools and explicit remote dispatch with mutual TLS and token authentication.
  Automatic outbound enrollment and registry-driven fleet routing remain future work.
- Default local memory to `data/vault`; require an explicit development-only opt-in
  for embedded OpenRouter environment keys.

Verification of this follow-up: **569 frontend and 26 script tests passed; TypeScript and production build passed. Current backend/browser evidence: [PR #18](https://github.com/irongeeks/ironcrew/pull/18)**. Authenticated provider
and deployment acceptance remain separate manual checks.

All notable changes to IronCrew will be documented in this file.

Every entry below is inherited: releases up to and including 2.6.0 were made by
[OctoOffice](https://github.com/Chepko932/OctoOffice), the project IronCrew is
forked from. They are kept verbatim, under the names those releases actually
shipped with, so the compare links still resolve and the history stays true.
IronCrew's own releases start above this line.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.0] - 2026-05-08

See the [detailed release notes](docs/releases/v2.6.0.md) for the complete write-up.

This release closes the entire 2026-05-07 code-review backlog (41/41 high-and-critical
issues) across five waves, plus three transitive-dependency security overrides.

### Security

- DNS-rebinding-resistant SSRF guard: hostnames are pre-resolved and the validated IP
  is pinned to the outbound HTTP request via a request-scoped `undici` dispatcher,
  closing the TOCTOU between check and connect (#89).
- Redirect-aware `safeFetch`: every hop is re-validated and re-pinned through
  `assertSsrfSafeUrl` with a 5-hop limit and `Authorization` stripping on cross-origin
  redirects (#89 review #2).
- `pnpm.overrides` pin `ip-address >= 10.1.1` (XSS in `Address6`, GHSA-v2v4-37r5-5v8g, #90).
- `pnpm.overrides` pin `hono >= 4.12.16` (bodyLimit bypass + JSX injection, #91).
- `pnpm.overrides` pin `fast-uri >= 3.1.1` (path traversal via percent-encoded dots, GHSA-q3j6-qgpj-74h6).
- `PUT /api/settings` enforces a strict allowlist of 32 known keys, rejecting all
  unknown keys with `400 unknown_setting_key`. `GET /api/settings` filters the
  response through the same allowlist so internal keys (`access_password_hash`,
  `mcp_servers`, `remote_session:*`, etc.) cannot leak via authenticated round-trip (#81).
- `PUT /api/ops/workflow-packs/:key/positions` validates the body with a strict Zod
  schema (≤200 phases, finite numbers, no extra fields) before writing to disk (#82).
- Approve handler stops the active agent process before mutating phase state, mirroring
  the `/reset` and `/reset-from` endpoints (#57).
- Phase-approve re-run now goes through `deps.runTask` instead of an HTTP self-loop, removing
  the dead `SESSION_AUTH_TOKEN`/port handling (#59).
- `sanitizeOAuthRedirect` rejects protocol-relative `//host/path` redirects (X-008 review).

### Accessibility

- `MobileBottomSheet` now exposes `role="dialog"` + `aria-modal`, traps focus, and
  closes on Escape (#52).
- Pixi.js office canvas honors `prefers-reduced-motion` for wandering, walk-cycle,
  bobbing, and pulse animations (#61).
- Light-theme `--text-muted` and `--accent-text` darkened to meet WCAG AA contrast (#62).
- Topbar nav, ghost buttons, `+ NEW MISSION`, and pack selector enlarged to ≥36×36 (#63).
- Pixi office canvas has an accessible DOM-twin department list revealed on
  `:focus-within` for screen-reader and keyboard users (#64).

### Frontend

- `useMobile` hook is SSR/test-safe and falls back to legacy `MediaQueryList.addListener`
  on older Safari (#60).
- `App.tsx` extracted into `RoomThemesContext`, `DecisionInboxContext`, and
  `useOfficePackBootstrap` hook; remaining handlers memoized with `useCallback` (#65).
- `useAgentLayer` per-agent sprite-load failures are isolated and logged via
  `Promise.all(agents.map(...))` instead of fire-and-forget `forEach`-async (#84).

### Architecture

- `connectors/built-in/comfyui/http.ts` now owns the ComfyUI HTTP helpers; the legacy
  `modules/workflow/comfyui/*` exports are `@deprecated` re-exports. New
  architecture test guards against future cross-layer imports (#55).
- `graph-builder.ts` moved into `server/packs/`, breaking the mutual recursion with
  the orchestration layer; new architecture test enforces `packs/` does not import
  from `modules/workflow/` (#56).
- `routeFollowUpViaCeo` returns a discriminated `RoutingResult` (`{decision} | {decision: null, reason}`)
  with metrics emitted per branch (`ceo.followup.routing`, #58).

### Type Safety

- Removed `Promise<any>` casts from `src/api/messaging-runtime-oauth.ts` (#78).
- `CrossDeptCooperationDeps`, `ReportRoutingDeps`, `ReviewConsensusDeps`, and
  `OutcomeContext` replaced with concrete `Pick<RuntimeContext, …>` interfaces (#79, #80).
- `db: any` replaced with structural `DbLike` across 13 deps interfaces in
  `collab/`, `agents/`, `meetings/`, and `planned-approval` (#83).
- LLM API responses validated with per-provider Zod schemas; throws typed
  `LlmResponseParseError` instead of silently returning empty strings (#85).
- CSRF guard `res` parameter typed as `express.Response` (#86).
- `cli-auth` route handlers narrow caught errors via `unknown` + `toErrorMessage` (#87).

### Tests / Coverage

- Backend test count: 1900 → **2492** (+30 %).
- Backend statement coverage: 35.47 % → **39.34 %**; branch **71.78 %**;
  function **72.97 %**.
- New tests for `message-idempotency` (99 %), `oauth/encryption` (100 % branch),
  `decision-inbox-routes` (96.79 %), `opencode` adapter (100 %), `context-sharing`
  (100 %), `planned-approval` (100 %), `planning-archive-tools` (100 %),
  `oauth/helpers` PKCE/redirect (combined 100 % branch), `oauth-runtime` (95.91 %),
  `cli-runtime` spawn path (86.92 %), `ceo-orchestrator` tick loop (97.30 %).
- Frontend test count: 217 → 270 (+24 %).

## [2.5.2] - 2026-05-07

See the [detailed release notes](docs/releases/v2.5.2.md) for the complete write-up.

### Fixed

- Replaced remaining `pnpm setup` references with `pnpm run setup` across
  CHANGELOG, release notes, AGENTS templates, setup scripts, and runtime
  routes (`setup-status`, OpenClaw `agent_upgrade_required` payload). The
  bare `pnpm setup` command is reserved by pnpm itself for installing pnpm
  and would not run the project setup script.
- `scripts/setup-wizard.mjs` no longer hangs when stdin is non-interactive
  (piped, redirected, or absent — common in CI, Docker provisioning, and
  AI-coding-agent driven installs). When `process.stdin.isTTY` is false or
  the new `--yes` / `-y` flag is passed, the wizard accepts all defaults
  without prompting. `bash install.sh --yes` is the recommended shorthand.

### Docs

- Simplified `docs/how-it-works.svg` to a single linear pipeline diagram.

## [2.5.1] - 2026-04-28

See the [detailed release notes](docs/releases/v2.5.1.md) for the complete write-up.

### Added

- Mobile agent picker in the Chat Panel — switch the active agent without leaving
  the conversation view.

### Security

- Dependency security patches via pnpm overrides: `@xmldom/xmldom >=0.8.13`,
  `hono >=4.12.14`, `@hono/node-server >=1.19.13`, `postcss >=8.5.10`.
- Auth hardening, data validation, WebSocket safety, and API shape consistency
  (deep audit follow-up).

### Changed

- Release polish: community health files (`CODE_OF_CONDUCT.md`, `CHANGELOG.md`),
  `package.json` metadata (`description`, `repository`, `homepage`, `bugs`,
  `keywords`, `author`), README troubleshooting section, CONTRIBUTING branch
  model sync.
- Reports now always produce a markdown deliverable; the presentation output
  format, its design-checkpoint workflow, and the upstream `tools/ppt_team_agent`
  submodule have been removed.
- `templates/AGENTS-octooffice.md` restored so `pnpm run setup` works on a fresh
  clone (was missing from the shipped tree).
- Personal identifiers in UI placeholders and test fixtures replaced with
  neutral RFC 5737 documentation values.

### Fixed

- `pnpm build` regression from the dormant-code cleanup (unused binding in
  `server/modules/workflow/orchestration.ts`).
- Auth noise, New Pack dialog race condition, `branches` endpoint, and CSRF
  token race on realtime-updates session restore.
- E2E test suite: pack-selector contamination, department ID casing, settings
  language selector, SetupWizard overlay, and WebSocket UI test flakiness.
- Mobile UI polish: header, bottom sheet, tab bar typography, Projects view,
  Mission Control tabs, and Terminal panel header.

## [2.5.0] - 2026-04-21

Full rebrand release with a new visual identity, redesigned home layout, unified
navigation, live activity panel, and safer autonomous scheduling. See the
[detailed release notes](docs/releases/v2.5.0.md) for the complete write-up.

### Added

- `MissionControl` 3-column Office home layout: `AgentSidebarPanel` (left),
  embedded `RetroOfficeView` + `MiniKanban` + `MetricsStrip` (center), and
  collapsible `ChatPanel` (right).
- `LiveTaskView` panel streaming agent activity, CLI output, and phase state
  via existing `cli_output` / `subtask_update` WebSocket events.
- Phase selection UI in task creation: pick a starting phase for pack-based
  tasks (`POST /api/core/tasks` now accepts optional `startPhaseId`).
- `OctoOfficeTopBar` — unified 46px top-bar navigation (Office, Tasks, Ops,
  Roster, Library, Projects, Settings) with theme toggle, clock, and action
  buttons.
- New pixel-art logo at `public/assets/octooffice-logo.svg`.

### Changed

- Rebranded the application to OctoOffice with a new dark palette
  (`#0d0d0f` base + `#34D399` emerald accent) and light palette
  (`#fafafa` base + `#10B981` emerald accent).
- Typography standardised on `Press Start 2P` for pixel headers and
  `JetBrains Mono` for body and data readouts.
- CSS custom properties (`--bg-base`, `--accent`, `--border`) are now the
  canonical colour tokens across all components.
- `RetroSidebar` and `RetroHeader` replaced by the unified `OctoOfficeTopBar`.
- `TerminalPanel` restyled with the new palette and pinned below the top
  bar via `--topbar-height`.
- Pack-to-department mapping is now owned by each pack's `departments:`
  YAML section; runtime department sync reads from there at hydration.
- Web research pack: removed the unused analysis department.
- Graph editor: more reliable drag-to-connect ports, improved node layout
  and label rendering, refined Editor/Builder modes, and a more accurate
  YAML preview panel.
- Autonomous CEO scheduler now skips tasks with subtasks in
  `awaiting_approval` state to prevent automation past approval gates
  (manual execution is unaffected).
- Seed agents renamed to German names for German-locale deployments.

### Fixed

- Pipeline subtasks reset on hard failure, enabling clean retry without
  manual intervention.
- Build errors and workflow view layout issues (#23).
- Security and UX issues surfaced during code review (#24).

### Removed

- Design mockup images and legacy pre-rebrand branding assets.

[Unreleased]: https://github.com/Chepko932/OctoOffice/compare/v2.6.0...HEAD
[2.6.0]: https://github.com/Chepko932/OctoOffice/compare/v2.5.2...v2.6.0
[2.5.2]: https://github.com/Chepko932/OctoOffice/compare/v2.5.1...v2.5.2
[2.5.1]: https://github.com/Chepko932/OctoOffice/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/Chepko932/OctoOffice/releases/tag/v2.5.0
