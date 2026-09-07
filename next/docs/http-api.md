# HTTP-Verträge

Die maschinenlesbare Spezifikation liegt in [openapi.json](openapi.json). Der Generator ordnet jede ausdrücklich registrierte Express-Methode einem Vertrag zu. Ein neuer oder entfernter Pfad ohne passende Vertragsänderung lässt Generierung und Test fehlschlagen. Der aktuelle Stand umfasst 161 Operationen; automatisch von Express beantwortete HEAD/OPTIONS-Anfragen sind keine zusätzlichen Fachoperationen.

```sh
node scripts/openapi.ts
node scripts/openapi.ts --check
node node_modules/vitest/vitest.mjs run tests/contracts/http-api.test.ts
```

Die Quelle steht in `apps/control/api-contracts/`: `registry.ts` hält Methode, Pfad, Runtime-Datei, Eingabe, Antwort, Revision, Authentifizierung und Medienart; die übrigen Module definieren die tatsächlich übertragenen Ressourcen. Vorhandene Zod-Schemas werden unter anderem für Konfiguration, Scope, Mandate, Modelle, Belege, Rechercheberichte, Wissen, Watches, Hosting, Störungsprofile und Updater-Ergebnisse importiert. Die wenigen inline in Routen definierten Eingaben sind hier ausdrücklich als Wire-Verträge abgebildet. Eine Änderung dieser Routen muss deshalb den HTTP-Vertragstest mit ausführen.

Zod-Refinements wie zusammengehörige Beobachtungsintervalle, Quellen-Eindeutigkeit und absolute Pfade sowie Zustandsregeln wie Scope, Mandat, Budget, CAS, Abnahme und Hashprüfung können nicht vollständig in JSON Schema ausgedrückt werden. Die API führt sie weiterhin serverseitig aus. Rekursive JSON-Verweise werden für ihre Position in OpenAPI umgeschrieben und auf Auflösbarkeit geprüft.

## Sitzung, Header und Fehler

- Geschützte Routen verwenden das HttpOnly-Cookie `ironcrew_session` mit SameSite=Strict; HTTPS setzt zusätzlich Secure. Schreibzugriffe verlangen `X-CSRF-Token`; ein angegebener Origin muss `publicOrigin` entsprechen.
- Fachmutationen verlangen `Idempotency-Key` (1–200 Zeichen). Methode, vollständiger Pfad, JSON-Body und If-Match werden gebunden. Ein identischer abgeschlossener Request erhält das gespeicherte Ergebnis; geänderte Bindung oder unklarer laufender Effekt erzeugt einen Konflikt. Enrollment und Rotation geben Zugangsdaten nur einmal aus; Wiederholung liefert 410.
- `If-Match` ist nur dort erforderlich, wo die Operation es deklariert. Company/Profile/Plan/Lead/Transition/Freigabe verwenden positive öffentliche Revisionen, auch in Anführungszeichen. Channel-Konfiguration verwendet initial `0` und sonst die exakte rohe Revision. Hosting- und Healthprofile erwarten positive numerische Header. Die Wissensentscheidung verwendet aktuell `Number(If-Match)` und meldet bei fehlender oder veralteter Revision einen Konflikt.
- Vor Firmenerstellung verwenden GET/PATCH setup `X-Setup-Token`; danach CEO-Cookie und beim Schreiben CSRF. POST setup trägt den Einmaltoken im Body. Setup und Login haben keine Idempotenzwiederholung. Login und Setup teilen jeweils den konfigurierten Fehlerbegrenzer: zehn fehlgeschlagene Versuche pro 15 Minuten; erfolgreiche Versuche verbrauchen kein Fehlerbudget.
- Normale Fehler haben `{code,messageKey,requestId,retryable:false}`. Provider-Webhooks verwenden im eigenen Handler `{error:code}`; Workerstreams `{error:{code}}`. Fehler der äußeren Control-Middleware können auf beiden Wegen die normale Fehlerhülle liefern. Rate-Limit-Antworten sind 429 `text/plain`. Die Spezifikation unterscheidet diese Formate.

