#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
import { updateRelease, UpdateError } from "./lib/release-update.mjs";
const HELP = `IronCrew: explizites natives Releaseupdate

Prüfen (kein Checkout-, Datenbank- oder Dienstwechsel):
  node scripts/ironcrew-update.mjs --to vX.Y.Z --check [--repo /opt/ironcrew]
Installieren (Dienst zuerst stoppen):
  node scripts/ironcrew-update.mjs --to vX.Y.Z --db /absolute/ironcrew.sqlite --backup-dir /absolute/backups

Optionen:
  --to vX.Y.Z               Exaktes stabiles Release; niemals main/latest
  --commit SHA             Erwarteter 40-stelliger Commit; sonst offizielles öffentliches Release-Manifest
  --repo PATH              Zielcheckout, Standard aktuelles Verzeichnis
  --remote NAME            Konfigurierter Git-Remote, Standard origin
  --check, --dry-run        Release und Checkout prüfen; keine Installation
  --db PATH                Bestehende SQLite-Datei, absolut
  --backup-dir PATH        Backupziel außerhalb des Checkouts, absolut
  --attachments PATH       Abweichendes Anhangverzeichnis
  --extra PATH             Weitere Backupdatei/-verzeichnis, absolut, mehrfach erlaubt
  --pnpm PATH              Installiertes pnpm-Binary (exakte Releaseversion erforderlich)
  --service-manager TYPE   systemd (Linux), launchd (macOS), manual
  --service NAME           Standard ironcrew.service / eu.irongeeks.ironcrew
  --runner-service NAME    Nativer Runner, Standard ironcrew-runner.service / eu.irongeeks.ironcrew-runner
  --launchd-domain DOMAIN  Standard system; alternativ gui/UID
  --confirm-stopped        Nur manual: bestätigt, dass alle Prozesse dieses Checkouts gestoppt sind
  --help                   Diese Hilfe

Private Assets, config/private, Standardvault und lokale .env werden gesichert,
sofern vorhanden. Abweichenden Vault und externe Service-/Runner-Envdateien
explizit mit --extra hinzufügen; Benutzer-Home wird niemals durchsucht.

Install/Build erfolgen in einem temporären Worktree. Bei Fehlern bleibt der
ursprüngliche Checkout bestehen. Ein fehlgeschlagener Wechsel wird nur bei
bestätigtem Dienststillstand rückgängig gemacht. Dienststart bleibt manuell;
Migrationen laufen erst beim späteren Serverstart. Nach diesem Start muss ein
DB-Rollback ausdrücklich aus dem Backup geplant werden und kann neue Daten
verlieren. Der Updater setzt Datenbanken niemals automatisch zurück.
`;
export function parseArgs(args) {
  const options = { extras: [] };
  const valued = {
    "--to": "to",
    "--commit": "commit",
    "--repo": "repo",
    "--remote": "remote",
    "--db": "db",
    "--backup-dir": "backupDir",
    "--attachments": "attachments",
    "--pnpm": "pnpm",
    "--service-manager": "serviceManager",
    "--service": "service",
    "--runner-service": "runnerService",
    "--launchd-domain": "launchdDomain",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--help", "-h"].includes(arg)) {
      options.help = true;
      continue;
    }
    if (["--check", "--dry-run", "--confirm-stopped"].includes(arg)) {
      options[arg === "--check" ? "check" : arg === "--dry-run" ? "dryRun" : "confirmStopped"] = true;
      continue;
    }
    if (arg === "--extra" || valued[arg]) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new UpdateError("Option benötigt einen Wert. Siehe --help.");
      if (arg === "--extra") options.extras.push(value);
      else {
        if (options[valued[arg]] !== undefined) throw new UpdateError("Option wurde mehrfach angegeben.");
        options[valued[arg]] = value;
      }
      continue;
    }
    throw new UpdateError("Unbekannte Option. Siehe --help.");
  }
  return options;
}
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else {
    const result = await updateRelease(options, {
      onProgress: (message) => console.error(`[ironcrew-update] ${message}`),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.mode === "apply")
      console.error(
        "[ironcrew-update] Release installiert. Dienst bleibt gestoppt. Vor dem manuellen Start Releasehinweise und Datenbankmigrationen prüfen.",
      );
  }
} catch (error) {
  console.error(
    `[ironcrew-update] ${error instanceof UpdateError ? error.message : "Updateprüfung fehlgeschlagen. Pfade, Rechte und lokale Programme prüfen."}`,
  );
  process.exitCode = 1;
}
