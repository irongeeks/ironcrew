# Native Installation, Sicherheit und Betrieb

## 1. Zielmatrix

Diese Matrix legt die zu entwickelnde und zu prüfende Mindestabdeckung fest, nicht bereits bewiesenen Support. Zentrale und Worker können gemeinsam oder getrennt auf jedem Zielsystem laufen. Die Firmendatenbank gehört immer genau einer Zentrale.

| Plattform | Baseline für Abnahme | Dienst und Pfade |
| --- | --- | --- |
| Linux | Debian 13 und Ubuntu 24.04 LTS; x64, arm64 | systemd; Programm `/opt/ironcrew`, Daten `/var/lib/ironcrew`, Konfiguration `/etc/ironcrew`. |
| macOS | macOS 15 auf x64/arm64, macOS 26 auf arm64 | launchd LaunchDaemon; `/Library/Application Support/IronCrew`; gesondertes Dienstkonto. |
| Windows | Windows 11 Pro/Enterprise, Windows Server 2022 und 2025; x64 | Windows Service, bevorzugt geprüfter WinSW-Wrapper; Programm `%ProgramFiles%/IronCrew`, Daten `%ProgramData%/IronCrew`. |

Weitere Versionen werden über getestete Matrixeinträge ergänzt. Fehlende passende Releasebinaries oder Betriebssystem-APIs sind in AP-00 zu erkennen. WinSW-Version und Bezugsquelle werden dort gegen offizielle Dokumentation geprüft, bevor ein Installer sie verwendet. Die bloße Ausführung eines Powershell-Scripts oder `pnpm dev` gilt nicht als Windows-Dienstinstallation.

Installer prüft Plattform, Rechte, Ports, freien Platz und vorhandene Laufzeiten. Er verwendet eine passende vorhandene Version oder installiert eine getestete private Runtime unter dem Programmverzeichnis; keine globale Node-Version ungefragt ersetzen. Node, benötigte CLI-Werkzeuge und Builds haben versionierte Bezugsquellen und Integritätsnachweise. Produktionsbetrieb startet gebaute JS-Dateien, keine Entwicklungswatcher. Installation/Update ist idempotent, protokolliert und bei Fehlern nachvollziehbar rückgängig zu machen.

Zentrale bindet zunächst Loopback-Port 8790; bei externem Zugang wird TLS samt konfigurierter öffentlicher URL verlangt. Port ist änderbar. Worker verbinden ausgehend über WSS mit der Zentrale. Browser und Workertransport haben getrennte Authentifizierung; Setup-Token ist kurzlebig und einmalig.

## 2. Worker und Isolation

Protokoll v1 aus `contracts/contracts.ts`: Enrollment, Hello/Capabilities, Heartbeat, Dispatch, Started, Result, ACK, Cancel. Startwerte Heartbeat 10 s, Lease 45 s, maximal 1 MiB je Kontrollnachricht. Größere Logs/Artefakte über begrenzten separaten Upload mit Hash, Zugriffstoken und Größenlimit. Fehlende Heartbeats ergeben offline, aber keinen Beweis, dass eine laufende externe Aktion aufgehört hat.

Credentials nur gehasht zentral speichern; Enrollment-Token einmalig/kurzlebig. Fencing-Generation verhindert Übernahme durch veraltete Workerinstanz. Ein Worker führt eine Action-ID nicht noch einmal aus, wenn lokal ein Ergebnisbeleg existiert. Zentrale bestätigt erst nach Persistenz. Bei zwei zentralen Prozessen wird der zweite Start durch Instanzlock verhindert; Hochverfügbarkeitscluster sind nicht Teil des ersten Umfangs.

Toolbroker und Auftragsprozesse laufen getrennt. Auftragscode erhält keine Betriebsverzeichnisse, zentrale Tokens, Proton-Sitzungen oder uneingeschränkte Prozessrechte. Umgebungsvariablen werden aus einer Allowlist neu aufgebaut; Ausgaben werden zusätzlich redigiert. Betriebssystemaktionen verwenden deklarierte Brokerfunktionen mit minimalem Zielzugriff.

Für frei erzeugten Code gilt ein nachgewiesenes Isolationsprofil: Linux kann Namespace-/Sandboxwerkzeuge mit isolierten Mounts, Prozess- und Netzwerkregeln verwenden; für macOS und Windows ist ein auftragsbezogener VM-Worker auf Virtualization-/Hyper-V-Basis der Ausgangspunkt. Der Supervisor läuft weiterhin nativ. Eine separate Benutzerkennung oder ein Windows Job Object allein wird nicht als vollständige Sandbox bezeichnet. AP-04 muss Lesen außerhalb des Workspace, unerlaubte Netzwerkziele, Kindprozessflucht und Ressourcengrenzen testen. Fehlt ein geeignetes Profil, bleibt diese Capability gesperrt oder wird an einen passenden entfernten Worker geroutet. Die Installation selbst benötigt kein Docker.

## 3. Backup und Wiederherstellung

