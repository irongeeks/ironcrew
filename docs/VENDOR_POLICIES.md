# Firmenfreigaben für Modelle und Provider

Im Command Center öffnet **Provider-Freigaben** die wirksamen Modellfamilien,
OpenRouter-Provider, zentralen Schutzregeln und den Änderungsverlauf. Alle
angemeldeten Benutzer können den Stand lesen und Modelle prüfen. Nur ein aktiver
Owner darf speichern. Im bestehenden Erststartmodus ohne Benutzerkonten hat der
über die äußere Anwendungsauthentifizierung zugelassene lokale CEO diese Rechte;
sein Audit-Actor heißt bis zur Kontoeinrichtung `ceo`. Ein fehlgeschlagener
Identitätsabruf schaltet den Editor nicht frei.

## Bedienung

1. Gewünschte Modellfamilien und ausführende OpenRouter-Provider auswählen.
2. Die Vorschau prüfen und eine Begründung mit mindestens zehn Zeichen eingeben.
3. **Freigaben speichern** erzeugt eine neue Revision samt Actor, Zeit,
   Correlation-ID und Audit-Verweis.
4. **Gespeicherte Policy prüfen** prüft eine konkrete Modell-ID und optional einen
   exakten OpenRouter-Providernamen. Diese Prüfung verwendet den gespeicherten
   Stand, kontaktiert keinen Anbieter und bestätigt weder Anmeldung noch
   Modellverfügbarkeit oder Budget.

Eine leere Familienauswahl blockiert reale Modellanfragen. Eine leere Providerliste
blockiert OpenRouter. Die deterministische Offline-MockRuntime benötigt keinen
externen Anbieter; konfigurierte Routingziele werden trotzdem gegen die
Vendor-Modellzuordnung geprüft.

Bei einer parallelen Änderung lehnt der Server den alten Schreibstand ab. Der
Entwurf bleibt erhalten. **Serverstand laden** zeigt die aktuelle Revision. Danach
kann der Owner seinen Entwurf ausdrücklich auf den geladenen Stand beziehen oder
verwerfen. Automatisches Überschreiben findet nicht statt.

## Eine verbindliche Obergrenze

`config/vendor-policy.yaml` bleibt die installationsweite Obergrenze. Die Oberfläche
kann ausschließlich Teilmengen ihrer Modellfamilien und Provider speichern.
Gesperrte Vendor-Familien und Aliase, Datenschutz, Fallback-Vorgaben, gesperrte
Endpunkte und Telemetrie lassen sich darüber nicht lockern.

Die wirksame Policy ist die Schnittmenge von YAML und letzter Firmenrevision.
Ändert der Betreiber die YAML, gilt ihre neue Einschränkung bei der nächsten
Prüfung. Ungültige oder fehlende Policy-Dateien führen zum Fehler. Ein Fingerprint
verhindert das Speichern gegen einen veralteten YAML-Stand. Revision 0 bedeutet,
dass noch keine Firmenauswahl gespeichert wurde.

## Ausführung und Runner

Task-Starts, Revision/Resume, Wiederholungen und Meeting-Turns prüfen die wirksame
Policy unmittelbar vor dem Runtime-Aufruf. Routing und seine Fallbacks prüfen die
konkrete Vendor-Modellzuordnung. CLI-Aliase erhalten den festen Präfix ihrer
offiziellen Runtime; eine fremde Modellfamilie ist darüber nicht zulässig.

Die Zulassung gilt für den jeweiligen Aufruf. Bei CLI-Adaptern kann vor dem
Prozessstart noch eine asynchrone Capability-Prüfung stattfinden.

Native Jobs übertragen ausschließlich Familien- und Providerlisten. Der Runner
bildet erneut die Schnittmenge mit seiner eigenen YAML. Er akzeptiert keine
übertragenen Lockerungen von Sperren, Datenschutz oder Fallbacks. Control Plane und
Runner müssen deshalb gemeinsam auf 0.2.0 aktualisiert werden; ältere Runner
verweigern die neue Jobstruktur.

Bereits abgesendete externe Requests werden nicht rückwirkend widerrufen. Native
Runs erhalten die Firmenauswahl beim Start; eine spätere Firmenänderung erreicht
sie erst mit dem nächsten Start/Resume. Der eigene YAML-Stand des Runners bleibt
zusätzlich verbindlich. Für den eingebetteten OpenRouter-Adapter wird der
Firmenstand vor jeder neuen Modellanfrage erneut geprüft, auch nach Tool-Runden.

## Speicherung und API

Migration 0035 ergänzt `crew_company_policy_revisions`, getrennt je Company.
Revision und Audit werden in derselben Transaktion gespeichert. Die API bietet
keine Änderung oder Löschung alter Revisionen; die Oberfläche zeigt die letzten
100 Einträge. Backup/Restore der SQLite-Datenbank enthält die Firmenfreigaben.

| Endpoint | Zweck |
| --- | --- |
| `GET /api/crew/policies/vendor` | Revision, YAML-Fingerprint, Auswahl, wirksame Policy und Historie |
| `PUT /api/crew/policies/vendor` | Owner-Speicherung mit `baseRevision`, `baselineFingerprint`, `reason`, `restrictions` |
| `POST /api/crew/policies/vendor/check` | Rein lesende Modell-/Providerprüfung, Entscheidung auch bei Ablehnung als HTTP 200 |

`restrictions` enthält ausschließlich `allowedFamilies` und `allowedProviders`.
Unbekannte Felder, Duplikate und ungültige Werte werden abgewiesen. HTTP 409 bedeutet
veraltete Revision oder YAML; HTTP 403 fehlende Ownerrechte oder Auswahl außerhalb
der Obergrenze. Session- und CSRF-Schutz gelten weiter.
