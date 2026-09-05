# Geschäftsdaten aus angebundenen Gewerken

Im Command Center öffnet **Geschäftsdaten** für den Owner die Quellenansicht.
Sie liest beim Öffnen ausschließlich den letzten lokalen Abruf. Ein externer
Aufruf erfolgt erst nach Mitarbeiterauswahl und **Aktualisieren** an einer Quelle.
Der Mitarbeiter braucht das zugehörige Werkzeugrecht; Installation eines Gewerks
vergibt keine Rechte. Eine verweigerte oder freigabepflichtige Werkzeugnutzung
führt zunächst zu keinem Netzaufruf. Die Quelle zeigt die Freigabe-ID. Nach der
Entscheidung im Freigabeeingang erneut mit demselben Mitarbeiter aktualisieren:
Die Genehmigung gilt für genau einen Abruf der gebundenen Quelle innerhalb von
15 Minuten. Mitarbeiter, Firma, Werkzeug und fester Endpunkt müssen übereinstimmen.
Deaktivierte Werkzeuge oder entzogene Grants bleiben trotz Genehmigung gesperrt.
Bindung und einmaliger Verbrauch werden dauerhaft auditiert und funktionieren auch
nach Neustart. Ein fehlgeschlagener genehmigter Netzaufruf verbraucht die Freigabe;
ein neuer Versuch erfordert eine neue Entscheidung.

## Einrichtung

1. Unter **Gewerke** das MSP- oder Finance-Pack installieren.
2. Die Integration auf dem Host konfigurieren, wie in [Business Packs](BUSINESS_PACKS.md)
   beschrieben. Zugangsdaten werden weder hier eingegeben noch im Browser gespeichert.
3. Unter **Werkzeuge** einem passenden Mitarbeiter das jeweilige Lesewerkzeug freigeben.
4. **Geschäftsdaten** öffnen, Mitarbeiter auswählen und die gewünschte Quelle abrufen.
5. Datenstand und **Datengrundlage ansehen** prüfen. Ein geladener Ausschnitt ist keine Vollerhebung.

| Quelle | Werkzeug | Tatsächlich ausgewertete Daten |
| --- | --- | --- |
| Proxmox | `proxmox.inventory` | VM-/Containerliste ohne Templates; Anzahl gelieferter Gäste und expliziter Status `stopped` |
| Tactical RMM | `rmm.agents` | Gelieferte Endpunkte und expliziter Status `online`; fehlender Status wird nicht als offline gewertet |
| Tactical RMM | `rmm.alerts` | Unaufgelöste, nicht stummgeschaltete Alarme; expliziter Schweregrad `error` |
| UniFi | `unifi.devices` | Erste Geräteseite, höchstens 200 angeforderte Datensätze; expliziter Status `ONLINE` innerhalb dieser Seite |
| sevDesk | `sevdesk.invoice` | Erste 100 angeforderte Rechnungen mit Quellstatus `200`; separat der von der Quelle gemeldete Gesamtzähler, sofern vorhanden |
| Lexware Office | `lexware.vouchers` | Erste 100 angeforderte offene Rechnungen; als überfällig markierte Einträge ausschließlich innerhalb dieser Seite |

Die Oberfläche nennt Quelle, Endpunkt, Abrufzeitpunkt und Quell-ID. Die aufklappbare
Datengrundlage enthält höchstens 100 Einträge, mit auf 160 Zeichen begrenzten Textfeldern.
Rechnungsbeträge, Kundennamen, Adressen und Alarmtexte werden nicht in diesen
Dashboard-Cache übernommen. Kein Cashflow, MRR, SLA-Risiko oder Umsatz wird aus
unvollständigen Listen hochgerechnet. Web-Agency-Kennzahlen benötigen weiterhin
eine tatsächliche CRM-/Angebotsquelle; das Pack liefert hierfür keine erfundenen Werte.

## Grenzen und Sicherheit

- Nur Owner dürfen die Daten lesen und Abrufe starten; die bestehende Session-/CSRF-Schicht bleibt aktiv.
- Es werden ausschließlich bereits registrierte Adapter verwendet. Die API akzeptiert keine URL,
  Authentifizierungsdaten, freien Filter oder beliebigen Werkzeugnamen.
- Das bestehende Agenten-Werkzeuggate prüft Firma, Agent, deaktivierte Werkzeuge und Grants.
- Der menschliche Actor, Mitarbeiter, Werkzeug, Endpunkt, Ergebnis und Correlation-ID werden
  im bestehenden Audit-Trail erfasst. Ein Audit-Intent wird vor dem externen Aufruf geschrieben.
- Gleichzeitige Abrufe derselben Quelle werden mit HTTP 409 abgelehnt. Quellen können getrennt
  aktualisiert werden; ein Fehler löscht nur die bisherige Messung dieser Quelle.
- Die gemeinsame JSON-Transportschicht begrenzt Antworten auf **2 MiB** und das Lesen des
  Antwortstreams auf **15 Sekunden**. Redirects werden abgelehnt; so wandern API-Schlüssel
  nicht über eine unkontrollierte Weiterleitung zu einem zweiten Host.
- UniFi lädt im Dashboard höchstens eine Standortseite (sofern der Standort nicht als UUID
  konfiguriert ist) und eine Geräteseite. Ein außerhalb der ersten Seite liegender Standort
  muss über seine UUID konfiguriert werden.
- Keine automatischen Abrufe, Polling-Schleifen, schreibenden Business-Aktionen oder neuen
  Integrationszugänge. Es gelten die vorhandenen, vom Betreiber gesetzten Adapter-Endpunkte
  und deren Leserechte; insbesondere ist dies kein generisches HTTP-Werkzeug.
- Der Cache ist bewusst flüchtig: Nach Neustart lautet der Zustand **Noch nicht abgerufen**.
  Historische Geschäftsdaten werden nicht persistiert; der Audit-Nachweis der Aufrufe bleibt erhalten.
- `not_installed`, `not_configured`, `not_refreshed`, `denied`, `approval_required` und `error`
  sind eigene Zustände. Fehler oder fehlerhafte Listen sind keine Nullmessung.

## API

```text
GET  /api/crew/business-dashboard
POST /api/crew/business-dashboard/:source/refresh
```

POST-Body: `{ "agentId": "agent-id" }`. Quellen: `proxmox`, `rmm-agents`,
`rmm-alerts`, `unifi`, `sevdesk`, `lexware`. Beide Endpunkte erfordern die Ownerrolle.

## Nachweise

Transporttests verwenden die echten Adapter mit injizierten Fetch-Antworten. Sie prüfen
Requestform, Zuordnung, Template-Ausschluss, Teilmengen, Grants, Fehlerzustände,
Antwortgrößen, Streamabbruch und Redirectverbot. Komponenten- und Browsertests prüfen
expliziten Abruf, fehlende Daten, Datengrundlage und Zugriffsfehler.
Es wurden keine privaten Live-Instanzen oder Buchhaltungskonten angesprochen.
Die manuelle Abnahme mit den tatsächlichen Anbieteraccounts bleibt beim Betreiber.
