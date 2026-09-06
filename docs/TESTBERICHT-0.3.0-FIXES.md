# Testbericht 0.3.0 — Korrekturen zur Prüfung

Stand: 6. September 2026. Basis: `main`, Commit
`2c709e38c83dfe329e21680de0df1d2dd832fabe` (v0.3.0).
Änderungspaket zur Prüfung als Pull Request. Keine Installation wurde aktualisiert
und kein Release veröffentlicht.

## OpenRouter ohne Herstellerbeschränkung

Die ausgelieferte Policy erlaubt alle Modell-IDs und alle Hosting-Anbieter.
Es gibt keine vordefinierte Hersteller-Sperrliste mehr. Der explizite Platzhalter
`*` bedeutet alle; leere Listen bedeuten weiterhin eine bewusste Sperre.
OpenRouter erhält bei uneingeschränkter Auswahl keine `only`-/`order`-Liste.

Vessel-Erstellung, Vessel-Bearbeitung, Routing und der bisherige Providerkatalog
laden den vollständigen Katalog. Kostenlose und kostenpflichtige Modelle sowie
neue Anbieter werden nicht ausgefiltert. Ein Ausfall des Katalogs verhindert
keine direkte Eingabe einer Modell-ID. Der Katalog nutzt `output_modalities=all`:
[OpenRouter-Dokumentation](https://openrouter.ai/docs/guides/overview/models).

Die Auswahl fügt der Runtime keine neuen Audio-/Bild-/Embedding-Fähigkeiten
hinzu. Modelle ohne Textausgabe sind sichtbar und auswählbar, erhalten aber
einen Hinweis zur Text-Chat-Anforderung der Agenten-Runtime. Reale Quoten,
Verfügbarkeit und die gesonderten Datenschutzanforderungen sensibler Aufgaben
bleiben wirksam. Es wurden keine kostenpflichtigen Modellaufrufe durchgeführt.

Bestehende, vom Owner gespeicherte Einschränkungen werden nicht gelöscht.
Nach einem Update können sie unter Provider-Freigaben durch **Alle Modelle** und
**Alle Anbieter** ersetzt werden. Separate native Runner benötigen ebenfalls
die aktualisierte Konfiguration.

## Befunde und Stand

| Befund | Stand der Änderung                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1     | E2E nutzt eigene Ports, frische DB je Lauf, API-Identitätsprüfung, keine produktive `.env`, keine Serverwiederverwendung. Portkonflikte brechen vor Schreibzugriffen ab.                                                                                                              |
| H1     | Gleiche kanonische Vorfahren-/Symlink-Auflösung für Projektpfade und erlaubte Wurzeln; Escape-Abweisung bleibt getestet.                                                                                                                                                              |
| H2     | CharacterStore-Test verwendet Realpfad; vollständige API-Suite in Linux-/macOS-CI statt Teilmenge. macOS wurde hier nicht ausgeführt.                                                                                                                                                 |
| H3     | 429 verbraucht Wiederholungsbudget; exponentieller Backoff mit Retry-After-Mindestfrist. Nach Budgetende sichtbares `failed`, Queue `dead`. Unberührte zustandslose Versuche gleicher Identität verwenden denselben Run.                                                              |
| M1     | Mitarbeiterzahlen aus `crew_agents`; alte Mitarbeiter separat. Aufgaben-/Aktivitätsmetriken bleiben teilweise Legacy und sind in API-Metadaten gekennzeichnet. Keine zusätzliche Migration für Installationen vor 0.3.0: laut Projektvorgabe existieren keine solchen Installationen. |
| M2     | POST/PATCH validieren Mitarbeiter vor SQL und liefern `400 agent_not_found`. Crew-IDs gehören weiter zu `/api/crew/tasks`; keine riskante FK-Migration.                                                                                                                               |
| M3     | Firmendatensatz ist Quelle für Firmen-/CEO-Namen; vorhandene Wizard-Daten werden einmalig übernommen. Settings und Identität speichern atomar.                                                                                                                                        |
| M4     | Regel-Injektion idempotent, `setup.json` ignoriert; E2E konsumiert die Installationsdatei nicht.                                                                                                                                                                                      |
| M5     | Hersteller-/Hosting-Sperren standardmäßig entfernt; vollständiger dynamischer Katalog mit freier ID-Eingabe.                                                                                                                                                                          |
| M6     | Explizite Policy-Einschränkungen werden bereits bei Vessel-Anlage und Modell-/Runtime-Änderung geprüft.                                                                                                                                                                               |
| N1     | Spezifische, verständliche Vault-Fehler statt ausschließlich `provider_test_failed`.                                                                                                                                                                                                  |
| N2     | Kraken-Symbol ersetzt. UI einschließlich Navigation, Einrichtung, Fachansichten und Update-Hinweisen auf EN/DE vereinheitlicht.                                                                                                                                                       |
| N3     | Setup berücksichtigt authentifizierte OpenRouter-Runtimes und injizierte Secrets.                                                                                                                                                                                                     |
| N4     | Einheitlicher Standard `data/vault`, Erstellung beim expliziten Verbindungstest; E2E schreibt seinen Vault in den eigenen Laufordner.                                                                                                                                                 |
| N5     | Fünf gezielte Dependency-Updates; Produktionsaudit ohne bekannte Advisories.                                                                                                                                                                                                          |
| N6     | Hauptansichten und Dialoge laden bei Bedarf. React bleibt im Startgraph, Charts/Terminal/3D außerhalb. Wirkungsloser SSH-Import bereinigt; messbare Größen siehe unten.                                                                                                               |
| I1     | pnpm-Einstellungen einschließlich Security-Pins nach `pnpm-workspace.yaml` verschoben; Regressionstests lesen die aktive Datei.                                                                                                                                                       |
| I2     | Bestehende API-Schreibweisen bleiben unverändert, um Clients nicht stillschweigend zu brechen.                                                                                                                                                                                        |
| I3     | Selbstüberspringenden Modus-Test durch echte Assertions ersetzt. Zwei explizite `fixme` und einzelne fremdsprachige Testtitel bleiben offen.                                                                                                                                          |

## Deutsch und Englisch

Nur `en` und `de` sind auswählbar und über die Settings-API speicherbar.
Unbekannte gespeicherte Sprachcodes fallen auf Englisch zurück; die Browsererkennung
berücksichtigt nur unterstützte Sprachen. Eine ausdrücklich gespeicherte Auswahl
wird beim Start nicht durch die Browsersprache ersetzt. Die Sprache gilt auch für
`html lang`, Datums-/Zahlenformate und den Einrichtungsassistenten.

Die Navigation verwendet konsistente Produktbegriffe. UI-eigene Status-/Rollenlabels,
Formularhilfen, Fehlertexte, Geschäftsdatenbeschreibungen und eingebaute Workflow-Knoten
folgen der aktiven Sprache. Benutzertexte, Namen, externe Datensätze, Modell-IDs und
technische Diagnosecodes bleiben unverändert. Release-Anweisungen verwenden die
aktuelle UI-Sprache, ohne den gemeinsam genutzten Release-Cache sprachabhängig zu machen.

Keine zusätzliche Legacy-Datenmigration: Unterstützte Ausgangsversion ist 0.3.0.
Vorhandene normale Schema-/Settings-Verarbeitung bleibt erhalten.

## Bundle-Optimierung

| JavaScript-Ladegraph                                  |  Vorher, gzip | Nachher, gzip | Verringerung |
| ----------------------------------------------------- | ------------: | ------------: | -----------: |
| App-Einstieg einschließlich statischer Abhängigkeiten | 653,179 Bytes | 122,722 Bytes |       81.2 % |
| Einstieg plus Zentrale und Büro                       | 653,179 Bytes | 188,729 Bytes |       71.1 % |

Messung: identische Produktionskonfiguration und gzip-Standardkompression je Datei;
alle statischen Imports transitiv und ohne doppelte Dateien summiert. Vorher-Wert
ist der Build unmittelbar vor der Ladeaufteilung, Nachher einschließlich EN/DE.
Die Zahlen betreffen JavaScript, nicht CSS/Bilder oder gemessene Ladezeiten.

Große Ansichten und Dialoge laden per `React.lazy`; lokale Lade-/Fehleranzeigen
fangen verzögerte oder gescheiterte Chunk-Downloads ab. Der zuständige UI-Baum
bleibt bei Navigation zwischen Büro, Aufgaben und Zentrale erhalten.
1.152 reine UI-Übersetzungsobjekte enthalten nur noch Englisch und Deutsch.

Der isolierte Three.js-Chunk bleibt rund 632 kB unkomprimiert (159 kB gzip),
wird erst für die 3D-Vorschau geladen und erzeugt weiterhin die ehrliche
550-kB-Buildwarnung. Die Warnschwelle wurde nicht erhöht.

## Verifikation

- Frontend: 85 Dateien, 692 Tests bestanden, einschließlich Sprachwechsel ohne Verlust von Eingaben und Navigationszustand.
- TypeScript-Projektbuild, Produktionsbuild und Formatprüfung erfolgreich.
  ESLint: 0 Fehler, 446 Warnungen (überwiegend bestehende Typ-/Importhinweise).
- Produktionsaudit: 0 bekannte Advisories (vorher 12); Stand dieses Prüflaufs.
- E2E-Isolation zusätzlich praktisch gegen simulierte laufende API auf Port 8790
  geprüft: 0 Zugriffe auf Live-API; Settings-Änderung ausschließlich in separater
  SQLite. Start bei belegtem Testport verweigert.
- Browser-E2E nicht abgeschlossen: Chromium fehlt; regulärer Download läuft in
  dieser Umgebung in Timeouts. API/Vite-Start und API-Identitätsprüfung funktionieren.
- API-Abschlusslauf: 5.355 bestanden, 6 fehlgeschlagen, 1 übersprungen.
  Alle sechs Fehler liegen in den unveränderten Unix-Socket-Tests von
  `runner-daemon.test.ts`: `listen EPERM` in dieser Umgebung.
- Skript-Suite: 11 Dateien, 110 Tests bestanden.
- Zusammen mit dem Frontend: 6.157 bestandene Tests, 6 umgebungsbedingte
  Fehler, 1 übersprungener Test. Die gesamte API-Suite wird nicht als grün gewertet.
- Bestehende OpenAPI-Vertragsprüfung erfolgreich; deren Scanner meldet weiterhin
  breite, schon vorhandene Abweichungen und deckt nicht jede Route ab.

Ein vollständiger Release-Nachweis benötigt zusätzlich die Browser-Suite und
Linux-/macOS-CI einschließlich echter Unix-Socket-Tests. Historische fehlerhafte
Runs oder durch alte E2E-Läufe veränderte Produktivdaten werden nicht automatisch
bereinigt.
