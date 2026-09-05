# Backup and restore

A database-only backup does not protect uploaded characters, attachments or the
Obsidian vault. Keep all of them, plus non-secret configuration and the existing
encryption secret in your password manager. CLI OAuth credentials stay with the
runner account and are reauthenticated through the official CLI when necessary.

The backup CLI makes a consistent SQLite `VACUUM INTO` snapshot, validates integrity,
and records file hashes in a tar.gz manifest. A live database snapshot is consistent;
files outside SQLite are not transactionally coupled to that snapshot. Pause runs
and file writes (or briefly stop the control plane) for a coherent full-system backup.

Example from an installed native checkout:

```bash
cd /opt/ironcrew
node scripts/ironcrew-backup.mjs --db data/ironcrew.sqlite --attachments data/crew-attachments --extra data/private-assets/characters --extra data/vault --extra config --out /secure-backups/ironcrew --keep 14
node scripts/ironcrew-backup.mjs --inspect /secure-backups/ironcrew/ARCHIVE.tar.gz
```

Adjust the vault path if `OBSIDIAN_VAULT_PATH` differs. Relative CLI paths resolve
against the caller's working directory, including after the TypeScript launcher
reexecutes. Use a backup directory with private permissions and encryption supplied
by your backup storage. Missing explicitly requested extras are listed in the
manifest; investigate them before treating the backup as complete.

For Docker, paths are `/data/octooffice.sqlite`, `/app/data/crew-attachments`,
`/app/data/private-assets/characters` and `/data/vault`. The preserved database filename
is intentional for upgrades from the existing named volume. Copy archives off that
volume; a backup stored only beside the database is lost with the same disk.

## Recovery rehearsal

Restore first to a new directory with no running service:

```bash
node scripts/ironcrew-backup.mjs --restore /secure-backups/ironcrew/ARCHIVE.tar.gz --db /restore-test/ironcrew.sqlite --attachments /restore-test/crew-attachments
```

Restore verifies hashes and database integrity before modifying the target. Existing
files are not overwritten by default. `--force` is an explicit recovery action that
moves the existing database and WAL/SHM companions aside rather than deleting them.
Never restore over an active database.

Extra files are extracted under `restored-extras-<timestamp>/` beside the destination
database. They are not written back to arbitrary paths from the archive. Review the
manifest and move each vault/assets/config directory to its intended location, with
the service account's ownership. Restore the original encryption secret from your
secret manager and start the matching application version with scheduling disabled.
Inspect company/task/run history, an uploaded figure, a vault note and an attachment
before reenabling execution. Then test one MockRuntime task and one authorized real
CLI task separately.

The production-image CI smoke test actually restarts a disposable container and
restores its backup, checking database content, assets, vault and attachment evidence.
It uses an isolated test volume and `--network none`; it never touches an operator's
installation. Linux/macOS native CI also tests backup and restore from another working
directory. No HA or automatic cross-version database downgrade is promised.
