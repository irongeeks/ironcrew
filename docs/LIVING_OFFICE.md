# Das lebendige Firmengebäude

Das moderne 2D-Office besitzt eigene Räume für die tatsächlichen Abteilungen der
Firma. Engineering, Infrastruktur, Security, Finance, Legal, Research, QA, Design,
Marketing, Sales, Knowledge, Automation und Vorstand erhalten unterschiedliche
Arbeitsplätze und Ausstattung. Weitere Abteilungen werden aus dem Firmenzustand
angeordnet. Die Lounge mit Kaffeebar, Flure, Meetingraum und Entscheidungszone
verbinden die Räume. Figuren behalten ihre kanonischen Agent-IDs, privaten Medien
und Verknüpfungen zu Aufgaben und Profilen.

## Bedienung

- Ein Raumschild oder die Abteilungswahl öffnet den Raumfokus. **Gebäudeübersicht**
  kehrt zum gesamten Gebäude zurück; **Einpassen** und **100 %** steuern die Ansicht.
- **Liste** zeigt dieselben Mitarbeiter und Aufgaben als bedienbare DOM-Ansicht,
  insbesondere für schmale Bildschirme und Tastaturnavigation.
- Figuren öffnen das Mitarbeiterprofil. Aufgaben und laufende Meetings öffnen
  weiterhin die tatsächlichen zugehörigen Daten.
- **Bürobewegung pausieren** hält die Bereitschaftsanimation an. Reduzierte Bewegung
  auf Betriebssystem-/Browserebene und unsichtbare Hintergrundtabs stoppen sie ebenfalls.

## Bereitschaft und tatsächliche Arbeit

Mitarbeiter in Bereitschaft können ihren Arbeitsplatz verlassen, über Türen und
Flure andere Bereiche besuchen und an Treffpunkten kurze Gesprächsgesten zeigen.
Die Routen und Pausen sind deterministisch aus ihren IDs abgeleitet. Maximal drei
Besucher sind gleichzeitig unterwegs; längere Aufenthalte halten das Bild ruhig.
Beim Zeigen mit der Maus oder Tastaturfokus bleibt eine Figur bedienbar stehen.

Diese Gesten sind visuelles Bereitschaftsverhalten und erzeugen keine Aufträge,
Chatnachrichten, Kosten oder Modellaufrufe. Tatsächliche Arbeits-, Meeting-,
Freigabe-, Pausen- und Fehlerzustände kommen aus dem Backend und haben Vorrang.
Echte Meetings bleiben mit Thema, Teilnehmern und Verlauf verknüpft.

## Umsetzung und Nachweise

- `office-building-layout.ts`: Abteilungsräume, Arbeitsplätze, Türen und Weggraph.
- `OfficeBuilding.tsx`: originale SVG-Einrichtung und Architektur.
- `office-motion.ts`: reine Zustands- und Routenberechnung.
- `useOfficeMotion.ts`: DOM-Transformationen über Animation Frames; keine React-
  Neuberechnung des gesamten Dashboards pro Frame. Listener und Frames werden
  beim Verlassen der Ansicht aufgeräumt.
- `CrewOffice.tsx`: Raumfokus, Filter, Profile, Aufgaben und zugängliche Listenansicht.

Unit-/Komponententests prüfen Layout, Wege, Statuspriorität, Kapazität, Pausen und
Cleanup. `tests/e2e/flows/living-office.spec.ts` prüft Räume und Raumfokus, mobile
Listen sowie Gehen/Pause/Reduced Motion mit einer kontrollierten Animationsuhr.
Die aktuelle Browser- und Plattformabnahme ist am jeweiligen PR/Commit nachzulesen;
Screenshots zeigen die tatsächliche Oberfläche mit den CI-Firmendaten.
