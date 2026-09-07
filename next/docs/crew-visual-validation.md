# Crew-Darstellung und lokale Abnahme

Die neun Charaktere werden deterministisch im Repository modelliert (`apps/web/src/CrewModel.ts`) und als in sich geschlossene GLBs ausgeliefert. Revision 2 hat 161608 Bytes für alle neun Modelle. Die originale Rollen- und Logoauswahl bleibt unverändert. Der [Kontaktbogen](test-evidence/crew-character-contact-sheet.png) zeigt die tatsächlichen Modelle frontal. Die Porträts im Profil werden aus denselben GLBs gerendert und brauchen keinen weiteren WebGL-Kontext.

Unterscheidung: Cersei trägt goldene Flechtsträhnen und Bordeaux/Gold, Mr. Robot Kappe/Brille/Bart/Arbeitsjacke, Morpheus randlose Sonnenbrille und langen Mantel, Steve Jobs Rollkragen/Jeans/Sneakers, Tyrion kurze Gliedmaßen bei erwachsenen Kopfproportionen und Weste, Saul Anzug/gestreifte Krawatte/Einstecktuch, Karla rote Jacke/Kamera/Notizblock, der Professor zerzaustes Haar/Brille/Hemd, Fury Augenklappe und breiten Ledermantel.

Die feste `seedKey`-Zuordnung übersteht umsortierte Listen und geänderte Anzeigenamen. Torso, Kopf, Arme, Unterarme, Beine und Knie erhalten echte lokale Zustandsposen. Arbeiten und Prüfung finden an getrennten Arbeitsplätzen statt. `reviewing` ist kein Beleg für eine Besprechung. Nur ein explizit zugeordneter laufender Koordinationsschritt (`activeCoordination`) darf die Besprechungspose auslösen; die aktuell vorhandenen Aufträge erfinden solche Schritte nicht. Bewegung ist keine fachliche Erfolgsmeldung und führt keine Modellaufrufe aus.

Reduced Motion setzt sämtliche Gelenke sofort auf die passende statische Pose zurück. Verdeckte Tabs pausieren die kontinuierliche Schleife. Kamera-Presets setzen auch verschobene Orbit-Ziele zurück, Pan/Zoom bleiben begrenzt; schmale Ansichten erhalten eine angepasste Kameradistanz. Ein Prüfsummenfehler lädt dieselbe lokal erzeugte Charakterform als gekennzeichneten Ersatz. Tatsächlicher WebGL-Kontextverlust lässt Profile und Aufträge bedienbar.

## Nachweise

Im [lokalen Gesamtgate](test-evidence/gates.json) zur Basis `686022a9a0f02f7ff8a93e120c4e82965c13a379` bestanden **508 Tests ohne Skips**, darunter 46 E2E-Fälle. Format, Lint, TypeScript, Build, OpenAPI und Dependency-Audit waren erfolgreich; der Audit meldete null bekannte Schwachstellen. Dies belegt den protokollierten lokalen Quellstand. Die [Drei-OS-CI 34139199380](https://github.com/irongeeks/ironcrew/actions/runs/34139199380) hat diesen abschließenden Stand auf macOS 15, Windows Server 2025 und Ubuntu 24.04 vollständig bestanden: **jeweils 508 Tests, 12 erfolgreiche Gates und keine Skips**. Die Originalberichte sind für [macOS](test-evidence/ci/686022a-macos-15/gates.json), [Windows](test-evidence/ci/686022a-windows-2025/gates.json) und [Ubuntu](test-evidence/ci/686022a-ubuntu-24.04/gates.json) gespeichert. Der [Linux-Isolationslauf 34139199314](https://github.com/irongeeks/ironcrew/actions/runs/34139199314) ist erfolgreich; die [Originalbelege](test-evidence/ci/linux-686022a/github-run.json) sind dauerhaft gespeichert. Die vorherige [Drei-OS-CI 34137823550](https://github.com/irongeeks/ironcrew/actions/runs/34137823550) zu `ebf3b98` bestand bereits jeweils 508 Tests ohne Skips auf macOS, Windows und Ubuntu. Dieser historische Erfolg ist im [CI-Verzeichnis](test-evidence/ci/README.md) archiviert und wird nicht auf einen anderen Commit übertragen.

- Sechs Unitprüfungen: stabile Zuordnung, keine erfundenen Meetings, statische Reduced-Motion-Posen, neun unterschiedliche Stationen, GLB-Prüfsummen/Artikulation/keine externen Ressourcen, charakteristische Merkmale/Polygonbudget.
- Vier Browserprüfungen bestanden: zwei GLB-Vertragsprüfungen mit expliziten API-Fixtures und zwei neue Prüfungen gegen die echte lokale Anwendung/SQLite ohne API-Abfangen. Sie prüfen Tastaturnavigation bis zum Nick-Fury-Profil, Kamera, System-Reduced-Motion, explizites Wiedereinschalten, Browser-Zurück, 200%-Seitenskalierung, 360px kompakt/3D und `WEBGL_lose_context`.
- [Desktop](test-evidence/crew-hall-desktop.png), [Mobil kompakt](test-evidence/crew-hall-mobile-compact.png), [Mobil 3D](test-evidence/crew-hall-mobile-3d.png), [Profil](test-evidence/crew-profile-fury.png).
- [Messdaten](test-evidence/crew-hall-performance.json): **41,64 tatsächlich gerenderte FPS** (251 Frames über 6027,7 ms) nach vollen 2s animierter Aufwärmphase. Die Testvorbereitung und Bildschirmaufnahmen laufen statisch; vor der Messung wird Bewegung ausdrücklich eingeschaltet und der tatsächlich aktive Zustand abgewartet. Erst dann beginnen 2s Aufwärmen und anschließend 6s Zählen. `animatedDuringSample=true` bestätigt die aktive Animation; pausiert wird erst nach Messende. Standardqualität und FPS-/Draw-Schwellen bleiben unverändert. Gerät: Apple M5, darwin 25.6.0 arm64; Headless Chromium 149, SwiftShader-Software-Renderer, 1440×1000, DPR 1. Gezählt werden Frames mit tatsächlichen `drawElements`-Aufrufen. Neun Figuren, Standardqualität. Der aktuelle Beleg stammt aus dem vollständigen lokalen E2E-Lauf am 2026-09-07T15:37:56.749Z und liegt über der 30-FPS-Schwelle. Der vorausgehende isolierte Referenzlauf um 12:24 UTC hatte die explizit mit `IRONCREW_PERFORMANCE_MIN_FPS=30` erzwungene Schwelle mit 36,57 FPS bestanden; die verlinkte JSON-Datei enthält den neueren Suitewert. Das ist keine geräteübergreifende FPS-Garantie; gewöhnliche CI erzwingt ohne benanntes Referenzgerät nur tatsächliches Rendering.

Die DOM-Semantik, Fokusführung und Browser-Skalierung sind automatisiert geprüft. Ein physischer Screenreader-Hörtest und die subjektive visuelle Abnahme durch den Anwender sind damit nicht behauptet. Das Manifest kennzeichnet diese visuelle Abnahme weiterhin als offen.

Reproduktion:

```sh
node apps/web/tools/generate-crew-assets.ts
node apps/web/tools/render-crew-portraits.mjs
npx --yes pnpm@10.30.1 exec vitest run tests/unit/crew-motion.test.ts
npx --yes pnpm@10.30.1 exec vite build --config apps/web/vite.config.ts
IRONCREW_PERFORMANCE_MIN_FPS=30 npx --yes pnpm@10.30.1 exec playwright test tests/e2e/hall-live.spec.ts
```
