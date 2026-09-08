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
