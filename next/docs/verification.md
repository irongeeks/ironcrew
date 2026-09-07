# Geprüfter lokaler Entwicklungsstand

2026-09-07T12:16:07.231328+00:00 · Arbeitszweig `rebuild/ironcrew` · Basis `76160c0e56324d1ec16ebf2956cbeadbc544cfc4`. Die Suite wurde vor dem Commit auf dem durch Dateihashes gebundenen Arbeitsstand ausgeführt.

**Alle lokalen Abschlussgates bestanden: 489 automatisierte Tests, keine ausgelassenen Fälle.**

| Gruppe | Bestanden |
| --- | ---: |
| unit | 51 |
| contracts | 46 |
| integration | 272 |
| e2e | 46 |
| recovery | 20 |
| install-tests | 54 |

Zusätzlich bestanden: Frozen-Lockfile-Installation, Formatprüfung, ESLint, TypeScript, Produktionsbuild und OpenAPI-Abgleich. Der Dependency-Audit meldet zum Prüfzeitpunkt **0 bekannte Schwachstellen**. Befehle, Plattform, Laufzeiten und vollständige Logs: [gates.json](test-evidence/gates.json), [audit.json](test-evidence/audit.json). Fünf zusätzliche Pythonprüfungen des CI-Bootstraps und Testzählers wurden erfolgreich ausgeführt; sie werden nicht in die 489 Fälle eingerechnet.

Die Browsergruppe enthält ausdrücklich gekennzeichnete UI-Vertragsfixtures sowie tatsächliche lokale HTTP-/SQLite-Abläufe. Unter anderem werden frische Einrichtung, Kunden-/Projektzuordnung, Mail-/OAuth-Konfiguration, Kostenklärung, Finanzen, Websitefeedback mit alten Versionen, technische Betreuungsrichtlinien, Worker, Kanäle, Incidentfreigaben, Dokumentoriginale und WebGL-Ausfall geprüft. Ein Testserver oder eine Konfigurationsprüfung ist keine Liveabnahme eines Anbieter- oder Kundenkontos. Die [Anforderungszuordnung](workflow-acceptance.md) und [Abnahmematrix](acceptance-status.json) weisen diese Grenzen einzeln aus.

## Quellbindung

Der vollständige Lauf blieb auf einem unveränderten Stand. [source-manifest.json](test-evidence/source-manifest.json) bindet 333 Dateien: Code, Tests, Skripte, Laufzeitassets, Lizenz und Workspace-Buildkonfiguration. Abhängigkeiten, Buildausgabe, lokale Daten, Screenshots und Berichte sind ausgenommen. SHA-256 der exakten UTF-8-Manifestdatei:

`dee3e61905b5460d55e27d13025b5c22fee0c58d63f9931865f6086b6fb69d04`

Die 21 Originalpaketdateien, die Manifestkopie und die beiden verwendeten Markenassets wurden erneut bytegenau geprüft; [Integritätsnachweis](test-evidence/package-integrity.json).

## Aktuelle Leistungsmessung

Nach Abschluss der übrigen Lasttests bestand der unveränderte Build den expliziten 30-FPS-Referenzlauf mit **36,57 FPS** (Apple M5, macOS arm64, Chromium 149/SwiftShader, 1440×1000, DPR 1). Bei 1.000 über die HTTP-API angelegten Aufträgen beträgt die Eingabereaktion **P95 23 ms**. Initiales JavaScript: **151.682 Bytes gzip-equivalent**; HQ-Ressourcen: **1.778.584 Bytes gzip-equivalent**. Axe meldet keine Verstöße in den sechs geprüften Leer-/Blockiert-Ansichten. Rohdaten, Lastgrenzen und Reproduktion: [Kapazität](ui-capacity-validation.md), [Halle](crew-visual-validation.md). Dies ist weder eine geräteübergreifende FPS-Garantie noch ein physischer Screenreader-Hörtest.

