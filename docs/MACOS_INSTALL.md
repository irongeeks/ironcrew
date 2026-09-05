# Installation — macOS

For a guided first start, follow [Erste Schritte](GETTING_STARTED.md).
For stable installations, follow [Releases and updates](RELEASES.md).
That procedure supersedes older branch-based update commands below.

IronCrew is self-hosted and local-first. The platform CI verifies the current
GitHub-hosted macOS runner; use Node22+ on a supported macOS release.

## Requirements

| Requirement              | Version                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| macOS                    | 13 or newer                                                             |
| Node.js                  | 22 or newer (SQLite is a Node 22 builtin — no native module to compile) |
| pnpm                     | 10.30.1 (pinned in package.json)                                                             |
| Xcode Command Line Tools | for `git`                                                               |

```bash
xcode-select --install          # if git is missing
brew install node@22 pnpm
node --version                  # must print v22.x or newer
```

If Homebrew's Node is not first on your `PATH`:

```bash
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Optional runtimes — Claude Code (`claude`), OpenAI Codex (`codex`), Google
Antigravity (`agy`). None is required: IronCrew ships **MockRuntime**, so
the full product works end to end without any provider login. Start there.

## Install

```bash
git clone https://github.com/irongeeks/ironcrew.git
cd ironcrew
pnpm install
```

## Configure

```bash
cp .env.example .env
```

```bash
API_AUTH_TOKEN=$(openssl rand -hex 32)   # paste the value into .env
DB_PATH=./data/ironcrew.sqlite
LOGS_DIR=./data/logs
HOST=127.0.0.1
PORT=8790
```

**Provider API keys do not belong in `.env` outside development.** Use the
macOS Keychain; see `docs/PROVIDER_AUTH.md`.

Company configuration lives in `config/` — `vendor-policy.yaml`,
`departments.yaml`, `agents.seed.yaml`. For private agent naming:

```bash
cp config/private/character-pack.local.example.yaml \
   config/private/character-pack.local.yaml
```

That file is gitignored, and may change cosmetic fields only — policy, tools and
roles cannot be altered through it.

## Run

```bash
pnpm dev:local                        # http://127.0.0.1:8800
```

or production-style:

```bash
pnpm build && pnpm start
```

Complete the setup wizard on first start, then open the **COMMAND** tab.

## Verify

```bash
pnpm test
pnpm build
pnpm lint
```

The vendor policy must refuse a blocked model at the API, not merely hide it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
     -X POST -H "Authorization: Bearer $API_AUTH_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"model":"deepseek/deepseek-chat"}' \
     http://127.0.0.1:8800/api/crew/vendor-policy/check
# expect: 403
```

## Native services (launchd)

Use the supplied LaunchDaemon templates in `deploy/launchd/` and the portable
`node scripts/deploy-service.mjs` renderer/installer. It supports both Intel and
Apple Silicon Node paths, keeps configuration in mode-0600 files rather than the
plist, and runs the control plane and runner as separate dedicated accounts.

See [SECURITY_OPERATIONS.md](SECURITY_OPERATIONS.md) for account provisioning,
render/install/uninstall and explicit `launchctl bootstrap`/`bootout` commands.
The installer never starts a service or performs a CLI login automatically.
The macOS CI job validates the generated plists with `plutil` and runs native
runner/persistence/backup tests. Test your actual official CLI login separately.

## macOS specifics

**Gatekeeper.** A newly installed CLI may be quarantined on first run. If macOS
refuses to open it, allow it once under System Settings → Privacy & Security.

**Full Disk Access.** Agents run under `restricted` permissions by default and
should only ever touch their assigned workspace. Do **not** grant Full Disk
Access to your terminal to "make things work" — that removes a boundary the
product relies on.

**Apple Silicon.** Use a native Node build. SQLite is built in, but optional native
dependencies such as node-pty may need Xcode Command Line Tools during installation.

**`PATH` under launchd** is minimal and will not include your shell profile, so
CLI runtimes must be on the explicit `PATH` in the runner environment file.

## Backups

Follow [BACKUP_RESTORE.md](BACKUP_RESTORE.md) to protect SQLite, uploaded characters,
attachments, the vault and configuration. Verify recovery to an isolated directory.

## Troubleshooting

**`command not found: node`** — Homebrew's `node@22` is keg-only; add it to
`PATH` as shown above.

**Every API call returns 401** — `API_AUTH_TOKEN` is unset or mismatched. When
unset, a random token is generated at boot and changes on every restart.

**Port 8800 already in use** — `lsof -nP -iTCP:8800 -sTCP:LISTEN`.

**launchd starts then immediately stops** — check
`/var/lib/ironcrew/service-error.log` and the runner equivalent; verify Node path,
environment permissions and configured secrets.
