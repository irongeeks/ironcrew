# Neubaufortschritt — 7. September 2026

Arbeitszweig `rebuild/ironcrew`, Basis `76160c0e56324d1ec16ebf2956cbeadbc544cfc4`. Neuer eigenständiger Workspace `next/`, Originalprojekt unverändert. Die 21 manifestierten Originalpaketdateien und die Manifestkopie wurden erneut gegen ihre tatsächlichen SHA-256 geprüft. Keine Migration alter Firmendaten.

## Abschlussstand

Die Programmteile wurden durch drei parallel arbeitende Subagenten und Root umgesetzt und zusammengeführt. Kunden-/Projektverwaltung, Onboarding, Mailaufnahme/OAuth, Finanzautomatisierung und wirksame Korrekturen, Such-/Modellkostenklärung, native Google-Workspace-Werkzeuge, echte Teamkonsultationen, Websitefeedback und native Dienstvorprüfungen sind implementiert und durch gezielte Tests geprüft. Die technische Websitebetreuung einschließlich Mandatdialog, Verschlüsselung, Restoreprobe, konkretem Update und Wartungsfenster ist ebenfalls fertig und gezielt geprüft. Der eingefrorene Quellstand hat alle zwölf Abschlussgates bestanden: 489 Tests ohne Auslassungen, Dependency-Audit 0 und unveränderte Bindung an 333 Quelldateien.

**Vollständige lokale Gates und unabhängig geprüfte TEST-Distribution sind fertig. Der isolierte Produktupdate-Nachweis 0.4.3 → 0.4.4 ist ebenfalls bestanden. Auch die finale Leistungsmessung ist bestanden: 36,57 FPS und P95 23 ms bei 1.000 Aufträgen. Die Git-Übergabe erfolgt auf `rebuild/ironcrew`; Ergebnisse der zusätzlichen Betriebssystem-/Isolations-CI stehen bei GitHub Actions.** Alte Gesamtzahlen sind historische Nachweise und nicht auf den aktuellen Quellstand übertragbar. Aktueller Bericht: `next/docs/release-readiness.md`. Maschinenlesbare Anforderungszuordnung: `next/docs/acceptance-status.json`.

| Paket | Implementierter Umfang | Abschlussnachweis / Grenze |
| --- | --- | --- |
| AP-00 | Eigenständiges pnpm-Workspace, gepinnte Versionen/Lockfile, TS-/JS-/Vite-Build, Reuse-Register, CI-Matrix. | Alle lokalen Gates bestanden; zusätzliche GitHub-CI prüft den gepushten Commit. |
| AP-01 | SQLite-Worker, Einrichtung/Auth/CSRF, neun Profile, Lead/CAS, Kunden/Projekte, exakte Scopes, Audit/Outbox. | Komponenten-, HTTP- und Browserprüfungen; aktuelle Gesamtsuite bestanden. |
| AP-02 | Versionierte Mandate, argumentgebundene Freigaben, transaktionale Reservierung und Kostenklärung, Proton-Broker. | Reale Komponenten/Fehlerinduktion; externer Testtresor und Modellbudget fehlen. |
| AP-03 | Eigener OpenRouter-Toolloop mit Dateiarbeit, Testausführung, immutable Artefakten und Wiederaufnahme. | Lokale Modell-/Werkzeugtests; kein fremder CLI-Harness. |
| AP-04 | Enrollment, Leases, Generationen, WSS, getrennte Byte-/Logstreams, Abbruch, Linux-Sandbox. | Eigene Linux-VM und getrennte Mac-/Linux-Hosts geprüft; Windows/Hyper-V noch nicht nativ abgenommen. |
| AP-05 | Vollständige Einrichtung mit tatsächlichen Einstellungen; Navigation, Auftragssplit, Profile, Administration und mobile Alternative. | Browser-, Tastatur-, Skalierungs- und Kapazitätsnachweise; physischer Screenreader-Test getrennt offen. |
| AP-06 | Eigene Halle/Logos, neun individuelle GLBs, Rigbewegungen, echte Zustandsbindung und Fallback. | Format-/Browser-/Bewegungsprüfungen; Messungen gelten für ihren jeweils dokumentierten Build und Host. |
| AP-07 | Vollständiger Katalog, Capability-/Kostenrouter, artefaktgebundene Bewertungen, Wissen und CEO-Regeln. | Lokale Regeln/Fehlerfälle geprüft; reale Qualitätsstichprobe benötigt Nutzung. |
| AP-08 | Abruf/Suche, Originalquellen, Rechercheberichte, Git/Nextcloud/Drive/Google Docs, Beobachtung und Konfliktschutz. | Tatsächliche lokale HTTP-/TLS-Verträge und Artefakte; reale Anbieterabnahme fehlt. |
| AP-09 | Konzepte, echte Pakete, Vorschau, Pins/Chat/Sammelfeedback, Folgeversionen, QA, Abnahme und getrennte Hostingfreigabe. | Websitekette unabhängig geprüft; technische Pflege mit neun Fachtests und einem mobilen Browserfall geprüft; reales Kundenhosting fehlt. |
| AP-10 | Alarmdedupe, Diagnose, typisierter Dienstbroker, echte Reparatur/Funktionscheck, Beobachtung, Prävention, getrennte Kundenmail. | Tatsächliche lokale Dienste und TLS/SMTP; Kundenziel und reales Postfach fehlen. |
| AP-11 | Quellenbelegte Finanzansichten, Belege/Teilzahlungen, wirksame Korrekturen, begrenzte Lernregeln, Routinen/Erinnerungen, Zahlungsvorbereitung. | Lokale Fach-/API-/Browsertests; sevdesk-Testfirma fehlt, optionales Banking bleibt unkonfiguriert. |
| AP-12 | Bots/E-Mail, Identitätsbindung, IMAP/MIME-Aufnahme, OAuth, Inbox/Outbox, DST-/Wiederanlaufregeln. | Lokale signierte Eingänge und TLS-Mail; reale Bots/Postfächer fehlen. |
| AP-13 | Native Dienstpakete mit OS-/Editionsvorprüfung, age-Backup/Restore, Feed/Update/Rollback und Diagnose. | Echter macOS-LaunchAgent sowie historische Linux-Betriebsproben; neues natives TEST-Paket und Produkt-Selbstupdate zusätzlich geprüft. |
| AP-14 | Zusammenführung, Originalanforderungen, fachliche/technische Nachweise und Releasevorbereitung. | Aktuelle lokale Gates, Paket und Produktupdate bestanden; fehlende externe Abnahmen bleiben ausdrücklich Releaseblocker. GitHub-CI wird getrennt am gepushten Commit geprüft. |

## Übergabe und Berechtigung

Befehle und Startanleitung: `next/README.md`. Liveausführung ist standardmäßig ausgeschaltet. Der Nutzer hat Commit und Push nach vollständiger Umsetzung und Prüfung ausdrücklich freigegeben. Dies ist keine pauschale Freigabe für kostenpflichtige Modelltests, Kundenänderungen oder Veröffentlichungen. Kein realer Versand, Zahlungslauf oder Kundendeployment wurde ausgelöst.

Der finale Bericht muss Befehle, tatsächliche Resultate, Quellhash und Installationsartefakt miteinander verknüpfen. Vorhandene Dateien allein gelten nicht als Abnahme. GitHub-CI und externe Zielsystem-/Kontonachweise sind getrennte Prüfschritte.
