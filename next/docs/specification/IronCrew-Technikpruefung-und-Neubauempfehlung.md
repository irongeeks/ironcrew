# IronCrew – Technikprüfung und Neubauempfehlung

Stand: 7. September 2026  
Grundlage: PRD-Entwurf 01, Dokumentversion 0.5  
Geprüfter Repository-Stand: `irongeeks/ironcrew`, Commit `76160c0e56324d1ec16ebf2956cbeadbc544cfc4`, Softwareversion 0.3.1  
Status: Technische Empfehlung zur Entscheidung. Ein Neubau ist ausdrücklich eine akzeptable Option für den Nutzer; seine Umsetzung ist damit noch nicht beschlossen.

## 1. Empfehlung

**IronCrew sollte einen neuen Produkt- und Laufzeitkern erhalten. Bewährte technische Grundlagen aus dem bestehenden Repository sollten gezielt übernommen werden.**

Das Ziel ist die gemeinsam entworfene digitale Firma: ein Chief of Staff als Ansprechpartner, verantwortliche Leads, dauerhafte Mitarbeiter, klar begrenzte Mandate und vier vollständige Arbeitsabläufe. Diese Begriffe sollen Datenmodell, Ausführung und Oberfläche bestimmen.

Der Bestand enthält bereits erhebliche eigene Entwicklungsarbeit. Besonders Worker-Verwaltung, Aufgabenpersistenz, Berechtigungsprüfung, Kostenbuchhaltung und Integrationsclients sind wertvoll. Gleichzeitig sind die heutige Oberfläche und Serverkomposition noch mit der früheren Anwendung verbunden. Die eigene Modelllaufzeit besitzt noch nicht die produktiven Werkzeuge und Wiederaufnahmefunktionen, die das PRD voraussetzt.

| Weg | Vorteil | Hauptnachteil | Bewertung |
| --- | --- | --- | --- |
| Bestehende Anwendung schrittweise umbauen | Vorhandene Funktionen bleiben unmittelbar erreichbar. | Neues Produktmodell müsste über längere Zeit mit alten Arbeitsabläufen und großen zentralen Komponenten zusammenleben. | Möglich, aber für dieses Ziel wenig attraktiv. |
| Neuer Produkt- und Laufzeitkern, gezielte Übernahme | Eigenständige Nutzerführung und klare Ausführung; vorhandenes Wissen und getestete Infrastruktur bleiben nutzbar. | Übernahmegrenzen und Datenmigration müssen ausdrücklich entwickelt werden. | **Empfohlen.** |
| Vollständiger Neubau aller Komponenten | Jede technische Entscheidung wäre frei. | Auch brauchbare Grundlagen und viele bereits geprüfte Fehlerfälle müssten erneut entwickelt werden. | Der zusätzliche Aufwand ist durch die Befunde nicht begründet. |

Für eine belastbare Aufwandszahl fehlen noch kurze technische Machbarkeitsnachweise. Prozentangaben zur Wiederverwendung wären derzeit Spekulation.

## 2. Was geprüft wurde

Die Prüfung umfasst Quellcode und Architektur, vorhandene Tests und CI-Protokolle des genannten Commits sowie ausgewählte offizielle Schnittstellendokumentationen. Es wurden keine produktiven Kundenkonten, Modelle oder externen Schreibfunktionen aufgerufen. Produktcode wurde nicht verändert.

