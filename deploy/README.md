# Deployment (systemd)

Everything needed to run IronCrew as a system service, so the machine keeps it
alive and no console has to stay open.

| File                            | What it is                                                           |
| ------------------------------- | -------------------------------------------------------------------- |
| `ironcrew.service`              | The control plane's systemd unit: hardened, journald, restart limits |
| `ironcrew.env.example`          | Every environment variable the server reads, grouped and commented   |
| `../scripts/install-service.sh` | Idempotent installer for the **control plane only** — see the caveat |
| `ironcrew-runner.service`       | The runner's systemd unit — **installed by hand**, see [The runner]  |
| `ironcrew-runner.env.example`   | The runner's environment file; nothing copies it for you             |

There are **two** services here, not one. The control plane is the whole
product on a single-box install and everything below applies to it. The runner
is optional in the sense that IronCrew runs without it, and not optional at all
in the sense that without it the control plane holds the owner's CLI logins
itself — see [The runner](#the-runner-second-unit-manual-install).

[The runner]: #the-runner-second-unit-manual-install

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

**The installer does not install the runner.** `SERVICE_NAME` is hardcoded to
`ironcrew` in `scripts/install-service.sh`, and there is no flag to point it at
the other unit. Running it does not create the `ironcrew-runner` user, does not
copy `ironcrew-runner.env.example`, and does not install
`ironcrew-runner.service`. That is a real gap, not a design choice — it is
listed in `docs/UPGRADE.md`'s "Known gaps" — and the next section is the manual
procedure it leaves you.

## The runner: second unit, manual install

**What this is for.** The official CLI runtimes (`claude`, `codex`, `gemini`,
`agy`) authenticate as the owner, and they keep those credentials under
`$HOME`. Whichever process runs them can read them. Without the runner, that
process is the control plane — the same one that parses incoming mail, accepts
chat messages from paired strangers, installs skills from marketplaces and
serves an HTTP API to the network. Each of those is an ingress, and each is one
bug away from the account that pays for the models and can act as the owner
elsewhere.

The runner moves the logins to a separate OS user with its own home and its own
unit. The control plane connects over a Unix socket and receives capabilities,
health and normalised events — never a token. `docs/THREAT_MODEL.md` **T-17**
is the full argument, and `docs/RUNNER_PROTOCOL.md` the protocol.

**Say plainly what skipping it means.** An install with only
`ironcrew.service` works and is supported: the CLI runtimes then run inside the
control-plane process, which is why that unit has to move `HOME` to
`/var/lib/ironcrew` for the credentials to be usable at all. But T-17's
separation is then **not in force** — it is a design commitment on paper, and
the credentials sit with the process that faces the network. Nothing in the
product warns you about this; the only signal is that you never installed a
second unit.

### 1. The user, the home and the workspace root

The runner's home is outside `/home` so the unit's `ProtectHome=true` can stay
on, and it is where `claude login` will write.

```bash
sudo useradd --system --gid ironcrew \
  --home-dir /var/lib/ironcrew-runner --create-home ironcrew-runner
sudo chmod 700 /var/lib/ironcrew-runner

# Job workspaces. The runner refuses any job whose workspace is outside this
# root, checked with realpath — so a bug in the control plane cannot turn into
# file access under the account holding the credentials.
sudo install -d -o ironcrew-runner -g ironcrew -m 2770 /var/lib/ironcrew/workspaces
```

The `ironcrew` **group** is shared deliberately: the socket is `0660`, owned by
the runner user and group-readable by the control plane's user. That group
membership is the access control. A localhost TCP port would be reachable by
every process on the box — including anything an agent itself starts — which
would make the separation decorative.

### 2. The environment file

Nothing copies or renames the example. Do it yourself, and note the name
changes on the way — `ironcrew-runner.env.example` becomes `runner.env`,
because that is the path baked into the unit's `EnvironmentFile=`:

```bash
sudo install -m 600 -o ironcrew-runner -g ironcrew \
  deploy/ironcrew-runner.env.example /etc/ironcrew/runner.env
sudoedit /etc/ironcrew/runner.env
```

`IRONCREW_RUNNER_TOKEN` must be filled in — generate it with
`openssl rand -hex 32` — and the **same value** must appear in
`/etc/ironcrew/ironcrew.env`, along with the same `IRONCREW_RUNNER_SOCKET`.
Two files, one secret, and no code checks that you got it right: a mismatch
shows up as a runner that starts fine and a control plane whose CLI runtimes
all fail to connect.

Note what is deliberately **absent** from `runner.env`: no mailbox passwords,
no messenger tokens, no search keys, none of the business-pack integrations.
What the runner does not know, it cannot lose.

### 3. The unit

```bash
sudo cp deploy/ironcrew-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
```

The shipped unit has the default layout baked in — prefix `/opt/ironcrew`, user
`ironcrew-runner`, env file `/etc/ironcrew/runner.env`, socket
`/run/ironcrew/runner.sock`. Unlike `ironcrew.service`, nothing templates it,
so a non-default `--prefix` or `--user` means editing the copy by hand.

### 4. Log the CLIs in — as the runner, not as you

This is the step the whole arrangement exists for. Run it as the runner user
with its own `HOME`, or the credentials land in the wrong account and the
separation buys nothing:

```bash
sudo -u ironcrew-runner HOME=/var/lib/ironcrew-runner claude login
sudo -u ironcrew-runner HOME=/var/lib/ironcrew-runner codex login   # and so on
```

### 5. Point the control plane at it, and start in order

Uncomment both variables in `/etc/ironcrew/ironcrew.env`:

```bash
IRONCREW_RUNNER_SOCKET=/run/ironcrew/runner.sock
IRONCREW_RUNNER_TOKEN=<the same value as in runner.env>
```

With `IRONCREW_RUNNER_SOCKET` set, every CLI runtime becomes a `RunnerRuntime`
that forwards to the daemon; unset, they run inline. The orchestrator sees the
same contract either way and cannot tell the difference — which is what makes
the security property cost nothing.

```bash
sudo systemctl enable --now ironcrew-runner
sudo systemctl restart ironcrew
```

Runner first, so the control plane finds the socket already listening rather
than probing an absent one on its first job.

**Verify:**

```bash
systemctl status ironcrew-runner
ls -l /run/ironcrew/runner.sock        # srw-rw---- ironcrew-runner ironcrew
journalctl -u ironcrew-runner -f
```

Then in the Command Center, agent detail → Runtime, or `GET /api/crew/runtimes`:
each CLI runtime should report installed **and authenticated**. If it reports
installed but not authenticated, step 4 was run as the wrong user.

### On every update

The unit is a copy, so installing a release does not refresh it. Add this to your update
routine:

```bash
sudo cmp deploy/ironcrew-runner.service /etc/systemd/system/ironcrew-runner.service \
  || sudo cp deploy/ironcrew-runner.service /etc/systemd/system/ && sudo systemctl daemon-reload
```

And restart the runner **before** the control plane, for the same reason as
above. `docs/UPGRADE.md` covers version skew between the two in detail — they
speak a protocol, and restarting one and forgetting the other is the failure it
is written about.

## Release updates

Use the [versioned release and update procedure](../docs/RELEASES.md).
Updates target a published version and its exact commit, with a backup before
changing the installation. The web service never replaces its own code.

Stop the control plane and any runner using the same checkout before updating.
Refresh service definitions when the release notes require it; start the runner
before the control plane. A database migrated by a newer release must not be
opened by an older release without restoring the matching backup.

## Where things live

| Thing                | Path                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| Application          | `/opt/ironcrew` (read-only for both services)                         |
| Database             | `/opt/ironcrew/data/ironcrew.sqlite` (`DB_PATH`) — control plane only |
| Logs (application)   | `/opt/ironcrew/data/logs` (`LOGS_DIR`)                                |
| Configuration        | `/etc/ironcrew/ironcrew.env` (mode 600)                               |
| Service account home | `/var/lib/ironcrew`                                                   |
| Unit                 | `/etc/systemd/system/ironcrew.service`                                |

And, when the runner is installed:

| Thing          | Path                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| Runner config  | `/etc/ironcrew/runner.env` (mode 600, owner `ironcrew-runner`)                  |
| Runner home    | `/var/lib/ironcrew-runner` — the CLI logins (`~/.claude`, `~/.codex`) live here |
| Job workspaces | `/var/lib/ironcrew/workspaces`                                                  |
| Socket         | `/run/ironcrew/runner.sock` (`0660`, removed when the unit stops)               |
| Unit           | `/etc/systemd/system/ironcrew-runner.service`                                   |

The CLI credentials belong in exactly one of those two homes, never both:
`/var/lib/ironcrew-runner` when the runner is installed, `/var/lib/ironcrew`
when it is not. A copy left behind in the control plane's home after adding the
runner keeps the exposure the runner was installed to remove.

Only the data directory and each service account's own home are writable; the
rest of the filesystem is read-only to both (`ProtectSystem=strict`).

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
does anything on its own. On a default install it registers five jobs —
`run-queue`, `routines`, `mailboxes`, `messengers`, `sweep` — plus `audit-ship`
when an audit sink is configured.

With `IRONCREW_SCHEDULER=off` the service still starts and answers HTTP, but it
never acts by itself: useful during a maintenance window, or when a second
instance should only serve the UI. Note that this includes **every routine** —
recurring work stops entirely, silently, with no catch-up when it comes back
on. To stop one routine, disable that routine rather than the scheduler.
`docs/SERVICE.md` has the intervals, the per-job reasoning and the startup log
line to check.

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

The runner is not covered by `--uninstall` either, for the same reason it is
not covered by the install. By hand:

```bash
sudo systemctl disable --now ironcrew-runner
sudo rm /etc/systemd/system/ironcrew-runner.service
sudo systemctl daemon-reload
```

`/etc/ironcrew/runner.env` and `/var/lib/ironcrew-runner` are left in place.
The second of those holds live CLI logins — if you are decommissioning the
machine rather than reinstalling, log those sessions out at the vendor before
deleting the directory. Removing the files does not revoke the sessions.
