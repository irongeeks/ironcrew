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

Der [erste Versuch](first-attempt-timeout.json) überschritt während gleichzeitigem Gesamtgate/Build die 90-Sekunden-Gesamtwartezeit des ursprünglichen Testharness. Zuletzt beobachtete persistierte Phase: `backed_up`; dieser Versuch zählt ausdrücklich nicht als Erfolg. Der erfolgreiche isolierte Wiederholungslauf verwendete eine außerhalb des Repos abgelegte Testkopie mit **180 Sekunden Gesamtwartezeit** und Fehlerprotokoll. Fachliche Assertions und die **produktive 30-Sekunden-Gesundheitsfrist nach Start** blieben unverändert. Original- und ausgeführter Harnesshash sind im Erfolgsbeleg enthalten; die Repoquelle wurde für die Wiederholung nicht geändert.

Die [finale Distribution](distribution.json) enthält **12763 manifestierte Dateien** für macOS ARM64, **90815205 Archivbytes**. Archiv-SHA256: `ea8f4bc11b3a49cd893080e385f8b6a12b0eb7ebf42709add53f85c2e7aa1af2`; Manifest-SHA256: `6f00ef9c16cb2c1e41d82a94233ff7372b75e5ddfce1f73b61267cd59ad42433`.

Lokales Archiv:
`/Users/robert/git/ironcrew/local-artifacts/final-complete-TEST-5O1PAZ/ironcrew-0.4.3-darwin-arm64-TEST.tgz`.

Der öffentliche Testschlüssel liegt daneben unter `TEMPORARY-TEST-PUBLIC.pem`. Der private temporäre Ed25519-Testschlüssel liegt außerhalb des Archivs und wurde zusätzlich anhand seines Inhalts-Hashs gegen alle manifestierten Dateien auf Abwesenheit geprüft.

Die [unabhängige Archivprüfung](independent-artifact-check.json) las jede Datei mit Python-`tarfile` als Stream, prüfte Bytezahl/SHA256, vollständige Manifestdeckung, doppelte/kollidierende Pfade und fehlende Archivlinks. Eine separate `verifyRelease`-Ausführung bestätigte erneut die Ed25519-Signatur. **Alle 315 kompilierten Paketdateien** stimmen auch mit dem anschließend wiederholten finalen Build überein. Der zugehörige erfolgreiche vollständige Gate-Lauf umfasst **489 Tests, null Skips** und bindet **333 Quelldateien** an Manifest-SHA256 `dee3e61905b5460d55e27d13025b5c22fee0c58d63f9931865f6086b6fb69d04`.

Reproduktion auf dieser eigenen Testinstallation nach Prüfung des öffentlichen Testschlüssels:

```sh
node /Users/robert/git/ironcrew/local-artifacts/final-complete-TEST-5O1PAZ/production-update-proof-180s.mjs \
  --release /Users/robert/git/ironcrew/local-artifacts/final-complete-TEST-5O1PAZ/release \
  --test-private-key /Users/robert/git/ironcrew/local-artifacts/verified-self-update-TEST-FUKIZI/TEMPORARY-TEST-KEY.pem \
  --age /Users/robert/git/ironcrew/repo/next/.var/ci-tools-native-check/age \
  --evidence /ABS/NEW-EVIDENCE.json
```

Dieser Produktlauf verwendet einen eigenen lokalen Servicebroker. Der getrennte Linuxnachweis oben prüft echte systemd-Dienstwechsel; [der native macOS-Produktnachweis](../launchd-product.json) prüft die echte kompilierte Zentrale als temporären GUI-LaunchAgent einschließlich OS-Vorprüfung, Stopp und Neustart. Ein privilegierter macOS-LaunchDaemon sowie Windows-Dienst/HyperV bleiben ohne native Zielsystemabnahme. Sämtliche Paket-/Update-Signaturen sind lokale Testsignaturen.
