# Produktiver externer Updater

Die Zentrale kann einen konkret vom CEO freigegebenen Updateplan dauerhaft in die lokale Queue einstellen. Ein **separater Updaterdienst** übernimmt Stop, Offline-Backup, Austausch, Neustart und Healthrollback. Er darf nicht im systemd-Cgroup der zu aktualisierenden Zentrale laufen. Ein unbekannter Dienstwechsel wird nicht automatisch wiederholt.

## Administrative Einrichtung

`IRONCREW_UPDATER_CONFIG` zeigt auf eine reguläre, nicht fremd beschreibbare JSON-Datei außerhalb der austauschbaren Installation. Beispiel (Pfade und Hashes vor Einrichtung tatsächlich bestimmen):

```json
{
  "version": 1,
  "companyId": "COMPANY-UUID",
  "dataDirectory": "/var/lib/ironcrew",
  "installDirectory": "/opt/ironcrew/current",
  "bootstrapDirectory": "/opt/ironcrew/updater-bootstrap",
  "ageExecutable": "/opt/ironcrew-tools/age",
  "ageExecutableSha256": "SHA256_DER_ADMINISTRATIV_INSTALLIERTEN_AGE_BINARY",
  "backupDirectory": "/var/backups/ironcrew",
  "trustedPublicKeyPem": "-----BEGIN PUBLIC KEY-----\nADMINISTRATIV_HINTERLEGTER_ED25519_KEY\n-----END PUBLIC KEY-----\n",
  "service": {
    "kind": "systemd",
    "executable": "/usr/bin/systemctl",
    "executableSha256": "SHA256_DES_INSTALLIERTEN_SYSTEMCTL",
    "name": "ironcrew.service"
  },
  "healthUrl": "http://127.0.0.1:8790/api/v1/health",
  "healthTimeoutMs": 30000
}
```

Programm, Daten und Bootstrap müssen getrennte Verzeichnisse sein. Controller und Dienstdefinition liegen außerhalb des austauschbaren Programmverzeichnisses. Auf POSIX verlangt ein privilegierter Updater Rootbesitz und sichere Elternverzeichnisse für Konfiguration, Programme, Bootstrap und Controller. Auch age-Binary und erlaubter Backupordner sind administrative Konfiguration: Eine CEO-Policy kann dem privilegierten Updater weder ein anderes Programm noch ein anderes Backupziel unterschieben. Der Binaryhash wird unmittelbar vor dem Offlinebackup nochmals geprüft. Der Datenordner und das Backupziel dürfen dem Dienstbenutzer gehören, ihre Elternverzeichnisse müssen administrativ geschützt sein. Bei privilegiertem Updater laufen sämtliche DB-/WAL-Zugriffe, Queueoperationen und Backuperstellung in signierten, eng begrenzten Kindprozessen unter dessen UID/GID ohne privilegierte Zusatzgruppen. Root übernimmt keinen chown auf Queue- oder zurückgemeldeten Archivpfaden. Eine symbolische Queueverknüpfung wird abgelehnt. Die administrative Datei bleibt Root-eigen, muss aber für das tatsächliche Control-Dienstkonto lesbar sein (z.B.0640 mit passender Gruppe oder0644 ohne Geheimnisse); Root0600 wäre für die nichtprivilegierte Zentrale unlesbar. Windows benötigt administrativ gesetzte ACLs; diese Plattformabnahme ist noch offen.

