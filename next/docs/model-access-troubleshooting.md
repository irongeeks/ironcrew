# Modellzugang in 0.4.1 prüfen

Diese Anleitung gilt für den neuen Produktkern unter `next/`. Die CLI-Provider-
und Docker-Anleitungen im Repository-Root beschreiben weiterhin die ältere Linie.

## Nach dem Update von 0.4.0

1. Unter **Einstellungen → Modelle** den Modellkatalog aktualisieren. Der Abruf
   benötigt keinen OpenRouter-Schlüssel. Ein Fehler bei einzelnen Modellen darf
   gültige Einträge und Free-Modelle nicht mehr aus dem gesamten Katalog entfernen.
2. Den absoluten Pfad zum installierten Proton-Pass-CLI verwenden. Stabile
   Versionen ab **2.3.2** werden unterstützt. `--version` darf beispielsweise
   `Proton Pass CLI 2.3.2 (ac04625)` ausgeben.
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

## Fehler und nächster Schritt

| Fehler | Bedeutung und Prüfung |
| --- | --- |
| `model_secret_configuration` | Absoluten CLI-Pfad und stabile Version ab 2.3.2 prüfen. Die Änderung wurde nicht übernommen. |
| `model_secret_unavailable` | Anmeldung, Sitzung, Ausführungsrechte und Secretverweis prüfen. Die bisherige Konfiguration bleibt erhalten. |
| `catalog_refresh_failed` | Abruf erneut versuchen und das Serverprotokoll prüfen. Gespeicherte Modelle bleiben bei einem fehlgeschlagenen Abruf erhalten. |
| `model_not_configured` | Die Zentrale besitzt keine einsatzbereite Runtime. Modellzugang prüfen, ausdrücklich aktivieren und speichern. |
| `no_routable_model` | Modellfähigkeiten, Verfügbarkeit, Preisangaben und Kostenrahmen prüfen. Sichtbarkeit im Katalog allein garantiert keine ausführbare Auswahl. |
| `budget_period_inactive` | Budgetzeitraum korrigieren; er muss den aktuellen Zeitpunkt einschließen. |

Bei Katalogfehlern protokolliert die Zentrale die feste Fehlerklasse: `http`
mit HTTP-Status, `schema`, `invalid_json`, `timeout` oder `transport`. Für
abgewiesene Einträge werden Anzahl, Index und betroffene Feldpfade aufgezeichnet.
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

[Updateanleitung und Releaseumfang](../../docs/releases/v0.4.1.md) ·
[Einrichtung](../README.md) · [Prüfnachweise](verification.md)
