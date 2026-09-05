# Releases und Updates

IronCrew verwendet stabile Versionen im Format `vMAJOR.MINOR.PATCH`.
Installiere eine [veröffentlichte Version](https://github.com/irongeeks/ironcrew/releases)
und lies deren Hinweise zu Migrationen, Konfiguration und Runner-Kompatibilität.
`main` ist der Entwicklungsstand.

## Release-Vertrag

- `package.json` bestimmt die Version; ein bereits veröffentlichter Release wird
  nicht nachträglich mit anderem Code überschrieben.
- CI und Plattformprüfung müssen für denselben Commit auf `main` erfolgreich sein.
- Quellarchiv, Manifest und SHA-256-Prüfsummen gehören zum Release.
- Das Produktionsimage wird zusätzlich über einen unveränderlichen OCI-Digest
  referenziert. Versionstags allein sind kein Integritätsnachweis.
- Die Weboberfläche zeigt installierte/verfügbare Version und den passenden Updateweg.
  Sie führt keine Git-Pulls, Paketinstallation oder Dienstneustarts aus.

## Wartungsfenster und Sicherungen

Beende oder pausiere laufende Aufgaben geordnet. Stoppe den Control Plane und alle
Runner, die denselben Checkout oder dieselbe Datenbank verwenden. Sichere neben
der Datenbank auch Anhänge, private Figuren, Vaults und lokale Konfiguration.
Externe Workspaces und separat betriebene Dienste benötigen eigene Sicherungen.

Backups enthalten vertrauliche Firmendaten. Verwende ein eigenes, nur für den
Betreiber zugängliches Verzeichnis außerhalb des Checkouts und kopiere wichtige
Sicherungen zusätzlich auf einen anderen Datenträger. Die Updatewerkzeuge löschen
keine alten Sicherungen automatisch.

## Nativ: Linux und macOS

Voraussetzungen: Node.js 22+, Git, die in `package.json` festgelegte pnpm-Version
und ein sauberer Git-Checkout. Nutze das Betreiberkonto mit Schreibrecht auf
Checkout und Sicherungsziel. Änderungen an versionierten Dateien müssen zuvor
reviewbar gesichert oder committed sein; private Dateien bleiben gitignored.

Vorprüfung für eine konkrete Version (hier der erste Release):

```bash
cd /opt/ironcrew
node scripts/ironcrew-update.mjs --to v2.8.0 --check
```

Die Prüfung lädt das veröffentlichte Manifest und das exakte Release-Tag. Sie
ändert weder Checkout noch Datenbank oder Dienste. Für freigegebene Mirrors kann
`--remote NAME --commit <vollständiger-Commit-aus-dem-Manifest>` verwendet werden.

Linux: Dienste zuerst stoppen. Den Runner nur nennen, wenn er installiert ist.
Danach als Betreiberkonto mit Zugriff auf die ausdrücklich genannten Dateien:

```bash
sudo systemctl stop ironcrew
sudo systemctl stop ironcrew-runner
node scripts/ironcrew-update.mjs --to v2.8.0 \
  --db /opt/ironcrew/data/ironcrew.sqlite \
  --backup-dir /var/backups/ironcrew \
  --extra /etc/ironcrew/ironcrew.env
```

Eine externe Runner-Envdatei oder ein abweichender Vault kommt mit einem weiteren
`--extra /absoluter/pfad` hinzu. Nur tatsächlich existierende Pfade angeben.
Unter macOS beide installierten Dienste mit `launchctl bootout` entladen,
beispielsweise `sudo launchctl bootout system/eu.irongeeks.ironcrew`.
Der Updater erkennt launchd; andere Labels sind mit `--service` und
`--runner-service` konfigurierbar. Für manuell gestartete Prozesse gilt nach deren
Beendigung `--service-manager manual --confirm-stopped`.

Der Updater sichert die bestehende SQLite-Datei, Standardanhänge, private Figuren,
beide Standard-Vaultpfade, `config/private` und eine vorhandene lokale `.env`.
Installieren und Bauen erfolgen in einem separaten Worktree. Erst ein erfolgreicher
Build wird eingewechselt. Ein Wechselproblem setzt Code und Buildartefakte nur
bei bestätigtem Dienststillstand zurück. Das Protokoll `update.json` und das
Backup liegen im ausgegebenen Unterverzeichnis des Sicherungsziels.

Nach erfolgreichem Wechsel bleiben die Dienste gestoppt. Prüfe die Release-Hinweise
und starte anschließend Runner und Control Plane in dieser Reihenfolge. Unter
Linux: `sudo systemctl start ironcrew-runner`, dann `sudo systemctl start ironcrew`.
Unter macOS die zugehörigen Plists mit `launchctl bootstrap system` wieder laden.
Erst dieser Start wendet ausstehende Datenbankmigrationen an.

### Einmaliger Einstieg aus einer älteren Installation

Wenn `ironcrew-update.mjs` noch fehlt, hole den veröffentlichten Release in ein
**separates** Verzeichnis. Der Updater selbst benötigt dort kein `pnpm install`:

```bash
git clone --depth 1 --branch v2.8.0 https://github.com/irongeeks/ironcrew.git /tmp/ironcrew-release-tools
node /tmp/ironcrew-release-tools/scripts/ironcrew-update.mjs \
  --repo /opt/ironcrew --to v2.8.0 --check
```

Führe nach der Vorprüfung denselben externen Updater mit den Installationsoptionen
aus. Der Zielcheckout benötigt seine bisherigen Abhängigkeiten für den vorhandenen
Backup-CLI. Der separate Clone ersetzt keine eigene Konfiguration.

## Docker Compose

Voraussetzungen: lokaler Docker-Daemon und Docker Compose mit Unterstützung für
`!reset` sowie `up --wait`. Das Release-Image ist zunächst **Linux/amd64**.
Neue GHCR-Pakete können zunächst privat sein; dann ist vor dem Pull ein regulärer
Registry-Login mit Leseberechtigung erforderlich. Die Pipeline ändert keine
Paket-Sichtbarkeit. Ein erfolgreicher anonymer Zugriff wird im Release-Workflow
explizit protokolliert.

Die zusätzliche Datei `compose.release.yaml` ersetzt nur den lokalen Build durch
das gewählte Image. Sie erhält Projektname, `octooffice-data`, den bisherigen
SQLite-Namen und sämtliche Mounts. Beim Wechsel von einer älteren Installation
ohne die Datei wird sie einmal aus dem geprüften Release in das bestehende
Compose-Verzeichnis kopiert. Der Updater kann wie beim nativen Einstieg aus dem
separaten Release-Clone ausgeführt werden; das Arbeitsverzeichnis bleibt das
**bestehende** Compose-Projekt.

```bash
cd /opt/ironcrew
node scripts/ironcrew-docker-update.mjs --to v2.8.0 \
  --backup-dir /var/backups/ironcrew-docker --check
node scripts/ironcrew-docker-update.mjs --to v2.8.0 \
  --backup-dir /var/backups/ironcrew-docker
```

Das Backup-Verzeichnis muss dem ausführenden Konto gehören und Modus `0700`
haben. Die Vorprüfung verändert keine Dienste oder Daten. Für die eigentliche
Aktualisierung muss der bisherige Container gesund laufen. Der Updater:

1. prüft Manifest, Versionsrichtung, Projekt und bestehende Mounts;
2. zieht das neue Image per Digest und prüft seine Version und Commit-Metadaten;
3. sichert das alte Image und die Betreiberkonfiguration;
4. stoppt den Container und sichert seine vollständigen persistenten Mounts;
5. schreibt die gewählte Image-Referenz separat nach `release-image.env`;
6. startet mit `--no-build --pull never --wait` und prüft Image, Mounts und Version.

Andere schreibende Container auf denselben Datenvolumes werden abgelehnt.
Zusätzliche Compose-Overrides oder Remote-Docker-Daemons benötigen einen separat
geprüften manuellen Updateplan. Ein Fehler nach dem Stoppen lässt den Dienst
nach Möglichkeit gestoppt und erzeugt `recovery.json` mit Archivpfaden und Hashes.
Es erfolgt keine automatische Datenrücksetzung.

Für spätere normale Starts nach erfolgreichem Update wird die gespeicherte
Image-Auswahl ausdrücklich geladen:

```bash
docker compose --env-file .env --env-file release-image.env \
  -f compose.yaml -f compose.release.yaml --profile prod up -d --no-build --wait
```

**Neue Docker-Installation:** den gewünschten Release klonen, `.env` konfigurieren
und `IRONCREW_RELEASE_IMAGE` auf die im Release-Manifest genannte Digest-Referenz
setzen. Danach denselben Compose-Aufruf zunächst ohne das noch nicht vorhandene
`--env-file release-image.env` ausführen. Der Update-CLI ist für bestehende
Installationen gedacht und erstellt keine neue Firma als Ersatz für fehlende Daten.

## Nach dem Update

Prüfe die installierte Version, `/health`, die Anmeldung und die gemeinsamen
Aufgabenansichten. Prüfe außerdem den Runner- und Providerstatus und führe einen
kleinen Auftrag mit anschließendem Review aus. Ein erreichbarer HTTP-Port allein
belegt keinen erfolgreichen Agent-Run.

## Wiederherstellung

Es gibt keine automatischen Abwärtsmigrationen. Vor dem ersten Start des neuen
Codes ist ein Code-Rollback möglich. Nach dem ersten Start können Migrationen oder
neue Schreibzugriffe erfolgt sein: dann gehören alter Code **und** passende
Daten-/Konfigurationssicherung zusammen. Das kann Änderungen seit der Sicherung
verwerfen; bewahre den fehlgeschlagenen Stand zur Analyse separat auf.

Die Updatewerkzeuge erstellen ein Wiederherstellungsprotokoll. Bei einem Fehler
bleibt die Installation gestoppt, soweit dies zur Vermeidung weiterer Schreibzugriffe
möglich ist. Starte nicht auf Verdacht eine alte Version gegen die neue Datenbank.
Für Details siehe [Backup und Restore](BACKUP_RESTORE.md) und
[Migrationen und Runner-Kompatibilität](UPGRADE.md).

## Einen neuen Release vorbereiten

1. Version in `package.json` erhöhen, Änderungen in `CHANGELOG.md` und
   `docs/releases/v<Version>.md` beschreiben.
2. Pull Request prüfen und alle Tests einschließlich Plattformprüfung ausführen.
3. Nach dem Merge wartet die Release-Pipeline auf beide erfolgreichen Prüfungen
   desselben Main-Commits und veröffentlicht die neue Version.
4. Release-Assets, Image-Digest und Workflow-Ergebnis kontrollieren.

Die Pipeline unterstützt einen erneuten expliziten Start über GitHub Actions.
Ein vorhandener veröffentlichter Release wird dabei nicht ersetzt.

Technische Grundlage: [GitHub Workflow-Ereignisse](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows),
[Docker Compose Updates](https://docs.docker.com/reference/cli/docker/compose/up/) und
[Images per Digest](https://docs.docker.com/reference/cli/docker/image/pull/).
