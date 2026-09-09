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

Abschluss der lokalen Fortsetzung: 6.983 Tests plus Produktions-GLB-Durchlauf bestanden; keine Skips, keine Root-Lint-/Buildwarnungen, beide Audits0.189 überholte CI-Rohdateien entfernt. Supertest-Adressfamilienfehler deterministisch reproduziert und mit4 Regressionen abgesichert. Details: [Prüfbericht](../docs/maintenance/repo-cleanup-2026-09-09.md).

# 2026-09-09 – Lokaler Mac-Test und Produktreview

- [x] Aktuellen Commit und lokale Laufzeit prüfen.
- [x] Aktuellen next-Produktbuild isoliert auf dem Mac starten und zentrale UI-Abläufe prüfen.
- [x] Native Start-/Neustart-/Persistenzprüfung und passende Regressionen ausführen.
- [x] Unabhängiges Code-/Produktreview mit reproduzierbaren Befunden abschließen.
- [x] Ergebnisse, Screenshots und Grenzen dokumentieren; eigene Testprozesse bereinigen.

Prüfstand: 8521efd. Fokus ist der aktuelle Produktkern next/; frühere grüne
Legacy-Tests sind Kontext und werden nicht als neuer Mac-Produkttest ausgegeben.

Live-Testvorgabe: Zugang über vorhandene lokale `pass-cli`; ausschließlich `openrouter/free`, Modell-, Firmen- und Mandatsbudget 0 USD. Zwei echte Aufrufe erfolgreich, beide mit abgeglichenen Kosten von 0 USD.

Ergebnis: 616 Tests, Lint, Typecheck und Formatprüfung bestanden; echter macOS-LaunchAgent mit Neustart und Datenerhalt geprüft. Zwei reproduzierte P2-Befunde (abweichender Vorschauport, Login nach Sitzungsablauf) und next-Buildgrößenwarnung offen. Eigene Testdienste beendet. [Prüfbericht](../docs/maintenance/mac-review-2026-09-09.md).

# 2026-09-09 – Reviewfehler und Crew-Figuren überarbeiten

- [x] Vorschauport durchgängig konfigurieren und Sitzungsablauf/Logout korrigieren; beide Fehler mit Regressionen absichern.
- [x] next-Bundleaufteilung ohne angehobene Warnschwellen korrigieren.
- [x] Neun Crew-Modelle mit natürlichen Proportionen, anatomischen Gesichtern/Händen und differenzierten Kleidungs-/Haarformen überarbeiten; GLBs und zugehörige Porträts erneuern.
- [x] Nahansichten und echte Halle visuell prüfen, Artikulation und gemessene Rendering-Leistung erhalten.
- [x] Gesamte next-Testsuite und Qualität erneut prüfen; Ergebnis und Grenzen dokumentieren.

Vorgaben: bestehende Rollen und Namen erhalten, lokale nachvollziehbare 3D-Assets, keine kostenpflichtigen Modellaufrufe; pass-cli/free-only gilt weiterhin für eventuelle Live-Tests.

Abschluss: beide P2-Fehler samt verspäteter Logout-Antwort korrigiert; 634 Tests ohne Skips und alle Qualitätsprüfungen grün, Audit 0. Crew-Revision 3 mit anatomischer Kopfbasis, neuen Körper-/Kleidungsformen und Distanzvarianten; echte Halle im vollständigen Lauf 35,19 FPS bei unverändert 30 FPS Mindestanforderung. Erneuter pass-cli/free-Livevertrag erfolgreich, Kosten 0 USD. [Fixbericht und Bildnachweise](../docs/maintenance/mac-fixes-and-crew-2026-09-09.md).
