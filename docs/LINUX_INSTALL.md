# Installation — Linux

IronCrew is self-hosted and local-first. Everything runs on your own
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

IronCrew ships **MockRuntime**, so the whole product works end to end with
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
DB_PATH=./data/ironcrew.sqlite
LOGS_DIR=./data/logs

# Bind to localhost unless you know you want otherwise.
HOST=127.0.0.1
# The API server's port (server/config/runtime.ts). 8800 is the Vite dev
# server, which proxies here — setting PORT=8800 makes the two collide.
PORT=8790
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
**COMMAND** tab for the IronCrew control plane.

## Verify the installation

```bash
pnpm test        # unit and integration tests
pnpm build       # type check and bundle
pnpm lint
```

Then check the control plane is alive:

```bash
curl -s -H "Authorization: Bearer $API_AUTH_TOKEN" \
     http://127.0.0.1:8800/api/crew/dashboard | head
```

Confirm the vendor policy is enforced server-side — this must return **403**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
     -X POST -H "Authorization: Bearer $API_AUTH_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"model":"deepseek/deepseek-chat"}' \
     http://127.0.0.1:8800/api/crew/vendor-policy/check
```

## Run as a service (systemd)

Do not hand-copy a unit file. The repository ships one, plus an installer:

| File                          | Purpose                                     |
| ----------------------------- | ------------------------------------------- |
| `deploy/ironcrew.service`     | the systemd unit, hardened and commented    |
| `deploy/ironcrew.env.example` | every environment variable the server reads |
| `scripts/install-service.sh`  | idempotent installer for both of the above  |

```bash
# The service runs the checkout in place — put it where it belongs first.
sudo git clone https://github.com/irongeeks/ironcrew.git /opt/ironcrew
cd /opt/ironcrew && sudo pnpm install && sudo pnpm build

sudo scripts/install-service.sh
```

**What the installer does.** It refuses to run as anything but root, creates
the `ironcrew` system user (no login shell, home in `/var/lib/ironcrew`),
creates `data/` and `data/logs/` owned by that user, copies
`deploy/ironcrew.env.example` to `/etc/ironcrew/ironcrew.env` with mode 600 —
**only if that file does not already exist**, so re-running never destroys your
configuration — templates the unit with your prefix, user and `node` path,
installs it and runs `daemon-reload`.

It does **not** start anything. Fill in the environment file, then enable the
service yourself:

```bash
sudoedit /etc/ironcrew/ironcrew.env     # at minimum OAUTH_ENCRYPTION_SECRET
sudo systemctl enable --now ironcrew
sudo systemctl status ironcrew
journalctl -u ironcrew -f
```

Another prefix or user: `--prefix /srv/ironcrew --user crew`. Removing it
again: `sudo scripts/install-service.sh --uninstall`, which stops, disables and
deletes the unit but never touches the data directory or the environment file.
Update, backup and log details are in `deploy/README.md`.

The unit logs to journald, restarts on failure, and gives up after 5 starts in
5 minutes instead of crash-looping forever. The application directory is
read-only to the service; only `data/` and `/var/lib/ironcrew` are writable.

For production, use the dedicated native runner and separate service accounts.
The runner daemon is implemented: CLI credentials stay with `ironcrew-runner` and
the control plane receives normalized events over an authenticated socket or TLS.
Do not authenticate the control-plane account with your personal CLI subscription.
The current installer, service definitions and explicit start/stop commands are in
[SECURITY_OPERATIONS.md](SECURITY_OPERATIONS.md).

## Docker Compose

A `compose.yaml` is inherited from upstream and runs the control plane. Note
that a containerised control plane **cannot** use your host CLI logins, and
mounting your home directory to give it them would expose every credential in
it. Connect the authenticated native runner or use MockRuntime; see
`docs/THREAT_MODEL.md` T-05.

## Backups

Use [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Protect the SQLite snapshot, uploaded
characters, attachments, vault, configuration and encryption secret. A live plain
copy of a WAL-mode SQLite file is not a safe backup.

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
