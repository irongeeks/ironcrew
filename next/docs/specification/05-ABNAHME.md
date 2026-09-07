# Abnahmekatalog

## Nachweisarten

**Automatisiert:** echte Komponenten mit lokalen Testdaten und Fehlerinduktion. **Vertrag:** dokumentierte Providerfixtures/Testserver gegen gepinnte Schemas. **Live:** berechtigtes Testkonto/Testsystem, konkrete externe ID und Funktionsnachweis. **Visuell/manuell:** definierte Ansichten/Geräte und protokolliertes Ergebnis. Diese Klassen getrennt ausweisen. Fehlender Zugang ist kein bestandener Live-Test.

## Technische Gates

| ID | Szenario | Erwartetes beobachtbares Ergebnis | Paket |
| --- | --- | --- | --- |
| CORE-01 | Frische Einrichtung, Reload nach jedem Schritt | Fortschritt erhalten, genau ein CEO und neun korrekte Crewprofile, keine Altdatenabhängigkeit. | 01,05 |
| CORE-02 | Auftrag ohne Lead / Leadwechsel gleichzeitig | Ungültiges Anlegen abgewiesen; Wechsel atomar mit genau einem Lead und Audit. | 01 |
| CORE-03 | Kundenbereich A greift auf B zu | DB/API/Tool verhindern Zugriff trotz identischem Mitarbeiter. | 01,04 |
| RUN-01 | Eigener Modelllauf verändert Datei und testet | Tatsächliche Änderung, Testbeleg, immutable Ergebnisversion; keine CLI-Harness-Delegation. | 03 |
| RUN-02 | Kill vor/ nach Toolintent und nach externem Effekt | Kontext erhalten; sichere Fortsetzung bzw. `effect_unknown`; keine blinde Doppelaktion. | 03,04 |
| RUN-03 | Freigabewarten, Neustart, geänderte Argumente | Unveränderte Aktion kann fortsetzen; veraltete Freigabe scheitert. | 02,03 |
| RUN-04 | Leaseverlust, doppelte Resultate, alte Worker-Generation | Kein neues Dispatch an alten Worker; Resultat einmal gebucht, unklare laufende Wirkung abgeglichen. | 04 |
| BUD-01 | Zehn parallele Aufrufe bei kleinem Restlimit | Transaktionale Reservierung verhindert weitere ungedeckte Aufrufe; abgerechnete Kosten nicht doppelt. | 02 |
| BUD-02 | Usage fehlt, Streamabbruch und teurer Fallback | Ungeklärte Kosten sichtbar/reserviert; jeder Versuch dem Auftrag zugeordnet. | 02,07 |
| SEC-01 | Pfad-/Symlink-/Reparse-Flucht, unerlaubtes Netzwerk, Kindprozess | Zugriff tatsächlich verweigert, nicht bloß protokolliert. | 04 |
| SEC-02 | Secretwert absichtlich in Toolausgabe/Fehler | Modell/UI/Logs erhalten redigierte Ausgabe; Prozessumgebung ohne fremde Secrets. | 04 |
| MOD-01 | Neuer Anbieter und Modell ohne Tools | Im vollständigen Katalog sichtbar; ungeeignete Ausführung mit erklärtem Grund verhindert. | 07 |
| KNOW-01 | Einzelkorrektur, Fachreview, Firmenregeländerung | Nur gewünschter Scope aktiv; Leadreview bzw. CEO-Entscheidung nach Typ. | 07,11 |
| CHAN-01 | Webhook-Duplikat, fremde CEO-ID, E-Mail-Spoofing | Ein Eingang einmal verarbeitet; keine fremde Freigabe. | 12 |
| JOB-01 | Sommerzeitwechsel, Neustart, wiederholter Alarm | Definierte Zeitzone/Nachholregel, kein unkontrollierter Auftragssturm. | 12 |
| OPSYS-01 | Installieren, rebooten, aktualisieren je Zielmatrix | Native Dienste laufen ohne interaktive Sitzung/Devserver; genaue getestete Version dokumentiert. | 13 |
| BAK-01 | Backup manipuliert / falscher Schlüssel / Restore frisch | Fehler vor Zielmutation; gültiger Restore vollständig und im Recoverymodus. | 13 |
| BAK-02 | Alte Reminder/Routinen nach Restore | Automatik pausiert bis Wirkungsabgleich und kontrollierte Wiederfreigabe. | 13 |
| UPD-01 | Falsche Signatur, inkompatibles Schema, Healthcheckfehler | Update verweigert bzw. getesteter Rückweg; keine beschädigte produktive DB. | 13 |
| UI-01 | 360 px, 200 % Zoom, Tastatur, DE/EN, WebGL-Verlust | Kernarbeit vollständig bedienbar, Zustände/Labels korrekt, kein Pflicht-3D. | 05,06 |
| UI-02 | Neun Avatare und Aktivitäten im HQ | Rollen gemäß PRD, echte Arbeitszustände, kostenfreie Dekoration, reduzierte Bewegung. | 06 |

