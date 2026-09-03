# Installation — macOS

Iron Command OS is self-hosted and local-first. Tested against macOS 13
(Ventura) and newer, on both Apple Silicon and Intel.

## Requirements

| Requirement              | Version                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| macOS                    | 13 or newer                                                             |
| Node.js                  | 22 or newer (SQLite is a Node 22 builtin — no native module to compile) |
| pnpm                     | 10 or newer                                                             |
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
Antigravity (`agy`). None is required: Iron Command ships **MockRuntime**, so
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
DB_PATH=./data/ironcommand.sqlite
LOGS_DIR=./data/logs
HOST=127.0.0.1
PORT=8800
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
pnpm dev                        # http://127.0.0.1:8800
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
     http://127.0.0.1:8800/api/ic/vendor-policy/check
# expect: 403
```

## Run at login (launchd)

Run it as **your own user**, not a system daemon: the CLI runtimes use logins
stored in your home directory, and a `LaunchDaemon` running as another user
cannot reach them.

`~/Library/LaunchAgents/com.irongeeks.ironcommand.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.irongeeks.ironcommand</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/node</string>
    <string>--experimental-strip-types</string>
    <string>server/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/YOURNAME/ironcrew</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>8800</string>
    <key>DB_PATH</key><string>/Users/YOURNAME/ironcrew/data/ironcommand.sqlite</string>
    <key>LOGS_DIR</key><string>/Users/YOURNAME/ironcrew/data/logs</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>          <true/>
  <key>KeepAlive</key>          <true/>
  <key>StandardOutPath</key>    <string>/Users/YOURNAME/ironcrew/data/logs/stdout.log</string>
  <key>StandardErrorPath</key>  <string>/Users/YOURNAME/ironcrew/data/logs/stderr.log</string>
</dict>
</plist>
```

Replace `YOURNAME`, then:

```bash
launchctl load  ~/Library/LaunchAgents/com.irongeeks.ironcommand.plist
launchctl list | grep ironcommand
launchctl unload ~/Library/LaunchAgents/com.irongeeks.ironcommand.plist   # to stop
```

`API_AUTH_TOKEN` is deliberately absent from the plist — plists are
world-readable. Keep it in `.env`, which the process loads from its working
directory, and `chmod 600 .env`.

## macOS specifics

**Gatekeeper.** A newly installed CLI may be quarantined on first run. If macOS
refuses to open it, allow it once under System Settings → Privacy & Security.

**Full Disk Access.** Agents run under `restricted` permissions by default and
should only ever touch their assigned workspace. Do **not** grant Full Disk
Access to your terminal to "make things work" — that removes a boundary the
product relies on.

**Apple Silicon.** No native modules are involved (SQLite is a Node builtin),
so there is nothing to compile and no Rosetta requirement.

**`PATH` under launchd** is minimal and will not include your shell profile, so
CLI runtimes must be on the explicit `PATH` in the plist.

## Backups

Everything is `data/` — one SQLite file plus logs. Stop the service before
copying; WAL mode means a live copy can be inconsistent. Alternatively:

```bash
sqlite3 data/ironcommand.sqlite ".backup 'data/backup-$(date +%F).sqlite'"
```

## Troubleshooting

**`command not found: node`** — Homebrew's `node@22` is keg-only; add it to
`PATH` as shown above.

**Every API call returns 401** — `API_AUTH_TOKEN` is unset or mismatched. When
unset, a random token is generated at boot and changes on every restart.

**Port 8800 already in use** — `lsof -nP -iTCP:8800 -sTCP:LISTEN`.

**launchd starts then immediately stops** — check
`data/logs/stderr.log`; the usual cause is a `PATH` that does not include Node.
