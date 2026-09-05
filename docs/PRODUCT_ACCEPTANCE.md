# Produktabnahme: lokaler IronCrew-MVP

Stand des Implementierungsumfangs für **0.3.0**. Diese Seite ordnet die MVP-Kriterien
des Master-Prompts konkretem Code und Tests zu. Ein vorhandener Test ist ein
prüfbarer Nachweisweg; sein Dateilink behauptet keinen erfolgreichen Lauf auf
jedem Commit. Die Gesamtprüfung des jeweiligen Release-Commits muss in
[CI](https://github.com/irongeeks/ironcrew/actions/workflows/ci.yml) und
[Plattformprüfung](https://github.com/irongeeks/ironcrew/actions/workflows/platform-production.yml)
grün sein. Release- und PR-Nachweise dokumentieren den tatsächlich geprüften Stand.

**Implementiert ist das integrierte lokale Produkt:** CEO-Kanal, eine gemeinsame
Firmen-/Aufgabendomäne, modernes Office, persistente Ausführung, Reviews,
Governance, Knowledge-Vault und installierbare Updates. Die unten getrennt
aufgeführte Abnahme mit mindestens einem echten CLI-Login bleibt erforderlich,
um das vollständige Master-Prompt-MVP auf dem Zielhost als abgenommen zu erklären.
Eine getestete MockRuntime oder ein Protokollfixture ersetzt diese Abnahme nicht.

## Implementierter Umfang und Nachweiswege

| MVP-Bereich | Implementierter Umfang | Nachprüfbare Belege |
| --- | --- | --- |
| Installation und Build | Gepinntes pnpm, lokale Entwicklung, Build, Tests; native Linux-/macOS-Anleitungen und Docker Control Plane | [package.json](../package.json), [Linux](LINUX_INSTALL.md), [macOS](MACOS_INSTALL.md), [Compose](../compose.yaml), [Plattformworkflow](../.github/workflows/platform-production.yml) |
| Gemeinsamer Firmenzustand | CEO-Kanal, Office und Kanban lesen dieselben persistierten Agenten, Aufgaben und Runs; Live-Updates statt separater Office-Wahrheit | [Company-Orchestrator](../server/ironcrew/orchestrator/company.ts), [Command Center](../src/ironcrew/CommandCenterView.tsx), [CEO-Browserworkflow](../tests/e2e/flows/iron-command-ceo-workflow.spec.ts) |
| Moderne Oberfläche | Abteilungsräume, originale Figuren, Raumfokus, Bereitschaftsbewegung, echte Statusdarstellung; responsive DOM-Liste und Reduced Motion | [Office-Bedienung](LIVING_OFFICE.md), [Office-Browsertest](../tests/e2e/flows/living-office.spec.ts), [Figuren](CHARACTERS.md) |
| Zugängliche Bedienung | Geschäftsdaten bleiben in DOM-Panels erreichbar; native modale Dialoge begrenzen den Tastaturfokus, schließen mit Escape und stellen Fokus wieder her | [Dialog](../src/ironcrew/DetailDialog.tsx), [Dialog-Tests](../src/ironcrew/DetailDialog.test.tsx), [Browserprüfung](../tests/e2e/flows/dialog-accessibility.spec.ts) |
| CEO → EA → Agent → Review | Triage, Planfreigabe, Delegation, persistierte Aufgaben und Ergebnisse; Abnahme und Revision | [Orchestrator-Tests](../server/ironcrew/orchestrator/company.test.ts), [Planworkflow](../server/ironcrew/orchestrator/project-plan-workflow.test.ts), [CEO-Browserworkflow](../tests/e2e/flows/iron-command-ceo-workflow.spec.ts) |
| Aufgaben und Wiederanlauf | Zustandsmaschine, atomare Claims, Ausführungssperren, Queue, Retry, Rate-Limit-Fortsetzung und Recovery | [Task-State-Tests](../server/ironcrew/domain/task-state.test.ts), [Task-Store-Tests](../server/ironcrew/domain/task-store.test.ts), [Queue-Tests](../server/ironcrew/orchestrator/run-queue.test.ts), [persistente Startaufträge](../server/ironcrew/domain/run-request-store.test.ts) |
| Runtime-Protokoll | MockRuntime und Adapter für Claude Code, Codex, Antigravity und OpenRouter; Capability-/Auth-Probes, Streaming, Abbruch, Fehler, Sessions und Usage | [MockRuntime](../server/ironcrew/runtime/mock-runtime.ts), [CLI-Adaptertests](../server/ironcrew/runtime/cli-adapter-runtime.test.ts), [Streaming-Tests](../server/ironcrew/runtime/openrouter-streaming.test.ts), [CLI-Abnahme](CLI_RUNTIME_ACCEPTANCE.md) |
| Native Runner und Secrets | Authentifizierte Jobs, beschränkte Workspaces, lokale offizielle CLI-Logins; SecretRefs und Redaction; kein allgemeines Home-Mount | [Runner-Protokoll](RUNNER_PROTOCOL.md), [Roundtrip-Tests](../server/ironcrew/runner/runner-roundtrip.test.ts), [Secret-Runtime-Tests](../server/ironcrew/runner/secret-runtime.test.ts), [Redaction-Tests](../server/ironcrew/security/redaction.test.ts) |
| Approvals und Budgets | Technische Gates, feste Hochrisikotypen, Budget-Hardstops, Zuordnung und Audit auch für delegierte Arbeit | [Approval-Grenzen](../server/ironcrew/orchestrator/approval-boundaries.test.ts), [Tool-Freigaben](../server/ironcrew/orchestrator/runtime-tool-approval.test.ts), [Streaming-Budgets](../server/ironcrew/orchestrator/stream-budget.test.ts), [Budget-Routing](../server/ironcrew/policy/budget-routing.test.ts) |
| Vendor-Policy | Installation-YAML als Obergrenze, firmenbezogene Einschränkungen, Provider-Allowlist bis zum Runner | [Zentrale Policy](../config/vendor-policy.yaml), [Policy-Tests](../server/ironcrew/policy/vendor-policy.test.ts), [Editor und Durchsetzung](VENDOR_POLICIES.md), [Browserworkflow](../tests/e2e/flows/vendor-policy.spec.ts) |
| Aktive Konfiguration | Versionierte Owner-Einstellungen für Laufzeiten, Tool-Sperren, zusätzliche Freigaben und Memory; CAS, Audit und echte Admission-/Tool-/Memory-Durchsetzung | [Konfiguration](COMPANY_CONFIGURATION.md), [Storetests](../server/ironcrew/policy/company-configuration-store.test.ts), [API-Tests](../server/ironcrew/api/company-configuration-routes.test.ts), [Browserworkflow](../tests/e2e/flows/configuration.spec.ts) |
| Wissen und Provenienz | Obsidian-kompatibler Vault mit Quellen, Suche und externem Watcher; optional Honcho mit lokaler Rückfallebene, Outbox, Retry und Löschung | [Memory](MEMORY.md), [Vault-Tests](../server/ironcrew/memory/obsidian-provider.test.ts), [Hybrid-/Provenienztests](../server/ironcrew/memory/hybrid-provider.test.ts) |
| Mitarbeiter und Qualität | Junior/Senior/Lead, Modellprofile, fachliche Sterne mit Run-Nachweisen; getrennte deterministische Text-/JSON-Prüfungen mit versionierter Rubrik und Replay | [Karriereworkflow-Tests](../server/ironcrew/orchestrator/career-workflow.test.ts), [Team-Browserprüfung](../tests/e2e/flows/people-performance.spec.ts), [objektive Prüfungen](OBJECTIVE_EVALUATIONS.md), [Messungs-Storetests](../server/ironcrew/domain/objective-evaluation-store.test.ts), [Browserworkflow](../tests/e2e/flows/objective-evaluations.spec.ts) |
| Tatsächliche Geschäftsdaten | Expliziter Abruf vorhandener MSP-/Finance-Adapter, Quelle/Zeit/Datengrundlage, Toolgate, ehrliche Teilmengen und Fehlerzustände | [Quellenumfang](BUSINESS_DASHBOARD.md), [Adapter-/Dashboardtests](../server/ironcrew/packs/business-dashboard.test.ts), [API-Tests](../server/ironcrew/api/business-dashboard-routes.test.ts), [Browserworkflow](../tests/e2e/flows/business-dashboard.spec.ts) |
| Web-Auth und optionale Dienste | Lokale Sessions, Rollen und OIDC-Adapter; optionale Mail-, Messenger-, MCP- und Business-Integrationen mit dokumentiertem Umfang | [Sessiontests](../server/ironcrew/auth/session-store.test.ts), [OIDC-Tests](../server/ironcrew/auth/oidc-provider.test.ts), [Mail](MAIL.md), [Messenger](MESSENGER.md), [Business-Packs](BUSINESS_PACKS.md) |
| Betrieb, Updates und Restore | Release-Pakete, native/Docker-Updates, Backup/Restore, Linux-/macOS-Prüfungen, SBOM-/Lizenzinventur | [Releases](RELEASES.md), [Backup](BACKUP_RESTORE.md), [Plattformworkflow](../.github/workflows/platform-production.yml), [Releaseworkflow](../.github/workflows/release.yml) |

Die neuen Panels besitzen Komponenten- und Browserprüfungen mit Fehler-, Leer- und
Berechtigungszuständen. Browseraufnahmen verwenden gekennzeichnete Testdaten.
Ältere eingebettete README-Screenshots behalten ihre dokumentierte Herkunft;
sie sind keine Aufnahmen der Betreiberinstallation.

## Abnahme auf dem Betreiberhost

Diese Schritte benötigen ausschließlich Ressourcen, die das Repository und seine
CI nicht bereitstellen: den tatsächlichen Zielhost, lokale CLI-Installationen,
offizielle Logins oder bewusst eingerichtete Anbieter-/Geschäftskonten.

1. **Mindestens eine reale CLI-Runtime abnehmen.** Unter dem dedizierten
   Runner-Betriebssystemkonto offiziell anmelden. Version und ermittelte Fähigkeiten
   prüfen; CEO-Auftrag bis Stream, Ergebnis, Review und Revision ausführen.
   Cancel, Rate-Limit-/Fehleranzeige, verfügbare Session-Fortsetzung und Wiederanlauf
   dokumentieren. [Konkrete Checkliste](CLI_RUNTIME_ACCEPTANCE.md).
2. **Installation und Wiederherstellung auf dem Zielhost bestätigen.** Mit der
   tatsächlichen Konfiguration starten; anschließend auf einem isolierten Ziel
   Datenbank, Vault, private Figuren, Anhänge und erforderliches Verschlüsselungssecret
   wiederherstellen. Die bestandene CI-Wiederherstellung ersetzt diesen eigenen
   Daten-/Dateirechte-/Dienstkonto-Nachweis nicht. [Betrieb](SECURITY_OPERATIONS.md),
   [Restore](BACKUP_RESTORE.md).
3. **Nur gewünschte externe Dienste einzeln abnehmen.** Eigene Testkonten beziehungsweise
   freigegebene interne Ziele für OpenRouter, Honcho, MCP, OIDC, Mail/Messenger und
   die tatsächlich genutzten Business-Adapter einrichten. Erst dann reale Abrufe,
   Quellstatus, Beschränkungen, Quoten und Ausfallverhalten dokumentieren.
   Nicht verwendete optionale Dienste müssen für den lokalen Kernbetrieb nicht
   aktiviert werden.
4. **Tatsächlich genutzte Remote-Runner prüfen.** Falls Kundennetze oder entfernte
   Hosts vorgesehen sind, Enrollment, ausgehende Verbindung, Zertifikate, Scope,
   Widerruf und Wiederverbindung auf diesen Systemen abnehmen. Die Protokolltests
   behaupten keine Installation in einem Kundennetz.

Diese Liste ist keine Aufforderung zur automatischen Nutzung privater Logins oder
zu einem ungeprüften Produktivdeploy. Die UI-Einrichtung und CI-Artefakte allein
belegen weder Provider-Abrechnung noch reale Buchhaltungs-/Kundensysteme.

## Optionale Erweiterungen über den implementierten MVP hinaus

Das breite Master-Zielbild bleibt längerfristig größer als der lokale MVP.
Insbesondere werden folgende Funktionen nicht als fertig ausgegeben:

- Vollständige Agency-/CRM-Kennzahlen, MRR, Cashflow- oder Budgetprognosen benötigen
  eigene Adapter, belastbare Zeitreihen und explizite Berechnungsvorschriften.
  Das Geschäftsdashboard zeigt derzeit definierte Lesedaten der vorhandenen Quellen.
- Überweisungen, Steuerabgaben, Vertragsabschlüsse und produktive Änderungen
  benötigen jeweils konkrete sichere Schreibadapter und Abnahme. Ein vorhandenes
  Freigabegate implementiert die nachfolgende Business-Aktion noch nicht.
- Freie YAML-/Endpoint-/Secret-Administration aller denkbaren Dienste ist kein
  Bestandteil des Firmeneditors. Die vorhandenen Adapter werden in ihren
  dokumentierten, getrennten Konfigurationswegen eingerichtet.
- Umfangreichere semantische Schlussfolgerungen, automatische Präferenzinferenz,
  zusätzliche Memory-/Secret-Provider, PostgreSQL, HA und erweiterter Mehrfirmenbetrieb
  sind eigene Erweiterungen. Honcho-Suche ist keine umfassende automatische
  Persönlichkeitsmodellierung.
- Die objektiven Text-/JSON-Prüfungen führen keine beliebigen Testprogramme aus
  und ersetzen keine fachlichen Benchmarks, Rechts-/Buchhaltungsprüfung oder
  unabhängige Produktionssicherheitsabnahme.

Die [Roadmap](ROADMAP.md) trennt diese Erweiterungen von der notwendigen
Betreiberabnahme. Die ältere [Master-Matrix](MASTER_PROMPT_COVERAGE.md) enthält
historische Meilensteine; für die hier erweiterten Bereiche ist dieser Stand maßgeblich.