## Ressourcenformen und Pagination

Ein `Document` besteht aus `id`, `scope`, `kind`, `revision` und `data`. Einige Fachmutationen liefern diese Hülle, andere den gespeicherten Fachwert direkt. Listen enthalten normalerweise `items` und `nextCursor`. HTTP-Vertragstests prüfen diese Unterschiede und vergleichen den vollständigen geparsten Wert mit der echten Antwort, damit unbekannte Felder nicht still verschwinden.

Nur die als Offset-Pagination markierten Routen konsumieren `cursor` und `limit`; Werte über 100 werden dort auf 100 begrenzt. Andere Fachlisten sind unpaginiert und geben `nextCursor:null` oder nur `items` zurück. Notifications verwenden einen persistierten Sequenzcursor `after` und `limit` von 1 bis 200. Ereignisverläufe eines Auftrags sind JSON-Listen; sie sind kein SSE-Endpunkt. Aktuell wird dieser Verlauf vor Pagination auf die ersten 1000 geladenen Scope-Ereignisse begrenzt.

Kunden und Projekte besitzen validierte Erstellungs- und revisionsgebundene Bearbeitungsrouten. Kunden bleiben an ihren Bereich gebunden; Projekte können zusätzlich einem Kunden dieses Bereichs zugeordnet werden. Ein Auftrag kann diese Kundenzuordnung nicht weglassen oder durch einen anderen Kunden ersetzen. Die historische `projects`-Dokumentliste erhält ältere Erweiterungsfelder als JSON; neue Schreibzugriffe verwenden den expliziten Entitätsvertrag. Integrationsprofile werden über die validierte Konfiguration verwaltet. Ebenso sind Tool-Ergebnisse, Eventdaten und Setup-Schrittdaten an ihren konkreten Tool-/Event-/Schritttyp gebunden. Diese begrenzten Erweiterungsfelder sind keine Behauptung einer vollständig typisierten freien Domäne.

## Freigegebene Updates im Wartungsfenster

`autoApplyApproved` ist eine optionale boolesche Eigenschaft der Update-Policy ohne Default. Fehlt sie, wird der bisherige Policy-Inhalt und damit sein Fingerprint nicht um ein Feld ergänzt. Nur der Wert `true` aktiviert die zeitgesteuerte Anwendung bereits konkret vom CEO freigegebener Pläne. Das konfigurierte Wartungsfenster und die ursprüngliche Zustimmung mit ihrer 24-Stunden-Gültigkeit gelten weiterhin; der Scheduler erteilt keine eigene Zustimmung und verlängert sie nicht.

GET `/api/v1/maintenance` enthält zusätzlich `updateScheduleAttempts`: `planId`, `state`, `bootId`, `attemptedAt` sowie optional `retryNotBefore` und `code`. Die möglichen Versuchszustände sind `running`, `queued`, `applied`, `deferred`, `failed` und `effect_unknown`. Sie sind vom Zustand des freigegebenen Plans und vom Ergebnis des externen Updaters getrennt. Nur klar als noch nicht ausgeführt erkannte vorübergehende Probleme können nach frühestens 30 Sekunden erneut versucht werden; eine unbekannte Wirkung wird nicht automatisch wiederholt.

Nach einer Wiederherstellung werden laufende Remotejobs und noch nicht abgeschlossene Updateausführungen als `effect_unknown` mit `recovery_generation_changed` markiert. Vorher freigegebene, noch nicht gestartete Updatepläne gehen zurück auf `planned`; alte Freigabeperson, Freigabezeit und Ablaufzeit werden entfernt. `recoveryGeneration` und `errorCode: recovery_approval_invalidated` machen die Entwertung sichtbar. Auch ein späteres operatives Fortsetzen aktiviert diese alte Zustimmung nicht erneut. Der Recoverybericht zählt `unknownRemoteExecutions` und `invalidatedUpdateApprovals`.

## Binärdaten, SSE und Worker

