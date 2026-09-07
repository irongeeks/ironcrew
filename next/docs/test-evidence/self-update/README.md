# Selbstupdate: native und vollständige Produktnachweise

[Linux/systemd-Protokoll](linux-systemd-2026-09-07.log): sieben tatsächlich ausgeführte Fälle, keine Skips. Testsystem: eigene Lima-VM `ic-lab`, Ubuntu24.04.4LTS (`aarch64`), offizielle private Node26.4.0-Runtime; age1.3.2-linux-arm64, Download-SHA256 `6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4`.

Dies ist ein kontrollierter Labornachweis. Die Fixture setzt ein vorhandenes Gastkonto **robert mit UID501** voraus und erstellt temporäre systemd-Units mit `User=robert`. Tatsächlich geprüft: Konto UID501/GID1000, zusätzlich `systemd-journal`; Daten-/Backupverzeichnisse werden von der Fixture ausdrücklich auf UID501/GID501 gesetzt. Der privilegierte Updater arbeitet als Root, seine signierten DB-/Datei-/Backuphelfer als UID501/GID501 ohne privilegierte Zusatzgruppen. Die Fixture ist kein allgemeiner systemd-Installer. Sie startet ein kleines wirklich laufendes HTTP-Control-Testprogramm (Version0.4.0→0.4.1), mit echter privater Runtime, Dienstwechseln, Datenbanksperren, Ed25519-Releases, age-Backup und Healthrollback. Die später hinzugefügte Aliasregression ist ein zusätzlicher lokaler Test und nicht nachträglich Teil dieses sieben Fälle umfassenden Linuxprotokolls.

Reproduktion ausschließlich in der dafür vorbereiteten eigenen Linux-Testumgebung:

```sh
sudo env IRONCREW_TEST_SYSTEMD=1 \
  IRONCREW_TEST_AGE=/home/robert.guest/ironcrew-isolation/updater-tools/age/age \
  IRONCREW_TEST_NODE=/home/robert.guest/ironcrew-isolation/tooling/node/bin/node \
  /home/robert.guest/ironcrew-isolation/tooling/node/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/install/updater-service.test.ts tests/isolation/updater-systemd.test.ts
```

Die sieben damaligen Fälle verwendeten folgende SHA256-geprüften Guestdateien:

| Datei                                   | SHA256                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| tests/install/updater-service.test.ts   | c2f55a54c0589e5a210101c439125eccd1094c5f8a89f3c7a49e4d5657d0d61b |
| tests/isolation/updater-systemd.test.ts | 3d47bf8a78e938ef78db0ffb4c87c0bab1b9b16ad2999181c11913f1632fe1db |
| tests/fixtures/updater.ts               | d848ec2a5da4414e1d5c08fc3d33c8a99c570650e919f232dff843e455e2cd09 |
| packages/operations/src/updater.ts      | 63baeefc76b11daef82d9cd77e3d81b3d6e6b85456b72293a550cd215328ad6c |
| packages/operations/src/releases.ts     | 0152dca7887e0edb98a3154e59d40bc4fb440f897ffef429e1d3e5242e2c80b7 |

Der davon getrennte vollständige Produktnachweis verwendet die tatsächlich gebaute und lokal signierte Distribution: private Runtime, echter `Control main`, echte HTTP-Anmeldung, Restoreprobe, konkrete CEO-Planfreigabe, externer signierter Updaterdaemon, neue Release-/Bootidentität und importierter Zustand `applied`.

Der [abschließende erfolgreiche Produktlauf](full-product-smoke.json) vom 07.09.2026 bestätigt Version **0.4.3 → 0.4.4**, neue Boot-ID, exakt passende Manifestidentität, Restoreprobe `passed` und API-Auftrag `applied`. Das echte verschlüsselte Offlinebackup umfasste 225016 Bytes. Der Lauf verwendete das normale macOS-TMPDIR mit `/var`-Pfadalias. Alle Testprozesse wurden geordnet beendet; das eigene temporäre Installations-/Datenverzeichnis wurde entfernt. Keine Nutzerdienste wurden ersetzt, kein Release veröffentlicht.

Der [historische erste Versuch](first-attempt-timeout.json) des vorherigen Pakets `final-complete-TEST-5O1PAZ` überschritt während gleichzeitigem Gesamtgate/Build die 90-Sekunden-Gesamtwartezeit des ursprünglichen Testharness. Zuletzt beobachtete persistierte Phase: `backed_up`; dieser Versuch zählt ausdrücklich nicht als Erfolg. Der damalige erfolgreiche isolierte Wiederholungslauf und die späteren erfolgreichen Läufe einschließlich des neuen Pakets `mobile-native-final-TEST-3kXDR9` verwendeten eine außerhalb des Repos abgelegte Testkopie mit **180 Sekunden Gesamtwartezeit** und Fehlerprotokoll. Fachliche Assertions und die **produktive 30-Sekunden-Gesundheitsfrist nach Start** blieben unverändert. Original- und ausgeführter Harnesshash sind im Erfolgsbeleg enthalten; die Repoquelle wurde für diese Läufe nicht geändert.

Die [finale Distribution](distribution.json) enthält **12763 manifestierte Dateien** für macOS ARM64, **90813487 Archivbytes**. Archiv-SHA256: `c17241ee86473ae1bd103b073132a524306f6439e5a7132b9318c93a414766c4`; Manifest-SHA256: `1edd9be09c127905bfa3cc5a236bcea2a3614a8631a90edaab8277b06c4659d6`.

Lokales Archiv:
`/Users/robert/git/ironcrew/local-artifacts/mobile-native-final-TEST-3kXDR9/ironcrew-0.4.3-darwin-arm64-TEST.tgz`.

