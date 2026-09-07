# Versionierte Modellbewertungen

Eine Modellnote entsteht ausschließlich durch eine explizite Qualitätsbewertung von 1 bis 5 mit Begründung. Ein erfolgreicher Test oder ein Review mit `passed` erzeugt keine Note. Die ursprünglichen Bewertungen bleiben unveränderlich erhalten; für die Stichprobe zählt je Bewerter, Artefaktversion und Modellaufruf nur die neueste Version. Gleichzeitige Korrekturen benötigen die passende `expectedVersion` und können die Stichprobe nicht vervielfachen.

Die Zuordnung prüft in demselben Bereich den tatsächlichen Auftrag, das unveränderliche Artefakt, eine erfolgreiche Werkzeugaktion mit diesem Ergebnis sowie den gespeicherten Modellaufruf mit passender Call-ID, Werkzeugname und Argumenthash. Mehrdeutige Zuordnungen oder manuell erzeugte Artefakte ohne Modellbezug erhalten keine erfundene Herkunft. Die Bewertung speichert Modell, Aktion, Artefaktversion und Inhalts-Hash.

Die Web-API akzeptiert ausschließlich persönliche Bewertungen des angemeldeten CEOs. `reviewerKind`, `reviewerId`, `modelId` und Auftrags-ID im Body sind nicht erlaubt; die Auftrags-ID stammt aus der geprüften Route. Ein vertrauenswürdiger interner Agentenaufruf des Dienstes kann einen vorhandenen Mitarbeiter als Reviewer verwenden; der Autor darf sich nicht selbst bewerten. Dieser Dienst führt keine automatische Agentenbewertung aus.

| API                                     | Inhalt                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/models/ratings`            | Getrennte menschliche/Agentenanzahl und Qualitätsmittel; gemessene Modelllatenz mit eigenem Stichprobenumfang                          |
| `GET /api/v1/orders/:id/model-ratings`  | Neueste Bewertungen sowie eindeutig zugeordnete, bewertbare Artefaktversionen                                                          |
| `POST /api/v1/orders/:id/model-ratings` | `{artifactVersionId,modelTurnId,quality,evidence,expectedVersion}`; neue Bewertung erwartet Version 0, Korrektur die bisherige Version |

POST läuft durch Session-, CSRF-, Idempotenz- und Schreibschutz der Zentrale. Die erwartete Bewertungsversion ist unabhängig von der Auftragsrevision.

In **Einstellungen → Modelle** erscheinen menschliche und Agentenbewertungen getrennt. Im Fachablauf eines Auftrags öffnet **Modellleistung bewerten** die Auswahl der nachweisbar gebundenen Version. Die Note ist anfangs leer und muss bewusst gewählt werden. Nach einer Korrektur erhöht sich die Bewertungsversion, nicht die Stichprobenzahl.

Latenzwerte stammen ausschließlich aus dem persistierten `model-turn.latencyMs`. Ohne Messung zeigt die Oberfläche „nicht gemessen“ und Stichprobe 0. Vorbereitungs-, Artefakt- oder Zahlungszeitpunkte werden nicht als Modelllatenz interpretiert. Mehrere Bewertungen desselben Turns erzeugen keine zusätzlichen Latenzmessungen.

`ratingRoutingStats(await new ModelRatings(repo).summaries(companyId, {orderKind}))` liefert ausschließlich menschliche Qualitätsmittel mit Stichprobenzahl, ergänzt um eine gemessene Latenz, falls vorhanden. Agentenmittel werden nicht in menschliche Qualität umgerechnet. Neutrale Routing-Defaults sind keine beobachteten Messwerte.

Nachweise: sechs Tests in `tests/unit/model-ratings.test.ts` verwenden eine isolierte echte SQLite-Datenbank und ausdrücklich synthetische Provenienz. Kein kostenpflichtiger Modellaufruf oder Produktionslatenznachweis wird damit behauptet. Der zusätzliche Browser-Vertragsfixture prüft getrennte Mittel/Stichproben, leere Notenvorauswahl und den exakten versionsgebundenen POST ohne behauptete Reviewer-Identität.
