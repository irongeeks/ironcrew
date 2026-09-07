# Entwicklungsplan und Liefernachweise

Alle Pakete sind noch offen. Die folgende Reihenfolge ist ein Bauplan, kein Bericht über erledigte Implementierung. Keine pauschalen Zeitangaben; AP-00 erstellt anhand des tatsächlichen Umfelds eine erste Aufwandsspanne und aktualisiert sie nach AP-03.

## Arbeitspakete

| ID | Abhängigkeit | Konkreter Lieferumfang | Fertig, wenn / Nachweis |
| --- | --- | --- | --- |
| AP-00 | – | Bestandscommit/Gitstatus prüfen, `next/`-Workspace anlegen, Versions-/Plattformmatrix, Reuse-Register, Befehle und CI-Grundgerüst. | Saubere Installation/Build unter Node 26; jede angegebene Abhängigkeit aufgelöst; Plattformlücken dokumentiert. |
| AP-01 | 00 | Schemas, SQLite-Migrationen, Firma/Bereiche/Crew, Auftrag mit Lead, Ereignis-/Outboxlog, Setup/Auth. | Leerer Datenbestand wird eingerichtet; kein Auftrag ohne Lead; fremder Bereich/ungeprüfter Setupzugriff abgewiesen. |
| AP-02 | 01 | Mandate, konkrete Freigaben, Kostenledger/Reservierung, Proton-pass-Verbindung und persistierte Modellnachrichten. | Argumentänderung entwertet Freigabe; parallele Reservierungen überschreiten Limit nicht; ungeklärte Kosten bleiben sichtbar. |
| AP-03 | 02 | Eigener OpenRouter-Toolloop, erster lokaler Worker, Dateilesen/-änderung, Testausführung und Artefaktversion. | Cersei-Auftrag erzeugt echte Datei, prüft sie und liefert Ergebnis; Prozessneustart und Freigabepause erhalten Kontext. Kein externer CLI-Harness; bis AP-04 nur eng begrenzte vertrauenswürdige Testfixtures ausführen. |
| AP-04 | 03 | Verteiltes Workerprotokoll, Enrollment, Leases, lokale Belege, Abbruch, Isolation auf Zielplattformen. | Verbindungsverlust/doppeltes Resultat ohne doppelte Wirkung; unbekannte Wirkung blockiert; Sandbox-Negativtests bestanden. |
| AP-05 | 01, UI-Verträge 02 | Designsystem B, vollständiges Onboarding, Navigation, Auftragssplit, Crewprofile, mobile Alternative. | Alle definierten Screens/Zustände mit echten API-Verträgen bedienbar; Tastatur/Zoom/DE-EN geprüft. Mockphase nur gekennzeichnet. |
| AP-06 | 04,05 | 3D-Halle, neun Charaktere, Statusbindung, Kamera, Animation/Fallback. | Passende Figuren und eigene Logos; keine Modellkosten für Dekoration; WebGL-Ausfall erhält nutzbare Auftragsarbeit. |
| AP-07 | 02,03 | Modellkatalog/Router, Reviewbewertung, Wissen mit Leadprüfung, versionierte Firmenregeln. | Vollständiger Katalog, begründete Wahl, sichtbare Stichprobe; keine automatische globale Regel aus Einzelkorrektur. |
| AP-08 | 04,05,07 | Such-/Abrufadapter, Rechercheworkflow, Quellen, Ergebnisdokument, Git/Nextcloud/Drive-Ablage. | Recherche liefert belegte lokale und externe Version; Konflikt/fehlender Upload verhindert falsche Abschlussmeldung. |
| AP-09 | 04,05,07,08 | Websiteworkflow: Briefing, Konzepte, Auswahl, Build, Vorschau, Pins, QA, Abnahme, Hostingprofile/Selbsthosting. | WEB-Kriterien; geändertes Artefakt benötigt neue Publishfreigabe; Selbsthostingpaket reproduzierbar. |
| AP-10 | 04,05,07 | IT-Connectoren, Vorfallzustände, Runbooks, Funktionscheck, Beobachtung und Präventionsauftrag. | OPS-Kriterien; Restart ohne Funktionsnachweis nicht „behoben“; Kundenmeldung wartet auf CEO. |
| AP-11 | 04,05,07,08 | sevdesk-Belege, Finanzübersicht, Lernregeln, Erinnerungen, Zahlungsvorbereitung und Export-Schnittstelle. | FIN-Kriterien; Testbelege/Teilzahlungen/Versandtimeout geprüft; Bankimport nur nach Formatnachweis verfügbar. |
| AP-12 | 02,04,05 | Discord/Telegram/E-Mail, Identitätsbindung, Inbox/Outbox, Zeitpläne und Zielmandate. | Kein zweiter Auftrag bei Eventduplikat; Kundenmail kann keine Freigabe erteilen; Scheduler-DST und Nachholregeln getestet. |
| AP-13 | 04,05 | Native Installer/Dienste, verschlüsselte Sicherung, Restore, Update/Rollback und Diagnose. | Plattforminstallation/Wiederstart belegt; Restore auf frischem System und Updatefehler mit Rückweg geprüft. |
| AP-14 | 06–13 | Vollständige Zusammenführung, echte Verbindungstests, Dokumentation, Releasevorbereitung. | Alle vier Abläufe und Betriebsgates bestanden oder fehlende Zugangsnachweise ausdrücklich als Releaseblocker ausgewiesen. |

Pakete 05 und erste Gestaltung 06 können neben Backendarbeit entstehen. Die vier Fachabläufe können nach gemeinsamen Grundlagen getrennt umgesetzt werden. Schnittstellen, Datenbankmigrationen und geteilte UI-Komponenten erhalten jeweils klare Zuständigkeit; parallele Änderungen am selben Modul abstimmen.

## Meilensteine

- M1: AP-00 bis AP-03. Eigene Crew erledigt einen kleinen echten Auftrag mit Wiederaufnahme.
- M2: AP-04 bis AP-08. Verteilte Ausführung, eigene Oberfläche, 3D, Wissen, Modellwahl und Recherche.
- M3: AP-09 bis AP-12. Vier Fachabläufe und alle Kanäle durchgängig.
- M4: AP-13/14 und alle übrigen Gates. Native installierbare erste vollständige Version.

M1/M2 sind interne Zwischenstände. Kein Weglassen eines Fachablaufs oder Ersetzen der 3D-Halle durch ein statisches Bild als angeblich fertiges Produkt.

## Fortschritt und Übergabe zwischen Agentensitzungen

`docs/progress.md` enthält pro AP Status (offen/in Arbeit/blockiert/geprüft), Commit/Arbeitsstand, Artefakte, Testbefehle mit Resultat, offene Fragen und nächsten konkreten Schritt. `docs/decisions.md` vermerkt Abweichungen; `docs/test-evidence/` enthält redigierte Resultate. Ein Paket darf nicht nur wegen existierender Dateien auf geprüft wechseln.

Zum Sitzungsende: laufende Prozesse und Arbeitszweig benennen, Änderungen erhalten, nächste Aktionen konkret hinterlassen. Keine Zugangsdaten oder vollständigen Kundendokumente in Übergabedateien. Produktkritische Unklarheit mit Optionen/Wirkung vorlegen; Routineentscheidungen selbst treffen und dokumentieren.
