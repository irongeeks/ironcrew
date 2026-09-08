# IronCrew Dokumentation

IronCrew ist eine lokal betreibbare virtuelle AI-Firma. Der CEO arbeitet über einen Executive Assistant mit einer Crew aus Fachmitarbeitern; Aufgaben, Ausführung, Reviews und Freigaben bleiben nachvollziehbar.

## Aktuell: IronCrew 0.4.4

Der neue Produktkern liegt unter `next/` und unterstützt Linux, macOS und Windows.

| Einstieg                                                                        | Inhalt                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Einrichtung und Bedienung](../next/README.md)                                  | Firma, CEO, Crew, Modelle, Mandate und Arbeitsabläufe                       |
| [0.4.4 und Update von 0.4.0–0.4.3](releases/v0.4.4.md)                          | Quellrelease, Datenverzeichnis beibehalten, Korrekturen und Prüfbedingungen |
| [Modellzugang und Fehlerdiagnose](../next/docs/model-access-troubleshooting.md) | Proton Pass, OpenRouter-Katalog, Bereitschaft und optionale Einrichtung     |
| [Prüfnachweise](../next/docs/verification.md)                                   | Tatsächliche Nachweise und Bindung an den jeweiligen Quellstand             |
| [Releasebereitschaft](../next/docs/release-readiness.md)                        | Betriebsgrenzen und externe Abnahmen                                        |

## Legacy 0.3.x

Die folgenden Anleitungen beschreiben den bisherigen Produktkern im Repository-
Root. Sie sind keine Installations- oder Updateanleitung für den Quellrelease 0.4.4.

## Installieren und betreiben

| Anleitung                                             | Inhalt                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Erste Schritte](GETTING_STARTED.md)                  | Lokaler Start, Konfiguration und erster Auftrag mit MockRuntime                      |
| [Releases und Updates](RELEASES.md)                   | Versionierte native Installation, Docker-Images, Updateprüfung und Wiederherstellung |
| [Linux](LINUX_INSTALL.md) · [macOS](MACOS_INSTALL.md) | Plattformspezifische Voraussetzungen und Dienste                                     |
| [Sicherer Betrieb](SECURITY_OPERATIONS.md)            | Getrennte Dienstkonten, systemd/launchd und nativer Runner                           |
| [Backup und Restore](BACKUP_RESTORE.md)               | SQLite, Vault, Konfiguration und private Dateien gemeinsam sichern                   |
| [Provider-Anmeldung](PROVIDER_AUTH.md)                | Offizielle CLI-Logins, SecretRefs und tatsächliche Runtime-Fähigkeiten               |
| [CLI-Abnahme](CLI_RUNTIME_ACCEPTANCE.md)              | Echte installierte und angemeldete Runtimes auf dem Zielsystem prüfen                |

## Die Firma bedienen

| Anleitung                                           | Inhalt                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Bedienungsleitfaden](USER_GUIDE.md)                | CEO-Kanal, Aufgaben, Entscheidungen und tägliche Orientierung                 |
| [Lebendiges Office](LIVING_OFFICE.md)               | Abteilungsräume, Bewegung, Raumfokus und zugängliche Liste                    |
| [Figuren](CHARACTERS.md)                            | 20 Originalfiguren, private Uploads und kopierbarer Generator-Prompt          |
| [Team und Leistung](CAREER_REVIEWS.md)              | Junior, Senior, Lead, fachliche Reviews und Modellvergleich                   |
| [Firmenkonfiguration](COMPANY_CONFIGURATION.md)     | Wirksame Laufzeit-, Tool-, Freigabe- und Memory-Grenzen mit Versionsverlauf   |
| [Objektive Run-Prüfungen](OBJECTIVE_EVALUATIONS.md) | Versionierte Kriterien, reproduzierbare Messungen und Modellvergleich         |
| [Geschäftsdaten](BUSINESS_DASHBOARD.md)             | Vorhandene MSP-/Finance-Quellen bewusst abrufen und die Datengrundlage prüfen |
| [Provider-Freigaben](VENDOR_POLICIES.md)            | Firmenfreigaben unter der zentralen YAML-Policy, Revisionen und Modellprüfung |
| [Modell-Routing](RUNTIME_ROUTING.md)                | Neun Profile, konkrete Modellzuordnung und kontrollierte Fallbacks            |
| [Vessels und Talente](VESSELS_TALENTS.md)           | Ausführungsrahmen und Fachkompetenz getrennt konfigurieren                    |
| [Projektplanung](PROJECT_PLANNING.md)               | Plan prüfen, Budget festlegen und Task-Abhängigkeiten freigeben               |
| [Warteschlange](RUN_QUEUE.md)                       | Persistente Ausführung, Wiederholungen und Kapazität                          |
| [Memory](MEMORY.md)                                 | Obsidian-Vault, Quellen und optionales Honcho                                 |
| [Coaching](COACHING.md)                             | Feedback, Evaluationen und versionierte Verbesserungen                        |
| [E-Mail](MAIL.md) · [Messenger](MESSENGER.md)       | Optionale Kommunikationskanäle einrichten                                     |
| [Business-Packs](BUSINESS_PACKS.md)                 | Fachliche Module und der jeweilige Integrationsumfang                         |

## Architektur und Entwicklung

| Dokument                                                                                      | Inhalt                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Architektur](ARCHITECTURE.md) · [Datenmodell](DATA_MODEL.md)                                 | Control Plane, persistierte Firmenzustände und Domänengrenzen                                |
| [Runner-Protokoll](RUNNER_PROTOCOL.md)                                                        | Authentifizierte Jobs, Events und Host-Ausführung                                            |
| [Tools](TOOLS.md) · [Netzwerk](NETWORKING.md)                                                 | Toolrechte, externe Zugriffe und Netzwerkgrenzen                                             |
| [Bedrohungsmodell](THREAT_MODEL.md) · [Sandbox-Freigaben](SANDBOX_ACCESS.md)                  | Risiken, Schutzmaßnahmen und zeitlich begrenzte Berechtigungen                               |
| [Upstream-Analyse](UPSTREAM_ANALYSIS.md) · [Drittanbieterhinweise](../THIRD_PARTY_NOTICES.md) | Herkunft und Attribution                                                                     |
| [Produktabnahme](PRODUCT_ACCEPTANCE.md)                                                       | MVP-Anforderungen mit Code-/Testnachweisen, Betreiberabnahme und langfristigen Erweiterungen |
| [Implementierungsstand](../IMPLEMENTATION_STATUS.md)                                          | Umgesetzte Funktionen, Testnachweise und offene Abnahmen                                     |
| [Roadmap](ROADMAP.md) · [Master-Prompt-Abdeckung](MASTER_PROMPT_COVERAGE.md)                  | Langfristiges Zielbild und verbleibende Arbeit                                               |
| [Screenshots](SCREENSHOTS.md)                                                                 | Aufnahmeverfahren, Testdatenherkunft und reproduzierbare Browserbilder                       |
| [Changelog](../CHANGELOG.md) · [Release-Historie](releases/README.md)                         | Änderungen je Version                                                                        |

Die Einstiegsdokumentation ist deutsch; einige technische Referenzen sind englisch. Für Installation und Updates ist die Release-Anleitung maßgeblich. Ältere Release-Notizen beschreiben ihren damaligen Stand.

- [Automatisches Setup](INSTALLER.md): vorhandene Voraussetzungen prüfen und fehlende Werkzeuge installieren (aktueller Quellcode nach 0.3.1).
