# Technischer Bauplan

## A. Verbindliche Ausgangsentscheidungen

Diese Festlegungen konkretisieren den autorisierten Bauplan. Änderungen sind mit Grund, Alternative, Produktwirkung und Nachweis in `docs/adr/` zu dokumentieren. Produktumfang, eigene Laufzeit, Charaktere, unterstützte Plattformfamilien oder native Installation werden dadurch nicht stillschweigend geändert.

| Bereich | Festlegung | Grund |
| --- | --- | --- |
| Sprache | TypeScript, strikter Modus, ESM | Gemeinsame Verträge für Web, API und Worker. |
| Laufzeit | Node.js 26.x, exakte getestete Patchversion je Release; pnpm 10.30.1 als Ausgangspunkt | Bestehender expliziter Node-26-Wunsch und Repositorybasis. Kein unbeschränktes `>=26` in Installern. |
| UI | React 19, Vite 8, CSS-Variablen und CSS Modules | Übernahme des etablierten Ökosystems bei neuer Oberfläche. |
| 3D | Three.js mit React Three Fiber 9, glTF/GLB-Assets; optional nötige kleine Hilfspakete | Deklarative Einbindung der räumlichen Ansicht. |
| Server | Express 5, Zod 4, REST unter `/api/v1`, OpenAPI 3.1 | Kleine, überprüfbare Oberfläche; Schemas als Laufzeitgrenze. |
| Daten | SQLite auf lokaler Platte; SQL-Migrationen, WAL, Foreign Keys, dedizierter DB-Worker-Thread | Ein zentraler Dienst, keine Pflicht zu weiterem Datenbankbetrieb. |
| DB-Zugriff | `node:sqlite` hinter Repository-Schnittstelle | Vorhandene Basis; isolierter Versionsvertrag und keine synchrone DB-Arbeit im HTTP-Thread. |
| Live-UI | SSE mit persistenter Ereignisfolge | Einfacher Wiederanschluss und klarer Datenfluss. |
| Worker | Ausgehendes authentifiziertes WSS, Protokollversion 1 | Native Rechner hinter NAT müssen keine eingehenden Ports öffnen. |
| Modelle | Eigener OpenRouter-Client und persistenter Toolloop | Kein CLI-Harness als eigentlicher Agentenmotor. |
| Tests | Vitest, Testing Library, Playwright; echter SQLite-Dateispeicher für Wiederanlauftests | Vorhandene Erfahrung nutzen, kritische Wirkungen wirklich prüfen. |
| Sicherung | Konsistenter Snapshot, etablierter Tar-Writer, age-Verschlüsselung | Keine eigene Kryptographie oder selbstgeschriebener Archivparser. |

