# IronCrew v0.4.3 — Nachtest Linux und macOS

- [x] Offene Issues #36–47 und Releasebasis 049554d prüfen.
- [x] #36/#37: Modellversand, Reservierungen und laufende Konfiguration reproduzieren und korrigieren.
- [x] #38: SQLite-Dateien einschließlich WAL/SHM privat anlegen und bestehende Rechte härten.
- [x] #39: Mail-Zeitstempel bei Redaction erhalten.
- [x] #40/#41: doppelte Katalog-IDs und überlappende Abrufe behandeln.
- [x] #42: generierte React-/WordPress-Artefakte bereinigen und CSP ausliefern.
- [x] #43: Katalogzähler, UUID-Eingaben, Ausführungsbereitschaft und Einrichtungsfortschritt korrigieren.
- [x] #44/#45/#47: Hauptserver-Proton, QA-CSRF und asynchronen Mobiltest korrigieren.
- [x] #46: Free-Router empfehlen und sichere 404-Hinweise ergänzen.
- [x] Regressionen, Build, Version, README und Docs prüfen.
- [ ] Commit, Push, PR-Merge und v0.4.3 nach vollständigen Release-Gates verifizieren.

## Review

Die Befunde umfassen die Anwendung unter next/ und den mitgelieferten Hauptserver. Beide betroffenen Implementierungen werden geprüft. Release-Gates und bestehende Sicherheitsprüfungen bleiben verbindlich.

- 440 Tests des neuen Kerns bestanden (lokal ohne Browserinspektion und privilegierten Updaterpfad wegen Umgebung; beide bleiben CI-Pflicht).
- 97 fokussierte Hauptserver-Tests, elf Release-Verträge sowie zusätzliche Recovery-Regressionen bestanden.
- Typecheck, ESLint, Formatprüfung und OpenAPI-Abgleich mit 162 Operationen bestanden.
- Unabhängiger Review verschärfte Discard-Beleg-/Reservierungsbindung und korrigierte HTML-Darstellungserhalt.
- Website-Wartungsfixture nutzt die tatsächlich bereinigten Ausgabebytes; alle neun Tests bestanden.
- #37 Neustartpflicht nicht reproduzierbar: echte alte→neue CLI-Konfiguration ohne Neustart erfolgreich; keine unbewiesene Ursachenbehauptung.

- Erste PR-CI: Linux-Neubau einschließlich aller Browser-/Recovery-/Installationsgates und Dependency-Audit bestanden. Hauptserver-CI und native macOS-Prüfung bestanden.
- Zusätzliche native Linux-Hauptserverprüfung: drei Zeitüberschreitungen in SQLite-Reopen/Migrationsfixtures bei unbeschränkter Workerzahl. Auf zwei Worker begrenzen; Assertions, Zeitlimits und vollständige Suiten unverändert erneut prüfen.

- Zweite PR-CI: allgemeine CI und vollständige Plattformprüfung inklusive nativer Linux-API bestanden; Neubau Linux/macOS grün. Windows deckte erstmals eine 404-Antwort im tatsächlich generierten Website-Server auf. Kanonische Root-/Dateipfade und plattformgerechte Containment-Prüfung werden korrigiert, Ausbruchprüfungen bleiben erhalten.

# v0.4.4 – Nachtest zu 0.4.3

- [x] #49 SPA-Fallback unter versteckten Elternverzeichnissen reproduzieren und korrigieren.
- [x] #50/#51 Live-Profil mit Nullbudget und ausreichendem Antwortlimit absichern.
- [x] #52 ältere Proton-Pass-Schreibweise kompatibel verarbeiten.
- [x] README, Docs, OpenAPI und aktive Version auf 0.4.4 aktualisieren.
- [ ] Regressionen, Typprüfung und Build prüfen; Commit, PR, Merge und Release verifizieren.

Lokale Prüfung: 158 Tests/20 Dateien, 11 Release-Verträge, fokussierte CLI-/Schema-Regressionen, Typecheck, Build, Lint, Format und OpenAPI erfolgreich. CI/Release werden nach dem Push am exakten Commit geprüft.

# v0.4.5 – Nachtest zu 0.4.4

- [x] #54 reale Plaintext-Feldausgabe des Proton-CLI im Legacy-Provider verarbeiten und testen.
- [x] #55 macOS-Test-Runtime ohne hartcodierten temporären Pfad auswählen und testen.
- [x] Aktive Version, README, Docs und OpenAPI aktualisieren.
- [ ] Regressionen und Build prüfen; Commit, Push, Merge und Release verifizieren.

Lokale Prüfung: 50 Legacy-Secret-Tests, 159 Tests des neuen Kerns, 11 Release-Verträge, Root-/Next-Typecheck, Build, Lint und Format erfolgreich. Positive Distribution lokal an fehlender originaler Node-Lizenz gestoppt; vollständige CI prüft mit offizieller Runtime. Veröffentlichung folgt am geprüften Main-Commit.
