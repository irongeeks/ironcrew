# Releasebereitschaft — Entwicklungsstand

Stand: 7. September 2026. Arbeitszweig `rebuild/ironcrew`, Basis `76160c0`. Die Implementierung liegt im eigenständigen Workspace `next/` und wird auf dem freigegebenen Arbeitszweig versioniert. Der Nutzer hat Commit und Push nach Abschluss und Prüfung freigegeben. Der externe CI-Status ist getrennt vom lokalen Prüfbericht auf [GitHub Actions](https://github.com/irongeeks/ironcrew/actions) einsehbar.

## Lokaler Abschluss und Git-Übergabe

Die verbleibenden Programmteile sind abgeschlossen: Kunden-/Projektverwaltung mit exakter Auftragszuordnung, technische Websitebetreuung einschließlich Mandatdialog und Wartungsfenstern, gemeinsame Kontobegrenzung, deklarierte Adapter-Ausgaben und abgesicherter Dienstneustart. Die zugehörigen gezielten Fach-, Browser- und Betriebssystemprüfungen sind bestanden.

Der eingefrorene Quellstand hat sämtliche lokalen Gates mit 489 Tests ohne Auslassungen bestanden; der Dependency-Audit meldet 0 bekannte Schwachstellen. Die neue signierte TEST-Distribution ist gebaut und unabhängig geprüft. Auch der isolierte Produktupdate-Nachweis 0.4.3 → 0.4.4 mit Restoreprobe und Offlinebackup ist bestanden. Die abschließende Messung auf Apple M5 ergab 36,57 FPS, P95 23 ms bei 1.000 Aufträgen und eingehaltene Ressourcenbudgets; alle lokalen technischen Schwellen sind bestanden. GitHub-CI prüft den gepushten Commit zusätzlich auf drei Betriebssystemen sowie mit der Linux-Isolationssuite.

Der aktuelle vollständige Nachweis steht in [verification.md](verification.md). Separate ältere VM-/Betriebsproben gelten ausdrücklich für ihren jeweils dokumentierten Quellstand.

## Bereits implementierte Erweiterungen

- IMAP/MIME-Aufnahme mit Originalen, Anhängen und Deduplizierung; OAuth-Erneuerung mit verschlüsseltem Tokenzustand und Wiederanlaufschutz.
- Native Google-Workspace-Werkzeuge, quellengebundene Rechercheauslieferung und lokale Dateiauslieferung mit konkreten Freigaben.
- Finanzroutinen, wirksame klassifikationsbezogene Belegkorrekturen und versionierte, ausdrücklich aktivierte Lernregeln.
- Tatsächliche parallele Teamkonsultationen mit zugerechneten Beiträgen, Budgetreservierungen und sichtbarem Hallenzustand.
- Suchkosten und ungeklärte Modellkosten mit Quellenbeleg, Reservierung und nachvollziehbarer Klärung.
- Browserprüfung eigener Artefakte in Chromium-Sandbox; gebundene Screenshots und DOM-Nachweise.
- Website-Konzeptvorschauen, markierbare Stellen, versionsgebundenes Chat-/Sammelfeedback und echte Folgeversionen. Die aktuelle unabhängige Website-Prüfung bestand 21 Integrationstests und vier lokale Browserprüfungen.
- Einrichtung mit tatsächlich gespeicherten Profilen, Bereichen und Konfigurationen; neun unterschiedliche lokale GLB-Figuren mit Bewegungen und dokumentierten Messungen auf benanntem Host.
- Signierter Releasefeed, Updateplanung und native Registrierung mit Prüfung der unterstützten Betriebssysteme. Ein echter macOS-Produkt-LaunchAgent wurde mit privater Node-Runtime gestartet, gestoppt und erneut gestartet; siehe `test-evidence/launchd-product.json`.

## Externe Abnahmen

Konkrete Anbieter-Testkonten und ein autorisiertes Modelltestbudget fehlen weiterhin. Lokale HTTP-/TLS-/SMTP-/Browser- und Wiederherstellungstests belegen keine erfolgreiche Nutzung echter Kundenkonten. Windows und die übrigen CPU-/OS-Varianten sind nicht vollständig nativ abgenommen; vorhandene macOS- und getrennte Linux-VM-Nachweise gelten nur für ihre benannten Umgebungen.

Produktiver Signaturschlüssel, administrative Zielinstallation und langfristiger Betrieb sind getrennte Releaseaufgaben. Bestehende Distributionsnachweise mit temporärem TEST-Schlüssel sind keine Produktionsfreigabe. Manuelle Screenreader- und subjektive Gestaltungsabnahme sind nicht durch automatisierte Browserprüfungen ersetzt.

Keine Kundensite wurde veröffentlicht, keine Nachricht an reale Empfänger gesendet und keine Zahlung oder Steuerübermittlung ausgelöst. Die optionale Bankingfunktion wird ohne eingerichtete Verbindung nicht als verfügbar ausgegeben.