Der öffentliche Testschlüssel liegt daneben unter `TEMPORARY-TEST-PUBLIC.pem`. Der private temporäre Ed25519-Testschlüssel liegt außerhalb des Archivs und wurde zusätzlich anhand seines Inhalts-Hashs gegen alle manifestierten Dateien auf Abwesenheit geprüft.

Die [unabhängige Archivprüfung](independent-artifact-check.json) las jede Datei mit Python-`tarfile` als Stream, prüfte Bytezahl/SHA256, vollständige Manifestdeckung, doppelte/kollidierende Pfade und fehlende Archivlinks. Eine separate `verifyRelease`-Ausführung bestätigte erneut die Ed25519-Signatur. **Alle 315 kompilierten Paketdateien** stimmen auch mit dem finalen Build nach den CI-Korrekturen überein. Der zugehörige erfolgreiche vollständige Gate-Lauf umfasst **508 Tests, null Skips** und bindet **341 Quelldateien** an Manifest-SHA256 `045d7404631d412d4f5fb5d07f54fea82dce5fe9472f3fee9da9b04f7b4e649e`.

Paketbau, unabhängige Archivprüfung und neuer echter Updateproof stammen aus `aabff77f55608ed1152429c5072eeba6a7c394a1`. `source-manifest.json` und `final-gates.json` liegen neben dem neuen Archiv; Gate-SHA256 `8e5e499ff81f4850c15e7919bbaa68cebdf8e8533fef351214e3bbeb62c3b896`. Alle 315 kompilierten Dateien wurden gegen den finalen Build verglichen. Der vollständige Produktlauf dauerte **96,026 Sekunden**, endete mit Exitcode 0 und bestätigte die neue Releaseidentität `fb37ca8b24313ac813a1a790552a127509e41bb75d70982d09738840a7daa7b1`. Der Harness, die ausgeführte Prüfroutine, rohe Ergebnisse und der gesonderte Cleanup-Nachweis liegen ebenfalls neben dem Archiv. Keine eigenen Testprozesse oder temporären Installationsverzeichnisse bleiben zurück.

Die abschließende Gatebindung gilt nun für `686022a9a0f02f7ff8a93e120c4e82965c13a379`: 508 Tests ohne Skips, alle zwölf Gates erfolgreich, Audit ohne Befund. Gate-SHA256 `531a8e5ac4f7e6ba5c4ef457409a889cf68cb4e7c5744caf509d713a5d09e84f`; separate Dateien `final-gates-686022a.json` und `final-source-manifest-686022a.json` liegen neben dem Archiv. Alle 315 Dateien des erneut geprüften Builds sind Byte für Byte identisch mit dem bestehenden Paket. Deshalb wurden weder Archiv noch Updateproof erneut ausgeführt. Die ursprünglichen `source-manifest.json`, `final-gates.json`, `original-aab-*.json` und der rohe Produktnachweis behalten ausdrücklich ihre aab-Provenienz; die vorherige ebf-Gatebindung bleibt ebenfalls im Artefaktverzeichnis erhalten. Der finale Stand 686022a bestand die Drei-OS-CI für macOS, Ubuntu und Windows (GitHub-Actions-Lauf `34139199380`) sowie den Linux-Isolationslauf `34139199314`; beide Läufe sind erfolgreich abgeschlossen.

Die früheren Pakete bleiben unverändert erhalten. `native-verified-final-TEST-0htXu2` enthält den vorherigen Stand b9d20e7 mit erfolgreicher Archivprüfung; dessen Updateproof wurde vor der letzten mobilen Suchfeldkorrektur bewusst noch nicht gestartet. Frühere erfolgreiche Produktproben einschließlich d20a werden nicht als Probe des neuen Builds ausgegeben. Die erfolgreiche finale CI-Bindung ist oben separat ausgewiesen; der historische CI-Stand zum Zeitpunkt von Paketbau und Produktproof bleibt in den JSON-Nachweisen unverändert. Dieses Paket und dieser neue Updateproof gelten für macOS ARM64.

Reproduktion auf dieser eigenen Testinstallation nach Prüfung des öffentlichen Testschlüssels:

```sh
node /Users/robert/git/ironcrew/local-artifacts/mobile-native-final-TEST-3kXDR9/production-update-proof-180s.mjs \
  --release /Users/robert/git/ironcrew/local-artifacts/mobile-native-final-TEST-3kXDR9/release \
  --test-private-key /Users/robert/git/ironcrew/local-artifacts/verified-self-update-TEST-FUKIZI/TEMPORARY-TEST-KEY.pem \
  --age /Users/robert/git/ironcrew/repo/next/.var/ci-tools-native-check/age \
  --evidence /ABS/NEW-EVIDENCE.json
```

Dieser Produktlauf verwendet einen eigenen lokalen Servicebroker. Der getrennte Linuxnachweis oben prüft echte systemd-Dienstwechsel; [der native macOS-Produktnachweis](../launchd-product.json) prüft die echte kompilierte Zentrale als temporären GUI-LaunchAgent einschließlich OS-Vorprüfung, Stopp und Neustart. Die fokussierte Windows-CI bestätigte inzwischen den echten PE-Fixturelauncher und signierten Updatewechsel mit Backup/Restoreprobe; dieser Nachweis verwendet einen eigenen Servicebroker und ist keine WinSW-Dienstregistrierung. Ein privilegierter macOS-LaunchDaemon sowie WinSW-Dienst/HyperV bleiben ohne native Zielsystemabnahme. Sämtliche Paket-/Update-Signaturen sind lokale Testsignaturen.
