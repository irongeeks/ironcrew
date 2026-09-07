# UI-Prüfstand und verbleibende Produktdifferenzen

Stand: 7. September 2026. React 19, Vite 8, CSS Modules und Original-Markenassets aus dem Entwicklungspaket. Produktdaten kommen aus `/api/v1`; Testfixtures sind ausdrücklich gekennzeichnet. Dieser Prüfstand behauptet keine vollständige Produkt- oder Live-Abnahme.

## Ausgeführte Prüfungen

| Prüfung                            | Ergebnis                                            | Grenze                                                                                                      |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tests/e2e/ui.spec.ts`             | 17 Browserfälle grün                                | Explizite API-Vertragsfixtures, keine Provider-Livenachweise                                                |
| `tests/e2e/website-local.spec.ts`  | 3 Browserfälle grün                                 | Echtes lokales HTTP-Backend, temporäre SQLite-Datenbank                                                     |
| `tests/e2e/admin-local.spec.ts`    | 7 Browserfälle grün                                 | Echte lokale APIs, SQLite, TLS-Worker und age; Recherchequelle ausdrücklich lokal injiziert                 |
| `tests/e2e/incident-local.spec.ts` | 1 Browserfall grün                                  | Echte lokale Profil-/Freigabe-API und HTTP-Prüfung; kein Dienstneustart, kein Versand                       |
| TypeScript / ESLint                | Geprüft für bearbeitete Dateien und Workspace-Typen | Root führt die abschließenden Gesamtgates aus                                                               |
| Vite-Produktionsbuild              | Initiales JavaScript ca. 129 kB gzip                | Halle separat ca. 256 kB gzip, PDF.js separat ca. 129 kB gzip, eigener PDF-Worker ca. 1,27 MB unkomprimiert |

Letzter vollständiger Playwrightlauf: **29 bestanden, 0 übersprungen**, 23,4 Sekunden. Darin enthalten sind 28 Fälle dieser UI-Arbeitsstrecke und der bestehende lokale Auftrag-/Chat-Persistenztest (`live-local.spec.ts`). GLB-Neuexport reproduzierte anschließend alle neun SHA-256-Werte identisch; nativer Channel-Import war ebenfalls grün.

Die UI-Fälle prüfen Entwürfe/URL-Tabs, DE/EN, Crew, 360/390/1024/1440 px, 200-%-CSS-Zoom mit Reflow, reduzierte Bewegung, WebGL-Kontextverlust, native Dialoge und Tastaturfokus, Modell-Secretreferenzen, explizite Liveaktivierung, persönliche versionsgebundene Modellbewertungen, Finanzdatenstände/Teilzahlungen/Währungstrennung, Kommandopalette, fehlendes Worker-TLS, gesperrte Belegvorschau bei falschem Hash sowie die GLB-Ladestrecke mit geprüftem Hash und ausdrücklichem Fallback.

Die echten lokalen Browserabläufe umfassen:

- Website: Login → Auftrag → Plan → fünf manuelle HTML-Konzepte → Auswahl → Build → vollständiges gzip-Websitepaket → isolierte Vorschau → Pin/Nachbesserung → drei manuelle Pflichtprüfungen → Abnahme → Reload.
- Konfiguration: Modellzugang, bewusstes Nullbudget, Crewprofil und fortgesetzter Setup-Wizard.
- Finanzen: realer Datenstand, Richtung, Teilzahlung, Quellenzeit und bytegenauer Download eines hashgeprüften Originalbelegs.
- Worker: einmaliger Konfigurationsdownload → echter WorkerClient über verifiziertes lokales TLS → letzte Verbindung → Rotation mit neuer Generation → Widerruf. Dieser Browserfall führt keinen Prozess aus.
- Eingangskanäle: explizit deaktiviertes Discordprofil mit öffentlichem Schlüssel speichern/neu laden, bewusst aktivieren, an den gewählten Bereich gebundenen Identitätschallenge anfordern. Keine behauptete Provideranmeldung.
- Recherchebeobachtung: über den echten Domänendienst gespeicherte Änderung einer ausdrücklich lokalen Testquelle anzeigen, als CEO bewerten, Beobachtung erstellen/aktivieren/pausieren. Der serverseitige Seed gehört ausschließlich zum temporären E2E-Server; es gibt keine Produktionsseedroute und keinen Live-Webquellenbeleg.
- PDF: echte gültige PDF-Datei lokal auswählen, Seitenbild und extrahierten Text anzeigen, nebenan zuordnen, speichern, nach Reload Hash und Seitenbild prüfen.
- Wartung: echten age-Schlüssel temporär erzeugen, Sicherungsplan als Entwurf anlegen, verschlüsseltes Archiv erstellen, tatsächlich entschlüsseln und wiederhergestellte Datenbank prüfen, erst danach aktivieren und pausieren. Ohne echte age-Binärdateien wird dieser Test ausdrücklich übersprungen; im lokalen Prüflauf waren sie vorhanden.
- Hosting: Profil und begrenztes Mandat anlegen, konkrete Freigabe anfordern, gespeicherte Aktion nach Löschen des Browserzustands aus der Datenbank wiederfinden und im Entscheidungszentrum ablehnen; keine Bereitstellung oder Veröffentlichung ausführen.
- Incident: Prüfprofil validieren und mit CAS aktualisieren → Reparaturfreigabe anfordern und ablehnen → tatsächlichen unabhängigen HTTP-Check gegen den lokalen Server starten → laufendes Beobachtungsfenster aus der Datenbank anzeigen → separate Kundenmailfreigabe anfordern und ablehnen. Reload und mobile EN-Ansicht geprüft. Der Test behauptet keinen ausgeführten Neustart, keine Zustellung und kein abgeschlossenes Beobachtungsfenster.
- Benachrichtigungen: tatsächliche Ereignisgeschichte anzeigen; lokale Lesemarkierung verändert keine Freigabeentscheidung; Dialog gibt Fokus zurück.

Screenshots in `apps/web/evidence/`: `website-local-accepted.png`, `finance-local.png` und `pdf-classification-local.png` sowie `incident-local-mobile.png` stammen aus tatsächlichen lokalen Fachabläufen. HQ-/Zoom-/GLB-Bilder verwenden gekennzeichnete API-Fixtures. Temporäre Testserver schließen nach dem Lauf; der eigene Vite-Server auf Port 8801 ist beendet. Die Tabelle beschreibt die 28 UI-Arbeitsstreckenfälle; der zusätzlich ausgeführte Root-Persistenztest ist in der Gesamtzahl 29 enthalten.

## Bedienung und Nachweisgrenzen

Workerzugänge bleiben nur bis zum einmaligen Download im flüchtigen UI-Zustand. Token stehen nicht in DOM oder Browserablage. Jede Generation bekommt ein eigenes lokales Datenverzeichnis. `workspace.execute` verlangt einen Pfad zum tatsächlich zu attestierenden Isolationsprofil; ohne konfigurierte TLS-Verbindung bleiben Anmeldung und Rotation gesperrt. Die normale Modellkonfiguration erhält auch `isolationProfilePath`, `mailConnections` und andere bestehende Verbindungsfelder beim Speichern.

Die Kanalverwaltung unter Einstellungen speichert Version/Revision mit CAS, Providerkonto, unveränderlichen Bereich, Allowlist, öffentlichen Discordschlüssel oder Proton-Secretreferenz. Bindung entsteht erst aus einer authentifizierten Providerantwort. Sie verleiht keinen Freigabekanal. Näheres in [channels.md](channels.md).

Die Finanzübersicht zählt jeweils den gewählten Snapshot, trennt Währungen und lässt unbekannte Richtung oder Bankstände offen. Originaldateien sind verknüpft. Die Zuordnung steht neben einer PDF-/PNG-/JPEG-Vorschau. PDF.js wird bei Bedarf mitsamt eigenem Worker geladen; nur Bytepuffer gelangen in den Parser. Hash und Dateisignatur werden geprüft. Es gibt keine Skriptausführung, XFA, Formular- oder anklickbare Annotationsebene. Seiten können gewechselt, extrahierter Text kann gelesen werden. Dies ist keine OCR für Scans und keine Erkennung beliebiger Buchhaltungsfelder. Umsetzung auf Basis der [offiziellen Mozilla-API](https://mozilla.github.io/pdf.js/api/) und des [PDF.js-Projekts](https://github.com/mozilla/pdf.js), exakt installierte Version 6.3.289. Die nicht mehr vorhandene Option `isEvalSupported` wird nicht vorgetäuscht.

Das Benachrichtigungszentrum lädt gespeicherte Ereignisse mit Cursor und Zeitangabe. Lesestand ist pro Firma lokal, kein organisationsweit synchronisierter Gelesenstatus. Ausstehende Entscheidungen bleiben eigenständige geschützte Aktionen. Die globale Cmd/Ctrl+K-Palette durchsucht bestehende Navigation und echte Aufträge.

Sicherungspläne, echte Wiederherstellungsprobe, Aktivierung/Pause, Aufbewahrungsoption, öffentliche Updatevertrauensschlüssel, Wartungsfenster, konkrete Updatepläne, Freigabe und Ausführung haben Formulare. Ein vollständiger Serverumzugs-/Disaster-Restore-Wizard ist weiterhin offen. Die Updateausführung wird durch ihre Backendgates geschützt; der UI-Browsernachweis aktiviert kein echtes Softwareupdate.

Hostingprofile und Mandate, Provisionierung/Veröffentlichung/Rückweg sowie Zustands- und Gesundheitsnachweise sind bedienbar. Wiederaufnahme verwendet vor jedem Retry die gespeicherten Aktionsargumente und dieselbe Aktions-ID. `effect_unknown` sperrt weitere Versuche in dieser Oberfläche. Ein produktiver HTTPS-Broker und echte DNS-/Providerabnahme bleiben erforderlich; [hosting-broker.md](hosting-broker.md) beschreibt den Vertrag. Der Browserfall belegt bewusst nur die Freigabe- und Ablehnungsstrecke. React-/WordPress-Pakete und deren isolierte Builds haben zusätzliche Backendtests; dieser UI-Test ist kein autonomer Modell-Designnachweis. Die WordPress-Vorschau wird ausdrücklich als statischer Entwurf bezeichnet.

Incident-Fachaktionen verwenden serverseitige Ziel- und Konfigurationshashes sowie gespeicherte Aktions-IDs. Healthprofile sind revisionsgebunden, Neustart und Kundenmeldung erfordern separate Freigaben. Der erste positive HTTP-Check bedeutet „Beobachtung läuft“; Ergebnis und Unterbrechungen kommen aus dem Domänendienst. Die Oberfläche aktualisiert aktive Beobachtungsstände regelmäßig und zeigt keine behauptete Entstörung. Mandate werden über die bestehende Mandatsverwaltung für die konkret angezeigten Dienst- bzw. Postfachziele erteilt. Ohne aktivierte Live-Ausführung bleiben Fachaktionen gesperrt. SMTP-Annahme ist ausdrücklich keine bestätigte Zustellung. Administrierte Service-/Mailverbindungen müssen vorliegen; einen weiteren Verbindungseditor hat diese begrenzte Incident-Ergänzung nicht eingeführt.

## 3D-Assetpipeline

`node apps/web/tools/generate-crew-assets.ts` erzeugt reproduzierbar neun eigenständige GLBs mit benannten Körpergruppen und `public/crew/manifest.json`. Gesamtgröße ca. 671 kB unkomprimiert. Die lokalen Formen sind aus den zuvor verwendeten prozeduralen Entwürfen abgeleitet, nicht final abgenommene Charakterkunst. Das Manifest enthält Hash und Größe; der Browser prüft diese, GLB-Version und Selbstständigkeit vor dem Laden. Externe Buffer-/Bild-URIs und zusätzliche glTF-Erweiterungen sind in dieser lokalen Pipeline nicht erlaubt. Fehlende oder veränderte Assets aktivieren eine sichtbare prozedurale Ersatzdarstellung.

Echte Auftragszustände steuern einfache Orts- und Gelenkbewegung: laufende Arbeit am Arbeitsplatz, Prüfung am Besprechungstisch, sonst Ausgangsposition. Das visualisiert den gespeicherten Zustand und behauptet keinen erfolgreichen Arbeitsschritt. Reduzierte Bewegung setzt die Position direkt und stoppt Schwingungen; versteckte Tabs pausieren Rendering. Final abgenommene Figuren, hochwertige Rigs/Animationen und gerätebezogene 30-FPS-Abnahme bleiben offen. Keine Drei-/PDF-Module im initialen HTML vorladen.

## Weitere offene Abnahmen

- Vollständiger manueller Screenreader-Test, nativer Browserzoom statt CSS-Zoom und reale Geräteprüfung.
- Redaktionelle DE/EN-Lokalisierung einzelner Backend-Statuscodes und administrativer Fachtexte.
- Automatische Provider-Aktualisierung und allgemeine manuelle Finanzsnapshot-Erfassung sind eigene Fachabläufe; vorhandene Daten werden nicht durch erfundene Nullsummen ersetzt.
- Live-Nachweise mit eigenen Proton-/OpenRouter-/Fachproviderkonten, authentifiziertem Versand und produktiven Hostingzielen. Lokale Fixtureerfolge ersetzen sie nicht.

Modellbewertungsdienst und sechs Domänentests sind in [model-ratings.md](model-ratings.md) dokumentiert. Der Channel-Registrar lässt sich unter Node 26.4.0 nativ importieren:

```sh
node --input-type=module -e 'const routes = await import("./apps/control/channel-routes.ts"); if (typeof routes.registerChannelRoutes !== "function") throw new Error("Registrar missing"); console.log("Native TypeScript import OK");'
```
