# IronCrew Dokumentation

IronCrew ist eine lokal betreibbare virtuelle AI-Firma. Der CEO arbeitet über einen Executive Assistant mit einer Crew aus Fachmitarbeitern; Aufgaben, Ausführung, Reviews und Freigaben bleiben nachvollziehbar.

**Neu hier?** Mit [Erste Schritte](GETTING_STARTED.md) lokal starten und anschließend den [Bedienungsleitfaden](USER_GUIDE.md) öffnen. Versionierung und der einmalige Wechsel von der bisherigen Versionsfolge auf `0.1.0` sind unter [Releases und Updates](RELEASES.md) beschrieben.

## Installieren und betreiben

| Anleitung | Inhalt |
| --- | --- |
| [Erste Schritte](GETTING_STARTED.md) | Lokaler Start, Konfiguration und erster Auftrag mit MockRuntime |
| [Releases und Updates](RELEASES.md) | Versionierte native Installation, Docker-Images, Updateprüfung und Wiederherstellung |
| [Linux](LINUX_INSTALL.md) · [macOS](MACOS_INSTALL.md) | Plattformspezifische Voraussetzungen und Dienste |
| [Sicherer Betrieb](SECURITY_OPERATIONS.md) | Getrennte Dienstkonten, systemd/launchd und nativer Runner |
| [Backup und Restore](BACKUP_RESTORE.md) | SQLite, Vault, Konfiguration und private Dateien gemeinsam sichern |
| [Provider-Anmeldung](PROVIDER_AUTH.md) | Offizielle CLI-Logins, SecretRefs und tatsächliche Runtime-Fähigkeiten |
| [CLI-Abnahme](CLI_RUNTIME_ACCEPTANCE.md) | Echte installierte und angemeldete Runtimes auf dem Zielsystem prüfen |

## Die Firma bedienen

| Anleitung | Inhalt |
| --- | --- |
| [Bedienungsleitfaden](USER_GUIDE.md) | CEO-Kanal, Aufgaben, Entscheidungen und tägliche Orientierung |
| [Lebendiges Office](LIVING_OFFICE.md) | Abteilungsräume, Bewegung, Raumfokus und zugängliche Liste |
| [Figuren](CHARACTERS.md) | 20 Originalfiguren, private Uploads und kopierbarer Generator-Prompt |
| [Team und Leistung](CAREER_REVIEWS.md) | Junior, Senior, Lead, fachliche Reviews und Modellvergleich |
| [Modell-Routing](RUNTIME_ROUTING.md) | Neun Profile, konkrete Modellzuordnung und kontrollierte Fallbacks |
| [Vessels und Talente](VESSELS_TALENTS.md) | Ausführungsrahmen und Fachkompetenz getrennt konfigurieren |
| [Projektplanung](PROJECT_PLANNING.md) | Plan prüfen, Budget festlegen und Task-Abhängigkeiten freigeben |
| [Warteschlange](RUN_QUEUE.md) | Persistente Ausführung, Wiederholungen und Kapazität |
| [Memory](MEMORY.md) | Obsidian-Vault, Quellen und optionales Honcho |
| [Coaching](COACHING.md) | Feedback, Evaluationen und versionierte Verbesserungen |
| [E-Mail](MAIL.md) · [Messenger](MESSENGER.md) | Optionale Kommunikationskanäle einrichten |
| [Business-Packs](BUSINESS_PACKS.md) | Fachliche Module und der jeweilige Integrationsumfang |

## Architektur und Entwicklung

| Dokument | Inhalt |
| --- | --- |
| [Architektur](ARCHITECTURE.md) · [Datenmodell](DATA_MODEL.md) | Control Plane, persistierte Firmenzustände und Domänengrenzen |
| [Runner-Protokoll](RUNNER_PROTOCOL.md) | Authentifizierte Jobs, Events und Host-Ausführung |
| [Tools](TOOLS.md) · [Netzwerk](NETWORKING.md) | Toolrechte, externe Zugriffe und Netzwerkgrenzen |
| [Bedrohungsmodell](THREAT_MODEL.md) · [Sandbox-Freigaben](SANDBOX_ACCESS.md) | Risiken, Schutzmaßnahmen und zeitlich begrenzte Berechtigungen |
| [Upstream-Analyse](UPSTREAM_ANALYSIS.md) · [Drittanbieterhinweise](../THIRD_PARTY_NOTICES.md) | Herkunft und Attribution |
| [Implementierungsstand](../IMPLEMENTATION_STATUS.md) | Umgesetzte Funktionen, Testnachweise und offene Abnahmen |
| [Roadmap](ROADMAP.md) · [Master-Prompt-Abdeckung](MASTER_PROMPT_COVERAGE.md) | Langfristiges Zielbild und verbleibende Arbeit |
| [Changelog](../CHANGELOG.md) · [Release-Historie](releases/README.md) | Änderungen je Version |

Die Einstiegsdokumentation ist deutsch; einige technische Referenzen sind englisch. Für Installation und Updates ist die Release-Anleitung maßgeblich. Ältere Release-Notizen beschreiben ihren damaligen Stand.
