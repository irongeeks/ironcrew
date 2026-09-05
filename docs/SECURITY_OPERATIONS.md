# Security operations

This guide covers one local-first control plane and a separate native runner.
It does not claim HA or PostgreSQL support. Native verification runs in the
`Platform and production verification` workflow on Linux and macOS; the Linux
job also builds and boots the production Docker image without external networking.

## Accounts and installation

Use two dedicated, non-root operating-system accounts: `ironcrew` for the control
plane and `ironcrew-runner` for CLI execution. Their homes are separate, mode 0700,
under `/var/lib/`. They share the `ironcrew` group only for the runner socket and
explicit workspaces. Never mount or copy your personal home or CLI tokens into the
control plane. Install official CLI tools on the host, then perform each official
login as the runner account. IronCrew does not do that login for you.

On Linux, create the accounts before installing definitions:

```bash
sudo groupadd --system ironcrew
sudo useradd --system --gid ironcrew --home-dir /var/lib/ironcrew --create-home --shell /usr/sbin/nologin ironcrew
sudo useradd --system --gid ironcrew --home-dir /var/lib/ironcrew-runner --create-home --shell /usr/sbin/nologin ironcrew-runner
```

Skip an account/group creation command if it already exists. On macOS, use your
normal managed-account provisioning (`dscl`/MDM) to create the same dedicated
non-admin accounts and group, with those homes. Choose free IDs according to your
organization's policy; the installer deliberately does not guess UIDs or create
interactive administrator accounts. CLI subscription authentication and OS-keychain
availability must be verified in that account's session. A headless launch daemon
cannot assume a personal GUI login keychain is unlocked.

Deploy a built checkout at `/opt/ironcrew`, owned by the administrator and readable
by both services. Use Node 22 or later. With Homebrew, pass the real Node path
(e.g. `/opt/homebrew/opt/node@22/bin/node`) rather than relying on a shell profile.

First render the exact files for review; this does not install or start anything:

```bash
node scripts/deploy-service.mjs render --role control --output ./service-preview
node scripts/deploy-service.mjs render --role runner --output ./service-preview
```

Then install each definition, still without enabling or starting services:

```bash
sudo node scripts/deploy-service.mjs install --role control --node /absolute/path/to/node
sudo node scripts/deploy-service.mjs install --role runner --node /absolute/path/to/node
```

The tool validates dedicated identities, built application, absolute paths and
configuration permissions. Existing environment-file content is never overwritten.
Definitions are root-owned mode 0644; environment files must be owned by their
service account and mode 0600. Environment files are parsed as data with Node's
`loadEnvFile`, never sourced as shell programs. Placeholder secrets fail startup.
The older `scripts/install-service.sh` remains supported for simple Linux paths;
use the new renderer for spaces and special characters.

Configure `/etc/ironcrew/ironcrew.env` and `/etc/ironcrew/runner.env`:

- Generate a unique `OAUTH_ENCRYPTION_SECRET` for the control plane and preserve it
  in your secret manager; losing it prevents decryption of existing mail credentials.
- Set the same strong `IRONCREW_RUNNER_TOKEN` in both service files.
- Set `IRONCREW_RUNNER_SOCKET` in both files. Linux default is
  `/run/ironcrew/runner.sock`; macOS uses
  `/var/lib/ironcrew-workspaces/runner.sock`.
- Set runner `IRONCREW_RUNNER_WORKSPACE_ROOT=/var/lib/ironcrew-workspaces` and
  restrict the control plane's `PROJECT_PATH_ALLOWED_ROOTS` accordingly.
- Use `HOST=127.0.0.1` until a trusted HTTPS reverse proxy is configured.
- Keep service `PATH` explicit; launchd does not read your shell configuration.

Linux start/stop:

```bash
sudo systemctl enable --now ironcrew-runner ironcrew
sudo systemctl stop ironcrew ironcrew-runner
journalctl -u ironcrew -u ironcrew-runner -f
```

macOS start/stop:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/eu.irongeeks.ironcrew-runner.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/eu.irongeeks.ironcrew.plist
sudo launchctl bootout system/eu.irongeeks.ironcrew
sudo launchctl bootout system/eu.irongeeks.ironcrew-runner
```

Generated plists are also supplied in `deploy/launchd/`. Render/install with the
actual Node path rather than copying their `/usr/local/bin/node` default blindly.
macOS launchd identities and private homes provide separation; they are not a Linux
systemd `ProtectSystem` sandbox. Restrict file ACLs and outbound traffic separately.
Rotate `/var/lib/<service-user>/service*.log` with your OS log policy.

Uninstall only removes the chosen definition and stops that service:

```bash
sudo node scripts/deploy-service.mjs uninstall --role control
sudo node scripts/deploy-service.mjs uninstall --role runner
```

Data, accounts, credentials and application files are retained.

## Container deployment

`compose.yaml --profile prod` runs the control plane. The image contains no
subscription CLI installation and starts directly, without package-manager
prestart hooks or a startup browser download. The optional rendering integration
can use the installed system Chromium. Provider execution belongs to the native
host runner; mounting a runner socket requires explicit permissions and matching
authentication configuration. A remote host uses the authenticated TLS runner
configuration described in `RUNNER_PROTOCOL.md`.

The existing named data volume is deliberately preserved. It is mounted at both
`/data` and `/app/data` so the database, vault, attachments and uploaded characters
survive rebuilds. The host `config/` is mounted read-only. Do not run `docker compose
down -v` as a routine update command; that explicitly deletes named volumes.

## Upgrade and recovery

Use the procedure in [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Before an upgrade,
record the current commit/image digest, take a verified backup, stop new task
execution and review migrations. Keep the previous application version and backup.
Do not point an older application at a database migrated by a newer version unless
that downgrade is explicitly supported. Restore a pre-upgrade snapshot instead.

A restart leaves task/run/queue state in SQLite. Expired claims and orphaned runs
are recovered by the scheduler. Test this with MockRuntime first; a mocked result
is not proof that your official CLI login works. Provider health, one real run,
streaming, cancel and resume are operator acceptance checks after upgrades.

## Dependency evidence and inherited licenses

The CI workflow publishes `production-sbom-and-licenses`: a CycloneDX 1.6 installed
production-component inventory, normalized license inventory and review findings.
It contains no local package paths. The existing CI vulnerability audit remains a
separate gate. A failed registry request is not reported as a clean vulnerability scan.

New nonstandard/unknown license metadata fails the license gate. The exact-version
baseline in `deploy/license-baseline.json` records inherited Remotion dependencies,
including custom-license and incomplete/UNLICENSED package metadata. This inventory
baseline is **not commercial permission or a legal clearance**. Review Remotion's
terms before deploying its features; changes in package version or license require
review rather than silently inheriting the baseline. MPL/LGPL/CC licenses also have
obligations; inclusion in the inventory does not remove them.

## Incident handling

Stop the relevant runner/task first, preserve audit and run IDs, and disable affected
SecretRefs or endpoints. Rotate compromised secrets in the actual provider; do not
paste values into chat, logs or issues. Use immutable/off-host backup storage and
retain an independently protected audit-chain key. Owner approval remains necessary
for production changes, external commitments and irreversible actions.
