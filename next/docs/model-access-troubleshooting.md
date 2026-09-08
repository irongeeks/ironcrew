# Modellzugang in 0.4.5 prüfen

Diese Anleitung gilt für den neuen Produktkern unter `next/`. Die CLI-Provider-
und Docker-Anleitungen im Repository-Root beschreiben weiterhin die ältere Linie.
Der Fix in 0.4.5 für Klartextausgabe von `pass-cli --field` betrifft diesen
mitgelieferten Legacy-Provider. Er benötigt keine Umstellung der Secretreferenzen
im neuen Kern.

## Nach dem Update von 0.4.0–0.4.4

1. Unter **Einstellungen → Modelle** den Modellkatalog aktualisieren. Der Abruf
   benötigt keinen OpenRouter-Schlüssel. Ein Fehler bei einzelnen Modellen darf
   gültige Einträge und Free-Modelle nicht mehr aus dem gesamten Katalog entfernen.
2. Den absoluten Pfad zum installierten Proton-Pass-CLI verwenden. Stabile
   Versionen ab **2.3.2** werden unterstützt. `--version` darf beispielsweise
   `Proton Pass CLI 2.3.2 (ac04625)` ausgeben. Share-/Item-IDs und Feldnamen
   unverändert übernehmen, auch wenn sie mit `-` beginnen. IronCrew bindet Werte
   jetzt als `--item-id=<Wert>` an ihre Option; keine zusätzlichen Anführungszeichen
   in die Oberfläche eingeben.
3. Die Proton-Anmeldung muss für das Betriebskonto der Zentrale gültig sein.
   Share-ID, Item-ID und Feldname verweisen auf den OpenRouter-Schlüssel.
   Ein optionales eigenes Sitzungsverzeichnis muss zu dieser Anmeldung passen.
4. Bei aktivierter Liveausführung den Modellzugang speichern. IronCrew prüft
   jetzt den tatsächlichen Secretzugriff. Erst danach wird die neue Runtime
   übernommen; der Schlüssel selbst wird nicht in der Konfiguration gespeichert.
5. Für einen Auftrag ein verfügbares Modell und ein gültiges Mandat auswählen.
   Der Budgetzeitraum muss den aktuellen Zeitpunkt einschließen. Für tatsächlich
   kostenfreie Modelle kann das Budgetlimit 0 USD betragen. Mandate, Fähigkeiten
   und Preisprüfung bleiben Voraussetzung für den Start.

Ein lesbares Secret bestätigt noch keinen erfolgreichen Modellaufruf bei
OpenRouter. Providerverfügbarkeit, Rate-Limits und Kontoeinstellungen werden erst
beim echten Aufruf wirksam. Insbesondere können Free-Modelle durch die gewählten
OpenRouter-Datenschutzeinstellungen ausgeschlossen sein. IronCrew ändert diese
Einstellungen nicht automatisch.

## Kostenlose Modelle

