# Screenshots der Dokumentation

Die README zeigt echte Chromium-Aufnahmen der IronCrew-Weboberfläche.
Sie werden aus dem Quellcode der Version 0.1.0 erzeugt, nicht aus einem Mock-up
oder einer nachgebauten Illustration.

## Was die Bilder darstellen

- Eine neue, isolierte E2E-Datenbank mit der originalen Seed-Crew.
- Einen über die CEO-API erzeugten Auftrag, ausdrücklich als Dokumentationstest bezeichnet.
- Office, Abteilungsfokus, Mitarbeiterübersicht, mobile Liste und Versionsverwaltung.
- Keine echten Kunden, persönlichen Assets, Zugangsdaten oder produktiven Ergebnisse.
- Keine erfundenen Sternebewertungen: ohne Arbeits-/Review-Runs steht „Unbewertet“.
- Die externe Release-Prüfung ist deaktiviert; die installierte Version kommt aus
  dem tatsächlichen Backend. Es wird kein zukünftiger Release vorgetäuscht.

## Reproduzieren

Nutze einen separaten Entwicklungscheckout. Die Vorbereitung setzt ausschließlich
`DB_PATH=.tmp/e2e-runtime/ironcrew.e2e.sqlite` neu auf. Der Vorgang benötigt freie
Ports 8810 und 8790 und darf nicht parallel zum normalen E2E-Lauf starten.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install --with-deps chromium
node scripts/capture-readme-screenshots.mjs
```

Der Capture startet die Testanwendung selbst. Bilder, `screenshots.json` und
Playwright-Trace liegen in `test-results/docs/`. Die Metadaten enthalten Version,
Zeitpunkt, Quellcommit im CI-Lauf und die Herkunft der Testdaten.

In GitHub Actions führt der Job **documentation-screenshots** dieselbe Aufnahme
auf einem frischen Runner aus und lädt das gleichnamige Artefakt hoch. Lade die
Bilder herunter, prüfe sie visuell und übernimm die PNGs samt Metadaten nach
`docs/screenshots/`. Nicht ungeprüft automatisch committen.

| Datei | Ansicht |
| --- | --- |
| `ironcrew-office.png` | Gesamtes Dashboard mit Office und CEO-Chat |
| `ironcrew-department.png` | Engineering im Raumfokus |
| `ironcrew-crew.png` | Mitarbeitertabelle mit Level, Modellprofil und Bewertungen |
| `ironcrew-mobile.png` | Mobile Crew-Liste |
| `ironcrew-updates.png` | Tatsächlich installierte Version und Updatehinweise |

Ältere Bilder bleiben als historisches Material im Repository, werden in der
aktuellen README aber nicht als gegenwärtige Oberfläche ausgegeben.

## Geprüfte Aufnahmen für 0.1.0

Die eingecheckten Bilder stammen aus dem
[Capture-Lauf 33957922393](https://github.com/irongeeks/ironcrew/actions/runs/33957922393),
Artefakt `documentation-screenshots` (`9966979577`). Alle fünf Bilder wurden
visuell geprüft; die Mitarbeitertabelle enthält alle 14 Seed-Mitarbeiter ohne
abgeschnittene Zeilen. Der Aufnahmecommit und Zeitpunkt stehen in
[screenshots.json](screenshots/screenshots.json).
