# Lokaler Mac-Test und Produktreview · 9. September 2026

Geprüft wurde der aktuelle Produktkern `next/` auf Commit `8521efd195f6ecd84ec58ab3d1d18ad96316e388`, Version 0.4.5. Umgebung: macOS 26.6.2, Apple Silicon, Node 26.4.0, pnpm 10.30.1 und Proton Pass CLI 2.3.3.

## Review-Ergebnis

Der geprüfte Kernablauf funktioniert. Zwei reproduzierte Funktionsfehler bleiben offen:

1. **P2 – Abweichender Vorschauport wird nicht durchgängig verwendet.** `next/apps/web/src/Workflows.tsx:634` setzt die iframe-Adresse auf 8792; der URL-Filter in derselben Datei, die persistierte URL in `next/packages/domain/workflows/website.ts:269` und die CSP in `next/apps/control/app.ts:95` verwenden ebenfalls den festen Port. Dagegen unterstützt der Listener `IRONCREW_PREVIEW_PORT` und die native Installation ausdrücklich einen eigenen Port. Im Repro antwortet die gebaute Website auf Port 54993 mit HTTP 200, das iframe adressiert aber 8792. Vorschau und visuelle Rückmeldung fallen damit bei dieser Konfiguration aus. Die Preview-Basisadresse muss gemeinsam an Workflow, Oberfläche und CSP übergeben werden.
2. **P2 – Nach Sitzungsablauf fehlt der Weg zur erneuten Anmeldung.** `next/apps/web/src/App.tsx:587` lädt den Sitzungszustand nur nach erfolgreichem Abmelden neu. Bei einer abgelaufenen Sitzung liefert DELETE `/session` jedoch HTTP 401; der Fehler bleibt unbehandelt und die alte angemeldete Oberfläche sichtbar. Der isolierte Repro bestätigt `authenticated=false`, unsichtbares Login und weiterhin sichtbaren Abmelden-Button. Ein manueller Reload stellt die Loginseite wieder her. Das Backend verweigert Zugriffe korrekt. Die Oberfläche sollte auf 401 den Sitzungszustand zurücksetzen und Logout auch nach bereits erfolgtem Sitzungsablauf abschließen.

Beide Befunde wurden mit echter temporärer SQLite-Datenbank, Produktions-Control-App und gebauter Oberfläche reproduziert. Ausführbarer Nachweis und Screenshots: `.tmp/mac-review-20260909/review/`. Für diesen Review wurden keine Produktquellen geändert.

## Tatsächlicher Produktablauf

Frischer Produktionsbuild, eigene lokale Firma und SQLite-Datenbank, sichtbarer Chromium-Browser auf diesem Mac. Der Control-Server lief auf 127.0.0.1:8875, der getrennte Preview-Listener auf 8876. Bestehende Benutzerfirmen und Integrationen wurden nicht verändert.

Über die Oberfläche geprüft: Ersteinrichtung mit Besitzerkonto, Crew, echter pass-cli-Verbindung, vollständigem Live-Katalog mit 584 Modellen, Firmenbudget 0 USD und ausdrücklich vertagtem Ausführungsrechner. Danach Auftrag, versionierter Arbeitsplan und enges Mandat ohne erlaubte Werkzeuge, mit einem Versuch und Kostenlimit 0 USD.

Der echte Modellaufruf aus dem Auftrag erreichte HTTP 200 und den Zustand `reviewing`. Die Antwort lautet exakt **IronCrew Mac OK**. Modellturn `85f9120c-9ec6-417b-8329-51589fa80e7d` ist `complete`, die Nutzung `reconciled`, die Reservierung `settled` und die gebuchten Kosten sind 0 USD. Die Provider-Generation ist `gen-1788943712-CCjIn1HRT7DeJjm2y7En`.

Sitzung, Auftrag, Plan, Mandat, Antwort und Kostenbuchung blieben nach Browserreload und vollständigem Serverneustart erhalten. Elf Haupt-/Einstellungsansichten waren erreichbar. 3D-Halle mit verifizierten Crew-Assets und Umschaltung zur kompakten Ansicht geprüft; mobile Auftrags-/Chat- und HQ-Ansicht bei 390 Pixeln ohne horizontalen Überlauf. In diesem Durchlauf keine JavaScript-Seitenfehler.

Zusätzlich wurde der tatsächliche Produkteinstieg über einen eigenen macOS-LaunchAgent im Benutzerdomain `gui/501` registriert, gestartet, gestoppt und neu gestartet. Registrierung war idempotent; der Prozess wechselte von PID 73308 zu 73388. Sitzung, Kunde, Projekt und Bereichsbeziehung blieben erhalten. Der eigene LaunchAgent wurde anschließend entladen und entfernt; die acht bereits bestehenden LaunchAgent-Dateien blieben unverändert. Dies war kein Systemdaemon-, Rechnerneustart- oder Loginzyklustest.