Für kostenlose Workflows bevorzugt `openrouter/free` auswählen. Der offizielle
[Free-Router](https://openrouter.ai/openrouter/free) wählt aus verfügbaren kostenlosen
Modellen und berücksichtigt angefragte Fähigkeiten wie Werkzeugaufrufe. Das ist keine
Verfügbarkeitsgarantie. Einzelne `:free`-Endpunkte können trotz Katalogeintrag mit HTTP 404
antworten. IronCrew weist dann auf den Router hin; es wechselt das freigegebene Modell
nicht stillschweigend. Modellwahl, Mandat, Preisprüfung und Kontoeinstellungen bleiben wirksam.

## Live-Prüfung und API-Referenzen

Das Profil für die Live-Prüfung akzeptiert `maxCostUsdMicros: "0"` für Modelle
mit einer Kostenschätzung von null. Fehlende Preisangaben bleiben ein Fehler;
kostenpflichtige Modelle benötigen weiterhin ein ausreichendes Budget.
Die Prüfung fordert höchstens 512 Ausgabetokens an und kalkuliert diese in der
Schätzung. Reicht das bisherige Limit nicht aus, Budget und Modellwahl prüfen.
Reasoning ohne endgültigen Antwortinhalt gilt weiterhin als fehlgeschlagen.

Für eigene API-Clients lautet der kanonische Secret-Provider `proton-pass`.
Der ältere Eingabewert `protonpass` wird auf diesen Wert normalisiert. Neue
Clients sollten `proton-pass` verwenden; Speicherung und Ausgabe bleiben kanonisch.

## Fehler und nächster Schritt

| Fehler | Bedeutung und Prüfung |
| --- | --- |
| `model_secret_configuration` | Absoluten CLI-Pfad und stabile Version ab 2.3.2 prüfen. Die Änderung wurde nicht übernommen. |
| `model_secret_unavailable` | Anmeldung, Sitzung, Ausführungsrechte und Secretverweis prüfen. Die bisherige Konfiguration bleibt erhalten. |
| `catalog_refresh_failed` | Abruf erneut versuchen und das Serverprotokoll prüfen. Gespeicherte Modelle bleiben bei einem fehlgeschlagenen Abruf erhalten. |
| `model_not_configured` | Die Zentrale besitzt keine einsatzbereite Runtime. Modellzugang prüfen, ausdrücklich aktivieren und speichern. |
| `no_routable_model` | Modellfähigkeiten, Verfügbarkeit, Preisangaben und Kostenrahmen prüfen. Sichtbarkeit im Katalog allein garantiert keine ausführbare Auswahl. |
| `model_free_endpoint_unavailable` | Der gewählte `:free`-Endpunkt hat HTTP 404 geliefert. `openrouter/free` ausdrücklich auswählen und erneut starten. |
| `model_dispatch_denied` | Vor dem Versand abgebrochen; Zugang/Konfiguration und sichere Diagnose prüfen. Die Reservierung wird mit 0 abgeschlossen. |
| `model_response_unknown` | Versand oder Antwort unklar. Unter Modellkosten zuerst anhand eines Belegs abrechnen; erst dann die fehlende Antwort ausdrücklich verwerfen und bei Bedarf erneut starten. |
| `budget_period_inactive` | Budgetzeitraum korrigieren; er muss den aktuellen Zeitpunkt einschließen. |

Bei Katalogfehlern protokolliert die Zentrale die feste Fehlerklasse: `http`
mit HTTP-Status, `schema`, `invalid_json`, `timeout` oder `transport`. Für
abgewiesene Einträge werden Anzahl, Index und betroffene Feldpfade aufgezeichnet.
Speicherung wird getrennt als `storage_rejected` (z. B. `invalid_transaction` oder
`revision_conflict`) bzw. `storage_failure` (z. B. `persistence_error`) ausgewiesen.
Große Kataloge werden seit 0.4.2 samt Status in einer SQLite-Transaktion gespeichert;
ein fehlgeschlagener Schreibvorgang hinterlässt keinen Teilkatalog. Bei wiederholten
Speicherfehlern den sicheren Code und die Version mit dem Fehlerbericht übermitteln.
Providerantworten und Secrets werden dabei nicht protokolliert.

Kann die Zentrale ein gespeichertes Secret nach einem Neustart nicht mehr lesen,
bleibt die Oberfläche zur Korrektur erreichbar. Das Startprotokoll meldet die
Liveausführung als gesperrt. Nach Korrektur den Modellzugang erneut speichern.

## Optionale Einrichtung

In Schritt 6 werden Verbindungen, Kunden, Projekte und Postfächer über ihre
jeweilige Schaltfläche gespeichert. Unvollständige Entwürfe können übersprungen
werden und werden beim Weitergehen nicht mitgespeichert. Die Pflichtbestätigung
für den Einrichtungsschritt bleibt erforderlich; fehlt sie, erscheint ein
sichtbarer Hinweis im Assistenten.

[Updateanleitung und Releaseumfang](../../docs/releases/v0.4.5.md) ·
[Einrichtung](../README.md) · [Prüfnachweise](verification.md)

## Laufdiagnose und Wiederaufnahme

Die Zentrale protokolliert fehlgeschlagene Modellaufrufe mit sicherer Modell-ID,
Fehlerphase und bei HTTP-Antworten dem Status. Providerantworten, Request-Inhalte
und Schlüssel bleiben verborgen. Ablehnungen vor dem Versand sowie definitive
HTTP-Clientfehler werden mit 0 abgerechnet. Transportabbrüche, Serverfehler und
verlorene Streams bleiben bis zur belegten Klärung unbekannt.

Eine Kostenklärung allein rekonstruiert keine Antwort. Nach erfolgreicher Klärung
bietet **Modellkosten** das bestätigte Verwerfen der fehlenden Antwort an. Dies
startet keinen Provideraufruf. Den Auftrag anschließend ausdrücklich erneut
ausführen; dafür müssen Plan, Mandat und Budget weiterhin gültig sein. Ein neuer
Aufruf kann neue Kosten verursachen. Die alte Anforderung und der Beleg bleiben
im Audit erhalten.
