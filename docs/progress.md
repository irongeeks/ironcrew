# Neubaufortschritt — 7. September 2026

Arbeitszweig `rebuild/ironcrew`, Basis `76160c0e56324d1ec16ebf2956cbeadbc544cfc4`. Neuer eigenständiger Workspace `next/`, Originalprojekt unverändert. Die 21 manifestierten Originalpaketdateien und die Manifestkopie wurden erneut gegen ihre tatsächlichen SHA-256 geprüft. Keine Migration alter Firmendaten.

## Abschlussstand

Die Programmteile wurden durch drei parallel arbeitende Subagenten und Root umgesetzt und zusammengeführt. Kunden-/Projektverwaltung, Onboarding, Mailaufnahme/OAuth, Finanzautomatisierung und wirksame Korrekturen, Such-/Modellkostenklärung, native Google-Workspace-Werkzeuge, echte Teamkonsultationen, Websitefeedback und native Dienstvorprüfungen sind implementiert und durch gezielte Tests geprüft. Die technische Websitebetreuung einschließlich Mandatdialog, Verschlüsselung, Restoreprobe, konkretem Update und Wartungsfenster ist ebenfalls fertig und gezielt geprüft. Der eingefrorene Quellstand hat alle zwölf Abschlussgates bestanden: 508 Tests ohne Auslassungen, Dependency-Audit 0 und unveränderte Bindung an 341 Quelldateien.

**Produktcommit `686022a9a0f02f7ff8a93e120c4e82965c13a379`: lokale 508 Tests, 12 Gates, Audit 0 und 341 unveränderte Quelldateien bestanden.** Die aktuelle Hallenmessung ergibt 41,64 FPS; der separate Kapazitätsbeleg von 12:24 UTC bleibt bei P95 23 ms und 1.000 Aufträgen. Die Drei-OS-CI `34139199380` hat diesen abschließenden Stand auf macOS 15, Windows Server 2025 und Ubuntu 24.04 mit jeweils 508 Tests, 12 erfolgreichen Gates und keinen Skips vollständig bestanden; auch der Linux-Isolationslauf `34139199314` ist erfolgreich. Die Originalbelege sind im [CI-Verzeichnis](../next/docs/test-evidence/ci/README.md) archiviert. Die vorherige Drei-OS-CI zu `ebf3b98` bestand bereits jeweils 508 Tests auf macOS, Windows und Ubuntu; dieser Erfolg bleibt an den damaligen Commit gebunden. Die macOS-ARM64-TEST-Distribution aus `aabff77` ist unabhängig geprüft; ihr echter Produktupdate-Nachweis 0.4.3 → 0.4.4 mit Restoreprobe und Offlinebackup ist bestanden.

Aktueller Bericht: `next/docs/verification.md`. Releasegrenzen: `next/docs/release-readiness.md`. Maschinenlesbare Anforderungszuordnung: `next/docs/acceptance-status.json`. Historische Gesamtzahlen, Messungen und Pakete bleiben an ihre damaligen Quellstände gebunden.

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
| AP-13 | Native Dienstpakete mit OS-/Editionsvorprüfung, age-Backup/Restore, Feed/Update/Rollback und Diagnose. | Echter macOS-LaunchAgent sowie historische Linux-Betriebsproben; Neues natives TEST-Paket aus `aabff77` mit unabhängiger Signatur-/Byteprüfung und echtem Produktupdate bestanden; übrige Zielinstallationen bleiben separat. |
| AP-14 | Zusammenführung, Originalanforderungen, fachliche/technische Nachweise und Releasevorbereitung. | Lokale Gates und neue Paket-/Produktupdatebelege bestanden; fehlende externe Abnahmen bleiben ausdrücklich Releaseblocker. GitHub-CI wird getrennt am gepushten Commit geprüft. |

## Übergabe und Berechtigung

Befehle und Startanleitung: `next/README.md`. Liveausführung ist standardmäßig ausgeschaltet. Der Nutzer hat Commit und Push nach vollständiger Umsetzung und Prüfung ausdrücklich freigegeben. Dies ist keine pauschale Freigabe für kostenpflichtige Modelltests, Kundenänderungen oder Veröffentlichungen. Kein realer Versand, Zahlungslauf oder Kundendeployment wurde ausgelöst.

Der finale Bericht muss Befehle, tatsächliche Resultate, Quellhash und Installationsartefakt miteinander verknüpfen. Vorhandene Dateien allein gelten nicht als Abnahme. GitHub-CI und externe Zielsystem-/Kontonachweise sind getrennte Prüfschritte.