- Belegoriginale werden als `application/octet-stream` mit Attachment-Disposition und inaktiver CSP geliefert; der gespeicherte Digest wird vor dem Senden überprüft.
- Artefakt-Downloads prüfen Pfad, Symlink-/Hardlink-Austausch und tatsächlichen SHA-256. Sie liefern `X-Content-SHA256` und `Cache-Control:no-store`.
- Website-Pakete sind vollständige, manifestgeprüfte `application/gzip`-Archive. `X-Content-SHA256` bindet das Archiv, `X-Package-SHA256` das Paketmanifest.
- GET `/api/v1/events` ist ein authentifizierter `text/event-stream`. `Last-Event-ID` überschreibt `after`. Update-Ereignisse übertragen nur `{type,aggregateId}` und die persistierte Sequenz als SSE-ID. Heartbeat-Kommentare halten die Verbindung offen. Nach bereits versendeten Headern signalisiert `event: stale` mit `data: {}` einen erneuten Ladebedarf.
- WSS `/api/v1/workers/connect` ist ein separater HTTPS-Upgrade-Handler mit Bearer-Enrollmenttoken, `X-Worker-Id` und `X-Worker-Generation`. Die OpenAPI-Erweiterung `x-websocket-protocols` verweist auf die gemeinsamen Nachrichtenschemas. Sequenz-, Generation-, Lease- und Attestierungsprüfungen sind Teil dieses Protokolls.
- Workerbytes gehen über die ausdrücklich dokumentierten TLS-Streams `/worker-transfers/{jobId}/input/{index}` und `/output/{index}`, nicht durch den JSON-Parser. Kurzlebige richtungs-, Job-, Generation-, Scope- und Manifesttickets ersetzen die CEO-Sitzung. PUT verlangt exakte Content-Length und bestätigt erst nach Hashprüfung/fsync mit 204. Grenzen: 32 MiB insgesamt und 1024 Artefaktdateien pro Manifest; optional folgen zwei Logdateien mit zusammen höchstens 1 MiB (höchster Outputindex 1025). Der körperlose POST `/{jobId}/start` mit `Content-Length:0` prüft die bestehende Autorität unmittelbar vor der isolierten Ausführung erneut.

Die Website-Vorschau ist ein eigener, standardmäßig auf Port 8792 laufender HTML-/Asset-Origin mit Paketmanifestprüfung und restriktiver CSP. Sie ist keine zusätzliche JSON-API; ihre Paket- und Assetprüfung wird separat in den Website-Integrations- und Browsertests geprüft.

## Nachweis und Grenzen

`tests/contracts/http-api.test.ts` umfasst elf Tests mit einem echten lokalen Express-Server und einer temporären SQLite-Datenbank. 107 unterschiedliche erfolgreiche HTTP-Operationen werden gegen ihre Request-/Response-Schemas geprüft. Enthalten sind Setup/Sitzung, Revision und CSRF-Fehler, Konfiguration/Profile, Website bis manuelle Abnahme und Download, Originalbelege und Zahlvorbereitung, Recherche mit expliziter lokaler Quellenfixture, fehlgeschlagene echte Watch-Konfiguration, Wissen/Schedules, Incident-/Hosting-Freigaben ohne Freischaltung eines externen Effekts, Worker-Einmaltoken, signierte Discord-Identitätsbindung und ein echter SSE-Strom.

Die Quellenfixture wird ausdrücklich auf Repository-Ebene angelegt; sie belegt das HTTP-Format und die immutable Verarbeitung, keinen erfolgreichen externen Rechercheabruf. Die übrigen Erfolgsoperationen sind schema- und routenseitig erfasst, aber nicht in dieser neuen HTTP-Suite erfolgreich durchlaufen. Dazu gehören insbesondere reale externe/native Ausführung, einzelne Watch-/Rating-Entscheidungen, Wartungsabläufe und Worker-Transfer-Erfolg. Die vorhandenen separaten Worker-, Updater-, Wartungs-, Rating- und Recherche-Integrationstests sind dafür zusätzliche Nachweise. Diese Spezifikation behauptet keine Live-Veröffentlichung, bezahlte Modellprüfung oder plattformübergreifende Produktionsabnahme.
