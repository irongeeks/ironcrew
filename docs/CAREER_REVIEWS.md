# Mitarbeiterlevel und fachliche Reviews

## Einrichten

1. Im Command Center **Team & Leistung** öffnen. Im lokalen Single-Owner-Modus ist die Einrichtung direkt verfügbar; nach Anlegen menschlicher Konten ist dafür die Ownerrolle erforderlich.
2. Für den vorgesehenen Abteilungslead eine Leveländerung anfragen und die erzeugte Freigabe in der Decision Inbox bestätigen. Junior und Senior lassen sich auf demselben Weg zuweisen.
3. Unter **Modell-Routing** die vorhandenen Profile auf konkrete Runtimes/Modelle legen und den Mitarbeitern zuordnen, beispielsweise ein günstiges `fast`-Profil für Junioren und `deep_reasoning` für anspruchsvolle Arbeit. Die Levelbezeichnung allein wählt kein Modell aus.
4. Pro Abteilung den genehmigten Lead festlegen und für dessen eigene Arbeit einen unabhängigen QA-/COO-Reviewer zuweisen. Danach die Abteilung und die globale Lead-Delegation aktivieren.
5. Neue Aufgaben starten. Zuweisung, Facharbeit und Review erscheinen als getrennte, verknüpfte Aufgaben und Runs. Bei fehlendem Reviewer bleibt die Bewertung ausdrücklich offen.
6. Im Mitarbeiterprofil und unter **Team & Leistung** Durchschnitt, Anzahl, Verteilung und begründete Reviews vergleichen. Schwierigkeit, Zeitraum und das tatsächlich protokollierte Modell können gefiltert werden.

Routing und Reviews verbrauchen ebenfalls Runtime-Kapazität und Budget. Ihre Kosten bleiben separat sichtbar und zählen zugleich gegen das Budget der ursprünglichen Aufgabe, ohne die Firmenkosten doppelt zu zählen. Der CEO kann ein Ergebnis trotz ausstehendem Review abnehmen; das ersetzt keine Bewertung und unterdrückt den unabhängigen Review nicht.

## Verhalten und Nachweise

IronCrew trennt den Mitarbeiterlevel (`junior`, `senior`, `lead`) von Professional Role, Persona, Vessel, Routingprofil und Toolrechten. Bestehende Mitarbeiter erhalten im neuen System zunächst `senior`; die Funktion bleibt standardmäßig deaktiviert. Eine Änderung gewährt keine zusätzlichen Tools oder Sandboxrechte. Bei der Aktivierung wird ein persistierter Snapshot vorhandener Aufgaben der betroffenen Abteilungen gespeichert: Sie werden nicht nachträglich in den Lead-Ablauf gezwungen. Bereits explizit begonnene Workflows bleiben zugeordnet.

Owner konfigurieren pro Firma und Abteilung eine genehmigte Lead-Person. Jede Leveländerung erzeugt eine `agent_lifecycle_change`-Freigabe in der bestehenden Decision Inbox. Erst nach gültiger Ownerentscheidung, erfülltem Quorum, passender Firmen-/Agentenbindung und unveränderter Ausgangsversion wird die neue Levelversion persistiert. Abgelaufene, manipulierte oder inzwischen überholte Freigaben ändern keinen Level. Konfiguration und Levelverlauf sind auditierbar.

Die tatsächliche Lead-Zuweisung und das fachliche Review laufen als eigene sichtbare Tasks mit eigenen Runtime-Runs. Ein Junior darf ausschließlich einfache, risikoarme und nicht sensible Aufgaben innerhalb seiner Abteilung übernehmen. Diese Bedingungen werden serverseitig geprüft. Eine Lead-Einstufung allein ändert weder Modell noch Berechtigungen.

Reviews akzeptieren ausschließlich ganzzahlige Gesamt- und Rubrikbewertungen von 1 bis 5, eine Begründung und Quellenhinweise. Rubrikversion 1 bewertet Korrektheit, Vollständigkeit und Qualität. Die aktuelle Abteilungsleitung bewertet die Mitarbeiter ihrer Abteilung. Für ihre eigene Arbeit muss ausdrücklich eine unabhängige QA-/COO-Person konfiguriert sein. Selbstbewertungen sind gesperrt; bloße Anzeigenamen oder Agentenschlüssel begründen keine QA-Berechtigung. Fehlende Reviewer und fehlgeschlagene Reviews bleiben als Workflowstatus sichtbar und erzeugen keine erfundenen Sterne.

Jede Bewertung bindet den abgeschlossenen Arbeitsrun und einen separaten abgeschlossenen Reviewrun. Runtime, Modell und Vessel beider Runs werden unveränderlich gespeichert. Die Daten stammen aus den tatsächlichen persistierten Runs, niemals aus einem später geänderten Agentenprofil. Ein leeres Modell bleibt unbekannt; ein CLI-Alias ist keine bestätigte konkrete Modellversion. Die Rubrikversion ist von der Reviewrundennummer getrennt. Datenbanktrigger verhindern nachträgliches Ändern oder Löschen von Bewertungen.

Die Historie enthält auch verspätete Reviews älterer Arbeitsruns. Für Mittelwert und Verteilung wird je Aufgabe ausschließlich die Bewertung ihres neuesten abgeschlossenen Arbeitsruns berücksichtigt, genau einmal. Eine noch ausstehende neue Bewertung reaktiviert keine alte Bewertung. Filter nach Zeitraum, Schwierigkeit oder Modell werden erst nach dieser Auswahl auf die angezeigten Ergebnisse angewendet. Mitarbeiter- und Modellgruppen zeigen Anzahl, arithmetischen Mittelwert, Verteilung, Schwierigkeit und Revisionsanzahl. Diese Werte beschreiben die beobachteten Aufgaben und Reviewerurteile; sie sind kein objektiver Modellbenchmark und führen zu keiner automatischen Beförderung.

Fehlgeschlagene interne Workflows können nach expliziter Owner-Revision und erneuter Vorbereitung ihrer Aufgabe wieder geöffnet werden. Abgeschlossene Bewertungen bleiben gesperrt. Dadurch entsteht kein automatischer Wiederholungszyklus.

API: `GET /api/crew/people` (optional `from`, `to` als Epoch-Millisekunden, `difficulty`, `model`), `PUT /api/crew/people/config`, `POST /api/crew/people/agents/:id/level`. Schreibzugriffe benötigen die Ownerrolle; die API bietet keine Route zum freien Erstellen oder Ändern von Sternen. Die globale Crew-Authentifizierung und CSRF-Middleware gelten weiterhin.