Exakte Paketversionen werden in AP-00 anhand aktueller offizieller Releases, Peer-Dependencies und Installtests festgesetzt und im Lockfile festgehalten. Der Bestands-Lockfile ist Startreferenz, kein Grund für pauschale Abhängigkeitsübernahme. Node 26 ist zum Prüfdatum noch Current, nicht LTS. Dieser Status wird im Releasebericht angegeben; die Node-Projektseite empfiehlt LTS für Produktion. `node:sqlite` ist als Release Candidate dokumentiert. Deshalb sind Patch-Pinning, Backup-/Migrationstests und eine isolierte DB-Schnittstelle Pflicht. [Node-Releases](https://nodejs.org/en/about/previous-releases), [SQLite-API](https://nodejs.org/api/sqlite.html)

React Three Fiber koppelt seine Hauptversion an React; vor Festschreibung der konkreten Version wird die Peer-Kompatibilität geprüft. [Projekt](https://github.com/pmndrs/react-three-fiber)

## B. Struktur und Übernahme

Entwicklung in einem isolierten Arbeitszweig `rebuild/ironcrew`, zunächst im Unterordner `next/` des bestehenden Repositories. Existiert der Zweig bereits, Zustand prüfen und weiterverwenden. Root bleibt als Referenz nutzbar. Eigener Workspace und Lockfile in `next/`; Root-Scripte erst bei geplantem Übergang ändern. Keine Git-Historie umschreiben.

| Zielpfad unter `next/` | Verantwortung |
| --- | --- |
| `apps/web` | Navigation, Auftrag, Onboarding, HQ; keine Secrets. |
| `apps/control` | HTTP, Auth, SSE, Scheduler, Ausführung koordinieren. |
| `apps/worker` | Enrollment, Ressourcen, begrenzte Toolausführung. |
| `apps/cli` | Setup, Diagnose, Backup/Restore, Dienstverwaltung. |
| `packages/contracts` | Zod-Schemas, Typen, OpenAPI, Wire-Protokoll. |
| `packages/domain` | Firma, Leads, Mandate, Wissen, Auftragszustände. |
| `packages/persistence` | SQL-Migrationen, Transaktionen und Repositories. |
| `packages/runtime` | OpenRouter, Modellkontext, Routing, Ausführungsjournal. |
| `packages/tools` | Werkzeugregistry, Rechteprüfung, Sandboxprofile. |
| `packages/integrations` | API-Clients und normalisierte Fachaktionen. |
| `packages/ui` | Tokens, Komponenten, lokale DE-/EN-Texte. |
| `packages/operations` | Installer, Updates, Verschlüsselung, Recovery. |
| `tests/contracts`, `tests/e2e`, `docs/adr` | Grenzen, vollständige Abläufe und Entscheidungen. |

Module verwenden definierte Dienste/Repositories, keine SQL-Zugriffe quer durch die Anwendung. Kreise zwischen Domain, Runtime und Integrationen sind zu vermeiden: Domain kennt Ports, Adapter implementieren sie. Keine neue universelle Company-Klasse.

Übernahmekandidaten aus `server/ironcrew`: Redaction und SecretRef, CAS/Lease-Logik, Approval-Bindung, Kostenledger, Worker-Enrollment, HTTP-Clients und geeignete Negativtests. Jeder übernommene Teil erhält Herkunftspfad, Referenzcommit, zugehörige Tests, Änderungen und Lizenzhinweise in `docs/reuse-register.md`. Alte UI-Komposition, CLI-zentrierte Laufzeit und Altdatenmigration werden nicht übernommen. Beispieldaten sind als Fixtures zu kennzeichnen. Reale Logos aus diesem Paket ersetzen das alte Oktopuszeichen.

## C. Datenmodell und Invarianten

IDs sind UUIDs. Zeiten werden UTC gespeichert; Anzeige/Scheduling verwenden eine IANA-Zeitzone. Zeilen mit Konkurrenzzugriff erhalten monotone `revision`. Jede Geschäftstabelle trägt `company_id`; sensible Inhalte zusätzlich `area_id` und gegebenenfalls `customer_id`/`project_id`. Referenzen müssen zum gleichen erlaubten Kontext gehören.

| Aggregate / Tabellen | Wesentliche Felder und Regeln |
| --- | --- |
| Company, CeoIdentity, SetupProgress | Eine aktive Firma, ein menschlicher CEO; Onboardingversion und letzter abgeschlossener Schritt. |
| Area, Customer, Project | Explizite Kontextgrenzen; Privatdaten werden nicht allein durch gemeinsame Firma freigegeben. |
| Employee, PersonaVersion, RoleGrant | Stabile Mitarbeiter-ID; veränderliche Persona, Modellprofil und Rang getrennt von Rechten. |
| Order | Ziel, Typ, Scope, `lead_employee_id NOT NULL`, Planversion, Abnahmekriterien, Kostenrahmen, Status und Wartegrund. Schon neue Eingänge erhalten Cersei als vorläufigen Lead. |
| Task, Assignment, Review | Teilaufgaben und Bearbeiter; Review-Ergebnisse, Prüfkriterien, konkrete Artefaktversion. Leadwechsel atomar und protokolliert. |
| MandateVersion, Approval | Zielsysteme, erlaubte Aktionen/Parameter, Zeit-/Kosten-/Versuchsgrenzen, Ablauf und Widerruf; Entscheidungen an Versions-/Argumenthash gebunden. |
| Run, ModelTurn, ToolAction | Persistente Modellnachrichten, Toolaufruf-ID, Intent, Ergebnis, externe ID, Wirkungszustand und Recovery-Daten. |
| Worker, Lease, Enrollment | Geräteidentität, Capability-Liste, Credential-Hash, Generation, Ablauf und Ressourcenlimit. |
| Artifact, ArtifactVersion, ExternalReference | Immutable Version, Hash, MIME, Größe, lokaler Blob, maßgebliches Zielsystem, externe Version/ETag und Übergabestatus. |
| KnowledgeEntry, KnowledgeRevision | Quelle, Kontext, Status vorgeschlagen/geprüft/aktiv/verworfen, Reviewer und Vorgänger. Firmenregeln nur CEO. |
| BudgetPeriod, Reservation, Usage | Gemeinsamer Firmentopf; Auftragslimits schränken zusätzlich ein. Reserviert/abgerechnet/ungeklärt separat. |
| Trigger, InboxEvent, OutboxMessage | Eindeutiger Provider-Ereignisschlüssel, Zuordnung, Wiederholungsstatus und Versandnachweise. |
| DomainEvent, AuditEvent | Ereignisfolge und Redaction; Audit mit Hashverkettung und optional extern gesichertem Prüfanker. Hashverkettung allein verhindert kein Umschreiben durch einen kompromittierten Host. |

`UNIQUE(provider, account_id, external_event_id)` verhindert wiederholte Verarbeitung eines identischen Eingangs. Semantisch gleiche Nachrichten auf anderen Kanälen werden als mögliche Dublette behandelt; keine unsichere automatische Zusammenlegung allein anhand gleicher Texte.

Zustandsänderung, Audit und Outbox-Ereignis werden in einer SQLite-Transaktion gespeichert. Keine Netzwerkanfrage in offener DB-Transaktion. Nur die Zentrale schreibt die Firmendatenbank; niemals SQLite-Datei über SMB/NFS zwischen Rechnern teilen. Anhänge liegen content-addressiert auf lokaler Platte, DB enthält Hashes und Zuordnung. Großdateien werden gestreamt.

## D. Zustände und Fortsetzung

Auftrag: `inbox → planning → ready → running → reviewing → completed`. Bekanntes Routinevorgehen darf mit dokumentiertem Plan direkt `inbox → ready`. Review mit Mängeln führt zu `running`. Aus jedem nichtterminalen Zustand sind `paused`, `blocked` und `cancelled` möglich; Wiederaufnahme kehrt zum gespeicherten sinnvollen Zustand zurück. `failed` bedeutet ausgeschöpfte Fehlerbehandlung, `completed` verlangt bestandene Pflichtprüfungen und erforderliche Ergebnisübergabe. Nachträgliche Änderung erzeugt neue Plan-/Artefaktversion und eröffnet relevante Prüfungen erneut.

Wartegrund separat: `approval`, `budget`, `external`, `worker`, `tool_error`, `unknown_effect`, `user_input`. Das UI zeigt verständliche deutsche/englische Texte.

Werkzeugaktion: `proposed → authorized → dispatched → running → succeeded|failed|effect_unknown`. Ablehnung führt zu `denied`; Ablauf vor Versand zu `expired`. Ein lokaler Timeout nach Versand führt bei möglicher Wirkung zu `effect_unknown`, nicht zu einem automatischen neuen Versuch.

Ablauf pro Modellschritt:

1. Aktuellen Auftrag, Kontext, Mandat und verfügbares Budget laden; passenden Modellkandidaten auswählen.
2. Modellrequest mit Nachrichtenstand, Konfigurationshash, Preisstand und Kostenreservierung persistieren, danach senden.
3. Gestreamte Ausgabe zunächst puffern. Nur vollständig erhaltene und gegen Schema validierte Toolargumente können eine Aktion erzeugen.
4. Toolabsicht, Argumenthash und eindeutige Action-ID speichern. Technische Rechte, Mandat, Ablauf und nötige konkrete Freigabe prüfen.
5. Worker übernimmt genau diese Action-ID unter Lease. Vor externem Aufruf speichert er einen lokalen Ausführungsbeleg; Ergebnis meldet er mit Sequenz und Hash.
6. Zentrale speichert Ergebnis und bestätigt. Worker bewahrt nicht bestätigte Ergebnisse und sendet sie nach Verbindungsrückkehr erneut. Doppelte Nachrichten bewirken keine doppelte Ergebnisbuchung.
7. Ergebnis als Toolnachricht persistieren, Kosten abgleichen und mit dem nächsten Modellschritt fortsetzen.

Worker-Abbruch nach externer Wirkung, aber vor Ergebnisbeleg bleibt grundsätzlich möglich. Wiederanlauf verwendet providerspezifische Status-/Objektabfrage. Bei fehlender eindeutiger Erkennung bleibt die Aktion blockiert. Kein globales Exactly-once-Versprechen. Ein Modellabbruch vor vollständigem Toolaufruf darf keine Werkzeugaktion auslösen; ein erneuter Modellrequest kann erneut Kosten verursachen und wird so gebucht.

Freigabewarten erhält den gesamten Kontext. Eine Freigabe gilt für Firma, Auftrag, Mandatsversion, Zielressource, Aktion, Argumenthash und gegebenenfalls Artefaktversion. Vor Dispatch werden diese Werte erneut geprüft. Ein Widerruf stoppt neue Schritte; bereits ausgeführte Wirkungen benötigen eine eigene Rücknahmeaktion.

## E. Budget und Modellrouter

Abrechnung intern in USD-Micros als Integer, da OpenRouterpreise in USD vorliegen; UI zusätzlich EUR mit gespeichertem Umrechnungskurs, Quelle und Zeitstand. Bei EUR-Limit wird der USD-Gegenwert bei Periodenbeginn fixiert; spätere Kursänderungen verändern das genehmigte Limit nicht unsichtbar. Ohne gesetzten Kurs wird USD transparent angezeigt. Kein ausgedachter Live-Kurs.

Transaktionale Prüfung: `gebucht + reserviert + neue_Reservierung <= Firmenlimit` und zusätzlich Auftragslimit. Keine Abteilungsbudgets. Reservierung beruht auf Inputumfang, maximalen Outputtokens und allen bekannten Aufrufkosten. Unbekannte Preisstruktur blockiert automatische Auswahl für kostenpflichtige Ausführung. Fehlende Usage wird als `unreconciled` behandelt; Reservierung bleibt bis zur Klärung bestehen. Providerreconciliation ist selbst idempotent. Bereits angefallene Mehrkosten werden ausgewiesen und sperren weitere Aufrufe bei Limitüberschreitung.

Katalog vollständig und ohne Anbieter-Whitelist anzeigen; auch für die aktuelle Aufgabe ungeeignete Modelle bleiben mit Begründung sichtbar. `output_modalities=all` bzw. den dann dokumentierten vollständigen Abruf nutzen. Katalog regelmäßig, zunächst alle 15 Minuten, und manuell aktualisieren; Fehler zeigt letzten erfolgreichen Stand. Routbarkeit und Katalogsichtbarkeit sind getrennt. [OpenRouter-Katalog](https://openrouter.ai/docs/api/api-reference/models/get-models)

Automatische Auswahl: zuerst Fähigkeiten, Kontextgröße, erlaubte Datenweitergabe, Verfügbarkeit und Budget; danach aufgabenspezifische Bewertung. Startheuristik unter passenden Modellen: 50 % geprüfte Qualität, 30 % geschätzte Kosten, 20 % gemessene Latenz, jeweils normalisiert und erklärbar. Fehlende Qualitätsdaten neutral markieren; neue Modelle erhalten nur innerhalb genehmigter Testlimits Vergleichsaufträge. Override ist möglich, technische Unfähigkeit wird klar gemeldet. Modellrang und Mitarbeiterpersona bleiben unabhängig.

Bewertungen speichern 1–5 Sterne plus Korrektheit, Vollständigkeit, Nutzbarkeit und Befugnis-Einhaltung, Reviewer, Schwierigkeit und Artefaktversion. Menschliche und Agentenbewertungen getrennt. Rollierende Auswertung je Aufgabentyp; Stichprobengröße anzeigen. Rang junior/senior/lead ist konfigurierbar und ändert keine Rechte automatisch.

## F. Kommunikation und API

Cookiebasierte CEO-Sitzung, HttpOnly/SameSite, CSRF-Prüfung bei Änderungen, verschlüsselte Verbindung bei externem Zugriff. Ersteinrichtung über kurzlebiges einmaliges Setup-Token aus lokalem Installer; kein öffentlich ungeschützter Erstbenutzer-Endpunkt. Lokales Passwort als Basis mit Argon2id-Hash, Rate Limit und Recovery-Verfahren; Implementierung durch geprüfte Bibliothek, kein eigener Hashalgorithmus.

| REST-Gruppe | Pflichtoperationen |
| --- | --- |
| `/setup`, `/session` | Einrichtung lesen/fortsetzen/abschließen, anmelden/abmelden. |
| `/company`, `/employees`, `/areas`, `/projects` | Firma, Crew und Kontext verwalten. |
| `/orders` | Anlegen, lesen, filtern, Lead ändern, planen, pausieren, fortsetzen, abbrechen. |
| `/orders/:id/messages`, `/artifacts`, `/reviews` | Gespräch, versionierte Ergebnisse, Feedback und Prüfung. |
| `/mandates`, `/approvals` | Versionen, Widerruf, konkrete Entscheidung. |
| `/models`, `/budget` | Katalog, Auswahlbegründung, Kosten und Reservierungen. |
| `/workers`, `/integrations`, `/schedules`, `/backups` | Konfiguration und beobachtbarer Betrieb. |
| `/events` | SSE ab `Last-Event-ID`; veralteter Cursor erzwingt erneuten Snapshot. |

Schreibrequests verwenden `Idempotency-Key`, versionierte Ressourcen `If-Match`. Gleicher Schlüssel und gleiche Anfrage liefern dasselbe Ergebnis; gleicher Schlüssel mit anderem Body ergibt 409. Alle Listen sind cursorpaginiert. Fehlervertrag: code, messageKey, requestId, retryable, optional actionId; niemals Secret oder rohe Providerantwort ungefiltert ausgeben. Schemas/OpenAPI werden gemeinsam erzeugt und im CI auf Abweichung geprüft. Vollständige Ressourcenfelder werden paketweise vor der Implementierung der jeweiligen Route ergänzt.

## G. API-Sicherheitsdetails und Schedulerdefaults

Session-Recovery ist lokal administrativ, mit Entwertung aller alten Sitzungen; kein Defaultpasswort. Freigaben werden serverseitig ausgeführt. Beim Öffnen einer generierten Site erhält deren Vorschau einen getrennten Ursprung und restriktive Sandbox; sie kann weder CEO-Cookies noch den internen API-Ursprung verwenden. Uploads erhalten MIME-/Größenprüfung, heruntergeladene Dateien werden nicht als ausführbare Inhalte im Hauptursprung serviert.

Scheduler speichert nächstes UTC-Fälligkeitsdatum plus IANA-Zeitzone und Regelversion. Default nach Ausfall höchstens ein zusammengefasster Nachholauftrag je Routine; überlappende Läufe werden nicht parallel gestartet. Bei DST-Doppeluhrzeit je planmäßigem Ereignis nur ein Lauf, bei übersprungener Uhrzeit nächster gültiger Zeitpunkt. Diese Regeln stehen neben der bearbeitbaren Routine. Goal-Mandate begrenzen zusätzlich Zahl gleichzeitig erzeugter Folgeaufträge, zunächst drei.
