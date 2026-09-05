# Objektive Tests und Modellvergleich

Unter **Command Center → Objektive Tests** prüft IronCrew gespeicherte finale Run-Nachrichten anhand expliziter Kriterien. Jede Messung verweist auf Firma, Aufgabe, Mitarbeiter, Runtime, erfassten Modellnamen und eine unveränderliche Rubrikversion. Es wird kein zusätzlicher Modellaufruf gestartet.

## Bedienung

1. Der Owner erstellt eine Rubrik mit stabiler Kennung, Titel, Änderungsgrund und bis zu 30 Einzelprüfungen. Kriterien möglichst **vor** der Arbeit festlegen.
2. Ein Owner oder Operator wählt diese Rubrikversion und einen abgeschlossenen Run.
3. **Run auswerten** speichert jedes Einzelresultat, Erfüllungsquote, Hashes und Audit-Bezug. Nicht erfüllte Prüfungen bleiben sichtbar.
4. **Nachweis reproduzieren** wiederholt die Prüfungen auf dem gespeicherten, redigierten Evidenzsnapshot. Eine erneute Auswertung derselben Rubrik/Run-Kombination erzeugt keine zusätzliche Stichprobe.
5. **Version überarbeiten** erstellt eine neue Version; frühere Kriterien und Ergebnisse bleiben erhalten. Bei zwischenzeitlichen Änderungen verweigert der Server die Speicherung mit HTTP 409. Den erhaltenen Entwurf anhand des aktualisierten Verlaufs abgleichen.

| Prüfart             | Bedeutung                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Enthält Text        | Exakte Zeichenfolge, Groß-/Kleinschreibung wird beachtet.                                                                                       |
| Enthält keinen Text | Die Zeichenfolge fehlt im redigierten Ergebnis.                                                                                                 |
| JSON-Feld hat Typ   | Gesamter Output ist gültiges JSON; ein eigener Feldpfad besitzt den angegebenen Typ. Unterstützt: string, number, boolean, array, object, null. |

Mehrere `message.completed`-Texte eines Runs werden in Ereignisreihenfolge mit Zeilenumbrüchen verbunden. `run.completed.summary` wird nicht nochmals angehängt. Markdown-Codezäune werden nicht stillschweigend entfernt; JSON-Prüfungen benötigen reines JSON. Im UI sind Feldpfade punktgetrennt, die API verwendet ein Array von Schlüsseln. Es werden keine Skripte, Shell-Befehle oder regulären Ausdrücke ausgeführt.

## Aussagekraft und Vergleich

Die Quote ist `erfüllte Kriterien / alle Kriterien × 100`, auf zwei Nachkommastellen gerundet. Der Vergleich gruppiert nach **exakter Rubrikversion, Mitarbeiter, Runtime und gespeichertem Modellnamen** und zeigt den arithmetischen Mittelwert dieser Run-Quoten sowie die Anzahl eindeutiger Runs. Verschiedene Rubrikversionen werden nicht vermischt.

Die 1–5 Lead-Sterne bleiben eine separate fachliche Einschätzung. Objektive Prüfungen ersetzen weder ein Lead-Review noch eine CEO-Freigabe. Sie befördern keine Mitarbeiter und ändern keine Modellzuordnung. Unterschiedliche Aufgaben, Stichprobenauswahl und schwierige Inhalte können Vergleiche verzerren. Eine erfüllte Textprüfung beweist das Vorhandensein des Texts, keine fachliche Richtigkeit. Für belastbare Modellentscheidungen dieselben Aufgaben und vorab festgelegten Kriterien mit mehreren Modellen bearbeiten lassen.

Ein nicht erfasster Modellname wird als **Standardmodell nicht erfasst** angezeigt. MockRuntime-Daten bleiben als `mock` erkennbar und sind keine Ergebnisse eines echten Providers.

## Persistenz und Sicherheit

- Migration `0037` ergänzt `crew_objective_rubrics` und `crew_objective_measurements`. Beide Tabellen verweigern reguläre Updates und Löschungen per SQLite-Trigger.
- Rubrikänderungen sind Owner-Aktionen mit Versionskonfliktprüfung. Messungen erfordern mindestens Operatorrechte. Angemeldete Viewer dürfen Ergebnisse und Replay lesen; sie erhalten keine Rohoutputs.
- Alle Referenzen werden auf die aktive Firma geprüft. Task, Agent und Run müssen zusammengehören; inkonsistente Event-Zuordnungen werden abgelehnt. Nur `completed` mit vorhandenem finalem Textergebnis ist auswertbar.
- Grenzen: 30 Kriterien, 2.000 finale Nachrichten, 2 MB gespeicherte Event-Payloads pro Run. Zu große Nachweise werden mit HTTP 413 abgelehnt. Prototype-Schlüssel sind als JSON-Feldpfade ausgeschlossen.
- Secrets in Kriterien werden abgelehnt, statt das Prüfkriterium heimlich zu verändern. Output-Snapshots werden nochmals redigiert. Die API zeigt Hashes und Prüfergebnisse, keine kopierten Rohoutputs.
- Audit erfasst Actor, Rubrikversion, Run/Task, Hashes und Ergebnisse. Rubrik- und Evidenzsnapshot erlauben deterministische Wiederholung mit Engine-Version 1.
- Nach einer Änderung der ursprünglichen Run-Nachweise bleibt die alte Messung erhalten und reproduzierbar. Eine erneute Messung derselben Kombination verweigert den veränderten Nachweis mit HTTP 409.
- Anzeigegrenzen: letzte 200 Rubrikversionen, abgeschlossene Runs und Messungen; maximal 500 Vergleichsgruppen. Jede angezeigte Vergleichsgruppe umfasst alle ihre gespeicherten Messungen.

## API

| Methode | Pfad                               | Berechtigung |
| ------- | ---------------------------------- | ------------ |
| GET     | `/api/crew/evaluations`            | Viewer       |
| POST    | `/api/crew/evaluations/rubrics`    | Owner        |
| POST    | `/api/crew/evaluations/measure`    | Operator     |
| GET     | `/api/crew/evaluations/:id/replay` | Viewer       |

Beispiel für eine Rubrik, keine vorgetäuschten Messergebnisse:

```json
{
  "key": "report-format",
  "baseVersion": 0,
  "title": "Berichtsformat",
  "reason": "Abnahmekriterien vor dem ersten Vergleich festlegen.",
  "cases": [
    { "id": "source", "label": "Quellenabschnitt", "kind": "contains", "expected": "Quellen" },
    { "id": "claim", "label": "Keine unbelegte Garantie", "kind": "excludes", "expected": "garantiert fehlerfrei" }
  ]
}
```

Messung: `{"rubricId":"rubric_…","runId":"run_…"}`. Firma, Actor, Score oder Nachweise können nicht über den Request überschrieben werden.
