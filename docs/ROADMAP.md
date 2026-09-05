# Roadmap

Die aktuelle [Produktabnahme](PRODUCT_ACCEPTANCE.md) ordnet den implementierten
lokalen MVP konkreten Code- und Testnachweisen zu. Die ältere
[Master-Prompt-Matrix](MASTER_PROMPT_COVERAGE.md) bewahrt frühere Meilensteine;
historische Phasenbezeichnungen sind keine Zusage, dass jede langfristige
Erweiterung bereits implementiert oder mit echten Accounts abgenommen ist.

## Implementierter Produktumfang für 0.3.0

Gemeinsame Company-Domäne, CEO-Workflow, modernes lebendiges Office, Karrierelevel,
Lead-Reviews, Modellrouting, Vendor-Freigaben und installierbare Updates sind vorhanden.
Hinzu kommen:

- [Firmenkonfiguration](COMPANY_CONFIGURATION.md): Owner verwalten zusätzliche
  Runtime-Grenzen, Tool-Sperren, Freigaben und Memory-Optionen versioniert und auditierbar.
  Die Werte werden bei der Ausführung angewendet; feste Schutzregeln bleiben verbindlich.
- [Geschäftsdaten](BUSINESS_DASHBOARD.md): die vorhandenen MSP-/Finance-Adapter
  liefern explizit angeforderte Messungen mit Quelle, Zeitpunkt und begrenzter Datengrundlage.
- [Objektive Run-Prüfungen](OBJECTIVE_EVALUATIONS.md): getrennte versionierte
  Text-/JSON-Kriterien, gespeicherte Messungen und reproduzierbare Nachweise ergänzen
  die fachlichen Lead-Sterne.
- [Memory](MEMORY.md): aktuelle Provenienz einer Quelldatei wird vor externem
  Upload und bei semantischen Treffern erneut geprüft; nicht mehr autorisierte
  Quellen bleiben nicht aufgrund alter Metadaten freigegeben.
- Native modale Dialoge mit Tastaturfokus, Escape und Fokuswiederherstellung.

Die endgültigen Gesamt- und Browserergebnisse gehören zum jeweiligen
Release-Commit. Es wird hier kein noch laufender CI-Lauf als bestanden ausgegeben.

## Nächster notwendiger Nachweis: Betreiberabnahme

1. Offizielle CLI unter dem dedizierten Runnerkonto auf dem tatsächlichen
   Linux-/macOS-Zielhost installieren und anmelden.
2. CEO → EA → Aufgabe → reale CLI → Live-Events → Review → Revision durchführen;
   Cancel, verfügbare Session-Fortsetzung, Fehler und Wiederanlauf prüfen.
3. Die eigene Installation auf einem isolierten Ziel wiederherstellen, einschließlich
   privater Figuren, Vault, Anhänge, Konfiguration und Verschlüsselungssecret.
4. Nur die gewünschten externen Dienste und Geschäftsadapter mit eigenen
   Testkonten oder freigegebenen internen Systemen abnehmen; Remote-Runner
   gegebenenfalls auf dem tatsächlichen entfernten Host prüfen.

[CLI-Checkliste](CLI_RUNTIME_ACCEPTANCE.md) · [Sicherer Betrieb](SECURITY_OPERATIONS.md) ·
[Backup/Restore](BACKUP_RESTORE.md) · [Abnahmematrix](PRODUCT_ACCEPTANCE.md)

## Optionale fachliche Erweiterungen

- CRM-/Agency-Quellen, MRR, Cashflow und belastbare Prognosen benötigen weitere
  Adapter und gemessene Daten; aus vorhandenen Ausschnitten werden keine
  Geschäftskennzahlen hochgerechnet.
- Business-Schreibabläufe nur mit konkreten Adaptern, Idempotenz, Audit und
  Freigaben ergänzen. Eine Entscheidung allein führt keine Bank-/Steuer-/Deploymentaktion aus.
- Objektive Evaluationen um gemeinsam definierte fachliche Testfälle erweitern;
  keine automatische Beförderung oder Änderung des Kerncodes aus einer Modellbewertung.
- Umfangreichere semantische Schlussfolgerungen nur mit nachvollziehbaren Quellen,
  Datenschutz und Löschung. Automatische Persönlichkeitsinferenz bleibt deaktiviert.
- Zusätzliche Konfigurations- und Adaptereditoren nur für tatsächlich unterstützte
  Funktionen; Secrets und Endpunkte bleiben in den dokumentierten Betreiberwegen.

## Optionale Infrastruktur

PostgreSQL, HA, zusätzliche Secret-/Memory-Adapter und erweiterter Mehrfirmenbetrieb
sind eigenständige Erweiterungen. Sie sind keine Voraussetzung für den lokalen
Single-Owner-MVP. OIDC und Remote-Runner besitzen bereits Implementierungen und
kontrollierte Tests; eine tatsächliche Installation benötigt die Betreiberabnahme.

Die CI-Inventur dokumentiert geerbte Lizenz-Ausnahmen, insbesondere Remotion;
sie ersetzt keine erforderliche Lizenzprüfung für den konkreten Einsatz.
