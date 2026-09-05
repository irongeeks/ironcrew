# Native CLI verification and acceptance

IronCrew probes the installed executable with bounded `--version`/`--help`
commands. Codex additionally probes `exec --help` and, when advertised,
`exec resume --help`. Version output is reduced to a version number. Probe
results are cached for 30 seconds; missing required flags stop dispatch.
Neither CLI installation nor streaming capability is proof of authentication.

## Supported contracts

- Claude Code: explicit `--resume SESSION_ID`, print/stream-json mode. Restricted
  runs explicitly select `--permission-mode plan`, including resumed sessions,
  so a local default or previous session cannot silently select a broader mode.
  Workspace-write selects `acceptEdits`; elevation still requires the existing
  approval policy. Optional partial-message/max-turn flags are used only when
  present in help.
- Codex: `exec resume SESSION_ID -` with JSONL and the current permission policy.
  The runtime no longer blindly enables an assumed `multi_agent` feature.
- Antigravity: `agy --conversation SESSION_ID`, only if the locally installed
  help confirms it and stream-json. IronCrew neither downloads an executable
  nor substitutes another program when `agy` is missing.
- Gemini's advertised `--resume` is usable when local help confirms it; no
  undocumented authentication-status command is invented.

Claude's advertised `auth status` JSON and Codex's advertised `login status`
are mapped to a verified boolean and a fixed authentication-method label.
Raw output, account email and credential fields never leave the probe.
A verified local login does **not** confirm current online quota or token validity.
Antigravity/Gemini remain `unverified` until a supported status contract exists.
No login flow is launched, and IronCrew does not read credential files itself.

Session references are captured from initial native events and included in
normalized events immediately, then again in terminal events. Unsupported
resume fails explicitly; it never silently creates a fresh session. The
orchestrator remains responsible for company/task/agent/runtime/permission/
workspace scoping of a persisted reference.

## Operator acceptance on Linux or macOS

Run under the dedicated runner user, in a disposable configured project
workspace. Install the official CLI yourself and finish its official login
flow locally. Do not copy credentials into IronCrew, containers or this repo.

Check only (no model request):

```bash
node --import tsx scripts/qa/ironcrew-runtime-acceptance.ts --provider claude --workspace /absolute/disposable-project
```

After reviewing the target workspace, explicitly request the small real
start/resume proof:

```bash
node --import tsx scripts/qa/ironcrew-runtime-acceptance.ts --provider claude --workspace /absolute/disposable-project --execute
```

Use `codex`, `antigravity` or `gemini` as `--provider` when appropriate. The
script rejects unknown providers and requires an existing absolute directory.
It emits only status metadata/event types and checks that the resumed session
remembers a random marker. No model credentials, model response text, prompts,
or account identifiers are printed. Real calls consume the operator's quota.
For providers whose auth status is unverified, the explicit `--execute` flag
is the operator's decision to attempt the supported CLI; a failed login/run is
reported as failure, not as successful integration.

In the Web UI, also verify cancellation of a long harmless run, streaming,
review/revision, and restart recovery with the same project. Retain normalized
run IDs and the resulting audit records as evidence. A successful subprocess
fixture test is not a real account acceptance test.

## Primary references

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude programmatic usage](https://code.claude.com/docs/en/headless)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex non-interactive output](https://developers.openai.com/codex/noninteractive)
- [Google Antigravity headless mode](https://antigravity.google/docs/cli/headless/)
- [Google Antigravity installation and authentication](https://antigravity.google/docs/cli/install/)

Local help remains the acceptance gate for the installed version. No official
CLI/account acceptance has been claimed merely from these references.
