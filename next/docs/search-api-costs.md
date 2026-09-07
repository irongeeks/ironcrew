# Such-API-Kosten

`research.search` (Brave Web Search) läuft im Control-Runtime- und Recherche-Workflow über denselben `IntegrationCostService`. Vor dem einzigen HTTP-Versuch werden Firmenbudget, Auftragsbudget und das kumulative Mandatslimit atomar belastbar reserviert. Der Adapter startet ohne gültigen Preis und Budgetbroker keinen Suchaufruf. `research.fetch` bleibt ein eigener öffentlicher HTTP-Lesezugriff, kein Brave-Suchaufruf.

## Administrative Preiskonfiguration

Die Brave-Verbindung benötigt `pricing`:

```json
{
  "id": "88a9bbcb-d4d7-4606-8fb6-221d03136829",
  "version": 1,
  "toolId": "research.search",
  "currency": "USD",
  "requestUsdMicros": "10",
  "validFrom": "2026-09-07T00:00:00.000Z",
  "expiresAt": "2026-10-07T00:00:00.000Z",
  "sourceUrl": "https://example.invalid/fixture-contract"
}
```

**Dies ist ausschließlich ein Testpreis, keine Brave-Preisempfehlung.** Der Administrator trägt den überprüften vertraglichen Brutto-Einzelpreis in USD-Mikroeinheiten und dessen Gültigkeit ein. Andere Währungen werden nicht geschätzt oder automatisch umgerechnet. Eine benutzte Preisversion wird pro Ziel dauerhaft unveränderlich registriert; Anpassungen benötigen eine neue Version oder ID. Bereits reservierte Aufrufe behalten ihren ursprünglichen Preis. Monatliche Gratisguthaben werden nicht als Nullkosten unterstellt.

Brave beschreibt Web Search als pro Anfrage abgerechneten Dienst mit kontobezogenen Guthaben. Die öffentliche Seite ist kein Beleg für den tatsächlichen individuellen Kontovertrag: [offizielle Preise](https://api-dashboard.search.brave.com/documentation/pricing), [Web-Search-GET-Vertrag](https://api-dashboard.search.brave.com/api-reference/web/search/get), geprüft am 07.09.2026. Die Software lädt Preise nicht selbstständig aus Webseiten.

## Ablauf und Fehlerverhalten

1. Der Broker bindet die gespeicherte Action einschließlich Ziel, Scope, Argumenthash, Auftrag, Mandatsversion und vollständigem Konfigurationshash an den Preis.
2. Reservierung und `integration-charge` werden vor HTTP gemeinsam dauerhaft gespeichert. Die Autorität wird unmittelbar danach erneut geprüft. Ein sicherer Fehler vor dem Versand kann die Reservierung mit Kosten null abschließen.
3. Ein HTTP-2xx-Abschluss wird einmal zum administrativen Einzelpreis verbucht, auch wenn anschließend der Suchantwortparser fehlschlägt. Die Abrechnung bezeichnet den konfigurierten Vertragspreis, keine vom Provider erfundene Messung.
4. Transportabbruch, Timeout und Nicht-2xx behalten ihre Reservierung als ungeklärt. Auch 429/503 werden nicht automatisch wiederholt. Ob der Provider solche Versuche berechnet, wird ohne kontospezifischen Beleg nicht geraten.
5. Ein Prozessabbruch zwischen HTTP und Kostenabschluss lässt die vorab gespeicherte Reservierung bestehen. Ein wiederkehrender Action-Aufruf wird gesperrt, unabhängig davon, ob ein neuer Service oder ein neuer Prozess läuft. Er erzeugt keinen zweiten HTTP-Aufruf. Bereits abgeschlossene ManagedAction-Receipts bleiben wie bisher wiederabspielbar.

`integration-charge` speichert ausschließlich Abrechnungsmetadaten, Preis, HTTP-Status und Antwort-SHA256. Suchantwortbytes und Broker-Secrets gelangen nicht in diesen Beleg. Die bestehende Integrationsgrenze redigiert Modellantworten.

## CEO-Abgleich ungeklärter Kosten

- `GET /api/v1/integration-costs` liefert bereichszugeordnete Kostenbelege und Revisionen des eigenen Unternehmens.
- `POST /api/v1/integration-costs/:id/reconcile`, mit Session, CSRF, Idempotency-Key und `If-Match`, benötigt `actualUsdMicros` und `evidence: {mediaType, contentBase64, description}`. Erlaubt sind PDF, JSON, Text und CSV bis ungefähr 512 KiB. Ein belegter Wert null ist erlaubt, ein automatischer Nullkosten-Fallback nicht.
- Die tatsächlichen Belegbytes, ihr SHA256 und der bestätigende CEO werden zusammen mit der Ledgeränderung atomar in `integration-cost-evidence` gespeichert. Die Liste enthält keine Belegoriginale. Noch laufende Actions sowie doppelte oder fremde Abgleiche werden abgewiesen. Ein Abgleich über dem reservierten Wert zeigt die wirklichen Mehrkosten im Firmenbudget; er erzeugt keine weitere Suchanfrage.

Tests: `tests/integration/integration-costs.test.ts` verwendet echte lokale HTTP-Server, SQLite-Neustarts, konkurrierende Reservierungen, kumulative Limits, widerrufene Mandate, simulierten Persistenzabbruch nach tatsächlichem HTTP sowie reale Control-Session-/CSRF-/Idempotenzpfade. `tests/contracts/integrations-http.test.ts` prüft zusätzlich den Brave-HTTP-Vertrag mit einem ausdrücklich injizierten reinen Transport-Testmeter. Es wurden keine echten Konten, kostenpflichtigen Anfragen oder Provider-Rechnungen benutzt.
