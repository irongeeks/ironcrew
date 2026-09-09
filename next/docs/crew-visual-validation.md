# Crew-Darstellung und lokale Abnahme

Die neun Charaktere werden aus versionierten lokalen Eingabedaten modelliert und als in sich geschlossene GLBs ausgeliefert. Revision 3 verwendet anatomische Kopftopologie, modellierte Augen und Hände, angepasste Körperproportionen sowie differenzierte Kleidung, Haare und Materialien. Die Kopfbasis stammt aus dem CC0-Basismesh von MakeHuman; Quelle, Revision, Lizenz und Anpassungen stehen im [Herkunftsnachweis](../apps/web/public/crew/ANATOMY-SOURCE.md). Körper, Kleidung und Artikulation werden im Repository erzeugt.

Alle neun vollständigen Modelle belegen zusammen 2.475.632 Bytes; zusätzliche Distanzvarianten 1.094.500 Bytes. Ab einer Kameradistanz von sechs Szeneneinheiten verwendet die Halle vereinfachte Geometrie mit denselben Gelenken und Materialien. Hysterese verhindert häufiges Umschalten an der Grenze. Nahansichten und Profilporträts verwenden die vollständigen Modelle. Die unveränderten Budgets von höchstens 12.000 Dreiecken und 40 Draw Calls je vollständiger Figur werden geprüft.

Die originale Rollen- und Logoauswahl bleibt unverändert. [Ganzkörper-Kontaktbogen](test-evidence/crew-character-contact-sheet.png) und [Gesichtsansichten](test-evidence/crew-character-faces.png) zeigen die tatsächlichen GLBs. Profilporträts werden aus denselben vollständigen Dateien gerendert und brauchen keinen weiteren WebGL-Kontext. Die Gestaltung bleibt stilisiert; die subjektive visuelle Abnahme durch den Benutzer steht aus.

Unterscheidung: Cersei trägt goldene Flechtsträhnen und Bordeaux/Gold, Mr. Robot Kappe/Brille/Bart/Arbeitsjacke, Morpheus randlose Sonnenbrille und langen Mantel, Steve Jobs Rollkragen/Jeans/Sneakers, Tyrion kurze Gliedmaßen bei erwachsenen Kopfproportionen und Weste, Saul Anzug/gestreifte Krawatte/Einstecktuch, Karla rote Jacke/Kamera/Notizblock, der Professor zerzaustes Haar/Brille/Hemd, Fury Augenklappe und breiten Ledermantel.

Die feste `seedKey`-Zuordnung übersteht umsortierte Listen und geänderte Anzeigenamen. Torso, Kopf, Arme, Unterarme, Beine und Knie erhalten echte lokale Zustandsposen. Arbeiten und Prüfung finden an getrennten Arbeitsplätzen statt. `reviewing` ist kein Beleg für eine Besprechung. Nur ein explizit zugeordneter laufender Koordinationsschritt (`activeCoordination`) darf die Besprechungspose auslösen; die aktuell vorhandenen Aufträge erfinden solche Schritte nicht. Bewegung ist keine fachliche Erfolgsmeldung und führt keine Modellaufrufe aus.

Reduced Motion setzt sämtliche Gelenke sofort auf die passende statische Pose zurück. Verdeckte Tabs pausieren die kontinuierliche Schleife. Kamera-Presets setzen auch verschobene Orbit-Ziele zurück, Pan/Zoom bleiben begrenzt; schmale Ansichten erhalten eine angepasste Kameradistanz. Ein Prüfsummenfehler lädt dieselbe lokal erzeugte Charakterform als gekennzeichneten Ersatz. Tatsächlicher WebGL-Kontextverlust lässt Profile und Aufträge bedienbar.

## Aktueller Mac-Nachweis · Revision 3

Die Fehlerkorrekturen und vollständigen aktuellen Prüfergebnisse sind im [Mac-Fixbericht](../../docs/maintenance/mac-fixes-and-crew-2026-09-09.md) dokumentiert. Die unten verlinkten Crew-Bilder und Messdaten wurden für Revision 3 erneuert.

## Historische Basisprüfung · Revision 2

