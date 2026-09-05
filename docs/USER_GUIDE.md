# IronCrew im Alltag

**COMMAND** ist die Firmensteuerung: Der CEO gibt dem Executive Assistant Aufträge, die Crew bearbeitet sie, und Ergebnisse kommen zur Abnahme zurück. Office, Aufgabenboard und CEO-Kanal verwenden dieselben Agenten und Aufgaben.

## Office und Orientierung

Das Gebäude zeigt unterschiedlich eingerichtete Abteilungsbüros, Flure, Lounge, Meetingraum und Entscheidungszone. Ein Klick auf eine Figur öffnet ihr Mitarbeiterprofil; das Raumschild führt in den Raumfokus. **Gebäudeübersicht** kehrt zurück, **Einpassen** passt die Darstellung an den verfügbaren Platz an.

**Liste** zeigt dieselben Mitarbeiter als zugängliche DOM-Ansicht. **Bürobewegung pausieren** hält die Bereitschaftsanimation an; die Einstellung für reduzierte Bewegung des Browsers wird ebenfalls berücksichtigt.

Mitarbeiter in Bereitschaft können umherlaufen und Gesprächsgesten zeigen. Diese Animation erzeugt keine Modellaufrufe und keine echten Chatnachrichten. Arbeits-, Meeting-, Freigabe- und Fehlerzustände kommen vom Backend und haben Vorrang. Details: [Lebendiges Office](LIVING_OFFICE.md).

## Aufträge, Projekte und Ergebnisse

Schreibe im **CEO-Kanal** möglichst das gewünschte Ergebnis, den Projektbezug und die Abnahmekriterien. Beispiel: „Erstelle für das ausgewählte Projekt eine Backup-Checkliste. Sie soll Sicherungsumfang, Aufbewahrung und einen Restore-Test beschreiben.“ Wähle bei vorhandenen Projekten den Projektkontext im Chat.

Einfache Aufträge werden triagiert und zugewiesen. Größere Projektaufträge können zunächst einen EA-Plan erzeugen. Unter **Projektpläne** prüfst du Ziel, Scope, Annahmen, Risiken, Budget, Verantwortliche und Abhängigkeiten. Erst die Freigabe erzeugt den Task-Baum. Ein Plan mit unbekanntem Budget benötigt ein bereits gesetztes positives Projekt-Hardlimit.

Das Board zeigt den persistierten Arbeitsstand. Öffne eine Aufgabe für ihre Ausführung und Ergebnisse. **Warteschlange** erklärt verzögerte Starts und Wiederholungen. Nach Abschluss erscheint die Aufgabe unter **Zur Abnahme**: **Abnehmen** schließt sie ab, **Revision** mit einer konkreten Begründung fordert Überarbeitung an.

## Entscheidungen und Budgets

Freigabepflichtige Aktionen erscheinen unter **Entscheidungen**. Prüfe die vorgeschlagene Aktion, ihren Umfang und die verfügbaren Nachweise, bevor du **Freigeben** oder **Ablehnen** wählst. Bei Bedarf lässt sich ein Mehr-Augen-Quorum verlangen. Eine fachliche Sternebewertung ersetzt diese Entscheidung nicht.

Budgetgrenzen und Runtime-Kapazität gelten auch für Planung, Lead-Zuweisung und Reviews. Unbekannte Subscriptionkosten werden nicht als erfundener Geldbetrag angezeigt. Ein bewilligter Plan oder eine Freigabe richtet außerdem keinen noch fehlenden Bank-, Mail- oder Deploymentadapter ein; der tatsächlich angebundene Umfang steht in den jeweiligen [Business-Packs](BUSINESS_PACKS.md).

## Mitarbeiter und Modelle

Im Mitarbeiterprofil sind fachliche Rolle, Ausführungsrahmen und Erscheinungsbild getrennt:

| Einstellung | Wirkung |
| --- | --- |
| Talent / fachliche Rolle | Kompetenz, Guidance und zugeordnete Policy |
| Vessel | Runtime, Modell, Timeout, Wiederholungen und Parallelität |
| Routingprofil | Konkrete primäre Modellroute und ausdrücklich erlaubte Fallbacks |
| Mitarbeiterlevel | Junior, Senior oder Lead im Abteilungsworkflow |
| Figur | Erscheinungsbild, private Medien und Statusanimation |

