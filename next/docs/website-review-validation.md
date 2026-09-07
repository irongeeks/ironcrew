# Prüfung der Website-Versionen und Rückmeldungen

Die unabhängige Prüfung hat folgende konkrete Fehler geschlossen:

- Eine vorbereitete, noch ungebaute Quellenrevision behält die letzte Vorschau zum Vergleich. Sie kann aber nicht mehr anhand dieses Vorgängers geprüft oder abgenommen werden. Neues Feedback setzt den Zustand nicht versehentlich von `selected` auf `built` zurück. Auch eine Erledigungsbestätigung wartet auf die gebaute aktuelle Version.
- Die gebündelte Übergabe zuvor gesammelter Rückmeldungen hebt eine zwischenzeitliche Abnahme atomar auf. Pins, Chatnachricht und Ausführungseingang bleiben gemeinsam gespeichert und versionsgebunden.
- Beim Wechsel zu einem anderen Konzept wird eine fachlich nicht zugehörige `sourceRevisionId` entfernt. Unveränderliche Konzeptstände und frühere Artefaktbytes bleiben erhalten.
- Wird eine ältere Vorschau betrachtet, bietet die Oberfläche keine Prüfung, Abnahme oder Erledigungsbestätigung für die aktuelle Version an. Fehler beim Laden der Änderungsliste werden sichtbar statt als leere Liste ausgegeben.
- CSP `default-src 'none'` verhindert nicht die durch einen Nutzerlink ausgelöste Selbstnavigation eines Iframes. Die statischen Konzeptvorschauen sind zusätzlich `inert`; eingebettete Skripte und externe Ressourcen bleiben durch Sandbox/CSP gesperrt. Begründung und Name bleiben außerhalb der statischen Darstellung lesbar.

`tests/integration/website-feedback.test.ts` prüft Stapelübergabe, unveränderte alte Bytes, Revisionsbindung, Ausschluss verfrühter Prüfung/Erledigung, Abnahmeinvalidierung und Quellenprovenienz. Gemeinsam mit den vorhandenen Workflowtests bestanden 21 Integrationtests.

`tests/e2e/website-preview-review.spec.ts` verwendet die echte lokale Anwendung: Ein Konzept enthält eine absichtliche externe Link-/Bild-/Meta-Refresh-Probe; beim tatsächlichen Mausklick entsteht kein externer Request. Zwei gebaute Versionen belegen die getrennte Vorschau-/Abnahmebedienung. Eine per Tastatur gesetzte Markierung `viewport-point:30,30` wird mit 390×650 und der tatsächlich betrachteten älteren Artefakt-ID gespeichert. Zusammen mit `website-local.spec.ts` bestanden vier Browserprüfungen. Nur die absichtlichen externen Probeziele werden vorsorglich abgefangen; die Anwendungs-API bleibt unverändert.