Backupservice: SQLite-Snapshot über getestete Backup-Schnittstelle, dazu immutable Artefakte und versionierte Konfiguration ohne rohe Secrets. Für Konsistenz kurz Schreibzufuhr anhalten oder einen Snapshot-Cut mit DB- und Blobmanifest herstellen; referenzierte Blobs werden bis Backupabschluss gegen Garbage Collection gepinnt. Manifest enthält Schema-/Appversion, Hashes und Vollständigkeitsstatus. Kein Kopieren einer offenen SQLite-Datei ohne ihren Konsistenzmechanismus.

Archiv über etablierten Tar-Writer an `age` streamen; automatisches Backup mit öffentlichem Empfängerschlüssel. Wiederherstellungsschlüssel separat durch CEO sichern; er ist weder im Backup noch als Modellkontext enthalten. Einrichtung umfasst tatsächlichen Entschlüsselungstest. Temporäre Klartextsnapshots in streng geschütztem Verzeichnis begrenzen und anschließend entfernen; keine garantierte physische Löschung auf SSD behaupten. [age-Projekt](https://github.com/FiloSottile/age)

Restore zunächst in Staging: Entschlüsselung, Größenlimits, Pfade, Symlinks, Hashes, Schema und Datenbankintegrität prüfen. Vor Zielwechsel Dienste anhalten und bisherigen Stand für Rückweg sichern. Restore erzeugt neue Recovery-Generation, entwertet alte Worker-Leases/Sitzungen und startet mit angehaltenen Routinen und Dispatch. Externe Wirkungen seit Sicherungszeitpunkt müssen abgeglichen werden; Wiederherstellung darf alte Mails/Erinnerungen nicht erneut versenden. CEO erhält einen konkreten Recovery-Bericht und schaltet passende Routinen wieder frei.

Initiale Vorschläge im Setup: täglich, sieben tägliche und vier wöchentliche Stände, auf lokales Ziel plus optional externes Ziel. Erst nach Bestätigung aktivieren. Produktziel: auf frischer Installation wiederherstellbar; RPO/RTO hängen von Datenmenge und Infrastruktur ab und werden gemessen, nicht erfunden.

## 4. Updates

Releaseartefakt enthält App-/Schema-/Protokollversion, exakte Runtimeversion, Manifest, Hashes und verifizierbare Signatur. Installer kennt den Vertrauensanker unabhängig vom heruntergeladenen Manifest. Ohne eingerichtete vertrauenswürdige Releaseherkunft bleibt automatischer Download/Install ausgeschaltet.

Setup schlägt automatische Patchupdates im gewählten Wartungsfenster vor; Minor/Major werden vorgelegt, bis der CEO andere Klassen freigibt. Vor Update neue Arbeit anhalten, laufende Aktionen geordnet abschließen/pausieren, Sicherung prüfen, Kompatibilität bewerten, gestagtes Release aktivieren und Healthcheck ausführen. Rollback berücksichtigt Schema: alte Binary darf nicht auf inkompatible neue DB starten. Wenn Restore nötig ist, folgen externe Wirkungen denselben Recovery-Regeln wie oben.

Worker können zeitweise hinterherhinken; nur kompatible Versionen erhalten Aufgaben. Rollout und Fehler sind im UI sichtbar. Kein Veröffentlichungsschritt in diesem Entwicklungspaket ist bereits eine Releasefreigabe.

## 5. Betriebswerte, die später gebraucht werden

| Zeitpunkt | Benötigt | Verhalten solange fehlend |
| --- | --- | --- |
| Ersteinrichtung | Firma/CEO, Passwort, Sprache, Zeitzone | Lokaler Setupmodus, noch keine fremden Konten. |
| Erster bezahlter Lauf | OpenRouter-SecretRef, Budgetbetrag/-periode, ggf. EUR-Kurs | Modellaufrufe gesperrt; UI/Tests mit Fixtures möglich. |
| Erster verteilter Lauf | Zentralen-URL/TLS, Workergerät und Scope | Lokaler Testworker bzw. Verbindungshinweis. |
| Connector-Livetest | Konten, Systemversionen, minimale Rechte, Testdaten | Adapter vorhanden, Capability „nicht live validiert“. |
| Websiteveröffentlichung | Hostingprofil, Domain, DNS-/TLS-Rechte | Vorschau und Übergabepaket möglich. |
| Banking-Import | Bank/Anwendung, unterstütztes Format | Strukturierte Zahlungsvorbereitung; Import nicht als verfügbar melden. |
| Backupaktivierung | Ziel, Retention, Schlüssel und bestätigter Restoretest | Sichtbarer Einrichtungsbedarf. |
| Updateautomatik | Releasevertrauen, Klassen, Zeitzone/Wartungsfenster | Manuelles geprüftes Update. |

Logs sind strukturiert und redigiert, mit requestId/orderId/actionId und konfigurierbarer Retention. Gesundheitsansicht zeigt DB, Worker, Katalog, ungeklärte Kosten, ausstehende Wirkungen und letzte Sicherung. Vollständige Modellprompts gehören nicht standardmäßig in Betriebslogs; gespeicherter Arbeitskontext unterliegt Bereichsrechten und Aufbewahrung.