`service.kind` unterstützt `systemd`, `launchd`, `winsw` und das ausdrücklich IronCrew-eigene, administrativ bereitgestellte Protokoll `ironcrew-service-v1`. Jeder Controlleraufruf prüft den konfigurierten Binärhash erneut und verwendet feste Argumente ohne Shell. Launchd verlangt zusätzlich `plistPath` und `configurationSha256`; WinSW `configurationPath` und `configurationSha256`. Renderer und Controller verwenden einheitlich WinSW2.12.0: administrativ geschützter, umbenannter Wrapper mit gleichnamiger XML-Datei neben der EXE, außerhalb des austauschbaren Programmordners. Der Wrapper muss den fest hinterlegten SHA256 der offiziellen x64-Distribution erfüllen. Aufrufe verwenden `/elevated OPERATION`, entsprechend dem [offiziellen WinSW2.12-Quellcode](https://github.com/winsw/winsw/blob/v2.12.0/src/WinSW/Program.cs); sie lösen keinen interaktiven UAC-Dialog aus und benötigen bereits bestehende administrative Rechte. Die Statusprüfung akzeptiert ausschließlich `Started`; eine passende Dateikonfiguration allein gilt nicht als laufender Dienst. Die Windows-Plattformabnahme bleibt offen. Ein Controllerupdate erfordert eine neue administrative Konfiguration und einen neuen konkret freigegebenen Plan. Der eigene Broker bestätigt JSON `{serviceName,state:"running"|"stopped"}`; diese Bestätigung ersetzt nicht den unabhängigen HTTP-Healthnachweis.

Die private Runtime startet die Zentrale aus dem Installationsordner, mit `IRONCREW_UPDATER_CONFIG` und dem tatsächlichen kompilierten Einstieg. Die Healthantwort bindet Version, SHA256 des signierten Release-Manifests und die pro Start neue `instanceId`. Der Updater akzeptiert HTTP ausschließlich auf Loopback oder HTTPS mit geprüfter Zertifikatskette (`trustedCaPem` optional administrativ).

## Lokale Distribution und Bootstrap

```sh
node dist/apps/updater/main.js package --project /ABS/BUILT_NEXT \
  --runtime /ABS/OFFICIAL_NODE_26_4_0 --runtime-sha256 EXPLICIT_SHA256 \
  --output /ABS/NEW_RELEASE --private-key /ABS/EXTERNAL_ED25519_KEY \
  --version 0.4.1 --archive /ABS/ironcrew-0.4.1.tgz
node dist/apps/updater/main.js bootstrap --release /ABS/NEW_RELEASE \
  --trusted-key /ABS/ADMIN_PUBLIC_KEY --output /ABS/NEW_BOOTSTRAP
node dist/apps/updater/main.js service-definition --config /ABS/ADMIN_CONFIG \
  --output /ABS/NEW_DEFINITION_DIRECTORY
```

Der Packager materialisiert Produktionsabhängigkeiten einschließlich transitiver Abhängigkeiten und Versionskonflikten, schließt Entwicklungspakete und den externen privaten Signaturschlüssel aus und signiert das exakte Manifest mit Ed25519. Die kopierte Runtime wird mit leerer Umgebung tatsächlich gestartet; Version, Plattform und Architektur müssen passen. Eine einzelne Homebrew-Node-Datei ist aufgrund externer `libnode`-Abhängigkeiten kein portables Runtimepaket und wird abgelehnt. Es werden ausschließlich Distributionen für den tatsächlichen Buildhost erstellt. Keine fremde Plattform wird allein aus einer Versionszeichenfolge abgeleitet.

`bootstrap` akzeptiert ausschließlich ein neues Ziel, kopiert nur signierte Manifestdateien und ersetzt keinen bestehenden Updater automatisch. `service-definition` erzeugt nur eine prüfbare systemd-, launchd- oder WinSW-Definition, registriert keinen Dienst. Eine unabhängige privilegierte Dienstregistrierung und die Berechtigungen erfolgen administrativ. Für ein späteres Bootstrapupgrade: Updaterdienst stoppen, laufende Jobs abgleichen, ein neues separat benanntes Bootstrapziel signaturgeprüft installieren, administrativen Pfad und Serviceeinheit auf dieses Ziel ändern und erst danach den separaten Updater starten. Das installierte Bootstrap und seine signierten Dateien bleiben administrativ besessen, müssen jedoch für die Dienst-UID les-/ausführbar sein (Verzeichnisse0755, Dateien0644, Runtime0755). Alte konkret freigegebene Pläne verlieren dadurch ihr Konfigurationsbinding und werden neu erstellt; der laufende Updater ersetzt sein eigenes Programm nicht. Der Bootstrap startet mit seiner eigenen privaten Runtime, eigenem Arbeitsverzeichnis und `dist/apps/updater/main.js serve --config ABS_PATH`; `run --config ABS_PATH --job UUID` verarbeitet einen einzelnen bereits eingestellten Auftrag. Beide Befehle prüfen tatsächlichen Einstieg, Runtime und vollständige Bootstrapsignatur.

## Transaktion und Wiederanlauf

Vor dem Queueclaim werden CEO, Firmenscope, exakter Plan, administrativer Konfigurationsfingerprint, Signatur, Zielversion, erlaubte Versionsklasse, Wartungsfenster und eine aktivierte Backuppolicy mit echter erfolgreicher Restoreprobe geprüft. Diese Prüfungen werden im externen Prozess und nochmals nach dem Stop wiederholt. Der Auftrag bindet auch die Wiederherstellungsgeneration. Unabhängige Prozess- und Datenbanksperren verhindern parallele Updater und Offline-Datenzugriffe.

Nach bestätigt beendetem Dienst und erworbener Instanzsperre entsteht ein neues age-verschlüsseltes Offline-Backup. Erst danach wird das signierte, erneut geprüfte Release bereitgestellt und per Verzeichnisumbenennung aktiviert. Vor Neustart schließt der Updater seine Datenbank und gibt die Instanzsperre frei. Neue Healthantworten müssen exakt Manifest und Version sowie eine neue Boot-ID bestätigen. Schlägt das fehl, wird der neue Dienst zunächst gestoppt und die Instanzsperre wieder erworben; anschließend wird der vorige Stand zurückbenannt, gestartet und unabhängig verifiziert. Auch Fehler zwischen Stop und der ersten Umbenennung versuchen ausschließlich den unveränderten, erneut signaturgeprüften vorherigen Stand wieder zu starten.

Das Ergebnis enthält einen auftragsgebundenen HMAC und wird nach dem Neustart durch die Zentrale importiert. Fremde Ergebnisse, geänderte administrative Konfiguration und Ergebnisse aus einer vorherigen Restoregeneration werden nach HMAC-Prüfung dauerhaft als verworfen markiert: Job und zugehöriger Plan/Wächter bleiben ungeklärt, die Wiederherstellungspause bleibt gesetzt. Wiederholter Import blockiert den Start und die Verarbeitung neuer Ergebnisse nicht. Nur ein bestätigter Erfolg oder bestätigter Healthrollback hebt die durch diesen Auftrag gesetzte Pause wieder auf; zuvor bestehende Pausen bleiben bestehen. Ein abgebrochener Wechsel bleibt `effect_unknown`, ohne blinden zweiten Stop/Start. Für manuellen Abgleich dienen `update-queue/<job>.progress.json`, der DB-Auftrag und die konkrete Prozess-/Dienstlage. Queue-Ergebnisse sind idempotent: erneuter Aufruf eines abgeschlossenen Jobs erzeugt keinen neuen Dienstwechsel.

Optionales `autoApplyApproved` wendet ausschließlich bereits konkret freigegebene Pläne im freigegebenen Wartungsfenster an. Zustimmung bleibt maximal24Stunden gültig, wird nicht automatisch verlängert; geplante Versuche werden dauerhaft aufgezeichnet. Erlaubte Versionsklassen ersetzen keine CEO-Freigabe.

Der Idle-Tick schreibt einen kleinen Heartbeat; die vollständige Bootstrapprüfung erfolgt beim Start, bei Konfigurationswechsel sowie vor jeder tatsächlichen Updateausführung, nicht jede Sekunde.

## Nachweise und Grenzen

`tests/install/updater-service.test.ts` mit gemeinsamem `tests/fixtures/updater.ts` verwendet echte private Node26-Kindprozesse, ein echtes HTTP-Healthziel, echte Ed25519-Signaturen und echte age-Backups. Dieselbe Fixture kann mit `IRONCREW_TEST_SYSTEMD=1` ausdrücklich in einer eigenen Linux-Test-VM als Root laufen: Sie erstellt nur eindeutig benannte temporäre `ironcrew-updater-fixture-*.service`-Units und stoppt, deaktiviert und entfernt sie nach jedem Test. `IRONCREW_TEST_NODE` und `IRONCREW_TEST_AGE` zeigen dabei auf vorher hashgeprüfte lokale Binaries. Am 07.09.2026 bestanden erfolgreicher Wechsel, tatsächlicher Healthrollback und Kandidatenmanipulationsschutz sowohl auf macOS ARM64 (eigener Broker) als auch Ubuntu24.04 ARM64 mit echtem systemd (privilegierter Updater, Zentrale unter eigenem Benutzer UID501, inklusive Besitzerprüfung des verschlüsselten Backups). Die Aktivierung setzt das geprüfte Programmverzeichnis auf 0755, damit der nichtprivilegierte Dienst nach dem Swap tatsächlich starten kann. Weitere Tests verhindern den Import alter Ergebnisse nach einem Generationswechsel und Eigentumsänderungen durch Queue-Symlinks. Der ausschließlich native Root-/UID-Test liegt separat in `tests/isolation/updater-systemd.test.ts`; für den vollständigen Linuxnachweis werden beide Testdateien ausdrücklich mit `IRONCREW_TEST_SYSTEMD=1` ausgeführt. Dabei bestätigt ein unter UID501 unlesbares root-eigenes Test-JSON, dass die Backuperstellung keine privilegierten Leserechte übernimmt.

`tests/install/distribution.test.ts` führt ein signiertes eigenständiges Paket mit transitiven Produktionsabhängigkeiten aus und installiert einen getrennten Bootstrap. Ein eigener macOS-LaunchAgent wurde inzwischen tatsächlich registriert, gestartet, über HTTP geprüft, per SIGTERM gestoppt, erneut gestartet und vollständig entfernt (siehe `test-evidence/launchd-native.json`). Dieser Nachweis umfasst keine privilegierte LaunchDaemon-Kontoanlage und keinen Produktupdatewechsel unter launchd. WinSW-Dienstwechsel, Windows-ACLs und weitere Plattform-/Architekturpakete wurden hier nicht abgenommen. Es wurden keine Nutzerdienste ersetzt und keine Releases veröffentlicht. Lokal erzeugte Abnahmepakete verwenden ausdrücklich temporäre Testschlüssel; diese sind keine produktiven Vertrauensanker.
