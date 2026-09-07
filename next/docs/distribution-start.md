# IronCrew – signiertes Installationspaket

Dieses Paket enthält die gebaute Zentrale, Oberfläche, Worker, externen Updater, Produktionsabhängigkeiten und eine eigene Node-26.4.0-Runtime. Ein ausdrücklich mit Testschlüssel erzeugtes Paket ist ein Abnahmeartefakt und kein produktiver Vertrauensanker.

## Signatur prüfen und starten

Den öffentlichen Ed25519-Schlüssel aus einer bereits vertrauenswürdigen administrativen Quelle beziehen. Die Releaseherkunft vor dem ersten Ausführen mit einer vertrauenswürdigen IronCrew-CLI prüfen:

```sh
node /ABS/TRUSTED_CLI/main.js verify-release --release /ABS/RELEASE --trusted-key /ABS/ADMIN_PUBLIC_KEY
```

Danach das geprüfte Paket in das administrative Programmverzeichnis übernehmen. Daten liegen in einem getrennten Verzeichnis im Besitz des Dienstkontos. Aus dem Programmverzeichnis starten, unter Linux/macOS beispielsweise:

```sh
export IRONCREW_DATA_DIR=/ABS/IRONCREW_DATA
./runtime/node dist/apps/control/main.js
```

Unter Windows/PowerShell:

```powershell
$env:IRONCREW_DATA_DIR = 'C:\ABS\IronCrewData'
.\runtime\node.exe dist/apps/control/main.js
```

Die Weboberfläche startet auf `http://127.0.0.1:8790`. Bei einer frischen Installation erscheint ein einmaliges Setup-Token im lokalen Startprotokoll. Firma, CEO und Passwort in der Oberfläche einrichten. Für externen Zugriff sind `IRONCREW_HOST`, `IRONCREW_PUBLIC_URL`, `IRONCREW_TLS_CERT` und `IRONCREW_TLS_KEY` mit einem tatsächlichen HTTPS-Zertifikat erforderlich. Vorschauen laufen getrennt auf Loopback-Port 8792 (`IRONCREW_PREVIEW_PORT`). Live-Modellausführung bleibt zunächst ausgeschaltet.

## Dauerhafter Betrieb

Die [Betriebsanleitung](docs/operations.md) beschreibt überprüfbare native Servicebundles, verschlüsselte Sicherung und Wiederherstellung. Die [Updateranleitung](docs/production-updater.md) erklärt administrative Pfade, den getrennten signierten Bootstrap, genaue Freigaben und Wartungsfenster. `IRONCREW_UPDATER_CONFIG` erst nach administrativer Einrichtung auf die dort beschriebene Datei setzen. Das Dienstkonto muss diese Datei lesen können; es darf sie nicht ändern.

Der Updater beendet die Zentrale für eine frische verschlüsselte Sicherung, aktiviert ein geprüftes Release und prüft die neue Manifest-/Startidentität. Ein Restore pausiert Routinen und Aufträge bis zum Wirkungsabgleich. Der [Workerbetrieb](docs/remote-execution.md) beschreibt tatsächliche isolierte Ausführung auf einem entfernten Linux-Worker.

age 1.3.2, pass-cli und etwaige betriebsspezifische Dienstcontroller sind eigene administrative Voraussetzungen. Dieses Paket installiert keine globalen Werkzeuge und registriert keine Dienste beim bloßen Entpacken. Windows-/launchd-Installationen und Kundenkonten benötigen ihre benannte Plattform-/Liveabnahme.

## Mitgelieferte Hinweise

Die Repositorylizenz liegt unter `LICENSE`, die Lizenz der privaten Node-Runtime unter `runtime/LICENSE`. Produktionsabhängigkeiten behalten ihre jeweiligen Lizenz-/Hinweisdateien in `node_modules`. Signierte Dateiliste und Signatur: `release-manifest.json` und `release-manifest.sig`.
