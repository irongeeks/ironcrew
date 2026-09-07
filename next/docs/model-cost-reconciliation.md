# Modellkosten abgleichen

Ein Modellturn reserviert Firmen-, Auftrags- und Mandatsbudget, bevor die OpenRouter-Anfrage startet. Fehlende Usage oder eine verlorene Antwort lassen die Reservierung bestehen. Im Budgetbereich zeigt **Modellkosten abgleichen** die eigene Firma mit Auftrag, Modell, gespeicherter Generation, Betrag, Kosten- und Antwortzustand.

## Anbieterabgleich

`POST /api/v1/model-costs/:id/provider` erhält einen leeren Body und die aktuelle Turnrevision als `If-Match`. Es werden weder Generation-ID noch Modell, Konto oder URL aus dem Request übernommen. Der Broker liest die bereits gespeicherte Generation und fragt über die administrativ konfigurierte OpenRouter-Verbindung deren Abrechnung ab. Nach der Secret-Auflösung und nach dem HTTP-Aufruf werden CEO, Turnrevision, Laufaktivität, Konfiguration und Restoregeneration erneut geprüft. Der Provider muss dieselbe Generation und dasselbe Modell bestätigen. Wiederverwendete Generation-IDs über mehrere Turns werden nicht automatisch verbucht.

Die Abfrage verwendet den offiziellen [OpenRouter-Generation-Endpunkt](https://openrouter.ai/docs/api/api-reference/generations/get-generation), geprüft am 07.09.2026. Ein einzelner HTTP-Aufruf hat Zeit- und Größenlimit; Weiterleitungen, fehlende oder ungültige Kosten, fremde ID/Modell und nicht erfolgreiche Antworten lösen keine Freigabe von Geld aus. Der gespeicherte Nachweis enthält nur feste Metadaten und deren SHA256. Rohe Providerantworten, Prompts, Antworttexte und Secrets erscheinen nicht in der Kostenliste.

## Manuelle Zuordnung

Fehlt eine dauerhaft gesicherte Provider-ID oder bleibt die Anbieterabfrage unklar, kann der CEO mit einem Originalbeleg abgleichen: `POST /api/v1/model-costs/:id/manual`, Body `{actualUsdMicros,evidence:{mediaType,contentBase64,description}}`, mit Session, CSRF, Idempotency-Key und Turnrevision. PDF/JSON/Text/CSV sind begrenzt; Belegbytes und Hash werden atomar mit Ledger und Turn-Kostenstatus gespeichert. Ein ausdrücklich belegter Nullbetrag ist möglich, ein Nullkosten-Fallback ohne Beleg nicht. Tatsächliche Mehrkosten werden verbucht und blockieren bei ausgeschöpftem Budget weitere Ausgaben.

Noch aktive Modellläufe werden nicht gleichzeitig abgerechnet. Der produktive Registrar erhält dafür den aktuellen Runtime-Aktivitätsprüfer; ohne diesen Hook verweigert der Service einen Abschluss. Nach einem Neustart kann die gespeicherte Reservierung abgeglichen werden. Ein paralleler oder wiederholter Abschluss schreibt den Ledger nicht doppelt.

## Kosten sind keine Modellantwort

Der Kostenservice verändert weder `run.pendingTurnId` noch `blockedReason`, Antwortinhalt, Toolaktionen oder Artefakte. Ein Turn mit verlorener Antwort bleibt nach Kostenklärung `model_response_unknown`; ein erneutes Resume führt keine neue Modellanfrage aus. Eine vollständige bereits gespeicherte Antwort mit ausschließlich fehlender Usage kann der bestehende Runtime-Resume-Pfad nach dem Ledgerabschluss weiterverarbeiten. Ein Kostenabgleich ist keine fachliche Ergebnisabnahme und keine Toolfreigabe.

Lokale Nachweise: `tests/integration/model-costs.test.ts` verwendet tatsächliche HTTP-Modellantworten und Generation-Abfragen, echte SQLite-Neustarts, falsche ID/Modell/Kosten, fremde Identität, Laufaktivität, konkurrierende Abschlüsse, Überziehung sowie echte CEO-Session-/CSRF-/Idempotenzaufrufe. `tests/contracts/openrouter.test.ts` und `tests/recovery/runtime-hardening.test.ts` prüfen zusätzlich Stream-/Runtimefehler. Es wurden keine echten OpenRouter-Konten oder kostenpflichtigen Modellaufrufe verwendet.
