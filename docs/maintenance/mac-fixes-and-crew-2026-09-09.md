# Mac-Korrekturen und Crew-Revision 3 · 9. September 2026

Die beiden im [vorherigen Mac-Review](mac-review-2026-09-09.md) reproduzierten P2-Fehler sind korrigiert. Die neun Crew-Figuren wurden einschließlich ihrer GLBs und Profilporträts überarbeitet. Ausgangspunkt ist `8521efd195f6ecd84ec58ab3d1d18ad96316e388`; die folgenden Prüfungen beziehen sich auf den darauf aufbauenden Arbeitsstand.

## Korrigiertes Verhalten

- **Vorschau mit eigenem Port:** Der tatsächlich gebundene Preview-Listener bestimmt API-URLs und CSP. Das gilt auch bei Port 0 und für ältere gespeicherte Vorschauadressen. Der Versionsvergleich verwendet dieselbe erlaubte Basisadresse. Eine echte lokale Vorschau mit abweichendem Port liefert HTTP 200 und wird im Browser geladen.
- **Sitzung abgelaufen:** HTTP 401 führt zurück zur Anmeldung. Abmelden behandelt bereits abgelaufene Sitzungen. Verspätete Antworten einer alten Sitzung dürfen eine inzwischen erfolgte neue Anmeldung nicht überschreiben; dafür bestehen API- und Browser-Regressionen.
- **Build- und Testwarnungen:** React, Three-Kern, Renderer und Add-ons werden entlang ihrer Modulgrenzen aufgeteilt. Die Halle bleibt verzögert geladen. Die Vite-Warngrenze bleibt bei 500 kB. Die widersprüchliche Farbkonfiguration für Playwright-Unterprozesse wird vor deren Start aufgelöst; Warnungen werden nicht gefiltert.

## Crew-Figuren

Revision 3 enthält anatomische Gesichter mit modellierten Augen, verbesserte Hände mit Fingern und Daumen, natürlichere Körperproportionen sowie neue Kleidungs-, Haar- und Materialformen. Brillen, Augenklappe, Flechtsträhnen und berufsspezifische Accessoires bleiben erhalten. Die Köpfe verwenden angepasste CC0-Geometrie aus MakeHuman; die [pinned Originalquelle und Lizenz](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.md#c-the-license-for-the-bundled-assets) und der [lokale Herkunftsnachweis](../../next/apps/web/public/crew/ANATOMY-SOURCE.md) machen die Herkunft nachvollziehbar.

Die neun vollständigen GLBs belegen zusammen 2.475.632 Bytes, ihre zusätzlichen Distanzvarianten 1.094.500 Bytes. Höchstens 12.000 Dreiecke und 40 Draw Calls pro vollständiger Figur bleiben als Budget bestehen. Distanzvarianten behalten Gelenke und Materialien; nahe Figuren und Porträts verwenden die volle Geometrie. Prüfsummen, Dateigrenzen und das Verbot externer Asset-Ressourcen gelten für beide Detailstufen.

- [Gesichter und Profilporträts](../../next/docs/test-evidence/crew-character-faces.png)
- [Ganzkörperansichten aller neun Figuren](../../next/docs/test-evidence/crew-character-contact-sheet.png)
- [Tatsächliche Halle auf dem Desktop](../../next/docs/test-evidence/crew-hall-desktop.png)
- [Vollständige Darstellungs- und Prüfdokumentation](../../next/docs/crew-visual-validation.md)

Die Nahansichten wurden visuell kontrolliert und nach unabhängiger Prüfung an Haaransatz, Halsübergang und Augen korrigiert. Die Gestaltung ist stilisiert; eine subjektive Freigabe durch den Benutzer wird im Manifest weiterhin nicht behauptet.

## Prüfung auf diesem Mac

Umgebung: macOS 26.6.2, Apple M5, Node 26.4.0, pnpm 10.30.1. Installationsprüfungen verwenden die offizielle eigenständige Node-Runtime und die explizit angegebenen age-Werkzeuge. Bestehende Benutzerfirmen werden nicht verändert.

| Prüfung      | Ergebnis                       |
| ------------ | ------------------------------ |
| Unit         | 97 bestanden                   |
| Contracts    | 71 bestanden                   |
| Integration  | 321 bestanden                  |
| Installation | 65 bestanden                   |
| Recovery     | 25 bestanden                   |
| Browser-E2E  | 55 bestanden                   |
| Gesamt       | **634 bestanden, keine Skips** |

Build, Format, Lint, Typecheck, OpenAPI und Dependency-Audit bestanden; Audit: 0 bekannte Schwachstellen. Der finale Build und die Testläufe enthalten keine Build-/Farbwarnungen. Ein unabhängiger Abschlussreview fand keine weiteren belegten Fehler und verifizierte zusätzlich alle 18 Full-/LOD-GLBs auf Prüfsumme, Dateigröße, interne Ressourcen und gültige Geometrieindizes.

Im vollständigen E2E-Lauf bestand die Halle mit **35,19 FPS**: 212 tatsächlich gerenderte Frames in 6025 ms, gemessen am 2026-09-09T09:32:42.645Z. Die aktuelle [Performance-JSON](../../next/docs/test-evidence/crew-hall-performance.json) enthält Renderer, Gerät und Einzelmessungen.

Die erste Messung mit allen vollständigen Figuren in der Gesamtansicht erreichte nur etwa 10 FPS. Die daraufhin eingeführten Distanzvarianten erreichten im isolierten Nachtest 36,57 FPS. Die 30-FPS-Anforderung wurde nicht reduziert. Gemessen werden tatsächlich gerenderte Frames mit neun animierten Figuren, zwei Sekunden Aufwärmen und sechs Sekunden Messdauer, 1440×1000 bei DPR 1, Chromium 149 mit SwiftShader auf diesem Mac. Dies ist keine geräteübergreifende Leistungsgarantie.

## Erneuter echter Modelltest

Der aktuelle Produktvertrag `next/scripts/live.ts` lief erneut mit dem vorhandenen Secret-Verweis und dem lokalen `pass-cli`. Modell: `openrouter/free`; reserviertes Kostenlimit: 0 USD; Ergebnis: nichtleere Antwort, Zustand `complete`, abgeglichene Kosten **0 USD**. Kein kostenpflichtiger Fallback.

Nachweis: `.tmp/mac-fixes-20260909/live/.var/live-evidence/1788946254890.json`, Generation `gen-1788946257-8QcLD6Ap0w79gOyHGi5H`. Das Profil enthält ausschließlich einen Secret-Verweis; der Schlüssel wird nicht in Quellcode oder Bericht abgelegt.

## Lokale Belege und Umfang

Die vollständigen Protokolle liegen unter `.tmp/mac-fixes-20260909/verified/`, ergänzende Fehlerreproduktionen unter `session-before.log`, `session-verified.log`, `fixed-repro-results.json`, `regressions.log`, `browser-after.log` und die Grafikmessungen unter `graphics/`. Temporäre Testdaten und Protokolle bleiben im ignorierten Verzeichnis. Die Crew-Bilder und die aktuelle Performance-JSON sind versionierte Nachweise.

Diese Fortsetzung prüft den geänderten Produktkern `next/`. Historische Legacy-, CI- und Native-LaunchAgent-Erfolge aus den vorherigen Berichten werden nicht als neue Durchläufe ausgegeben. Externe Veröffentlichungen, Versand, produktive Dienste und signierte Distributionen sind nicht Teil dieses Tests.
