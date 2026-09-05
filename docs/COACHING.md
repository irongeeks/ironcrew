# Coaching, Evaluationen und freigegebene Guidance

IronCrew verbindet dokumentierte Beobachtungen mit konkreten Änderungsvorschlägen
für die Arbeitsweise eines Agenten. Eine menschliche Owner-Entscheidung übernimmt
die geprüfte Änderung als neue, nachvollziehbare Guidance-Version. Ein Vorschlag,
eine bestandene Prüfung oder eine Lesson Learned verändert den Agenten noch nicht.

## Ablauf in der Oberfläche

1. **Coaching** öffnen und einen Agenten auswählen. Die aktive Guidance, ihre
   Versionsnummer und die freigebende Person sind sichtbar.
2. Ein **1-on-1**, eine **Retrospektive** oder eine **Lesson Learned** mit
   Beobachtungen, Vereinbarungen und nächsten Schritten speichern. Eine optionale
   Run-ID verweist auf einen abgeschlossenen Run dieses Agenten.
3. Eine neue Coaching-Guidance vorschlagen. Der Text ersetzt die bisherige
   Coaching-Ergänzung vollständig; die aktive Version lässt sich als Ausgangspunkt
   laden. Professionelle Rolle, Persona und Sicherheitsrichtlinien bleiben bestehen.
4. Bereits installierte Skill-Referenzen auswählen und konkrete Prüfkriterien
   formulieren. Es werden keine Community-Pakete installiert oder Tools freigegeben.
5. **Kriterien auswerten**. Jede Prüfung zeigt ihr Ergebnis, den Beobachtungswert
   und gegebenenfalls den gespeicherten Run mit einem SHA-256-Nachweis.
6. Als Owner die tatsächliche Änderung und die Ergebnisse prüfen und eine
   Begründung eingeben. **Freigeben und übernehmen** erzeugt eine neue Version;
   **Ablehnen** beendet den Vorschlag ohne Änderung der aktiven Guidance.

Freigegebene Guidance gilt für nachfolgende Runs; laufende Prozesse werden nicht
umgeschrieben. Der Versionsverlauf hält frühere Texte, Skill-Auswahl, Vorschlag,
Owner und Zeitpunkt fest. Eine Korrektur ist ein neuer Vorschlag auf der aktuellen
Version. Es gibt keine automatische Beförderung oder Änderung des Kerncodes.

## Was eine Evaluation aussagt

Der Evaluator führt deterministische Bedingungen aus, keine subjektive
LLM-Selbstbewertung. Ein Ergebnis „3 von 4 Kriterien bestanden“ bedeutet genau das;
es ist weder eine objektive Genauigkeitsnote noch eine Aussage über die generelle
fachliche Qualität des Agenten.

| Prüfung                             | Ausgewertete Quelle                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Guidance enthält Text               | Exakter, groß-/kleinschreibungssensitiver Teiltext im vorgeschlagenen Guidance-Text                                       |
| Guidance vermeidet Text             | Derselbe Teiltextvergleich mit erwartetem Nichtvorkommen                                                                  |
| Installierte Skill-Referenz gewählt | Skill-Auswahl im Vorschlag, mit Installationsnachweis dieser Firma                                                        |
| Gespeicherter Run abgeschlossen     | Persistierter Run-Status muss `completed` sein                                                                            |
| Gespeichertes Ergebnis enthält Text | Teiltext in normalisierten `message.completed`-Texten bzw. `run.completed`-Zusammenfassungen; Run muss abgeschlossen sein |

Run-Prüfungen lesen echte gespeicherte Ergebnisse. Token- und Kostenwerte stammen
aus diesem Run; unbekannte Subscription-Preise werden nicht geschätzt. Der
Nachweis-Hash umfasst die verwendeten Run-Metadaten und Ergebnis-Events. Rohtexte
aus fremden Runs werden nicht in den Coaching-Ergebnisbericht kopiert.

Historische Runs belegen vergangene Arbeit. Sie beweisen **nicht**, dass die noch
nicht freigegebene Guidance ein besseres Ergebnis erzeugt. Das Panel startet
keine zusätzlichen Provider-Runs. Für einen Wirksamkeitsvergleich nach Freigabe
dieselbe fachliche Aufgabe unter kontrollierten Bedingungen erneut ausführen und
die neuen Run-Nachweise in einer Folgeevaluation vergleichen. Stichwortprüfungen
ersetzen keine menschliche fachliche Abnahme.

## Zustände und Grenzen

Ein Vorschlag ist nach Erstellung inhaltlich unveränderlich:

