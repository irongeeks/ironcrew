# Releasebereitschaft — Entwicklungsstand

## Wartungsrelease 0.4.3

Die [Issues #36–47](../../docs/releases/v0.4.3.md) betreffen den neuen Kern und
mitgelieferte Legacy-Komponenten. Regressionen prüfen den konfigurierten
CLI→Runtime→HTTP-Versand einschließlich Konfigurationswechsel ohne Neustart,
Vorabablehnung gegenüber unbekanntem Versand, belegte Kostenklärung und
explizites Verwerfen fehlender Antworten. Die im Bericht vermutete generelle
Neustartpflicht war im bisherigen Quellpfad nicht reproduzierbar.

Weitere Nachweise umfassen private SQLite-/WAL-/SHM-Dateien, TLS-IMAP-Datumswerte,
doppelte und konkurrierende Katalogabrufe, Setup-Migration sowie bereinigte
Website-Artefakte und deren reale Buildskripte/HTTP-Header. Die Hauptserver-Fixes
bestanden 97 fokussierte API-, QA- und Mobiltests sowie den TypeScript-Build.
Zusätzlich bestanden 440 Unit-/Vertrags-/Integrationstests des neuen Kerns.
Browser-Inspektion und der privilegierte Updaterpfad bleiben lokal wegen fehlendem
Chromium beziehungsweise fremd beschreibbarem Workspace-Elternpfad ausgenommen;
die CI prüft beide ohne Ausnahmen. Elf Release-Vertragstests bestanden.
Die neuen Browserfälle laufen in der vollständigen CI; lokal scheiterte der
Chromium-Download. Diese Einschränkung ersetzt kein Release-Gate.

Die Veröffentlichung verlangt sämtliche fünf Workflows am selben Main-Commit.
[Release und Manifest](https://github.com/irongeeks/ironcrew/releases/tag/v0.4.3)
binden den tatsächlichen Nachweis an die ausgelieferten Quellen. Ein echter
Modellaufruf mit dem privaten Betreiberkonto ist kein Teil der Fixtures.

## Wartungsrelease 0.4.2

Die [Korrekturen zu Issues #31–34](../../docs/releases/v0.4.2.md) werden mit
HTTP-/SQLite-Regressionen für 99, 100, 579 und 1.200 Modelle, wiederholte
Aktualisierung, entfernte Modelle, vollständigen Rollback und konkurrierende
Refreshes geprüft. Ausführbare CLI-Fixtures prüfen IDs mit führendem Bindestrich
und unveränderte Sonderzeichen. Ein unabhängiger Manifest-Vertrag prüft Schema 3,
exakte Laufzeitvoraussetzungen, Archiv-Commit und Prüfsummen.

Lokal bestanden 194 Unit-, Vertrags- und Integrationstests sowie elf
Manifest-/Veröffentlichungstests. Zusätzlich wurde der echte öffentliche
OpenRouter-Katalog ohne Schlüssel abgerufen und vollständig in eine temporäre
SQLite-Datenbank geschrieben: 579 Modelle, darunter 22 mit `:free`-ID, Status
`ready` und gültige Audit-Kette. Dies war kein Modellaufruf.

Die Veröffentlichung verlangt alle fünf vollständigen CI-Workflows für denselben
Main-Commit. Die tatsächliche Quellbindung und CI-Links stehen im
[Release 0.4.2](https://github.com/irongeeks/ironcrew/releases/tag/v0.4.2) und seinem
Manifest. Ein erneuter echter OpenRouter-Aufruf mit dem Betreiberkonto auf tank
ist kein Bestandteil der automatisierten Fixtures. Die folgenden Nachweise
bleiben an ihre jeweiligen historischen Versionen gebunden.

## Wartungsrelease 0.4.1

[Release-Hinweise](../../docs/releases/v0.4.1.md) und
[Modellzugang prüfen](model-access-troubleshooting.md) beschreiben die Korrekturen
aus dem Linux-Testbericht zu 0.4.0. Lokal bestanden 140 fokussierte Unit-,
Vertrags- und Integrationstests, zehn Tests der Quellrelease-Veröffentlichung,
Typecheck, Lint, Formatprüfung und Build. Die Onboarding-Browserregression bestand
unter Chromium 149. Ein zusätzlicher Starttest bestätigte die erreichbare
Reparaturoberfläche bei fehlendem Proton-CLI und den Health-Status 0.4.1.

Die vollständigen finalen Betriebssystemprüfungen werden für den veröffentlichten
Commit erneut verlangt. Deren konkrete Commitbindung und CI-Links stehen im
[Release 0.4.1](https://github.com/irongeeks/ironcrew/releases/tag/v0.4.1) und seinem
`release-manifest.json`. Ein Live-Modellaufruf mit dem Betreiberkonto auf tank
wurde hier nicht wiederholt; Konto und Proton-Sitzung stehen dieser Testumgebung
nicht zur Verfügung. Bestehende externe Abnahmegrenzen gelten weiter.

Die folgenden früheren Nachweise behalten ihre ursprüngliche Quellbindung;
sie werden nicht nachträglich als Prüflauf von 0.4.1 ausgegeben.

Stand: 7. September 2026. Arbeitszweig `rebuild/ironcrew`, Basis `76160c0`. Die Implementierung liegt im eigenständigen Workspace `next/` und wird auf dem freigegebenen Arbeitszweig versioniert. Der externe CI-Status ist getrennt vom lokalen Prüfbericht auf [GitHub Actions](https://github.com/irongeeks/ironcrew/actions) einsehbar.

## Lokaler Abschluss und Git-Übergabe

Die verbleibenden Programmteile sind abgeschlossen: Kunden-/Projektverwaltung mit exakter Auftragszuordnung, technische Websitebetreuung einschließlich Mandatdialog und Wartungsfenstern, gemeinsame Kontobegrenzung, deklarierte Adapter-Ausgaben und abgesicherter Dienstneustart. Die zugehörigen gezielten Fach-, Browser- und Betriebssystemprüfungen sind bestanden.

Der Produktcommit `686022a9a0f02f7ff8a93e120c4e82965c13a379` hat sämtliche lokalen Gates mit **508 Tests ohne Auslassungen**, stabilem Manifest über **341 Dateien** und **0 bekannten Audit-Schwachstellen** bestanden. Die erneuerte Hallenmessung auf Apple M5 ergab **41,64 FPS**. Die getrennte Kapazitätsmessung vom 7. September um 12:24 UTC bleibt mit **P95 23 ms bei 1.000 Aufträgen** und ihren Ressourcen-Hashes auf diesen damaligen Build gebunden. Die neue signierte macOS-ARM64-TEST-Distribution aus Produktcommit `aabff77` ist unabhängig geprüft: 12.763 Archivdateien und 315 bytegleiche Builddateien. Ihr echter Produktupdate-Nachweis 0.4.3 → 0.4.4 mit Restoreprobe und Offlinebackup ist bestanden; Paketpfad und Hashes stehen im [Gesamtbericht](verification.md).

Die [Drei-OS-CI 34139199380](https://github.com/irongeeks/ironcrew/actions/runs/34139199380) hat diesen abschließenden Stand auf macOS 15, Windows Server 2025 und Ubuntu 24.04 vollständig bestanden: **jeweils 508 Tests, 12 erfolgreiche Gates und keine Skips**. Die Originalberichte sind für [macOS](test-evidence/ci/686022a-macos-15/gates.json), [Windows](test-evidence/ci/686022a-windows-2025/gates.json) und [Ubuntu](test-evidence/ci/686022a-ubuntu-24.04/gates.json) gespeichert. Der [Linux-Isolationslauf 34139199314](https://github.com/irongeeks/ironcrew/actions/runs/34139199314) ist erfolgreich; die [Originalbelege](test-evidence/ci/linux-686022a/github-run.json) sind dauerhaft gespeichert. Die vorherige [Drei-OS-CI 34137823550](https://github.com/irongeeks/ironcrew/actions/runs/34137823550) zu `ebf3b98` bestand bereits jeweils 508 Tests ohne Skips auf macOS, Windows und Ubuntu. Dieser historische Erfolg ist im [CI-Verzeichnis](test-evidence/ci/README.md) archiviert und wird nicht auf einen anderen Commit übertragen.

Der aktuelle vollständige Nachweis steht in [verification.md](verification.md). Separate ältere VM-/Betriebsproben gelten ausdrücklich für ihren jeweils dokumentierten Quellstand.


## Bereits implementierte Erweiterungen

- IMAP/MIME-Aufnahme mit Originalen, Anhängen und Deduplizierung; OAuth-Erneuerung mit verschlüsseltem Tokenzustand und Wiederanlaufschutz.
- Native Google-Workspace-Werkzeuge, quellengebundene Rechercheauslieferung und lokale Dateiauslieferung mit konkreten Freigaben.
- Finanzroutinen, wirksame klassifikationsbezogene Belegkorrekturen und versionierte, ausdrücklich aktivierte Lernregeln.
- Tatsächliche parallele Teamkonsultationen mit zugerechneten Beiträgen, Budgetreservierungen und sichtbarem Hallenzustand.
- Suchkosten und ungeklärte Modellkosten mit Quellenbeleg, Reservierung und nachvollziehbarer Klärung.
- Browserprüfung eigener Artefakte in Chromium-Sandbox; gebundene Screenshots und DOM-Nachweise.
- Website-Konzeptvorschauen, markierbare Stellen, versionsgebundenes Chat-/Sammelfeedback und echte Folgeversionen. Die aktuelle unabhängige Website-Prüfung bestand 21 Integrationstests und vier lokale Browserprüfungen.
- Einrichtung mit tatsächlich gespeicherten Profilen, Bereichen und Konfigurationen; neun unterschiedliche lokale GLB-Figuren mit Bewegungen und dokumentierten Messungen auf benanntem Host.
- Signierter Releasefeed, Updateplanung und native Registrierung mit Prüfung der unterstützten Betriebssysteme. Ein echter macOS-Produkt-LaunchAgent wurde mit privater Node-Runtime gestartet, gestoppt und erneut gestartet; siehe `test-evidence/launchd-product.json`.

## Externe Abnahmen

Konkrete Anbieter-Testkonten und ein autorisiertes Modelltestbudget fehlen weiterhin. Lokale HTTP-/TLS-/SMTP-/Browser- und Wiederherstellungstests belegen keine erfolgreiche Nutzung echter Kundenkonten. Die vorhandenen Windows-Server-2025-CI-, macOS- und getrennten Linux-VM-Nachweise gelten nur für ihre benannten Umgebungen. Eine vollständige administrative Zielinstallation über alle freigegebenen CPU-/OS-Varianten, Windows/Hyper-V-Isolation und ein privilegierter macOS-LaunchDaemon sind damit nicht vollständig abgenommen.

Produktiver Signaturschlüssel, administrative Zielinstallation und langfristiger Betrieb sind getrennte Releaseaufgaben. Bestehende Distributionsnachweise mit temporärem TEST-Schlüssel sind keine Produktionsfreigabe. Der physische Screenreader-Hörtest bleibt als manuelle Zugänglichkeitsprobe offen. Die vorhandenen Figuren-, Animations- und Bildschirmnachweise sind keine subjektive Nutzerbewertung; daraus entsteht keine zusätzliche technische Freigabeanforderung.

Keine Kundensite wurde veröffentlicht, keine Nachricht an reale Empfänger gesendet und keine Zahlung oder Steuerübermittlung ausgelöst. Die optionale Bankingfunktion wird ohne eingerichtete Verbindung nicht als verfügbar ausgegeben.
