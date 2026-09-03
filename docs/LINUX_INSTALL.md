# Installation — Linux

Iron Command OS is self-hosted and local-first. Everything runs on your own
machine; nothing is sent to a third party unless you configure a provider.

## Requirements

| Requirement | Version                                                              |
| ----------- | -------------------------------------------------------------------- |
| Node.js     | 22 or newer (SQLite support is a Node 22 builtin — no native module) |
| pnpm        | 10 or newer                                                          |
| git         | any recent version                                                   |
| RAM         | 2 GB free is comfortable                                             |

Optional, only if you want that runtime:

- Claude Code CLI (`claude`) — an active Claude subscription
- OpenAI Codex CLI (`codex`) — a ChatGPT account
- Google Antigravity CLI (`agy`)

Iron Command ships **MockRuntime**, so the whole product works end to end with
none of those installed. That is the recommended way to try it first.

## Install

```bash
git clone https://github.com/irongeeks/ironcrew.git
cd ironcrew
pnpm install
```

If Node 22 is not your default:

```bash
# with nvm
nvm install 22 && nvm use 22
node --version    # must print v22.x or newer
```

## Configure

```bash
cp .env.example .env
```

Set at minimum:

```bash
# A long random value. Sessions and encryption derive from it.
API_AUTH_TOKEN=$(openssl rand -hex 32)

# Where the database and logs live.
DB_PATH=./data/ironcommand.sqlite
LOGS_DIR=./data/logs

# Bind to localhost unless you know you want otherwise.
HOST=127.0.0.1
PORT=8800
```

**Do not put provider API keys in `.env` for production use.** They belong in a
secret store; see `docs/PROVIDER_AUTH.md`. `.env` is acceptable for development
only.

### Company configuration

Everything about your company is in `config/`:

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `vendor-policy.yaml`                | which model vendors may be used — enforced in the backend  |
| `departments.yaml`                  | your departments                                           |
| `agents.seed.yaml`                  | the seed crew: role, policy and persona per agent          |
| `private/character-pack.local.yaml` | optional, gitignored: your own display names and portraits |

To use your own agent naming without committing it:

```bash
cp config/private/character-pack.local.example.yaml \
   config/private/character-pack.local.yaml
$EDITOR config/private/character-pack.local.yaml
```

A character pack may change **only** cosmetic fields. Any attempt to alter
policy, tools or roles through it is rejected at load — see
`docs/ARCHITECTURE.md`.

## Run

Development, with hot reload:

```bash
pnpm dev
# web: http://127.0.0.1:8800
```

Production-style, serving the built frontend:

```bash
pnpm build
pnpm start
```

On first start you will see the setup wizard. Complete it, then open the
**COMMAND** tab for the Iron Command control plane.

## Verify the installation

```bash
pnpm test        # unit and integration tests
pnpm build       # type check and bundle
pnpm lint
```

Then check the control plane is alive:

```bash
curl -s -H "Authorization: Bearer $API_AUTH_TOKEN" \
     http://127.0.0.1:8800/api/ic/dashboard | head
```

Confirm the vendor policy is enforced server-side — this must return **403**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
     -X POST -H "Authorization: Bearer $API_AUTH_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"model":"deepseek/deepseek-chat"}' \
     http://127.0.0.1:8800/api/ic/vendor-policy/check
```

## Run as a service (systemd)

Create a dedicated user so the service never runs as root:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin ironcommand
sudo cp -r . /opt/ironcrew
sudo chown -R ironcommand:ironcommand /opt/ironcrew
```

`/etc/systemd/system/ironcommand.service`:

```ini
[Unit]
Description=Iron Command OS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ironcommand
Group=ironcommand
WorkingDirectory=/opt/ironcrew
EnvironmentFile=/opt/ironcrew/.env
ExecStart=/usr/bin/node --experimental-strip-types server/index.ts
Restart=on-failure
RestartSec=5

# Hardening. The service needs its own data directory and nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/ironcrew/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ironcommand
sudo systemctl status ironcommand
journalctl -u ironcommand -f
```

> **Note on CLI runtimes.** `ProtectHome=true` means the service cannot read a
> human user's `~/.claude` or `~/.codex` logins — which is deliberate. Running
> real CLI runtimes under a service account requires the native runner daemon
> described in `docs/RUNNER_PROTOCOL.md`, which is not implemented yet. Until
> then, run interactively (`pnpm dev`) as the user who owns those logins.

## Docker Compose

A `compose.yaml` is inherited from upstream and runs the control plane. Note
that a containerised control plane **cannot** use your host CLI logins, and
mounting your home directory to give it them would expose every credential in
it. Use MockRuntime or API-key providers in a container; see
`docs/THREAT_MODEL.md` T-05.

## Backups

Everything lives in one SQLite file plus the logs directory. Stop the service,
copy `data/`, restart. WAL mode means a live copy can be inconsistent — stop
first, or use `sqlite3 … ".backup"`.

## Troubleshooting

**`SyntaxError` or unknown option on start** — Node is older than 22.
`node --version`.

**`SQLITE_BUSY`** — another process holds the database. Only one control plane
per `DB_PATH`.

**Every API call returns 401** — `API_AUTH_TOKEN` is unset or does not match.
When unset, a random token is generated at boot and changes on every restart.

**The setup wizard blocks the UI** — complete it, or
`PUT /api/settings {"onboarding_completed": true}`.

**A model is refused with 403** — that is the vendor policy working. Check
`config/vendor-policy.yaml`; the response says which rule matched.
