# IronCrew v0.4.1 — Linux-Testbericht

- [x] Claudes Drive-Bericht vom 2026-09-07 gegen Release-Commit 3e062b5 lesen.
- [x] BEFUND-01: offizielles Proton-Pass-CLI ab 2.3.2 akzeptieren.
- [x] BEFUND-02/03: OpenRouter-Katalog und kostenlose Modellauswahl wiederherstellen.
- [x] BEFUND-04: Secretzugriff vor Runtime-Bereitschaft prüfen.
- [x] BEFUND-05: sichere, konkrete Katalogdiagnosen und verständliche Fehler.
- [x] BEFUND-06: optionale Formulare unabhängig von Setup-Navigation prüfen.
- [ ] Regressionen, Build und Release-Gates ausführen.
- [ ] v0.4.1 veröffentlichen und Release verifizieren.

## Prüfung

- Proton-CLI-Vertrag: 41 Tests erfolgreich.
- Katalog-/Runtime-Verträge und neue Bereitschafts-/API-Regressionen erfolgreich.
- Typecheck, ESLint und Produktionsbuild erfolgreich.
- Onboarding-Browserregression mit Chromium 149 lokal erfolgreich.
- Vollständige Betriebssystem-, age-/Installations- und Isolationsgates werden im Release-Commit durch CI geprüft. Lokale Gesamtprüfung hatte fehlende native Werkzeuge und keine Freigabe für privilegierte Updaterpfade; dies ist keine erfolgreiche vollständige Betriebssystemabnahme.
- Echter OpenRouter-Aufruf auf tank bleibt ein Betreiber-Nachtest; hier keine Kontozugangsdaten.