## Vollständige Fachabnahme

**Website (PRD WEB-01 bis WEB-09 bzw. sämtliche WEB-IDs im beigefügten PRD):** Beispielkunde liefert Briefing und Dateien. Crew legt mehrere konkrete Entwürfe vor, übernimmt Auswahl, baut eine reale Site und reagiert auf versionsgebundene Pins. Mobile/Funktions-/Qualitätschecks liefern Nachweise. Abnahme und Veröffentlichung sind getrennt. Neue Artefaktversion invalidiert bisherige Publishentscheidung. Eigene Hostingumgebung wird geprüft provisioniert oder ein tatsächlich startbares Selbsthostingpaket geliefert. Fortlaufende technische Pflege hat eigenes Mandat.

**IT (alle OPS-IDs im PRD):** Testdienst gezielt stoppen, Alarm zweimal zustellen, einen Vorfall erzeugen. Morpheus diagnostiziert, erlaubte Reparatur wird ausgeführt und von unabhängiger Funktionsprüfung bestätigt. Beobachtungsphase kann erneuten Ausfall erkennen. Kundenmeldung wird vor Versand konkret genehmigt. Präventionsarbeit ist verknüpfter Folgeauftrag. Ein Connector-Timeout nach Aktion führt zur Wirkungsklärung.

**Finanzen (FIN-01 bis FIN-11):** Doppelter Beleg, bekannter Lieferant, unklare Zuordnung, Teilzahlung, strittige Rechnung und Zahlungspause. sevdesk-Entwürfe mit externer ID; freigegebene Routinen automatisch, Ausnahmen sichtbar. Bestätigte Regel lernt nur im gewählten Scope. Erinnerung höchstens einmal pro Regelstufe/Zeitraum bei hinreichend frischen Daten; verlorene Versandantwort wird geklärt. Zahlungsvorbereitung ist nicht bezahlt. Banking-Datei muss, falls als verfügbar angeboten, in der konkret gewählten Anwendung validiert/importiert werden.

**Recherche (RES-01 bis RES-09):** Frage mit widersprüchlichen und nicht erreichbaren Quellen. Empfehlung unterscheidet Belege, Annahmen und Lücken; vollständiges Dokument tatsächlich erzeugt und abgelegt. Externe Dateikonflikte nicht überschreiben. Beobachtungsmandat erkennt relevante Inhaltsänderung, erzeugt neue Version und meldet wesentliche Auswirkungen ohne eigenmächtige Firmenregeländerung.

## Befehlsvertrag für AP-00

Folgende Befehle müssen im neuen Workspace als Skripte implementiert und in der README dokumentiert werden. Sie existieren durch diese Spezifikation noch nicht:

```sh
cd next
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contracts
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm test:recovery
pnpm test:install
```

Der erste Lockfile wird einmal kontrolliert erzeugt, danach gilt frozen-lockfile. Live-Tests sind ein separater expliziter Befehl `pnpm test:live -- --profile <testprofil>`, nie Teil eines gewöhnlichen lokalen Unitlaufs. Das Profil referenziert externe Secrets, enthält sie nicht.

Ein Gatebericht enthält Testname, Datum, Commit, Plattform, Befehl, Resultat, Belegpfad und verbleibende Einschränkung. Screenshots ersetzen keine Tests auf externe Wirkungen. Historische CI-Ergebnisse aus der Technikprüfung belegen nur den damaligen Bestand.

## Releaseentscheidung

Releasekandidat erst bei grünen technischen Gates und allen vier Fachabläufen. Ausstehende Kontotests und fehlender Bankimport werden konkret ausgewiesen; ein optional noch nicht konfigurierter Import ist von einer behaupteten, aber ungetesteten Funktion zu unterscheiden. Der Nutzer erhält einen prüfbaren Stand, Installationsanleitung und bekannte Einschränkungen. Merge/Push/Release benötigen die in der aktiven Sitzung gültige Freigabe.