Unter **Modell-Routing** lassen sich `fast`, `balanced`, `deep_reasoning`, `coding`, `research`, `legal_research`, `finance`, `vision` und `long_context` konkreten verfügbaren Runtimes und Modellen zuordnen. Ein Profilname bestätigt keine Fähigkeit und wählt ohne Einrichtung kein Modell. Die zentrale Vendor-Policy und Budgetgrenzen bleiben wirksam.

### Junior, Senior und Lead aktivieren

1. **Team & Leistung** öffnen und die gewünschten Leveländerungen beantragen.
2. Die zugehörigen Freigaben unter **Entscheidungen** bestätigen.
3. Modelle über **Modell-Routing** zuordnen: beispielsweise ein günstiges Profil für Junioren und ein leistungsfähigeres für anspruchsvolle Facharbeit.
4. Pro Abteilung einen genehmigten Lead und für dessen eigene Arbeit einen unabhängigen QA-/COO-Reviewer festlegen.
5. Die Abteilung und die globale Lead-Delegation aktivieren.

Die Funktion ist standardmäßig deaktiviert. Neue Aufgaben folgen nach Aktivierung dem Lead-Ablauf; vorhandene Aufgaben werden nicht nachträglich hineingezwungen. Junioren dürfen nur einfache, risikoarme und nicht sensible Aufgaben ihrer Abteilung übernehmen. Eine höhere Stufe vergibt keine zusätzlichen Tool- oder Sandboxrechte.

### Bewertungen lesen

Der Lead bewertet abgeschlossene Facharbeit mit 1–5 Sternen, Begründung und Quellen. Selbstbewertungen sind gesperrt. Fehlende oder fehlgeschlagene Reviews bleiben sichtbar und erhalten keine künstlichen Sterne.

**Team & Leistung** und das Mitarbeiterprofil zeigen Durchschnitt, Anzahl, Verteilung und Historie. Die Auswertung nutzt je Aufgabe die Bewertung des neuesten abgeschlossenen Arbeitsruns; eine neue, noch unbewertete Revision übernimmt keine alten Sterne. Filter nach Schwierigkeit, Zeitraum und tatsächlich protokolliertem Modell helfen beim Vergleich. Beachte die Anzahl und Art der Aufgaben: Ein hoher Durchschnitt bei wenigen einfachen Tasks ist kein allgemeiner Modellbenchmark. Details: [Team und Leistung](CAREER_REVIEWS.md).

## Figuren zuweisen oder selbst erstellen

Öffne im Mitarbeiterprofil den Figureneditor, wähle eines der **20 Originale**, prüfe die Vorschau und wähle **Figur speichern**. Optional lassen sich ein privates Portrait und ein Ganzkörperbild hochladen.

Unter **Prompt für eine eigene Figur erstellen** kannst du Identität und Stil beschreiben und den **Generator-Prompt kopieren**. Verwende den Text in deinem gewählten Bildmodell und lade das Ergebnis anschließend hoch. Das Kopieren ruft selbst kein Bildmodell auf. Private Uploads gehören nicht zu den öffentlichen Repository-Assets. Formate, Spritesheets, GLB-Vorschau und Löschung erklärt [Figuren](CHARACTERS.md).

## Wissen und Integrationen

Unter **Wissen** findest du lokale Memory-Einträge und ihre Quellen. Der Obsidian-kompatible Vault bleibt für lesbare Notizen maßgeblich; operative Aufgaben, Runs und Referenzen liegen in SQLite. Honcho ist optional und standardmäßig deaktiviert. Ein Honcho-Ausfall soll lokale Arbeit nicht blockieren; Details zu Klassifikation und Synchronisierung stehen in [Memory](MEMORY.md).

**E-Mail**, **Messenger**, **Kanäle** und Business-Packs benötigen ihre jeweilige Einrichtung. Prüfe Status und dokumentierten Funktionsumfang, bevor du echte Kundenaufträge darüber ausführen lässt. [E-Mail](MAIL.md) · [Messenger](MESSENGER.md) · [Business-Packs](BUSINESS_PACKS.md)

## Updates und Datensicherung

Unter Einstellungen → **Version und Updates** werden installierte und verfügbare Version sowie der passende Installationsweg angezeigt. Die Aktualisierung selbst erfolgt im Wartungsfenster auf dem Host mit den dokumentierten Werkzeugen. Sichere Datenbank, private Figuren, Anhänge, Vault und lokale Konfiguration gemeinsam.

[Releases und Updates](RELEASES.md) · [Backup und Restore](BACKUP_RESTORE.md) · [Dokumentationsübersicht](README.md)
