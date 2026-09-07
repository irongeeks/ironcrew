# Technische Betreuung veröffentlichter Websites

Die Betreuung setzt PRD §15.8 um. Bei einem verifiziert veröffentlichten Hostingziel bietet die Auftragsfläche eine technische Betreuung an. Sie bleibt ausgeschaltet, bis der CEO die genaue Vereinbarung bestätigt. Inhalte, SEO und Weiterentwicklung benötigen eigene Aufträge. Firmensicherung und Selbstupdates der IronCrew-Zentrale laufen über die getrennte Maintenance-Verwaltung.

## Bedienung und Befugnisse

1. Im Websiteauftrag unter **Hosting und Veröffentlichung** das vorhandene Profil auswählen und ein Mandat für `website.care.check`, `website.care.backup` und gegebenenfalls `website.care.update` erteilen. Das Mandat bindet dieses Profil, Ablaufzeit, Aktionszahl, Laufzeit und Gesamtkosten.
2. Unter **Technische Websitebetreuung** ein verifiziertes Deployment und das Mandat wählen. Vereinbart werden Laufzeit, separater Betreuungs- und Vorfallbudgetrahmen, Prüfintervall, Backupzeitplan mit IANA-Zeitzone, beim Broker administrativ hinterlegte Sicherungsziel-ID, öffentlicher age-Empfänger und Aufbewahrungszeit. Beträge werden in USD eingegeben und exakt in USD-Mikroeinheiten gespeichert.
3. Eine Updatefreigabe nennt eine einzelne Patchversion mit aktuellem und neuem Manifest-SHA256, bestätigten Kosten und Wartungsfenster. Geänderte Versionen benötigen eine neue bestätigte Vereinbarung. Die Konfiguration erzeugt einen eigenen Betreuungsauftrag; ein abgeschlossener Websitebau wird dadurch nicht wieder geöffnet.
4. Erst das ausdrückliche Aktivierungshäkchen erlaubt den Scheduler. Pause und Änderungen verwenden die gespeicherte Revision. Eine Änderung des Betreuungsbudgets erfordert zuerst die separate CEO-Änderung am verknüpften Betreuungsauftrag.

Policy, Aktionen und Ergebnisse binden Bereich/Kunde/Projekt, Websiteauftrag, Deployment, Artefaktversion, Paket-SHA256, Profilfingerprint, Mandatsversion und Restoregeneration. Vor jeder HTTP-Wirkung werden diese Bindungen und das Mandat erneut geprüft, insbesondere nach Secretauflösung. Nach einem Firmenrestore berechtigt die alte Generation zu keinem Dispatch. Secretwerte gelangen ausschließlich vom Broker in den Transport.

## Zeitsteuerung und Fehler

Healthchecks nutzen ein begrenztes Intervall. Backups nutzen Cron mit IANA-Zeitzone; fällige Slots werden vor dem Dispatch dauerhaft vermerkt. Ein Neustart wiederholt keinen bereits verbuchten Slot. Updates laufen nur innerhalb ihres ausdrücklich vereinbarten Fensters (1–360 Minuten, Vorgabe 30). Verpasste Fenster werden sichtbar vermerkt und auf den nächsten regulären Termin gesetzt. Auch ein manuell angeforderter Patch unterliegt dem Fenster. Ein bereits versuchter Kandidat wird nicht automatisch erneut installiert.

Vor einem Update erfolgen eine verschlüsselte Sicherung und eine isolierte Restoreprobe. Die alte Version wird unabhängig über HTTPS geprüft; nach einer bestätigten Änderung werden neue Versionsidentität und Websitefunktion geprüft. Bei bekannter Updateantwort und fehlgeschlagener Healthprüfung wird ausschließlich der dazugehörige Rückweg angefordert und die alte Identität erneut geprüft. Eine verlorene Schreibantwort erlaubt keinen blinden Retry oder Rollback.

Ungeklärte Schreibwirkungen und beim Prozesswechsel zurückgebliebene laufende Jobs blockieren weitere Automatik dieser Policy. Es wird kein erfundenes Erfolgsergebnis erzeugt. Diese Fälle benötigen eine externe Wirkungsklärung; eine allgemeine automatische Übernahme fremder Brokerzustände oder ein pauschaler Freigabe-Button ist nicht vorhanden. Wiederkehrende Ausfälle derselben noch offenen Störung erzeugen einen einzigen verknüpften Incident. Diagnose, Reparatur, Beobachtungsfenster und Kundenkommunikation bleiben dem Incidentablauf mit dessen eigenen Mandaten vorbehalten.

## Bereitzustellender Hostingbroker

