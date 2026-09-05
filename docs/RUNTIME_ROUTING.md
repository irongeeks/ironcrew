# Runtime-Routingprofile

IronCrew bietet neun abstrakte Profile: `fast`, `balanced`, `deep_reasoning`, `coding`, `research`, `legal_research`, `finance`, `vision` und `long_context`. Modellnamen stehen ausschließlich in der Owner-Zuordnung. Ohne Profilbindung bleibt das bisherige Agent-Vessel maßgeblich.

## Einrichtung

Im Command Center **Modell-Routing** öffnen. Ein aktiver Owner wählt je Profil ein bestehendes Firmen-Vessel, dessen Runtime, den tatsächlichen Modellnamen und die kanonische Vendor-Modell-ID. Für offizielle CLI-Aliase muss die Vendor-ID exakt zur Runtime und zum Modell passen, etwa `anthropic/<alias>` für Claude. OpenRouter benötigt einen qualifizierten Modellnamen. Die zentrale `config/vendor-policy.yaml` prüft sowohl echte Modellnamen als auch kanonische IDs im Backend.

`config/routing-profiles.yaml` ist die Zod-validierte Bootstrapkonfiguration (Schema-Version 1). Alle primären Ziele sind zunächst leer; Fallbacks sind deaktiviert. Beim ersten Zugriff wird die Konfiguration als Firmenrevision in SQLite übernommen. Danach ist die Datenbank die maßgebliche Konfiguration; Änderungen erfolgen über UI/API, nicht durch erneutes Einlesen der YAML-Datei. Das schützt Owner-Änderungen nach Neustarts. Jede Speicherung und Agentbindung wird auditiert. Gleichzeitige Änderungen erfordern die aktuelle Revision und liefern sonst HTTP 409; der Editor bewahrt ungespeicherte Entwürfe.

API:

- `GET /api/crew/routing`: authentifizierte Benutzer erhalten Konfiguration, Revision, Bindungen, Firmen-Vessels und Revisionshistorie.
- `PUT /api/crew/routing`: Owner sendet `{expectedRevision, config}` als JSON.
- `PUT /api/crew/routing/agents/:agentId`: Owner sendet `{profileKey}`; `null` entfernt die Bindung.

## Tatsächliche Ausführung

Task-Dispatch und Meeting-Turns verwenden dieselbe Profilauswahl. Vor dem Start werden Firmenzugehörigkeit, unveränderte Vessel-Runtime, Vendor-Policy, Sensitivität, benötigte Fähigkeiten, Projekt-Workspace, Budgets, Kapazität, Health und Auth-Status geprüft. Fehlende Bestätigung einer angeforderten Fähigkeit blockiert den Start. `vision` und `longContext` bleiben bei Runtimes ohne ausdrückliche Capability-Bestätigung gesperrt; ein Profilname allein bestätigt keine Modelleignung.

Eine explizite, geordnete Fallbackkette darf ausschließlich vor dem Start wegen Nichtverfügbarkeit genutzt werden (beispielsweise fehlende Runtime, Health/Auth-Ausfall, Cooldown oder belegtes Vessel). Policy-, Budget-, Workspace- oder Capability-Verweigerungen werden niemals durch einen anderen Kandidaten umgangen. Unbestätigte Authentifizierung wird nicht als erfolgreicher Login ausgegeben; die offizielle Runtime beziehungsweise der native Runner entscheidet weiterhin an seiner Auth-/SecretRef-Grenze.

Nach einem gestarteten Task bleibt die tatsächlich verwendete Route für Wiederholungen und Revisionen festgehalten, auch wenn ein unabhängiges Profil geändert wurde. Eine inzwischen entfernte oder deaktivierte Fallbackroute wird gesperrt. Es gibt keinen automatischen Providerwechsel nach Teilresultaten, Fehlern oder Kostenereignissen. Fehlende Verfügbarkeit vor dem Start bleibt in der persistenten Queue ohne verbrauchten Ausführungsversuch. Meeting-Streams benötigen einen bestätigten Abschluss; Abbruch oder unvollständige Streams ergeben einen sichtbaren Fehlerbeitrag.

## Grenzen bleiben wirksam

Jeder Run speichert das ursprüngliche und das gewählte Vessel bereits beim atomaren INSERT. Beide Parallelitätsgrenzen gelten; Agent- und Task-Locks bleiben bestehen. Meeting-Reservierungen zählen ebenfalls gegen beide Vessels und werden anschließend freigegeben. Es gilt das kleinere Timeout. Ein Fallback erhält niemals eine erhöhte Sandboxberechtigung; beim primären Ziel muss jede Freigabe weiter zur tatsächlich verwendeten Runtime und zum Workspace passen.

Ein Kostenereignis speichert Runtime, ursprüngliche Runtime, Transportprovider und Modellvendor. Dadurch gelten Budgetgrenzen für Ursprung und Ziel sowie Provider und Modellvendor, während Firmen-, Agent-, Projekt- und Taskkosten nur einmal gezählt werden. Prüfungen erfolgen vor Ausführung und nach jedem Usage-Ereignis; unbekannte Subscriptionkosten werden als Quota ohne erfundenen Preis gespeichert.

## Nachweise und Grenzen

Regressionstests verwenden ausschließlich Stub-/Mock-Runtimes und die reale SQLite-/Orchestrator-/API-Schicht. Sie prüfen Primär-/Fallbackausführung, Modellweitergabe, Neustart, Richtlinienverweigerungen, Budgetstopps zwischen Ereignissen, Bindungen, Ownerrechte, Versionskonflikte und Meetingfehler. Frontendtests verwenden den echten JSON-/CSRF-Transport. Der Playwright-Flow speichert ein Profil, bindet einen Agenten und prüft den Zustand nach erneutem Laden sowie die Vendor-Policy; die Browserausführung erfolgt in CI. Tatsächliche Task- und Meeting-Dispatchs werden durch die Backend-Integrationstests nachgewiesen.

Es wurden keine CLI-Logins, kostenpflichtigen Modellaufrufe oder Providerkonten zur Abnahme verwendet. Der manuelle Nachweis für reale installierte und authentifizierte Runtimes bleibt erforderlich. Diese Änderung ergänzt Runtime-Routing; sie erklärt nicht sämtliche langfristigen Master-Prompt-Phasen für abgeschlossen.
