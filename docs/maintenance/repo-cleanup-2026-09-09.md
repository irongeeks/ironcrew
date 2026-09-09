# Repository-Nachtest vom 9. September 2026

Ausgangsstand: `0521a90` (Version 0.4.5), lokaler macOS-ARM64-Checkout.
Die Prüfung umfasst den Legacy-Hauptserver im Root und den eigenständigen Kern
unter `next/`. Die abschließenden historischen Release- und Plattformnachweise wurden erhalten;
überholte Zwischenläufe sind nach Benutzerfreigabe bereinigt.

## Korrekturen

- Überholte `.gitmodules` entfernt: `tools/playwright-mcp` ist bereits vollständig
  versionierter Quellcode; das Repository enthält keine Gitlinks.
- Den Echo-Beispiellink in `docs/node-types/README.md`, doppelte Imports und
  veraltete ESLint-Ausnahmen korrigiert.
- Vitest und Coverage auf 4.1.11 aktualisiert; betroffene transitive Root-Pakete
  gezielt abgesichert. Grund ist unter anderem die vom Maintainer bestätigte
  [Vitest-Schwachstelle](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
  Die Root-CI prüft nun auch Entwicklungsabhängigkeiten und niedrige Schweregrade.
- `pnpm test` und `pnpm test:ci:unit` laufen ausdrücklich einmal vollständig durch,
  statt lokal im Watchmodus der ersten Suite stehenzubleiben.
- Der öffentliche Secret-Check akzeptiert ausschließlich bekannte synthetische
  Testwerte und die vollständigen hashgebundenen öffentlichen PKI-Fixtures.
  Er prüft weiterhin die Git-Historie und gibt bei Treffern keine Secretinhalte aus.
- Wiederaufgenommene `next/`-Prüfungen benötigen denselben Quellfingerabdruck wie
  der frühere Lauf. `--evidence-dir` hält neue Protokolle getrennt von historischen
  Nachweisen; siehe [CI-Prüfungen](../../next/docs/ci-gates.md).
- Der Root-Entwicklungsserver überwacht keine fremden `next/`- und
  Testverzeichnisse mehr. Zuvor löste dort jede neue `tsconfig.json` einen
  vollständigen Browserreload mit Verlust offener Dialoge aus. Der neue
  Browsertest reproduziert das Problem vor dem Fix und prüft den Zustandserhalt.
- Community-Packs aus Browsertests werden pro Lauf isoliert. Früher ausgelassene
  Pack-/Reportfälle erhalten echte Testdaten; der Chromium-Smoketest ist über
  `IRONCREW_BROWSER_SMOKE=1` ausführbar und verwendet einen lokalen HTTP-Server.
- Die Lizenzinventur ergänzt die bereits unverändert im Lockfile vorhandene,
  tatsächlich installierte macOS-ARM64-Remotion-Variante. Ihre fehlende
  Lizenzmetadatenangabe bleibt ausdrücklich `Unknown` und prüfpflichtig; diese
  Inventur ist keine Lizenzfreigabe.

## Erste vollständige lokale Prüfung

Alle lokalen Testartefakte liegen unter `.tmp/repo-cleanup-20260909/` und
gehören nicht zum Release-Quellcode.

| Bereich                                    | Ergebnis                                                                                                            | Lokaler Nachweis                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| next: komplette Gates                      | 12/12 bestanden, 616 Tests, 0 Skips                                                                                 | `next/final/gates.json`                                |
| next: Python-Regressionen                  | 7 bestanden                                                                                                         | `next/python-tests.log`                                |
| next: Audit                                | 0 bekannte Schwachstellen                                                                                           | `next/final/audit.json`                                |
| Root: Webtests mit Coverage                | 709 bestanden, 0 Skips                                                                                              | `legacy/final-unit-migrated.log`                       |
| Root: API mit Coverage und echtem Chromium | 5.377 bestanden, 0 Skips                                                                                            | `legacy/final-unit-migrated.log`                       |
| Root: Skriptverträge                       | 147 bestanden, 0 Skips; nach Browserende separat wiederholt                                                         | `legacy/verified-scripts.log`                          |
| Root: Dokumentationsaufnahmen              | 1 bestanden, auch mit frischem Vite-Cache                                                                           | `legacy/docs-cold-cache.log`                           |
| Root: Browser-E2E                          | 95 bestanden, 0 Skips                                                                                               | `legacy/verified-e2e.log`                              |
| Root: Typprüfung, Build, Format, OpenAPI   | bestanden                                                                                                           | `legacy/verified-*.log`, `legacy/openapi.log`          |
| Root: ESLint                               | 0 Fehler; 436 bestehende `no-explicit-any`-Warnungen                                                                | `legacy/verified-lint.log`                             |
| Root: Audit                                | 0 bekannte Schwachstellen (zuvor 19)                                                                                | `root/audit-final.json`                                |
| Root: Public-Preflight                     | Secretcheck einschließlich 203 Revisionen, Umgebungsvertrag und Build bestanden                                     | `root/preflight-final.log`                             |
| Root: Quellrelease-Verträge                | 11 bestanden                                                                                                        | `root/source-release.log`                              |
| Linux ARM64: Container                     | Build, Health, Migrationen, Persistenz, Neustart, Backup/Restore bestanden                                          | `root/docker-build-final.log`, `root/docker-smoke.log` |
| Linux ARM64: Container-Update              | echtes Offline-Backup, Datenerhalt, gesundes Update und kontrollierter Stopp bei fehlerhaftem Healthcheck bestanden | `root/docker-update-smoke-verified.log`                |
| Root: Lizenzinventur                       | 400 Komponenten inventarisiert, keine neuen Befunde                                                                 | `root/supply-chain/`                                   |

Die Pfade in der letzten Spalte gelten relativ zum lokalen Testartefaktordner.
Insgesamt **6.963 bestandene Tests**, ohne Skips in den abschließenden
Teilläufen, zuzüglich der beiden realen Containerprüfungen. Die maschinenlesbare
Zusammenfassung liegt in `summary.json`. Ein einzelner vorheriger Docs-Lauf
verlor durch einen Reload seine Ansicht; direkter und kalter Nachlauf bestanden.
Eine zusätzliche Ursache dieses einzelnen Vorlaufs ließ sich nicht belegen.

Das geprüfte Containerimage hatte die ID
`sha256:65b44b66ad2234d5b19a02683203909fc42f2b7965c40a47d082b2def19204eb`.
Die Registryauflösung beim Update wurde durch eine lokale Fixture ersetzt;
Containerwechsel, Volumes, Backup und Healthprüfung liefen tatsächlich.
Compose 5.5.1 wurde nur im Testartefaktordner bereitgestellt, gegen den
SHA-256-Wert des [offiziellen Releases](https://github.com/docker/compose/releases/tag/v5.5.1)
geprüft und mit einem für Colima erreichbaren temporären Verzeichnis verwendet.
Werkzeugnachweis: `root/compose-bootstrap.json`.

Die erzeugten E2E-Laufdaten sowie die eigenen Testcontainer und Testimage-Tags
wurden entfernt. Colima wurde wieder gestoppt und der zuvor aktive Docker-Kontext
`default` wiederhergestellt. Buildausgaben, Abhängigkeiten und die gesammelten
Prüfnachweise bleiben für lokale Weiterarbeit verfügbar.

next-Quellmanifest: 357 Dateien, während des vollständigen Laufs unverändert;
SHA-256 des Manifests:
`80ee2c7efb9d7579999d74bc784ad857574cab0a2724e5748c4869ef3f4bdef2`.

## Wiederholen

Root-Suiten nacheinander ausführen: Die Launcher-Vertragstests belegen bewusst
die gleichen Ports wie der E2E-Server. Ein gleichzeitiger Lauf auf demselben Host
ist deshalb kein gültiger Testaufbau. Web/API bestanden im Aggregate-Lauf; der
Skriptteil wurde nach Ende der Browserprozesse vollständig separat ausgeführt.

```sh
pnpm install --frozen-lockfile
IRONCREW_BROWSER_SMOKE=1 pnpm test:ci:unit
pnpm test:e2e
pnpm exec playwright test --config playwright.docs.config.ts
pnpm format:check
pnpm lint
pnpm openapi:check
pnpm build
pnpm audit --json
pnpm preflight:public
node --test scripts/release/source-release.test.mjs
```

Für next gilt die [Anleitung mit expliziten nativen Werkzeugen](../../next/docs/ci-gates.md).
Die Tests benötigen auf macOS eine offizielle portable Node-Runtime mit
Original-Lizenz; das kopierte Homebrew-Binary erfüllt diesen Distributionsvertrag
wegen externer Bibliotheken nicht.

## Grenzen

Dieser Nachtest belegt den lokalen macOS-ARM64-Stand und die separat genannten
Containerprüfungen. Native Windows-Installationen, privilegierte Linux-Dienste,
Liveprovider mit echten Konten sowie manuelle Screenreader-/Produktabnahmen sind
damit nicht neu abgenommen. Die nachfolgende Warnungsbereinigung, Commit und Push sind vom Benutzer
ausdrücklich beauftragt. Eine neue Produktversion oder Veröffentlichung ist
nicht Gegenstand dieses Wartungsauftrags.


## Fortsetzung nach Freigabe: Altlasten und Warnungen

- 189 überholte, versionierte CI-Rohdateien (1.293.311 Bytes) entfernt.
  Die beiden abschließenden OS-Matrizen, ihre Linux-Isolation und der erfolgreiche
  native Windows-Nachweis bleiben vollständig erhalten. Run-Metadaten behalten
  ihre ursprünglichen Werte; der [Nachweisindex](../../next/docs/test-evidence/ci/README.md)
  erklärt die Aufbewahrung und verweist auf den Git-Stand der entfernten Daten.
- Sämtliche 436 expliziten `any`-Warnungen im Legacy-Server durch konkrete
  SQLite-, Prozess-, Provider-, Meeting- und Callbackverträge sowie geprüfte
  JSON-Objekte ersetzt. Der normale Lintbefehl erlaubt jetzt keine Warnungen.
- Three.js-Kern, Renderer und Addons separat gebündelt. Der größte Three.js-Block
  sinkt von 632,24 kB auf 343,93 kB; der Grenzwert bleibt bei 550 kB. Alle Teile
  bleiben an die bei Bedarf geladene Modellvorschau gebunden. Grundlage sind
  die vorhandenen Paketmodule und [Rolldowns Gruppierung mit Prioritäten](https://rolldown.rs/reference/OutputOptions.codeSplitting).
- Der isolierte E2E-Launcher kann mit `IRONCREW_E2E_PREVIEW=1` den Produktionsbuild
  testen. CI prüft damit zusätzlich echten GLB-Upload, Rendering, Drehen, Zoom
  und Speichern sowie die weiterhin zweidimensionale Bürofigur.
- Vitest-Datenbanken und Logs enthalten jetzt Prozess- und Worker-ID. Zwei
  gleichzeitig gestartete Suiten mit Worker `1` können sich dadurch nicht mehr
  gegenseitig die Datenbank löschen; ein Prozess-Regressionsfall prüft den Erhalt.
- Auto-Retry protokolliert den tatsächlich vorher zugewiesenen Agenten. Ist der
  Agent inzwischen gelöscht, wird seine ID verwendet. Zwei echte SQLite-Tests
  sichern beide Fälle ab.
- Supertest 7.2.2 wird per hashgebundenem pnpm-Patch korrigiert: Testanfragen
  nutzen die Adressfamilie des tatsächlich gebundenen Servers. Der alte feste
  IPv4-Host konnte einen anderen Listener auf derselben Portnummer treffen.
  Vier echte Netzwerkfälle sichern die Kollision und beide Adressfamilien ab;
  zwei davon scheitern nachweislich ohne Patch. Details: [Patchbeschreibung](../../patches/README.md).
- Der Source-Release-Gate erkennt eine schon anderweitig vergebene Version
  bereits vor dem Packen. Ein Wartungspush mit derselben Version überspringt
  die Veröffentlichung; bestehende Tags und Assets werden nicht verändert.
  Tests decken direkte und annotierte Tags, Zyklen und unveränderte Retries ab.
- Die next-Prüfung entfernt `FORCE_COLOR`, wenn sie `NO_COLOR` setzt, und
  vermeidet damit ihre eigene widersprüchliche Farbausgabe-Konfiguration.

Die abschließenden Wiederholungen liegen unter `.tmp/warnings-cleanup/`.
Die früheren Ergebnisse oben bleiben ihrem tatsächlichen Prüflauf zugeordnet.


### Abschließende lokale Nachweise der Fortsetzung

| Prüfung | Ergebnis | Log unter `.tmp/warnings-cleanup/` |
| --- | --- | --- |
| Web mit Coverage | 709 bestanden | `web-final.log` |
| API mit Coverage und echtem Chromium | 5.394 bestanden | `api-final.log` |
| Skriptverträge | 148 bestanden | `scripts-final.log` |
| Browser-E2E, kompletter unveränderter Stand | 95 bestanden | `e2e-final-stable.log` |
| Dokumentationsaufnahmen | 1 bestanden | `docs-final.log` |
| Zusätzlicher Produktions-GLB-Test | 1 bestanden | `production-glb-final.log` |
| next, alle 12 Gates | 616 bestanden | `next-final/gates.json` |
| Python-Regressionsfälle | 7 bestanden | `python-final.log` |
| Quellrelease-Verträge | 13 bestanden | `source-release.log` |
| Frozen-Install, Format, OpenAPI, Typecheck, Build | bestanden | `install-final.log`, `format-final.log`, `openapi-final.log`, `build-final.log` |
| ESLint und Produktionsbuild | 0 Fehler, 0 Warnungen | `lint-final.log`, `build-final.log` |
| Beide vollständigen Dependency-Audits | 0 bekannte Schwachstellen | `audit-final.json`, `next-final/audit.json` |

Das sind **6.983 Tests plus ein zusätzlicher Produktions-GLB-Durchlauf**, ohne
Skips in den abschließenden Teilläufen. `summary.json` enthält die maschinenlesbare
Zusammenfassung. Das neue next-Manifest umfasst unverändert 357 Quelldateien,
SHA-256 `c79c52869d44b3684b4edbdaad4fd22d9271c2311d50a162b9332d69fd2d7f44`.
Die Patch-Kontextzeilen wurden danach lediglich gekürzt; der tatsächlich
installierte Supertest-Code wurde bytegleich zum vollständigen API-Lauf geprüft.

Ein API-Zwischenlauf mit fremdem HTTP-404 bleibt in `api-final-isolated.log`
nachvollziehbar; der deterministische Listener-Test belegt die Ursache und den
Fix. Ein Browser-Zwischenlauf verlor die Projektplanansicht durch einen Reload.
Dessen zusätzliche Ursache ließ sich nicht belegen; der kalte gezielte Lauf und
anschließend alle 95 Browserfälle ohne Quellenänderungen bestanden. Diagnose
und ursprüngliche Browserartefakte liegen unter `reload-diagnosis/` beziehungsweise
`e2e-first-artifacts/`. Eine bloße Wiederholung ohne Ursachenprüfung ersetzte
keinen Fehlerfix.

Die unabhängigen Reviews bestätigten die konkreten Callbackverträge und die
Unversehrtheit der erhaltenen Baselines (109 Dateien, 100 geprüfte Artefakthashes,
37 unveränderte Run-Metadaten). Commit und Push wurden ausdrücklich autorisiert;
die zugehörigen Remote-Prüfungen sind am gepushten Commit in GitHub Actions
nachvollziehbar. Dieser Bericht behauptet keine neue Releaseveröffentlichung.
