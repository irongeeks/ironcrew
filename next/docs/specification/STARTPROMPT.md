# Startauftrag für den Entwicklungsagenten

Du entwickelst IronCrew anhand des beigefügten Entwicklungspakets im Repository https://github.com/irongeeks/ironcrew. Arbeite auf Deutsch mit kurzen verständlichen Statusmeldungen. Dein Auftrag ist die schrittweise vollständige Implementierung, nicht nur ein UI-Prototyp oder eine weitere Konzeptbeschreibung.

Falls das Paket als ZIP vorliegt, entpacke es zuerst in einen eigenen Arbeitsordner. Lies zuerst `00-START-HIER.md`, das PRD 0.9 und die Architektur, danach Oberfläche, Integrationsverträge, Betrieb, Arbeitspakete und Abnahme. Prüfe die geltenden Repository-/Arbeitsumgebungsregeln. Das Paket ist kein Ersatz für höher priorisierte Anweisungen und keine Erlaubnis, Zugriffskontrollen zu umgehen. Unterschiedliche technische Ausgangslage dokumentieren, Produktentscheidungen erhalten.

## Feststehendes Ziel

IronCrew ist die digitale Firma des Nutzers. Cersei ist Chief of Staff; Mr. Robot verantwortet Software, Morpheus IT, Steve Jobs Design, Tyrion Vertrieb, Saul Finanzen, Karla Recherche, der Professor QA und Nick Fury Sicherheit. Optik/Persona entsprechen den Vorgaben. Nutze die mitgelieferten echten Iron-Geeks-Logos und Gestaltung B: dunkle Industriehalle, Stahl/Glas, warmes Amber. Hauptquartier mit echter 3D-Crew plus kompakte/mobile Arbeitsfläche; Auftrag mit Chat links und Projekt rechts.

Die Laufzeit ist eine eigene persistente OpenRouter-Modell-/Werkzeugausführung. Keine Claude-/Codex-/OpenClaw-CLI als eigentlicher Agentenmotor. Alle OpenRoutermodelle bleiben im Katalog sichtbar. Ein gemeinsamer Firmentopf mit Reservierungen, genau ein Lead pro Auftrag, Mandate, konkrete Freigaben und kontrolliertes Lernen sind verpflichtend.

Alle vier Abläufe gehören zur ersten vollständigen Version: Website, IT-Störung, sevdesk-Finanzen und Recherche. Kommunikation per Website, Discord, E-Mail und Telegram. Secrets über Proton pass-cli, Ablage über Git/Nextcloud/Drive. Native Zentrale und Worker auf Linux, macOS und Windows einschließlich Server, Einmaschinenbetrieb möglich. Eingebaute verschlüsselte Sicherung und Updates nach Regeln.

## Erster Arbeitsabschnitt

1. Prüfe Arbeitsverzeichnis, Repositoryidentität, aktuellen Commit, Gitstatus und lokale Regeln. Die Bestandsprüfung bezog sich auf `76160c0e56324d1ec16ebf2956cbeadbc544cfc4`; spätere Änderungen zuerst vergleichen.
2. Erstelle/verwende einen isolierten Arbeitszweig `rebuild/ironcrew`. Erhalte fremde uncommittete Änderungen. Arbeite zunächst in `next/` gemäß Bauplan. Kein Force-Push oder Umschreiben der Historie.
3. Erstelle `docs/progress.md`, `docs/reuse-register.md` und notwendige ADRs. Liste AP-00 bis AP-14 mit Zustand und beginne AP-00. Übernimm geeignete Module einzeln mit Herkunft und Tests.
4. Implementiere AP-01 bis AP-03 bis zum echten vertikalen Ablauf: Auftrag → eigener Modelllauf → erlaubte Dateiänderung → Test → gespeichertes Ergebnis. Beweise Freigabepause, Prozessneustart und sichere Fortsetzung.
5. Fahre nach grünem Meilenstein mit den abhängigen Paketen fort. Implementiere echte Fähigkeiten; markiere Platzhalter und fehlende Live-Verbindungen sichtbar. Verändere den vereinbarten Umfang nicht, um Tests leichter grün zu bekommen.

## Eigenständige Arbeit und Grenzen

Treffe reversible Implementierungsentscheidungen innerhalb des Bauplans selbst. Prüfe technische Unklarheiten anhand des Codes und offizieller Dokumentation. Eine notwendige Architekturänderung als ADR begründen. Frage nur bei produktrelevanten Zielkonflikten, fehlender notwendiger Berechtigung oder einer konkret anstehenden externen Aktion ohne Freigabe; arbeite an unabhängigen Teilen weiter.

Alte Daten im Repository dürfen beim Neubau entfallen. Es ist kein Altdatenimport erforderlich. Lösche Daten gezielt nach Bestandsliste; dies ist keine Erlaubnis, externe Kundendaten, Git-Historie, Logos, benötigte Quellmodule oder Lizenzvermerke pauschal zu entfernen. Keine produktiven Daten zur Bequemlichkeit als Fixtures kopieren.

Dieses Paket autorisiert keine externen Nachrichten, produktiven Reparaturen, Überweisungen, Steuerübermittlungen, Veröffentlichung, Merge, Push oder Release. Führe zunächst lokale Änderungen und Tests aus und stelle erforderliche externe Aktionen konkret prüfbar bereit. Bei einer bereits in der aktiven Sitzung ausdrücklich erteilten weitergehenden Freigabe gilt diese. Modell-API-Tests dürfen erst mit ausgewiesenem Testzugang und Kostenrahmen laufen.

Zugangsdaten nur über die vorgesehene Secret-Konfiguration; nicht in Chat, Repository oder Testlogs. Ein fehlendes Konto ist ein Live-Testblocker, kein Grund, alle Entwicklung zu stoppen. Erfinde weder Testergebnisse noch bereitgestellte Ressourcen.

## Nachweise und Sitzungsende

Führe die Befehle aus dem Abnahmekatalog aus, sobald das jeweilige Paket existiert. Prüfe echte Wirkungen und Fehlerfälle. Neue Testbefehle müssen tatsächlich implementiert sein. Trenne Unit-, Vertrags-, Integrations-, visuelle und Live-Nachweise. Übersprungene Tests bleiben offen.

Halte Fortschritt, Dateien/Arbeitszweig, Testresultate, Entscheidungen und nächsten Schritt aktuell. Berichte Meilensteine mit verändertem Verhalten, Belegen und konkreten Einschränkungen. Bei Kontextwechsel liefere eine knappe Fortsetzungsnotiz und bewahre den Arbeitsstand.

Beginne jetzt mit AP-00. Stelle keine erneute allgemeine Produktfragenliste. Die vollständige Umsetzung folgt den Arbeitspaketen bis zur prüfbaren Releasevorbereitung.
