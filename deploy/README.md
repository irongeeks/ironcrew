# Deployment (systemd)

Everything needed to run IronCrew as a system service, so the machine keeps it
alive and no console has to stay open.

| File                            | What it is                                                         |
| ------------------------------- | ------------------------------------------------------------------ |
| `ironcrew.service`              | The systemd unit: hardened, journald logging, restart limits       |
| `ironcrew.env.example`          | Every environment variable the server reads, grouped and commented |
| `../scripts/install-service.sh` | Idempotent installer that wires the two together                   |

## Install

```bash
# 1. Put the checkout where the service will run it
sudo git clone https://github.com/irongeeks/ironcrew.git /opt/ironcrew
cd /opt/ironcrew && sudo pnpm install && sudo pnpm build

# 2. Install the service
sudo scripts/install-service.sh
```

The installer creates the `ironcrew` system user, creates
`/opt/ironcrew/data` and `/opt/ironcrew/data/logs`, copies the environment
example to `/etc/ironcrew/ironcrew.env` (mode 600, **never** overwriting an
existing file), templates the unit and runs `daemon-reload`. It deliberately
does **not** start anything — fill in the environment file first, then:

```bash
sudoedit /etc/ironcrew/ironcrew.env     # at minimum OAUTH_ENCRYPTION_SECRET
sudo systemctl enable --now ironcrew
```

Other layouts:

```bash
sudo scripts/install-service.sh --prefix /srv/ironcrew --user crew
sudo scripts/install-service.sh --help
```

## Update after a `git pull`

The service runs with a read-only application directory, so the update itself
is done by you, not by the service (leave `AUTO_UPDATE_ENABLED=0`).

```bash
cd /opt/ironcrew
sudo -u ironcrew git pull
sudo -u ironcrew pnpm install
sudo -u ironcrew pnpm run migrate:v1.0.5   # the prestart migration `pnpm start` would run
sudo -u ironcrew pnpm build
sudo scripts/install-service.sh            # refresh the unit; your env file is kept
sudo systemctl restart ironcrew
```

## Where things live

| Thing                | Path                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| Application          | `/opt/ironcrew` (read-only for the service)                             |
| Database             | `/opt/ironcrew/data/ironcrew.sqlite` (`DB_PATH`)                        |
| Logs (application)   | `/opt/ironcrew/data/logs` (`LOGS_DIR`)                                  |
| Configuration        | `/etc/ironcrew/ironcrew.env` (mode 600)                                 |
| Service account home | `/var/lib/ironcrew` — CLI runtime credentials (`~/.claude`, `~/.codex`) |
| Unit                 | `/etc/systemd/system/ironcrew.service`                                  |

Only the data directory and the service account's home are writable; the rest
of the filesystem is read-only to the service (`ProtectSystem=strict`).

## Logs

The service logs to journald. There is no log file to rotate.

```bash
journalctl -u ironcrew -f            # follow
journalctl -u ironcrew -n 200        # last 200 lines
journalctl -u ironcrew -p err -b     # errors since boot
systemctl status ironcrew
```

`LOGS_DIR` is separate: it holds IronCrew's own structured run logs, not the
process output.

## Background work

`IRONCREW_SCHEDULER` (`on` / `off`, default `on`) controls whether the service
does anything on its own — draining the run queue, polling mailboxes and
messengers. With `IRONCREW_SCHEDULER=off` the service still starts and answers
HTTP, but it never acts by itself: useful during a maintenance window, or when
a second instance should only serve the UI.

## Backups

Stop the service, copy `data/`, start it again. WAL mode means a live copy can
be inconsistent.

```bash
sudo systemctl stop ironcrew
sudo tar czf /var/backups/ironcrew-$(date +%F).tar.gz -C /opt/ironcrew data
sudo systemctl start ironcrew
```

Back up `/etc/ironcrew/ironcrew.env` separately and treat it as a secret.

## Uninstall

```bash
sudo scripts/install-service.sh --uninstall
```

Stops and disables the service and removes the unit. The data directory, the
environment file, the application and the `ironcrew` user are kept — remove
them by hand if you mean to.