## Native Distribution und zusätzliche Betriebsproben

Das neue macOS-ARM64-TEST-Paket liegt unter `/Users/robert/git/ironcrew/local-artifacts/final-complete-TEST-5O1PAZ/ironcrew-0.4.3-darwin-arm64-TEST.tgz`, Größe **90.815.205 Bytes**. Es enthält eine private Node-26.4.0-Runtime, Produktionsabhängigkeiten, native Dienst-/Updaterprogramme, Oberfläche und Anleitungen. Ed25519-Signatur und sämtliche **12.763** regulären Archivdateien wurden unabhängig geprüft; keine Links oder doppelten Pfade. Die 315 enthaltenen Builddateien entsprechen dem finalen Build.

Archiv-SHA-256: `ea8f4bc11b3a49cd893080e385f8b6a12b0eb7ebf42709add53f85c2e7aa1af2`.

Manifest-SHA-256: `6f00ef9c16cb2c1e41d82a94233ff7372b75e5ddfce1f73b61267cd59ad42433`.

Der separate echte Produktupdate-Nachweis **0.4.3 → 0.4.4 ist bestanden**: neue Bootidentität und korrektes Kandidatmanifest, erfolgreiche Restoreprobe, CEO-Plan im Zustand `applied` sowie verschlüsseltes Offlinebackup mit 225.016 Bytes. Testzentrale und Updater wurden beendet und temporäre Daten entfernt; [Produktprotokoll](test-evidence/self-update/full-product-smoke.json). Der erste Versuch überschritt unter paralleler Prüf-/Kopierlast das 90-Sekunden-Gesamtwartefenster des Testskripts und gilt nicht als bestanden. Die erfolgreiche isolierte Wiederholung verwendete 180 Sekunden Gesamtwartezeit mit identischen fachlichen Assertions, unverändertem Produkt und unveränderter Gesundheitsfrist. Der erste Timeout bleibt als eigener Nachweis erhalten.

Weitere tatsächlich ausgeführte Nachweise bleiben mit ihrem jeweils dokumentierten damaligen Stand verknüpft:

- Linux-Isolation mit 17 Angriffsszenarien und eigene VM: [Labor](test-evidence/isolation/README.md).
- Getrennte Mac-/Linux-Hosts mit WSS, Datei-/Logstreams, Replay, Abbruch und React-/WordPress-Builds: [Remoteausführung](remote-execution.md).
- Tatsächliche WordPress-/PHP-/MariaDB-Installation und isolierte Websitepakete: [Website-Builds](site-builds.md).
- Native Linux-systemd-Updates mit Fehlerinduktion und Rückweg: [Betriebslabor](test-evidence/self-update/README.md).
- Aktuell erneut gestarteter, gestoppter und neugestarteter macOS-Produkt-LaunchAgent mit OS-Vorprüfung und begrenztem Stop-Warten: [Dienstnachweis](test-evidence/launchd-product.json).

## Reproduktion und verbleibende Abnahme

```sh
python3 scripts/verify-local.py --require-tools
```

Vorher `IRONCREW_TEST_AGE`, `IRONCREW_TEST_AGE_KEYGEN` und `IRONCREW_TEST_NODE` auf die geprüften eigenständigen Programme setzen; [Voraussetzungen](../README.md). Die GitHub-CI verwendet denselben strikten Runner auf Ubuntu, macOS und Windows; ihre Ergebnisse sind eine getrennte Prüfung des gepushten Commits.

Der temporäre TEST-Signaturschlüssel ist kein produktiver Vertrauensanker. Anbieter-/Kundenkonten, produktive Zielinstallation und verbleibende native Plattform-/Bedienungsabnahmen sind ausdrücklich als [Releasegrenzen](release-readiness.md) aufgeführt. Keine bezahlte Modellanfrage, Kundennachricht, Zahlung oder Kundensite-Veröffentlichung wurde für diese Prüfungen ausgelöst.