Im [lokalen Gesamtgate](test-evidence/gates.json) zur Basis `686022a9a0f02f7ff8a93e120c4e82965c13a379` bestanden **508 Tests ohne Skips**, darunter 46 E2E-Fälle. Format, Lint, TypeScript, Build, OpenAPI und Dependency-Audit waren erfolgreich; der Audit meldete null bekannte Schwachstellen. Dies belegt den protokollierten lokalen Quellstand. Die [Drei-OS-CI 34139199380](https://github.com/irongeeks/ironcrew/actions/runs/34139199380) hat diesen abschließenden Stand auf macOS 15, Windows Server 2025 und Ubuntu 24.04 vollständig bestanden: **jeweils 508 Tests, 12 erfolgreiche Gates und keine Skips**. Die Originalberichte sind für [macOS](test-evidence/ci/686022a-macos-15/gates.json), [Windows](test-evidence/ci/686022a-windows-2025/gates.json) und [Ubuntu](test-evidence/ci/686022a-ubuntu-24.04/gates.json) gespeichert. Der [Linux-Isolationslauf 34139199314](https://github.com/irongeeks/ironcrew/actions/runs/34139199314) ist erfolgreich; die [Originalbelege](test-evidence/ci/linux-686022a/github-run.json) sind dauerhaft gespeichert. Die vorherige [Drei-OS-CI 34137823550](https://github.com/irongeeks/ironcrew/actions/runs/34137823550) zu `ebf3b98` bestand bereits jeweils 508 Tests ohne Skips auf macOS, Windows und Ubuntu. Dieser historische Erfolg ist im [CI-Verzeichnis](test-evidence/ci/README.md) archiviert und wird nicht auf einen anderen Commit übertragen.

## Aktuelle visuelle und technische Prüfung

- Sieben Crew-Unitprüfungen: stabile Zuordnung, keine erfundenen Meetings, statische Reduced-Motion-Posen, neun unterschiedliche Stationen, GLB-Prüfsummen/Artikulation/keine externen Ressourcen, charakteristische Merkmale/Polygonbudget sowie anatomische Geometrie und Handgelenke.
- Zehn zusätzliche LOD-Prüfungen sichern Geometrie, Materialien, Gelenke, endliche Attribute und die exportierten Distanzvarianten ab.
- Vier Browserprüfungen: zwei GLB-Verträge mit expliziten API-Fixtures und zwei Prüfungen gegen die echte lokale Anwendung/SQLite. Sie prüfen unter anderem Tastaturnavigation bis zum Nick-Fury-Profil, Kamera, System-Reduced-Motion, explizites Wiedereinschalten, Browser-Zurück, 200%-Seitenskalierung, 360px kompakt/3D und `WEBGL_lose_context`.
- [Desktop](test-evidence/crew-hall-desktop.png), [Mobil kompakt](test-evidence/crew-hall-mobile-compact.png), [Mobil 3D](test-evidence/crew-hall-mobile-3d.png), [Profil](test-evidence/crew-profile-fury.png).
- [Messdaten](test-evidence/crew-hall-performance.json): Der isolierte Revision-3-Lauf erreichte am 9. September 2026 **36,57 tatsächlich gerenderte FPS** (220 Frames über 6015,7 ms), mit explizit unveränderter Mindestanforderung von 30 FPS. Der abschließende vollständige E2E-Lauf erreichte **35,19 FPS** (212 Frames über 6025 ms); die verlinkte JSON-Datei enthält diesen neueren Messwert. Nach zwei Sekunden animierter Aufwärmphase werden sechs Sekunden tatsächliche `drawElements`-Frames gezählt. Neun animierte Figuren, Standardqualität, Apple M5, Headless Chromium 149, SwiftShader-Software-Renderer, 1440×1000, DPR 1. Die Distanzvarianten beseitigen den zuvor bei etwa 10 FPS gemessenen Engpass der vollständigen Geometrie in der Gesamtansicht. Die Messung ist keine geräteübergreifende FPS-Garantie.

Die DOM-Semantik, Fokusführung und Browser-Skalierung sind automatisiert geprüft. Ein physischer Screenreader-Hörtest und die subjektive visuelle Abnahme durch den Anwender sind damit nicht behauptet. Das Manifest kennzeichnet diese visuelle Abnahme weiterhin als offen.

Reproduktion:

```sh
node apps/web/tools/generate-crew-assets.ts
node apps/web/tools/render-crew-portraits.mjs
npx --yes pnpm@10.30.1 exec vitest run tests/unit/crew-motion.test.ts tests/unit/crew-lod.test.ts
npx --yes pnpm@10.30.1 exec vite build --config apps/web/vite.config.ts
IRONCREW_PERFORMANCE_MIN_FPS=30 npx --yes pnpm@10.30.1 exec playwright test tests/e2e/hall-live.spec.ts
```
