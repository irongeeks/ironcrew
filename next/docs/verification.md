# Geprüfter lokaler Entwicklungsstand

2026-09-07T15:36:55.645592+00:00 · Arbeitszweig `rebuild/ironcrew` · geprüfter Implementierungscommit `686022a9a0f02f7ff8a93e120c4e82965c13a379`. Sämtliche 341 Dateihashes des lokalen Prüflaufs stimmen mit den Git-Dateien dieses Commits überein.

**Alle lokalen Abschlussgates bestanden: 508 automatisierte Tests, keine ausgelassenen Fälle.**

| Gruppe | Bestanden |
| --- | ---: |
| unit | 53 |
| contracts | 46 |
| integration | 278 |
| e2e | 46 |
| recovery | 20 |
| install-tests | 65 |

Zusätzlich bestanden: Frozen-Lockfile-Installation, Formatprüfung, ESLint, TypeScript, Produktionsbuild und OpenAPI-Abgleich. Der Dependency-Audit meldet zum Prüfzeitpunkt **0 bekannte Schwachstellen**. Befehle, Plattform, Laufzeiten und vollständige Logs: [gates.json](test-evidence/gates.json), [audit.json](test-evidence/audit.json). Fünf zusätzliche Pythonprüfungen des CI-Bootstraps und Testzählers wurden erfolgreich ausgeführt; sie werden nicht in die 508 Fälle eingerechnet.

Die Browsergruppe enthält ausdrücklich gekennzeichnete UI-Vertragsfixtures sowie tatsächliche lokale HTTP-/SQLite-Abläufe. Unter anderem werden frische Einrichtung, Kunden-/Projektzuordnung, Mail-/OAuth-Konfiguration, Kostenklärung, Finanzen, Websitefeedback mit alten Versionen, technische Betreuungsrichtlinien, Worker, Kanäle, Incidentfreigaben, Dokumentoriginale und WebGL-Ausfall geprüft. Ein Testserver oder eine Konfigurationsprüfung ist keine Liveabnahme eines Anbieter- oder Kundenkontos. Die [Anforderungszuordnung](workflow-acceptance.md) und [Abnahmematrix](acceptance-status.json) weisen diese Grenzen einzeln aus.

## Quellbindung

Der vollständige Lauf blieb auf einem unveränderten Stand. [source-manifest.json](test-evidence/source-manifest.json) bindet 341 Dateien: Code, Tests, Skripte, Laufzeitassets, Lizenz und Workspace-Buildkonfiguration. Abhängigkeiten, Buildausgabe, lokale Daten, Screenshots und Berichte sind ausgenommen. SHA-256 der exakten UTF-8-Manifestdatei:

`045d7404631d412d4f5fb5d07f54fea82dce5fe9472f3fee9da9b04f7b4e649e`

Die 21 Originalpaketdateien, die Manifestkopie und die beiden verwendeten Markenassets wurden erneut bytegenau geprüft; [Integritätsnachweis](test-evidence/package-integrity.json).

## Aktuelle Leistungsmessung

Nach statischer Testvorbereitung liefen bestätigte Animation, volle 2s Aufwärmen und 6s Messung bei Standardqualität (`animatedDuringSample=true`); erst danach wurde für die Testauswertung pausiert. Die erneute Messung im vollständigen lokalen Prüflauf erreichte **41,64 FPS** (Apple M5, macOS arm64, Chromium 149/SwiftShader, 1440×1000, DPR 1). Die getrennte historische Kapazitätsmessung vom 2026-09-07T12:24:09.878Z ergab bei 1.000 über die HTTP-API angelegten Aufträgen eine Eingabereaktion von **P95 23 ms**. Initiales JavaScript: **151.682 Bytes gzip-equivalent**; HQ-Ressourcen: **1.778.584 Bytes gzip-equivalent**. Axe meldet keine Verstöße in den sechs geprüften Leer-/Blockiert-Ansichten. Rohdaten, Lastgrenzen und Reproduktion: [Kapazität](ui-capacity-validation.md), [Halle](crew-visual-validation.md). Dies ist weder eine geräteübergreifende FPS-Garantie noch ein physischer Screenreader-Hörtest.

## Native Distribution und zusätzliche Betriebsproben

Das macOS-ARM64-TEST-Paket aus Produktcommit `aabff77f55608ed1152429c5072eeba6a7c394a1` liegt unter `/Users/robert/git/ironcrew/local-artifacts/mobile-native-final-TEST-3kXDR9/ironcrew-0.4.3-darwin-arm64-TEST.tgz` und umfasst **90.813.487 Bytes**. Die unabhängige Prüfung bestätigte die Ed25519-Signatur, alle **12.763** regulären Archivdateien, fehlende Links/Pfadduplikate und **315 bytegleiche Builddateien**. Der private TEST-Signaturschlüssel ist nicht enthalten. [Paketprüfung](test-evidence/self-update/independent-artifact-check.json). Paketbau und echter Updateablauf bleiben an `aabff77` gebunden. Nach der anschließenden Test-/Prüfskriptkorrektur wurden alle 315 Produktdateien nochmals bytegleich zum abschließenden Build von `686022a` geprüft; dieser Vergleich bindet das unveränderte Paket an den neueren Gatebericht.

