# Third Party Notices

Iron Command OS incorporates and derives from third-party open source work.
This file records what was taken, under which licence, and what was changed.

---

## 1. OctoOffice — vendored codebase

- **Upstream**: https://github.com/Chepko932/OctoOffice
- **Version imported**: v2.7.0 (commit `0e69d0b`, branch `main`)
- **Licence**: Apache License 2.0
- **Copyright**: Copyright (c) Joshua Dormann

Iron Command OS is a fork of OctoOffice. The complete upstream tree was
imported as a single commit (`chore: import OctoOffice v2.7.0 as Iron Command
OS base`) so that every subsequent change is reviewable as a diff against the
unmodified baseline.

The Apache-2.0 `LICENSE` file is preserved verbatim at the repository root and
continues to govern the vendored portions.

### Modifications made to OctoOffice code

Per section 4(b) of the Apache License, the following files carry
Iron Command OS modifications:

| File                                                                                   | Change                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `server/adapters/adapter-interface.ts`                                                 | Added `permissionMode` to `InvocationContext`.                                              |
| `server/adapters/claude.ts`                                                            | Removed hardcoded `--dangerously-skip-permissions`; permission flags are now policy-driven. |
| `server/adapters/codex.ts`                                                             | Removed hardcoded `--yolo`; defaults to a read-only sandbox.                                |
| `server/adapters/gemini.ts`                                                            | Removed hardcoded `--yolo`; defaults to `--approval-mode default`.                          |
| `server/modules/workflow/core/cli-tools.ts`                                            | Same permission-flag change on the second argv-building path.                               |
| `server/modules/workflow/agents/cli-runtime.ts`                                        | Added a pre-spawn guard rejecting unauthorised permission-bypass flags.                     |
| `server/modules/bootstrap/migrations/registry.ts`                                      | Registered migration `0002-iron-command-domain`.                                            |
| `server/server-main.ts`                                                                | Mounted the Iron Command control plane under `/api/ic`.                                     |
| `server/test/adapters/{claude,codex,gemini}-adapter.test.ts`                           | Updated to assert the safe defaults instead of the removed unsafe flags.                    |
| `src/app/types.ts`, `src/app/AppMainLayout.tsx`, `src/components/OctoOfficeTopBar.tsx` | Added the `command` view and its navigation entry.                                          |
| `.gitignore`                                                                           | Added Iron Command entries.                                                                 |

All files under `server/ironcommand/`, `src/ironcommand/` and `config/` are
original Iron Command OS work, not derived from OctoOffice.

---

## 2. OneManCompany — conceptual reference only

- **Upstream**: https://github.com/1mancompany/OneManCompany
- **Licence**: Apache License 2.0
- **Copyright**: Copyright (c) OneManCompany contributors

**No code was copied.** OneManCompany is a Python/FastAPI project; per the
Iron Command architecture rules there is no Python sidecar and no bidirectional
synchronisation with it.

Concepts studied and independently reimplemented in TypeScript:

- The Executive-Assistant-as-single-entry-point model, and the idea of an
  explicit triage step before any delegation
  (→ `server/ironcommand/orchestrator/triage.ts`).
- An explicit task-phase transition table rather than free-form status strings
  (→ `server/ironcommand/domain/task-state.ts`).
- Separation of persona ("talent") from runtime limits ("vessel") from tool
  permissions (→ `server/ironcommand/domain/crew-config.ts`).
- Prompt assembly from named, priority-ordered sections
  (→ `buildAgentGuidance()`).

Iron Command's implementations differ substantially: they are TypeScript,
SQLite-backed rather than YAML-on-disk, and the triage classifier is
deterministic rather than an LLM call.

---

## 3. Paperclip — conceptual reference only

- **Upstream**: https://github.com/paperclipai/paperclip
- **Licence**: MIT
- **Copyright**: Copyright (c) 2025 Paperclip AI

**No code was copied.** Paperclip targets PostgreSQL with Drizzle ORM;
Iron Command targets SQLite via `node:sqlite`, so the mechanics were
reimplemented rather than ported.

Mechanics studied and independently reimplemented:

- Compare-and-set task claiming instead of a lock table, checking the affected
  row count (→ `TaskStore.claim()` in `server/ironcommand/domain/task-store.ts`).
- The execution-lock triple on the task row, with release guarded on the
  owning run id so a late reaper cannot clear a fresh owner's lock
  (→ `TaskStore.releaseLock()`, `TaskStore.recoverOrphaned()`).
- Optimistic concurrency via a `status_version` column
  (→ `ic_tasks.status_version`).
- Two-point budget enforcement: a pre-dispatch gate plus post-spend
  re-evaluation, with soft-warn and hard-stop thresholds
  (→ `server/ironcommand/policy/budget-engine.ts`).
- Company-scoped tenancy on every business table from the outset.

Since the MIT licence permits reuse with attribution, this notice serves as the
attribution for the design influence even though no source was copied.

---

## 4. Honcho — optional external service

- **Upstream**: https://github.com/plastic-labs/honcho
- **Licence**: AGPL-3.0

**No code was copied and none is vendored.** Honcho is treated strictly as an
optional external memory service reached over its network interface, behind the
`MemoryProvider` abstraction. Its server code is deliberately not incorporated
into this repository, which keeps the AGPL's source-provision obligations with
the Honcho deployment rather than with Iron Command OS.

---

## 5. Runtime dependencies

Third-party npm dependencies retain their own licences as declared in
`package.json` and `pnpm-lock.yaml`. Run `pnpm licenses list` for the current
resolved set.

## 6. Media and character assets

No copyrighted images, actor likenesses, audio, franchise logos or scraped
assets are committed to this repository. The seed crew in
`config/agents.seed.yaml` uses original archetype names. Private naming and
portraits live in gitignored paths (`config/private/`,
`data/private-assets/`) and are never distributed with this repository.
