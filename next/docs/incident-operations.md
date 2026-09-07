# Störungsbetrieb: Reparatur, Beobachtung und Kundenmail

`IncidentService` verbindet die vorhandene fachliche Störungschronik mit administrativ konfigurierten `serviceTargets`, einem unabhängigen HTTP-Prüfziel und TLS-Mailkonten. Neustart, Funktionsnachweis, Beobachtung und Kundennachricht sind getrennte Schritte; eine Brokerannahme bestätigt keine Wiederherstellung.

## Konfiguration und API

Ein CEO hinterlegt mit `POST /api/v1/incident/health-profiles` ein persistentes Prüfprofil für einen bereits im gleichen Scope konfigurierten Dienst. Pflichtfelder: `targetId`, `scope`, `url`, `contains`, `observationSeconds`, `checkIntervalSeconds`, `maxCheckGapSeconds`. Optional: `expectedStatus` (200), `timeoutMs` (5000) und `trustedCaPem` für eine private CA. Das zulässige Prüfintervall ist höchstens die tolerierte Lücke; die Lücke muss kürzer als das Beobachtungsfenster sein. URLs sind ausschließlich administrative HTTP(S)-Ziele ohne eingebettete Zugangsdaten, Query oder Fragment. Modelldaten können keine freien Prüfziele erzeugen. HTTPS prüft Zertifikatskette und Hostname; explizit konfigurierte HTTP-Ziele bestätigen keine TLS-Eigenschaft. Weiterleitungen werden nicht verfolgt.

Ändern: `PUT /api/v1/incident/health-profiles/:targetId` mit `If-Match` und vollständigem Profil. Profilkonfiguration verlangt CEO, CSRF und Idempotenz. `GET /api/v1/incident/health-profiles` liefert die unternehmensweite CEO-Liste; das Modellwerkzeug `incident.health_profiles` liefert ausschließlich den aktuellen Scope.

`GET /api/v1/orders/:id/incident/status` liefert Chronik, aktiven oder abgeschlossenen Beobachtungsauftrag, Prüfprofil mit Revision, scoped Dienst- und Mailziele mit serverseitigem Konfigurationshash sowie persistierte Aktionen. Damit können Clients Freigaben und Wiederholungen nach einem Neuladen exakt rekonstruieren. Die Liste enthält auch abgeschlossene Aktionen als Verlauf.

Alle drei Aktionsrouten verlangen `actionId`, `mandateId`, `mandateVersion`:

- `POST .../incident/repair`: zusätzlich `targetId` und `targetConfigSha256` des Dienstziels. `incident.repair` benötigt eine konkrete CEO-Freigabe. Ein begrenzter nativer Broker führt nur den typisierten Neustart gegen genau dieses konfigurierte Ziel aus; freie Shellparameter sind nicht zulässig. Zielkonfiguration, Auftrag und Mandat werden vor dem Prozessstart erneut geprüft. Ein neuer Reparaturversuch stoppt ein laufendes Beobachtungsfenster.
- `POST .../incident/check`: zusätzlich `targetId` und `healthProfileSha256`. Das Lesemandat `incident.check` muss Ziel, komplette Beobachtungsdauer und Ablauf abdecken. Der erste tatsächliche HTTP-Nachweis startet das persistente Fenster nur bei passendem Status und Inhalt. Ein gescheiterter Prüfvorgang bleibt in der Untersuchung.
- `POST .../incident/customer-message`: zusätzlich Mail-`targetId`, `targetConfigSha256`, `to`, `subject`, `content`, `incidentState`. Das Mandat für `incident.customer_message` muss das Mailziel einschließen. Die konkrete Freigabe bindet Mailkonfiguration und Absender, Empfänger, Betreff, Nachricht und Störungszustand. Der tatsächliche Versand prüft Zustand und Autorisierung erneut nach asynchroner Secret- und CA-Auflösung. SMTP-Annahme wird als `accepted`, niemals als bestätigte Zustellung ausgewiesen.

Die gleichnamigen Runtimewerkzeuge (`incident.repair`, `incident.check`, `incident.customer_message`) nehmen nur die fachlichen Parameter. Aktion, Auftrag und Mandat stammen vom bereits gespeicherten Runtimeauftrag. Ein Autorisierungsadapter vermeidet verschachtelte Journale und prüft dessen Status, Ziel, Werkzeug, Scope und Parameterhash erneut.

## Beobachtung und Betrieb

`IncidentService.tick(companyScope)` prüft fällige persistente Beobachtungen aller Scopes des Unternehmens; Root bindet den Aufruf an die gemeinsame Hintergrundbarriere. Die Zentrale wacht dafür sekündlich auf; Profile bestimmen die tatsächliche Prüffrequenz. Neustart und Backup-Pause führen nicht zu einer erfundenen lückenlosen Beobachtung.

Jede Probe wird als mandatierte Aktion journalisiert. HTTP-Antworten sind auf 1 MiB und die konfigurierte Zeit begrenzt. Chronikevidenz enthält Zeitpunkt, tatsächlichen Status, Body-SHA-256, Bytezahl, URL und Prüfarten; der vollständige Antwortinhalt wird nicht in die Chronik kopiert. Profil und Mandat werden auch nach dem Netzaufruf nochmals geprüft.

Erst eine erfolgreiche Probe am Ende des gesamten Fensters setzt die Störung auf `resolved`. Ein Rückfall setzt sie zurück auf `investigating` und stoppt die Routine. Mandatswiderruf, Profiländerung, pausierter Auftrag oder eine zu große Lücke blockieren die Beobachtung. Auch eine langsam eintreffende positive Antwort darf eine Lücke zwischen tatsächlichen Nachweisen nicht verdecken. Ein neuer Reparatur- und Prüfschritt braucht die weiterhin gültigen beziehungsweise neu erteilten Mandate; die Routine verlängert diese nicht selbst.

Beobachtete Wiederherstellung bestätigt keine technische Ursache. `unknown`, `suspected` und `confirmed` bleiben in der Ursachenchronik getrennt erhalten. Kundennachrichten erfolgen ausschließlich nach konkreter Freigabe, nicht als automatische Folge einer gesunden Probe.

## Ausgeführte Tests

`tests/integration/incident-control.test.ts` startet einen wirklichen ausführbaren Dienstbroker-Fixtureprozess, der ausschließlich die erwarteten typisierten Neustartargumente akzeptiert. Ein getrennter HTTP-Server liefert den tatsächlichen Zustand dieser Fixture. Eine steuerbare Uhr prüft das komplette Fenster, Rückfall, Lücke, langsame Antworten, Mandatswiderruf, Profiländerung und erneute Reparatur. Weitere Tests prüfen den gespeicherten Runtimeauftrag und senden freigegebene Nachrichten an eine echte lokale TLS-SMTP-Senke. Eine Zustandsänderung während der Secret-Auflösung verhindert nachweislich den Versand. Es werden keine produktiven Dienste verändert und keine externen E-Mails verschickt.
