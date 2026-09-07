# IronCrew Web

React 19 / Vite 8, gemeinsame `/api/v1`-Verträge und lazy geladene React-Three-Fiber-Halle. Die Assets unter `public/brand/` sind unveränderte Nutzeroriginale aus dem Entwicklungspaket.

Vom `next`-Workspace aus:

```sh
pnpm dev:web
pnpm build
pnpm test:e2e
```

Der Entwicklungsserver läuft auf `127.0.0.1:8801` und leitet `/api` an die Zentrale auf `127.0.0.1:8790` weiter. Der Produktionsbuild liegt unter `next/dist/web`. Die Zentrale serviert diesen Build.

`tests/e2e/ui.spec.ts` prüft explizite **API-Vertragsfixtures**, nicht externe Livekonten. Es prüft mobile Routen und Chatentwürfe, URL-Tabs nach Reload, neun Crewprofile, DE/EN, leeren Zustand, native Dialoge, 360 px ohne Seitenüberlauf, SecretRef-Konfiguration mit standardmäßig ausgeschalteter Live-Ausführung und nutzbaren Zustand bei WebGL-Verlust. Die Screenshots in `evidence/` zeigen ebenfalls Testfixtures. `playwright.ui.config.ts` erlaubt einen isolierten UI-Lauf gegen einen bereits gestarteten Vite-Server.

`tests/e2e/website-local.spec.ts` führt ohne API-Mocks Login, Auftragserstellung, Plan, fünf echte HTML-Konzepte, Auswahl, Build, getrennte Vorschau, Pinauflösung, drei menschliche Pflichtprüfungen und Abnahme durch. Ein zweiter echter Browserfall prüft Modellkonfiguration, Nullbudget, Profile und Wizardfortsetzung. Ein dritter prüft Finanzdatenstand, Teilzahlung, Quellenstand und den bytegenauen Download eines echten Originalbelegs. Diese Tests gehören zur Root-Playwright-Konfiguration. Erfolgreiche UI-Fixtures sind kein Live-Nachweis für Proton, OpenRouter, Fachintegrationen oder Veröffentlichung.

## Nachgewiesener lokaler Stand

- Eigenständige Oberfläche im Design B; URL-Navigation, persistiertes Setup, Auftragssplit und Crewprofile.
- Reale API-Aufrufe für Pläne, Aufträge, Nachrichten, Entscheidungen, Modell-/Verbindungskonfiguration, Mandate und Routinen.
- Manuelle Facharbeit: Website-Konzepte/Build/Vorschau/Pins/Prüfung/Abnahme; echte Finanzbelegdateien, Korrektur und Zahlungsvorbereitung; Vorfallzuordnung/Diagnose/Prävention; geprüfte Recherchequellen und versionierte Ergebnisdokumente.
- Alle Beträge haben eine Quelle bzw. bleiben sichtbar ungeklärt. Belegerfassung markiert keine Zahlung als erfolgt.
- Kein Three.js-Preload im initialen HTML. Letzter Build: initiales JS rund 129 kB gzip, separater Hallen-Chunk rund 256 kB gzip, PDF.js wird bei Bedarf geladen.

Vollständige Prüfliste und Produktdifferenzen: [`docs/ui-validation.md`](../../docs/ui-validation.md).

## Noch offen für die vollständige Abnahme

- Neun GLBs werden aus gekennzeichneten lokalen Entwürfen reproduzierbar exportiert und vor dem Laden anhand des Manifests geprüft. Zustandsgebundene einfache Orts-/Gelenkbewegung ist vorhanden; finale Figuren, hochwertige Animationen und gerätebezogene 30-FPS-Messung fehlen.
- Worker-Enrollment/Rotation/Widerruf, Channelverwaltung, Recherchebeobachtung, Benachrichtigungen, sichere Belegvorschau, Hostingfreigaben und Wartungsformulare sind bedienbar. `admin-local.spec.ts` prüft sieben echte lokale Abläufe einschließlich TLS-Worker und age/Restoreprobe. Produktive Provider-/Hostingabnahme und vollständige Disaster-Restore-Führung bleiben offen.
- Website-HTML kann manuell versioniert werden. Das ist keine Behauptung, dass ein automatischer Designlauf bereits geprüft wurde. React-/WordPress-Builds brauchen den isolierten Worker.
- Automatisierter 200-%-CSS-Zoom mit Container-Reflow und bedienbaren Chat-/Arbeitsflächentabs sowie reduzierte Bewegung sind geprüft. Ein vollständiger manueller Screenreader- und nativer Browserzoom-Nachweis steht aus.

GLBs neu erzeugen: `node apps/web/tools/generate-crew-assets.ts`. Prüfumfang und genaue Fixturegrenzen stehen in der UI-Prüfliste.

`incident-local.spec.ts` prüft reale Healthprofil-Versionierung, Reparatur-/Kundenmailfreigabe mit Ablehnung und einen tatsächlichen lokalen HTTP-Check samt Beobachtungsstatus. Die mobile englische Ansicht wird ebenfalls geprüft; es wird kein Dienst neugestartet und keine E-Mail gesendet.