- `draft`: gespeichert, noch nicht ausgewertet.
- `ready`: sämtliche gespeicherten Prüfkriterien bestanden; Owner-Review möglich.
- `failed`: mindestens eine Prüfung nicht bestanden; Freigabe technisch gesperrt.
- `applied`: Owner hat geprüft und die neue Guidance-Version ist gespeichert.
- `rejected`: begründet abgelehnt; keine Änderung der aktiven Guidance.

Eine erneute Auswertung eines offenen Vorschlags erzeugt einen zusätzlichen,
persistierten Evaluationsdatensatz. Die Oberfläche zeigt das jüngste Ergebnis.
Abgeschlossene Vorschläge können nicht erneut ausgewertet oder übernommen werden.

Maximal 30 Kriterien je Vorschlag, 12.000 Zeichen Guidance, 40 Skill-Referenzen und
4.000 Zeichen Review-Begründung. Run-Nachweise sind auf 2.000 Ergebnis-Events und
2 Millionen gespeicherte JSON-Zeichen begrenzt. Listen zeigen die letzten 100
Vorschläge, Notizen und Versionen pro Agent; ältere Einträge bleiben in SQLite.

## Berechtigungen und Zuverlässigkeit

- Lesender Zugriff benötigt eine Crew-Anmeldung. Operatoren dürfen Vorschläge,
  Beobachtungen und Auswertungen erstellen. Nur aktive Owner dürfen Änderungen
  freigeben oder ablehnen. Im bestehenden Bootstrap-Modus gilt die lokale,
  authentifizierte Vor-Account-Installation als CEO.
- Der Store prüft die Owner-Berechtigung zusätzlich zur HTTP-Route. Agenten oder
  Routinen können keine Freigabe erzeugen. Vom Client gelieferte Rollen,
  Firmen-IDs, Score-Felder und Policy-Änderungen werden nicht akzeptiert.
- Agent, Vorschlag, installierte Skills und Run-Nachweise werden an die Firma
  gebunden. Fremde oder noch laufende Runs sind als Nachweis unzulässig.
- Bei der Freigabe werden Basisversion, Installationsfingerprints und Ergebnisse
  erneut geprüft. Ein inzwischen geänderter Skill oder Run entwertet die frühere
  Auswertung; eine konkurrierend freigegebene Guidance entwertet die Basisversion.
- Version, Entscheidung und Audit-Eintrag werden in einer SQLite-Transaktion
  geschrieben. Scheitert der Audit-Eintrag, bleibt auch die Guidance unverändert.
- Pro Vorschlag verbindet eine Correlation-ID Erstellung, Evaluation und
  Entscheidung. Guidance-Inhalte werden im Audit als Hash statt als Prompt-Dump
  erfasst; sensible Muster werden vor Speicherung redigiert.
- Skill-Auswahl ist eine Referenz auf bereits installierte Fähigkeiten. Sie
  erweitert keine Netzwerk-, Dateisystem-, Tool- oder Freigaberechte. Policy
  bleibt übergeordnet; die Persona ist keine Quelle fachlicher Befugnisse.

## API und Speicherung

Alle Routen liegen unter `/api/crew/coaching` und verwenden die bestehende
Crew-Identität und den regulären API-/CSRF-Transport.

| Methode und Pfad               | Inhalt                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `GET /?agentId=…`              | Aktive Version, Versionsverlauf, Vorschläge mit jüngster Evaluation, Notizen, verfügbare installierte Skills |
| `POST /proposals`              | `{agentId,title,guidance,skills,cases}`                                                                      |
| `POST /proposals/:id/evaluate` | Leeres Objekt; der Server berechnet die Ergebnisse                                                           |
| `POST /proposals/:id/review`   | `{decision: "approve"                                                                                        | "reject", reason}`; nur Owner |
| `POST /notes`                  | `{agentId,kind,title,body,runId?}`                                                                           |

Migration `0031-crew-coaching.ts` ergänzt `crew_coaching_proposals`,
`crew_coaching_evaluations`, `crew_agent_guidance_versions` und
`crew_coaching_notes`. Die Daten bleiben beim Prozessneustart erhalten. Die
Agenten-Ergänzung verändert keinen geteilten Talent-Datensatz und betrifft damit
nicht unbeabsichtigt weitere Agenten mit demselben Talent.

Implementierung: `server/ironcrew/domain/coaching-store.ts`,
`server/ironcrew/api/coaching-routes.ts`, `src/shared/coaching.ts` und
`src/ironcrew/CoachingPanel.tsx`. Die Domain-/API-Tests decken den vollständigen
Freigabefluss, Neustart, falsche Firmenzuordnung, Berechtigungen, fehlgeschlagene
Qualitätsprüfungen, veraltete Basisversionen/Nachweise und Audit-Rollback ab.