Archiv-SHA-256: `c17241ee86473ae1bd103b073132a524306f6439e5a7132b9318c93a414766c4`.

Manifest-SHA-256: `1edd9be09c127905bfa3cc5a236bcea2a3614a8631a90edaab8277b06c4659d6`.

Der echte Produktupdate-Nachweis **0.4.3 → 0.4.4** bestand für dieses Paket in **96,026 Sekunden**: neue Bootidentität, geprüftes Kandidatmanifest, erfolgreiche Restoreprobe, CEO-Plan `applied` und verschlüsseltes Offlinebackup mit **225.016 Bytes**. Eigene temporäre Prozesse und Daten wurden bereinigt. Die produktive Gesundheitsfrist bleibt bei **30 Sekunden**; das Testfenster umfasst **180 Sekunden**. [Produktprotokoll](test-evidence/self-update/full-product-smoke.json), [Betriebsnachweis](test-evidence/self-update/README.md).

Weitere tatsächlich ausgeführte Nachweise bleiben mit ihrem jeweils dokumentierten damaligen Stand verknüpft:

- Linux-Isolation mit 17 Angriffsszenarien und eigene VM: [Labor](test-evidence/isolation/README.md).
- Getrennte Mac-/Linux-Hosts mit WSS, Datei-/Logstreams, Replay, Abbruch und React-/WordPress-Builds: [Remoteausführung](remote-execution.md).
- Tatsächliche WordPress-/PHP-/MariaDB-Installation und isolierte Websitepakete: [Website-Builds](site-builds.md).
- Native Linux-systemd-Updates mit Fehlerinduktion und Rückweg: [Betriebslabor](test-evidence/self-update/README.md).
- Aktuell erneut gestarteter, gestoppter und neugestarteter macOS-Produkt-LaunchAgent mit OS-Vorprüfung und begrenztem Stop-Warten: [Dienstnachweis](test-evidence/launchd-product.json).

## GitHub-Prüfung des Implementierungscommits

Die [Drei-OS-CI 34139199380](https://github.com/irongeeks/ironcrew/actions/runs/34139199380) hat diesen abschließenden Stand auf macOS 15, Windows Server 2025 und Ubuntu 24.04 vollständig bestanden: **jeweils 508 Tests, 12 erfolgreiche Gates und keine Skips**. Die Originalberichte sind für [macOS](test-evidence/ci/686022a-macos-15/gates.json), [Windows](test-evidence/ci/686022a-windows-2025/gates.json) und [Ubuntu](test-evidence/ci/686022a-ubuntu-24.04/gates.json) gespeichert. Der [Linux-Isolationslauf 34139199314](https://github.com/irongeeks/ironcrew/actions/runs/34139199314) ist erfolgreich; die [Originalbelege](test-evidence/ci/linux-686022a/github-run.json) sind dauerhaft gespeichert. Die vorherige [Drei-OS-CI 34137823550](https://github.com/irongeeks/ironcrew/actions/runs/34137823550) zu `ebf3b98` bestand bereits jeweils 508 Tests ohne Skips auf macOS, Windows und Ubuntu. Dieser historische Erfolg ist im [CI-Verzeichnis](test-evidence/ci/README.md) archiviert und wird nicht auf einen anderen Commit übertragen.

Die abschließenden Windows-Korrekturen betreffen den begrenzten nativen Testprozess-Handlevertrag und die lokale Hostidentifikation. Die Hosterkennung liest dieselben fünf `Win32_OperatingSystem`-Felder direkt über WMI, ohne auf einen vorgefüllten PowerShell-Modulcache angewiesen zu sein. Minimalumgebung, 15-Sekunden-Grenze und OS-/SKU-/Caption-Prüfungen bleiben erhalten. Der native Gegenversuch lieferte in 284 ms dieselben Werte wie der CIM-Kontrolllauf; der Produkt-Host-/Registrierungstest bestand im Windows-Fokuslauf in 4.239 ms.

Der Browser-Deny-Proxy behandelt Verbindungsabbrüche an übernommenen CONNECT-Sockets und schließt diese beim Herunterfahren. Zwei echte TCP-Regressionstests prüfen weiterhin 403, fehlende Weiterleitung und das vollständige Schließen der Verbindungen; die Browser-Sandbox bleibt aktiv.

## Reproduktion und verbleibende Abnahme

```sh
python3 scripts/verify-local.py --require-tools
```

Vorher `IRONCREW_TEST_AGE`, `IRONCREW_TEST_AGE_KEYGEN` und `IRONCREW_TEST_NODE` auf die geprüften eigenständigen Programme setzen; [Voraussetzungen](../README.md). Die GitHub-CI verwendet denselben strikten Runner auf Ubuntu, macOS und Windows; ihre Ergebnisse sind eine getrennte Prüfung des gepushten Commits.

Der temporäre TEST-Signaturschlüssel ist kein produktiver Vertrauensanker. Anbieter-/Kundenkonten, produktive Zielinstallation und verbleibende native Plattform-/Bedienungsabnahmen sind ausdrücklich als [Releasegrenzen](release-readiness.md) aufgeführt. Keine bezahlte Modellanfrage, Kundennachricht, Zahlung oder Kundensite-Veröffentlichung wurde für diese Prüfungen ausgelöst.