## Ausschließlich kostenlose Modelltests

Der Benutzer gab echte Tests mit seinem lokalen Proton-Pass-Zugang und ausschließlich kostenlosen Modellen frei. Beide Modellaufrufe verwendeten `openrouter/free`. Vor dem Produktaufruf wurden Prompt- und Completion-Preise aus dem aktuellen Katalog als 0 geprüft. Testprofil, Auftrag, Mandat und Firmentopf begrenzten Kosten auf 0 USD; es gab keinen kostenpflichtigen Fallback.

Der vorgelagerte echte Integrationsvertrag (`next/scripts/live.ts`) bestand ebenfalls, mit abgeglichenen Kosten 0 USD und nichtleerer Antwort. Insgesamt **zwei echte Aufrufe, zusammen 0 USD**. OpenRouter beschreibt diesen Router als ausschließlich auf kostenlose Modelle begrenzt: [offizielle Modellseite](https://openrouter.ai/openrouter/free).

Der Zugang wurde über `pass-cli item view` und den produktiven `ProtonPassResolver` bezogen. Im gespeicherten Produktprofil stehen ausschließlich Secret-Verweise. Ein lokaler Abgleich der Prüfartefakte gegen den tatsächlich aufgelösten Schlüssel ergab keinen Treffer. Zugangsdaten und Sitzungsdateien gehören nicht in diesen Bericht oder in Git.

## Regressionen und Qualität

| Prüfung                   | Ergebnis                       |
| ------------------------- | ------------------------------ |
| Unit                      | 83 bestanden                   |
| Contracts                 | 71 bestanden                   |
| Integration               | 320 bestanden                  |
| Browser-E2E               | 52 bestanden                   |
| Installation und Recovery | 90 bestanden                   |
| Gesamt                    | **616 bestanden, keine Skips** |

Lint, Typecheck und Formatprüfung bestanden ebenfalls mit Exitcode 0.

Ein anfänglicher Unitlauf mit einer kopierten Homebrew-Node-Binärdatei scheiterte an deren externer dylib-Abhängigkeit. Mit der dokumentierten offiziellen Standalone-Runtime über `IRONCREW_TEST_NODE` bestanden alle 83 Unitprüfungen; dafür war keine Quelländerung nötig. Drei Warnungen des direkten Playwright-Aufrufs betreffen die geerbten `NO_COLOR`-/`FORCE_COLOR`-Variablen.

Der frische Build besteht, ist aber **nicht warnungsfrei**: `Hall` beträgt 964,95 kB, der Haupteinstieg 551,28 kB unkomprimiert/minifiziert, beide oberhalb des Vite-Hinweises von 500 kB. Die vorherige Beseitigung der Legacy-Three.js-Warnung gilt nicht für diesen unabhängigen next-Build. Dies ist eine verbleibende Optimierungsaufgabe, kein in diesem Test belegter Funktionsausfall.

## Belege und Grenzen

Lokale Belege liegen unter `.tmp/mac-review-20260909/`: `order-evidence.json`, `live-product-summary.json`, `restart-evidence.json`, `.var/live-evidence/`, `regressions/summary.json`, `regressions/playwright-report/index.html`, `native/`, `quality/` sowie die Desktop-/Mobile-Screenshots. Zwischenfehler der ergänzenden Browser-Harnesses betrafen falsche Selektoren, eine erwartete statt tatsächlicher Navigation und fehlende Test-Paginierung; die korrigierten Durchläufe sind oben ausgewiesen.

Die realen Modelltests belegen Textantwort, Autorisierung, Kostenabrechnung und Persistenz. Produktive externe Dienste, Versand, Veröffentlichung, Remote-Worker und signierte Distributionen wurden dadurch nicht neu abgenommen. Das Mandat erlaubte keine Werkzeugaktionen.

Die eigenen Testserver und Browser sind beendet, die Ports 8875/8876 wieder frei. Die temporäre Browser-Sitzungsdatei wurde entfernt und das einmalige Setup-Token im lokalen Log geschwärzt. Prüfdaten und Belege bleiben lokal im ignorierten Testverzeichnis erhalten.

## Nachfolgende Korrektur

Die oben dokumentierten Befunde beziehen sich auf den damaligen Prüfstand. Beide P2-Fehler und die Warnungen wurden anschließend korrigiert; Crew-Modelle und Porträts wurden überarbeitet. Aktuelle Nachweise stehen im [Fixbericht](mac-fixes-and-crew-2026-09-09.md).
