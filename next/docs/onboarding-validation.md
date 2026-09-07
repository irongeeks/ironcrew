# Wirksame Firmeneinrichtung

Der achtstufige Assistent verwendet dieselben tatsächlichen Konfigurations-, Crew-, Worker-, Kanal-, Mandats- und Routinenformulare wie die Einstellungen. Änderungen an Namen/Personas und neuen Bereichen werden über die jeweilige Fach-API gespeichert. Proton-Pass- und OpenRouter-Verweise landen in der ausführbaren Konfiguration; der Katalogtest zeigt fehlenden Zugang als Fehler. Die mitgelieferten Iron-Geeks-Logos sind sichtbar und werden mit der Crew bestätigt.

Fehlender Modellzugang und fehlende Ausführungsrechner verlangen eine ausdrückliche Später-Entscheidung. „Konfiguriert“ wird gegen den gespeicherten Zustand überprüft. Die Workeroberfläche erzeugt echtes Enrollment nur bei erfüllter TLS-Voraussetzung; registrierte Zugangsdaten werden von bestätigtem Kontakt unterschieden. Ein lokaler Isolationspfad ist konfigurierbar, gilt aber erst nach gesonderter Ausführungsprüfung als nachgewiesen. Mandate werden niemals nur durch den Schrittwechsel erteilt.

Die Abschlussansicht liest tatsächliche Profile, Bereiche, Zugangskonfiguration, Katalogeinträge, Worker-Kontakte, Mandate und Routinen. Fehlende Einrichtung bleibt sichtbar. Der Abschluss startet keinen Auftrag. Passwort und Setup-Token werden nach der Kontoübernahme aus Formular und Einrichtungszustand entfernt; Fortschrittsmetadaten enthalten sie nicht.

`tests/e2e/setup-fresh-local.spec.ts` startet eine eigene leere SQLite-Firma und durchläuft die Browseroberfläche ohne API-Interception: Einmal-Token, Konto, neun Crewprofile, persistente Profiländerung, echte Konfiguration mit ausdrücklich nicht vorhandenem Test-Proton-CLI, fehlgeschlagener Katalogtest, 0-USD-Budget, abgelehnte unbelegte Worker-Konfiguration, Später-Entscheidung, echter neuer Bereich, Mandatsprüfung, Reload-Fortsetzung und Abschluss mit weiterhin deaktivierter Live-Ausführung. Es wird kein externer Provider verwendet oder erfolgreich behauptet.

[Abschluss der echten lokalen Einrichtung](test-evidence/setup-fresh-summary-local.png).


Normale, noch ungespeicherte Formulareingaben werden beim Schrittwechsel ausschließlich im Arbeitsspeicher des geöffneten Assistenten gepuffert und auch nach verzögert geladenen Auswahllisten wieder eingesetzt. Passwörter, Dateien, versteckte Felder, Token-/Secret-Werte und Checkbox-/Radio-Bestätigungen werden nicht aufgenommen. Proton-Pass-Share-/Item-/Feldnamen bleiben Referenzen. Der Puffer überlebt weder Reload noch Abmeldung; dauerhaft gespeichert bleiben nur ausdrücklich an die Fach-API übernommene Änderungen und der sichere Fortschritt. Der echte Browserfall prüft eine ungespeicherte Referenz beim Zurück-/Vorwärtswechsel.
