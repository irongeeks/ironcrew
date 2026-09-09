# Aktuelle Wartung

Frühere Release-Aufgaben sind in den [Releaseberichten](../docs/releases/)
und der Git-Historie dokumentiert. Diese Liste führt den aktuellen Wartungsauftrag.

# 2026-09-09 – Repository aufräumen und vollständig lokal prüfen

- [x] Sauberen Ausgangsstand, Produktgrenzen, Projektregeln und bekannte Präventionsregeln prüfen.
- [x] Aufräumbare Dateien, veraltete Verweise und Repository-Hygiene prüfen und gezielt korrigieren.
- [x] Root: Frozen-Install, Format, Lint, OpenAPI, Typprüfung, Build, Web/API/Skripte und Browser prüfen.
- [x] next/: vollständige lokale Gates mit echten Testwerkzeugen, Browser und Dependency-Audit prüfen.
- [x] Reproduzierbare Fehler beheben und betroffene Prüfungen erneut ausführen.
- [x] Änderungen unabhängig prüfen und Ergebnis mit Befehlen, Testzahlen und Grenzen dokumentieren.

Umfang: lokaler Checkout beider Produktlinien. Kein Releaseauftrag; externe Konten und produktive Installationen sind keine lokalen Tests. Historische Prüfnachweise bleiben erhalten.

Zwischenreview: Root-Audit von 19 Advisories auf 0 reduziert; next-Audit von 2 auf 0. Notwendiger Vitest-4-Wechsel wird mit vollständigen Regressionen geprüft. Aufgedeckt und korrigiert werden zudem unsichere Wiederaufnahme alter Gate-Ergebnisse, irrtümliche Secret-Scanner-Befunde und fehlende Isolation schreibender Pack-Browsertests.

Abschlussreview 2026-09-09:6.963 Tests bestanden (Legacy6.329, next616, Python7, Quellrelease11), keine Skips in den finalen Teilläufen. Beide Audits0; next12/12 Gates und stabiler Quellstand. Docker ARM64 Build/Backup/Restore sowie echtes Update mit kontrolliertem Fehlerstopp bestanden. Öffentlicher Preflight über203 Revisionen erfolgreich. Unabhängiger Review der Packpfade/Secretprüfung/Resumeprüfung abgeschlossen. Details und verbleibende436 Legacy-any-Warnungen, Three.js-Chunkwarnung und einzelner nicht reproduzierbarer Docs-Reload stehen in docs/maintenance/repo-cleanup-2026-09-09.md. Kein Commit/Push.

# 2026-09-09 – Altlasten entfernen, Warnungen beheben, Commit und Push

- [x] Benutzerfreigabe für Löschen nicht benötigter Altdaten sowie Commit/Push dokumentiert.
- [x] Entbehrliche alte Testläufe und überholte Rohdaten anhand Referenzen entfernen.
- [x] Alle 436 Legacy-any-Warnungen durch belastbare Typverträge beheben.
- [x] Three.js-Buildwarnung durch passende Modulaufteilung beheben.
- [x] Gesamte betroffene Qualitätssuite und unabhängigen Review durchführen.
- [x] Geprüften Stand und Commit/Push gemäß ausdrücklicher Benutzerfreigabe vorbereiten.

Die abschließende Remote-Verifikation erfolgt am daraus erzeugten Commit auf
`origin/main`; ihre Run-Links gehören zum Ergebnisbericht der Sitzung.

Akzeptanz: keine Warnungsunterdrückung oder angehobenen Schwellwerte, keine entfernten Produktfunktionen, bestätigter Testumfang und bereinigter Git-Arbeitsstand nach Push.

Abschluss der lokalen Fortsetzung: 6.983 Tests plus Produktions-GLB-Durchlauf bestanden; keine Skips, keine Lint-/Buildwarnungen, beide Audits0.189 überholte CI-Rohdateien entfernt. Supertest-Adressfamilienfehler deterministisch reproduziert und mit4 Regressionen abgesichert. Details: [Prüfbericht](../docs/maintenance/repo-cleanup-2026-09-09.md).