Die CI-Protokolle zeigen 709 bestandene Webtests, 5.365 bestandene API-Tests bei einem übersprungenen Test sowie 135 bestandene Scripttests. Die Browser-Suite meldet 91 bestandene und drei übersprungene Tests. Formatierung, Linting, Typprüfung und Build waren erfolgreich. Die Plattformprüfung war für die vorhandenen Linux-, macOS- und Docker-Jobs erfolgreich. Das ist ein guter Ausgangspunkt. Mehrere zentrale Ablaufprüfungen verwenden ausdrücklich eine MockRuntime und belegen daher keine vollständigen Arbeitsabläufe mit echten externen Konten. [CI des geprüften Commits](https://github.com/irongeeks/ironcrew/actions/runs/34051631598), [Plattformprüfung](https://github.com/irongeeks/ironcrew/actions/runs/34051631564)

Die vollständige Testsuite wurde in dieser Arbeitsumgebung nicht erneut ausgeführt: Hier ist Node 24 vorhanden, während das Repository Node 26 voraussetzt. Die angegebenen Ergebnisse stammen aus den eingesehenen CI-Protokollen, nicht aus einem neuen lokalen Testlauf.

## 3. Architektur: vorhandene Basis und konkrete Lücken

### Oberfläche und Produktstruktur

Die Anwendung enthält eine eigene IronCrew-Oberfläche, führt jedoch weiterhin alte globale Zustände, Navigation und Serverbausteine mit. Mehrere Ansichten münden in dieselbe große CommandCenter-Komponente; diese hat rund 6.600 Zeilen. Das erschwert eine durchgehend neue Nutzerführung.

Das vorhandene Büro besteht wesentlich aus SVG-/DOM-Darstellung und Figurenbildern. Einzelne 3D-Vorschaufunktionen sind vorhanden; das entworfene begehbare beziehungsweise räumlich erlebbare Industriehallen-Hauptquartier ist damit noch nicht umgesetzt. Der aktuelle Einrichtungsassistent deckt ebenfalls nicht das vollständige, gemeinsam entworfene Firmen-Onboarding ab. [Anwendungslayout](https://github.com/irongeeks/ironcrew/blob/76160c0e56324d1ec16ebf2956cbeadbc544cfc4/src/app/AppMainLayout.tsx), [CommandCenter](https://github.com/irongeeks/ironcrew/blob/76160c0e56324d1ec16ebf2956cbeadbc544cfc4/src/ironcrew/CommandCenterView.tsx)

**Folgerung:** Nutzerführung und zentrale Ansichten neu entwickeln: Hauptquartier mit Briefing, Gespräch mit dem Chief of Staff, zusammenhängende Auftragsfläche sowie Ergebnis- und Entscheidungsansichten. Die 3D-Darstellung greift auf dieselben Auftragszustände zu wie die kompakte und mobile Oberfläche.

### Eigene Laufzeit und Werkzeuge

Es existiert bereits eine eigene OpenRouter-Schleife mit Streaming, Werkzeugprüfung, Freigaben und Kostenereignissen. Im produktiven Worker sind gegenwärtig jedoch nur das Auflisten und Lesen von Arbeitsdateien angeschlossen. Der eingebettete Modus ergänzt vor allem interne Lese-, Wissens- und Freigabewerkzeuge. Eine eigene Modellschleife ist somit vorhanden; eine vollständig eigene produktive Ausführung für Websitebau und Systemreparaturen noch nicht. [OpenRouter-Laufzeit](https://github.com/irongeeks/ironcrew/blob/76160c0e56324d1ec16ebf2956cbeadbc544cfc4/server/ironcrew/runtime/openrouter-runtime.ts), [Worker-Werkzeuge](https://github.com/irongeeks/ironcrew/blob/76160c0e56324d1ec16ebf2956cbeadbc544cfc4/server/ironcrew/runner/workspace-tools.ts)

Außerdem hält diese Laufzeit den Modellkontext lokal im laufenden Prozess und meldet `sessionResume: false`. Persistente Aufgaben und Worker-Leases ersetzen keinen dauerhaft gespeicherten Modell- und Werkzeugablauf.

**Folgerung:** Kontrollierte Werkzeuge für Dateiveränderung, Builds, Tests, Vorschauen und Integrationsaktionen ergänzen. Vor jedem externen Eingriff werden Absicht und Aufrufidentität gespeichert, anschließend Ergebnis und nachgewiesene Wirkung. Ein Neustart muss auch den Zustand „Wirkung noch unklar“ behandeln können. Eine Aktion darf nach einem Timeout nicht allein deshalb wiederholt werden, weil ihre Antwort fehlt.

### Domäne, Befugnisse und Lernen

Explizite Werkzeugrechte, standardmäßige Zugriffsverweigerung und an konkrete Argumente gebundene Freigaben sind gute Grundlagen. Die heutige allgemeine Aufgabenstruktur bildet jedoch noch nicht durchgängig den verpflichtenden Lead, Kunden-/Bereichszuordnung und vollständige Mandate ab. Ein optional zugewiesener Bearbeiter erfüllt die dauerhafte Ergebnisverantwortung nicht.

**Folgerung:** Auftrag, Lead, Crewzuordnung, Mandat, Artefaktversion, Abnahme und Wissensänderung als eigene Fachobjekte modellieren. Mandate brauchen erlaubte Ziele und Aktionen, Grenzen, Gültigkeit und eine Version. Fachwissen wird nach Prüfung durch den Lead übernommen; Änderungen an Firmenregeln erhalten die vereinbarte CEO-Entscheidung.

### Kosten und automatische Modellwahl

Das Kostenledger verwendet präzise Ganzzahlbeträge und kann Ausgaben aggregieren. Die aktuelle Prüfung berücksichtigt aber vor allem bereits gemeldete Kosten. Es fehlen Reservierungen für gleichzeitig beginnende kostenpflichtige Aufrufe. Fehlende Kostenangaben werden in der betrachteten Laufzeit als null behandelt. [Budgetlogik](https://github.com/irongeeks/ironcrew/blob/76160c0e56324d1ec16ebf2956cbeadbc544cfc4/server/ironcrew/policy/budget-engine.ts)

**Folgerung:** Einen gemeinsamen Firmentopf führen, vor Aufrufen geschätzte Höchstkosten reservieren, anschließend abrechnen und ungeklärte Kosten sichtbar nachermitteln. Planung, Ausführung, Prüfung und Wiederholungen zählen zum Auftrag. Ein Limit darf nur in dem Umfang als hart bezeichnet werden, in dem Providerkosten und Aufrufgrenzen tatsächlich begrenzbar sind.

Die vorhandene Profilwahl mit Fallbacks ist noch kein aufgabenabhängiger Modellrouter. OpenRouter stellt einen dynamischen Katalog mit Fähigkeiten und Preisdaten bereit. Für den gewünschten vollständigen Katalog muss die Abfrage auch die Modalitäten berücksichtigen; die dokumentierte Standardauswahl beschränkt sich auf Textausgabe. Auswahlregeln und Qualitätsbewertung bleiben IronCrew-Aufgaben. [OpenRouter-Modellkatalog](https://openrouter.ai/docs/api/api-reference/models/get-models)

### Worker, Installation und Wiederherstellung

Versioniertes Worker-Protokoll, Enrollment, Heartbeats, Leases und die Bestätigung von Kostenmeldungen sind gute Übernahmekandidaten. Sie passen zum Ziel VPS plus Tank sowie zum Betrieb auf einem einzelnen Rechner.

Linux-Systemdienste und macOS-Startmechanismen sind vorhanden. Der untersuchte Windows-Installer setzt Node voraus und richtet keinen vollständigen Windows-Systemdienst ein. In der betrachteten Plattform-CI fehlt ein Windows-Job. Der native Betrieb muss deshalb für jede zugesagte Plattform ausdrücklich abgenommen werden.

Das Backup erstellt geprüfte SQLite-Snapshots, Manifeste und Hashes. Das resultierende Archiv ist jedoch gzip-komprimiert und **nicht verschlüsselt**. Auch ein Wiederherstellungsmodus, der automatische Aktionen zunächst anhält und alte Worker-Leases entwertet, gehört zusätzlich entwickelt. [Backup](https://github.com/irongeeks/ironcrew/blob/76160c0e56324d1ec16ebf2956cbeadbc544cfc4/server/ironcrew/backup/backup.ts), [Wiederherstellung](https://github.com/irongeeks/ironcrew/blob/76160c0e56324d1ec16ebf2956cbeadbc544cfc4/server/ironcrew/backup/restore.ts)

## 4. Integrationen: technische Tragfähigkeit

„Dokumentiert möglich“ bedeutet hier: Die öffentliche Schnittstelle unterstützt die benötigte Grundoperation. Kontozugang, Berechtigungen und vollständiger Ablauf sind erst nach einem Verbindungstest bestätigt.

| Integration | Befund | Konsequenz für IronCrew |
| --- | --- | --- |
| sevdesk | Vorhandener Adapter liest Rechnungen und Belege. Die API dokumentiert Belegupload/-speicherung sowie Erstellung und Versand von Erinnerungen. | Schreibabläufe, Regeln und Schutz vor doppeltem Versand ergänzen. |
| sevdesk: Finanzübersicht | Offene Posten und Transaktionen sind zugänglich. `CheckAccount.balance` kann einen gemeldeten Bankstand enthalten; `getBalanceAtDate` summiert bekannte Transaktionen. | Quelle und Aktualität anzeigen; berechnete Transaktionssummen nicht als gesicherten Bankstand ausgeben. |
| sevdesk: Zahlungsvorbereitung | Im geprüften Schema wurde kein Export für SEPA-Zahlungsaufträge gefunden. Eine Zahlungsbuchung ist keine Überweisung. | Banking-Import als eigene Funktion planen und gegen die konkrete Banking-Anwendung prüfen; Freigabe bleibt beim CEO. |

Die sevdesk-Prüfung basiert auf dem offiziellen OpenAPI-Schema, Spezifikationsversion 2.0.0; die produktive Basis verwendet weiterhin `/api/v1`. Tarif, Kontoversion und Datenfrische bleiben beim Verbindungstest zu prüfen. [sevdesk-Schema](https://api.sevdesk.de/openapi.yaml)

| Integration | Befund und erforderliche Arbeit |
| --- | --- |
| Proton Pass | Die bestehende SecretRef- und Redaction-Struktur ist brauchbar. Der pass-cli-Adapter enthält selbst noch Annahmen über das Ausgabeformat. Offizielle Agent-Zugänge haben einen eigenen Sitzungslebenszyklus und verlangen für bestimmte Operationen eine Begründung. CLI-Version, Anmeldung, Erneuerung und Fehlerfälle müssen praktisch geprüft werden. [Agent-Dokumentation](https://protonpass.github.io/pass-cli/commands/agent/) |
| Nextcloud | Der vorhandene Client liest per WebDAV. Die offizielle Schnittstelle unterstützt auch Upload und Dateiverwaltung. Upload, Konflikte, Versionzuordnung und Rückverweise zum Auftrag müssen ergänzt werden. [Nextcloud WebDAV](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/basic.html) |
| Google Drive | Datei-Uploads und Revisionsverwaltung sind dokumentiert. Ein entsprechender Fachadapter wurde im geprüften eigenen Backend-Bereich nicht gefunden. OAuth, Zielordner und die unterschiedliche Behandlung nativer Google-Dokumente und hochgeladener Dateien gehören in den Vertragstest. [Uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [Revisionen](https://developers.google.com/workspace/drive/api/guides/manage-revisions) |
| Git | Vorhandene Repository-/Workspace-Funktionen sind Ausgangspunkte. Der neue Ablauf braucht eine ausdrückliche Zuordnung von Auftrag, Repository, Arbeitsstand und freigegebenem Lieferstand. Die tatsächliche Zuständigkeit von Git, Nextcloud und Drive wird je Artefakt festgelegt. |
| Tactical RMM | Lesen und Remote-Aktionen sind dokumentiert. Payloads hängen von der installierten Version ab; API-Keys übernehmen Benutzerrechte. Vorhandene Instanz integrieren und erlaubte Aktionen gegen deren Swagger prüfen. Die Bereitstellung von Tactical RMM selbst ist eine gesonderte Distributionsfrage. [API](https://docs.tacticalrmm.com/functions/api/), [Lizenz des Anbieters](https://docs.tacticalrmm.com/license/) |
| Proxmox | Tokenbasierte REST-Zugriffe mit einschränkbaren Rechten sind dokumentiert. Der aktuelle API-Viewer war bei dieser Prüfung nicht zugänglich; konkrete Reparaturaktionen und Privilegien müssen am Zielcluster verifiziert werden. [API](https://pve.proxmox.com/wiki/Proxmox_VE_API), [Berechtigungen](https://pve.proxmox.com/pve-docs/pveum-plain.html) |
| Microsoft 365 | Mail und Administration benötigen getrennte Rechteprofile. Graph dokumentiert Postfachzugriff, Versand, Benutzer-, Lizenz- und Dienstzustandsoperationen. Eine angenommene Mail ist noch kein Zustellnachweis. Breite Entra-Rechte werden durch zusätzliche Exchange-RBAC-Regeln nicht automatisch eingeschränkt. [Graph-Authentifizierung](https://learn.microsoft.com/en-us/graph/auth-v2-service), [Mailversand](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), [Exchange RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) |

Website, Discord, Telegram und E-Mail bleiben die gewählten Kommunikationskanäle. Ein vollständiger Praxistest ihrer Identitätsbindung, Wiederholungsbehandlung und Freigabeantworten war nicht Gegenstand dieser Schnittstellenprüfung und ist Teil der späteren Abnahme.

## 5. Vorgeschlagene Zielarchitektur

Ein modularer zentraler Dienst mit verteilten Ausführungsrechnern passt zum gewünschten Betrieb. Separate Microservices sind durch den bisherigen Bedarf nicht begründet. TypeScript, React und Vite können weiterverwendet werden; die notwendige Erneuerung betrifft vor allem Produktstruktur und Ausführung.

| Modul | Verantwortung |
| --- | --- |
| Firma und Aufträge | Mitarbeiter, Chief of Staff, Leads, Bereiche, Kunden, Aufträge und Crewzuordnung. |
| Ausführung | Dauerhafter Modellkontext, einzelne Arbeitsschritte, Werkzeugaufrufe, Pausen und Wiederaufnahme. |
| Befugnisse und Kosten | Mandate, konkrete Freigaben, technische Rechteprüfung, Reservierungen und Abrechnung. |
| Wissen | Quellen, Geltungsbereich, Vorschläge, Lead-Prüfung und nachvollziehbare Änderungen. |
| Integrationen und Artefakte | Externe Clients, Arbeitsdateien, Versionsbezug, Zielsysteme und Wirkungsnachweise. |
| Betrieb | Worker, Secrets, native Dienste, Updates, verschlüsselte Sicherung und Wiederherstellung. |
| Oberfläche und Kanäle | Hauptquartier, kompakte Arbeitsfläche, Vorschauen und dieselbe Auftragslogik in allen Kanälen. |

SQLite ist für eine einzelne zentrale Instanz weiterhin ein prüfbarer Ausgangspunkt. Ob ein anderer Datenbankdienst nötig wird, sollte aus den Anforderungen an Parallelität und Wiederherstellung folgen. Eine Datenbankmigration allein schafft noch keine belastbare Agentenlaufzeit.

Native Installation und kontrollierte Ausführung sind getrennte Aufgaben. Generierter Code erhält einen abgegrenzten Arbeitsbereich und keine geerbten Betriebszugänge. Welche Isolation der jeweilige Worker dafür bereitstellt, wird plattformbezogen festgelegt. Docker ist damit keine Pflicht für die Installation von IronCrew.

## 6. Übernahmegrenzen

| Kategorie | Kandidaten |
| --- | --- |
| Gezielt übernehmen und erneut prüfen | SecretRef/Redaction, Aufgaben-Claims und Leases, Auditmechanismen, Kostenledger, Bindung von Freigaben an Argumente, Worker-Enrollment, HTTP-Clients, Testfixtures und Fehlerfalltests. |
| Mit neuem Vertrag überarbeiten | OpenRouter-Transport, Worker-Protokoll, Datenstores, Proton-pass-Adapter, Modellrouting, Backup und Restore. |
| Neu entwickeln | Produktnavigation und Hauptquartier, Auftrags-/Mandatsmodell, dauerhafte eigene Ausführung, Wirkungsjournal, Kostenreservierungen, Artefaktabnahme und die vier vollständigen Fachabläufe. |
| Aus dem neuen Kern herauslösen | Alte Workflow-Komposition, Abhängigkeit von CLI-Harnesses als eigentlicher Ausführungsbasis und der bisherige CompanyOrchestrator als universeller Dienst. |

Die Übernahme erfolgt modulweise mit zugehörigen Tests und dokumentierter Herkunft. Vorhandene Lizenz- und Urhebervermerke bleiben entsprechend der übernommenen Bestandteile erhalten; diese Prüfung ist keine vollständige Herkunfts- oder Lizenzprüfung.

## 7. Lieferetappen und überprüfbare Ergebnisse

Die Etappen ordnen die Umsetzung. **Alle vier gewählten Startabläufe bleiben Bestandteil der ersten nutzbaren Version.**

1. **Kernverträge und technische Nachweise.** Ein Auftrag mit genau einem Lead; eigenes Modell führt eine erlaubte Dateiänderung aus; Freigabe, Neustart und Wiederaufnahme funktionieren. Parallelität am Kostenlimit sowie ein Timeout nach möglicher externer Wirkung werden gezielt geprüft. pass-cli wird mit einer festgelegten Version praktisch validiert.
2. **Erster vollständiger Arbeitsweg.** Auftrag an den Chief of Staff → Plan → Ausführung → Prüfung → tatsächliches Artefakt → Ablage mit Rückverweis. Dazu eine erste eigene Arbeitsoberfläche und ein früher visueller Entwurf des Hauptquartiers. Dieser Nachweis verwendet reale Werkzeuge, nicht ausschließlich simulierte Antworten.
3. **Die vier Fachabläufe.** Website inklusive Varianten, Feedback und Abnahme; IT-Störung mit Reparaturprüfung und Beobachtung; sevdesk-Verarbeitung mit bestätigten Regeln und Zahlungsvorbereitung; Recherche mit Quellen und versioniertem Ergebnis. Kundenkommunikation und Zahlungserinnerungen folgen ihren jeweils bereits gewählten unterschiedlichen Freigaberegeln.
4. **Kanäle und laufender Betrieb.** Website, Discord, Telegram und E-Mail; mehrere native Worker; automatische Routinen; geeignete Verbindungstests pro Zielsystem. Windows-Dienstbetrieb und Wiederanlauf werden auf Windows geprüft.
5. **Abnahme und Übergang.** Verschlüsselte Sicherung auf einer frischen Installation wiederherstellen, automatische Aktionen kontrolliert freischalten, Update im Wartungsfenster testen und die vier Abläufe anhand des PRD abnehmen. Erst danach wird der neue Stand zum regulären System.

Für externe Aktionen umfasst die Abnahme mindestens: erlaubter Zugriff, verweigerter Zugriff, Rate Limit, verlorene Antwort nach möglicher Wirkung und sichere Fortsetzung. Ein grüner allgemeiner Testlauf ersetzt diese gezielten Nachweise nicht.

## 8. Übergang und noch offene Entscheidungen

Der neue Kern sollte zunächst getrennt vom laufenden Stand im selben Repository entstehen. Der bestehende Stand bleibt nachvollziehbar erhalten. Es braucht einen ausdrücklichen Importweg für relevante Mitarbeiter-, Auftrags-, Wissens- und Konfigurationsdaten; zwei gleichzeitig aktive Routinen gegen dieselben externen Systeme werden vermieden.

Für den Beginn der Umsetzung ist als nächster Produktentscheid die empfohlene Richtung zu wählen: **neuer Kern und eigene Oberfläche mit selektiver Übernahme**. Danach können die technischen Nachweise aus Etappe 1 in konkrete Umsetzungstickets überführt werden.

Später benötigte Betriebsangaben sind insbesondere die tatsächlichen Zielsystemversionen und Kontoberechtigungen, die Banking-Anwendung samt Importformat, die Worker-Plattformen sowie Sicherungsziel und Wiederherstellungsschlüssel. Diese Angaben verhindern die Architekturentscheidung nicht und müssen jetzt nicht als langer Fragenkatalog beantwortet werden.

Der bestehende PRD-Entwurf bleibt die Produktgrundlage. Dieses Dokument ergänzt ihn um Befunde und eine vorgeschlagene technische Richtung; unbestätigte Architekturdetails werden dadurch nicht zu bereits beschlossenen Produktentscheidungen.