`HostingCareHttpClient` erweitert den dokumentierten [Hostingbroker](hosting-broker.md). Das ist ein enges, bereitzustellendes Brokerprotokoll, keine behauptete native API eines Hostinganbieters. Es gibt keine freie Shell- oder JSON-Batch-Schnittstelle.

| Aufruf                                                           | Erwartete tatsächliche Wirkung und Bindung                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/resources/:resourceId/backups`                         | Verschlüsseltes Archiv des gebundenen Deployments am vereinbarten Ziel; Receipt enthält Paket-/Archivhash, Empfänger, positive Bytezahl, Ziel-ID und exakt vereinbarte Kosten.  |
| `POST /v1/resources/:resourceId/backups/:backupId/restore-probe` | Isoliertes Wiederherstellen genau dieses Archivs; Archivhash, wiederhergestellter Pakethash, Funktionsprüfung und Nachweishash müssen passen.                                   |
| `POST /v1/resources/:resourceId/maintenance`                     | Ausschließlich die vereinbarte Patchversion und Manifestidentität installieren, an vorab geprüftes Backup und aktuelle Version gebunden; konkreten Rollbackverweis zurückgeben. |
| `POST /v1/resources/:resourceId/maintenance/rollback`            | Ausschließlich den gespeicherten Rückweg von bekannter neuer zu bekannter alter Version ausführen.                                                                              |
| `GET /.well-known/ironcrew-maintenance.json`                     | Öffentlich geprüfte Ressourcen-ID, tatsächlich installierte Laufzeitversion und Manifest-SHA256 bereitstellen.                                                                  |

Brokeraufrufe verwenden TLS und eine administrative CA-Konfiguration. Öffentliche Prüfungen kontrollieren DNS gegen erlaubte Adressen, pinnen die aufgelöste Adresse für die TLS-Verbindung und prüfen Zertifikat, Websiteinhalt sowie Deploymentidentität. Der Broker muss die von ihm bestätigte Verschlüsselung, Aufbewahrung, Restoreprobe und Installationswirkung tatsächlich implementieren; IronCrew kann eine kryptografische Dateiwirkung auf einem entfernten Kundenserver nicht allein aus einem JSON-Versprechen beweisen. Die lokale Fixture prüft diese Wirkungen zusätzlich direkt auf dem Dateisystem.

Vor kostenpflichtigen Backup-/Updateaufrufen reserviert IronCrew den ausdrücklich bestätigten Betrag im Firmenbudget, separaten Betreuungsauftrag und Mandat. Die HTTP-Bestätigung muss denselben Betrag nennen. Unklare Wirkungen lassen ihre Reservierung ungeklärt bestehen. Öffentliche Healthreads sind explizit ohne Providerentgelt konfiguriert; unbekannte Fremdpreise werden dadurch nicht als kostenlos behandelt.

## Ausgeführte lokale Nachweise

Am 7. September 2026 bestanden alle neun Fälle in `tests/integration/website-care.test.ts`: reales TLS, echtes age-Archiv, getrennte Entschlüsselung/Extraktion und Hashprüfung jeder Paketdatei; Versionswechsel einer eigenen lokalen Laufzeitfixture; Healthrollback; fehlerhafte Restoreprobe; verlorene Updateantwort und Neustart ohne Wiederholung; Alarmdeduplizierung; Scope, Generation, Widerruf nach Secretauflösung und Ablauf; echte CEO-HTTP-Sitzung mit CSRF/Revisions-/Idempotenzprüfung; persistente Crontermine und verpasstes Wartungsfenster. Die Laufzeitfixture verändert eine echte lokale Versionsdatei und HTTP-Funktion. Sie installiert keine produktive WordPress-/Node-Laufzeit.

`tests/e2e/website-care.spec.ts` prüft die echte gebaute React-Oberfläche bei 390×844 mit ausdrücklich vorgegebenen API-Fixtures: auswählbare Care-Mandatswerkzeuge, genaue USD-Konvertierung, konkrete Patchbindung und standardmäßig deaktivierte Automatik. Dieser Browserfall ist kein Providerwirkungstest. Typecheck und fokussierter ESLint-Lauf waren ebenfalls grün. Die vollständigen Releasegates werden getrennt auf dem eingefrorenen Gesamtstand ausgeführt.

Reproduktion: `IRONCREW_TEST_AGE=/absoluter/pfad/age node node_modules/vitest/vitest.mjs run tests/integration/website-care.test.ts`. `age-keygen` muss daneben liegen. Für den Browserfall zuerst den Webbuild ausführen und anschließend `node node_modules/@playwright/test/cli.js test tests/e2e/website-care.spec.ts` starten. Es werden ausschließlich temporäre Testschlüssel und lokale Testdaten genutzt.
