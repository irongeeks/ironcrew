# IronCrew – PRD-Entwurf 01

Stand: 7. September 2026  
Status: Erster Produktentwurf aus dem gemeinsamen Brainstorming. Keine Implementierungs- oder Releasefreigabe.  
Dokumentversion: 0.9, unabhängig von der Softwareversion. Neubaurichtung, Zielplattformen, frischer Datenbestand, neun Crewcharaktere und Gestaltung B sind bestätigt. Das Entwicklungspaket ergänzt technische Festlegungen, Oberflächenspezifikation, Arbeitspakete und Abnahmeverfahren.

## 1. Produktidee

**IronCrew ist deine digitale Firma. Du führst sie als CEO über einen vertrauten Chief of Staff. Ein dauerhaftes Kernteam übernimmt Verantwortung und stellt für konkrete Aufträge passende Teams zusammen.**

Die Firma bearbeitet das Iron-Geeks-Geschäft und persönliche Vorhaben. Sie erledigt konkrete Aufträge, führt freigegebene Routinen aus und verfolgt ausdrücklich übertragene Ziele. Ihre räumliche Oberfläche ist ein eigenes, modernes 3D-Hauptquartier in einer umgebauten Industriehalle. Die Darstellung macht echte Arbeit, Zusammenarbeit und nötige Entscheidungen sichtbar.

Der Entwurf beschreibt das gewünschte Produkt. Die Technikprüfung liegt vor; sie belegt noch keine vollständigen Abläufe mit produktiven Konten. **Beschlossen ist ein neuer Produkt- und Laufzeitkern mit eigener Oberfläche und gezielter Übernahme bewährter Grundlagen.** IronCrew wird aus dem Modell der digitalen Firma heraus entworfen. Die konkrete Übernahme einzelner Module wird anhand ihrer Eignung und Tests entschieden.

### Leseschlüssel

- **Beschlossen:** Im Gespräch ausdrücklich gewählt oder als Bestandteil einer gewählten Variante übernommen.
- **Ausarbeitung:** Vorgeschlagene Konkretisierung für Umsetzung und Abnahme; noch keine separat bestätigte Detailentscheidung.
- **Offen:** Benötigt eine Produktentscheidung, technische Prüfung oder konkrete Betriebsparameter.

## 2. Beschlossenes Zielbild

| Thema | Entscheidung |
| --- | --- |
| Identität und Arbeitsweise | Digitale Firma; konkrete Aufträge mit passenden Teams. |
| Führung | Du bist CEO. Ein Chief of Staff ist dein zentraler Ansprechpartner. |
| Selbstständigkeit | Aufträge delegieren und zusätzlich Ziele beziehungsweise dauerhafte Mandate übertragen. |
| Belegschaft | Dauerhaftes Kernteam mit zeitweise hinzugezogenen Spezialisten. Mitarbeiteridentität und Modell sind getrennt. |
| Kernteam | Neun feste Mitarbeiter: Chief of Staff und acht fachliche Verantwortliche. |
| Charaktere | Bestätigte Wunschbesetzung aus fiktiven Figuren und einer realen Persönlichkeit; Optik und Persona orientieren sich an der jeweiligen Vorlage. Namen, Erscheinung und Umgangston bleiben editierbar. |
| Darstellung | Stilisierte menschliche 3D-Figuren in einer eigenen Industriehalle mit deinen Logos. |
| Visuelle Richtung | Entwurf B – die Einsatzzentrale: dunkle Industriehalle, Stahl, Glas und warme bernsteinfarbene Beleuchtung. |
| Markenauftritt | Die eigenen Logos des Nutzers sind verbindliche Gestaltungsgrundlage. Konkrete Assetdateien werden für die Umsetzung zugeordnet. |
| Einstieg | Hauptquartier mit kompaktem Briefing; daraus direkter Zugang zu Aufträgen, Ergebnissen und Gesprächen. |
| Geschäftlicher Umfang | Iron Geeks plus persönliche Projekte; eine gemeinsame Firma mit zugeordneten Bereichen und Zugriffsrechten. |
| Auftragseingang | Bekannte Abläufe beginnen direkt; neue, unklare oder aufwendige Aufträge zunächst mit Plan oder Entwurf. |
| Qualität | Prüfung nach Anspruch und Risiko; jeder Auftrag hat genau einen verantwortlichen Lead. |
| Lernen | Leads prüfen und pflegen Fachwissen; Änderungen an Firmenregeln kommen zum CEO. |
| Benachrichtigungen | Sofort bei nötigen Entscheidungen und relevanten fertigen Ergebnissen; zusammengehörige Anliegen bündeln. |
| Kommunikationskanäle | Website, Discord, E-Mail und Telegram. |
| Menschliche Nutzer | Ein Benutzer: du. Kein Kundenportal und keine zusätzlichen menschlichen Mitarbeiterkonten im ersten Umfang. |
| Modelle | Automatische Auswahl nach Aufgabe, Fähigkeiten, Budget und Ergebnissen; feste Vorgaben möglich. Vollständiger verfügbarer OpenRouter-Katalog mit Live-Abruf, Filtern und Autocomplete. |
| Agentenlaufzeit | Eigene IronCrew-Laufzeit für Modellaufrufe, Werkzeuge, Kontext und Auftragsfortsetzung. |
| Entwicklungsrichtung | Neuer Produkt- und Laufzeitkern sowie eigene Oberfläche; geeignete, getestete Grundlagen aus dem Bestand gezielt übernehmen. |
| Verteilung | Zentrale mit verteilten Ausführungsrechnern; Zielaufbau VPS und Tank, weitere Rechner ergänzbar. Betrieb auf einer Maschine bleibt möglich. |
| Erste vollständige Abläufe | Website erstellen; IT-Störung bearbeiten; Belege und Finanzverwaltung; Recherche mit Ergebnisdokument. |
| Befugnisse | Freigegebene Routinen plus Mandate mit selbstständiger Wahl des Vorgehens innerhalb ihrer Grenzen. |
| Fehlerbehandlung | Innerhalb des Mandats neu planen; feste Grenzen für Wiederholungen, Zeit und Kosten. |
| Kosten | Gemeinsamer Firmentopf; Verteilung nach Priorität, Kostenrahmen je Auftrag. |
| Secrets | Proton Pass über pass-cli als zentrale Secrets-Verwaltung. |
| Dateien | Eigene Arbeitsablage; Anbindungen an Git, Nextcloud und Google Drive. |
| Automatische Arbeit | Zeitpläne, Ereignisse und Initiative aus freigegebenen Zielen beziehungsweise Mandaten. |
| IT-Anbindungen | Tactical RMM, Proxmox VE, Linux/Docker, Windows/Windows Server und Microsoft 365. |
| Finanzanbindung | sevdesk über dessen API; laufende Finanzverwaltung. Ersetzt die zuvor vorgeschlagene Lexware-Anbindung. |
| Webtechnologien | HTML/CSS/JavaScript, React und WordPress; offen für weitere moderne Frameworks, Toolkits und Build-Werkzeuge. |
| Installation | Native Systemdienste; Installer prüft und richtet Voraussetzungen ein. |
| Zielplattformen | Linux, macOS und Windows einschließlich Windows Server für Zentrale und Ausführungsdienste; unterstützte Versionen werden technisch festgelegt. |
| Bestandsdaten | Frische Einrichtung ohne Migration alter Daten. Alte Daten im Repository dürfen im Zuge des Neubaus entfernt werden. |
| Updates | Automatisch im Wartungsfenster für freigegebene Releasearten; größere Änderungen werden vorgelegt. |
| Sicherung | Eingebaute, zeitgesteuerte und verschlüsselte Firmensicherung mit Wiederherstellung auf neuer Installation. |

## 3. Umfang der ersten nutzbaren Version

Alle vier ausgewählten Abläufe gehören zum gewünschten ersten Lieferumfang. Ihre Umsetzung kann in internen Meilensteinen erfolgen; keiner wird durch diesen Entwurf stillschweigend zum späteren Zusatz erklärt.

| Ablauf | Eingang | Erwartetes Ergebnis |
| --- | --- | --- |
| Website | Briefing, Kundenunterlagen, Budget | Geprüfte Website mit Vorschau, Prüfbericht und konkreter Veröffentlichungsfreigabe. |
| IT-Störung | Meldung, Alarm oder manuell erteilter Auftrag | Diagnose, erlaubte Reparatur oder klare Eskalation, Funktionsprüfung und Dokumentation. |
| Finanzverwaltung | Belege, E-Mails, festgelegte Eingangsordner und sevdesk-Daten | Geordnete Belege, unterstützte API-Übergaben, offene Punkte, Forderungen/Verbindlichkeiten und Finanzbriefing. |
| Recherche | Geschäftliche oder persönliche Frage | Quellenbelegtes, geprüftes Ergebnisdokument mit nachvollziehbarer Ablage. |

Website, Discord, E-Mail und Telegram sowie die ausdrücklich ausgewählten Fach- und Datei-Anbindungen gehören zum Zielumfang der ersten Version. Konkrete API-Funktionsmatrizen sind vor einer verbindlichen Aufwandsschätzung auszuarbeiten.

### Zunächst außerhalb des Umfangs

- Mehrere menschliche Nutzer, Kundenportal und externe Gästezugänge.
- Eigene Ticketsystem-Anbindung; IronCrew hat eigene Aufträge und darf Störungsmeldungen daraus erzeugen.
- Vollständiger Ablauf von Kundenanfrage zu Angebot als eigenständiges Abnahmeziel.
- Allgemeine Softwareentwicklung als eigenständiger fünfter Abnahmeablauf; Codeerstellung für die gewählten Abläufe ist erforderlich.
- Externe Agenten-Harnesses als Ausführungsgrundlage. Dienste und Werkzeuge dürfen angebunden werden.
- Ein eigener vollständiger Passworttresor als Ersatz für Proton Pass.
- Eine Pflicht zur Kombination mit Infrastrukturbackups. Die eingebaute Firmensicherung muss eigenständig nutzbar sein.
- Eine Garantie, jedes beliebige Framework ohne projektspezifische Prüfung produktiv zu unterstützen.

## 4. Firma, Crew und Verantwortung

### 4.1 Kernteam

| Rolle | Bestätigter Charakter | Verantwortung |
| --- | --- | --- |
| Chief of Staff | Cersei Lannister | Zentrale Kommunikation, Prioritäten, Koordination, Entscheidungen und Budgetverteilung. |
| Software & Automatisierung | Mr. Robot | Webentwicklung, Anwendungen, Integrationen und interne Werkzeuge. |
| IT-Betrieb | Morpheus | Infrastruktur, Hosting, Wartung und Störungen. |
| Design & Nutzererlebnis | Steve Jobs | Gestaltung, Markenauftritt und Bedienbarkeit. |
| Vertrieb & Marketing | Tyrion Lannister | Interessenten, Kampagnen und Kundenentwicklung; der vollständige Angebotsablauf folgt später. |
| Finanzen & Verwaltung | Saul Goodman | Belege, Kostenübersicht, Finanzverwaltung und Organisation. |
| Recherche & Wissen | Karla Kolumna | Quellenarbeit, Dokumentation und Wissensorganisation. |
| Qualitätssicherung | Der Professor aus Haus des Geldes | Unabhängige Prüfung und fachübergreifende Qualitätsstandards. |
| Sicherheit | Nick Fury | Zugriffsmodelle, Sicherheitsprüfungen und Bewertung technischer Änderungen. |

Die neun Charaktere wurden einzeln mit dem Nutzer festgelegt. **Beschlossen:** Optik und Persona werden passend zur jeweiligen Vorlage gestaltet. Die nachfolgenden Profile in Abschnitt 21 konkretisieren diese Richtung; fertige Avatare sind noch visuell abzunehmen. Eine Figur verändert keine fachlichen Befugnisse.

Jeder Auftrag hat genau einen Lead. Er verantwortet Ergebnis, Abnahmekriterien, erforderliche Prüfung und Nacharbeit. Andere Mitarbeiter können fachlich zuarbeiten oder unabhängig prüfen. Der Chief of Staff muss nicht bei jedem Arbeitsschritt eine zusätzliche Delegationsstufe erzeugen.

Zeitweise Spezialisten werden einem konkreten Auftrag zugeordnet. Ihre Ergebnisse und relevanten Erkenntnisse bleiben nach Abschluss bei der Firma. Dauerhafte Einstellungen werden zunächst dem CEO vorgeschlagen; Einzelheiten des Einstellungsprozesses bleiben auszuarbeiten.

### 4.2 Bereiche und Wissenstrennung

Geschäftliche und persönliche Aufgaben gehören zu einer Firma. Aufträge erhalten eine Bereichszuordnung und bei Bedarf Kunde/Projekt. Mitarbeiter können in mehreren Bereichen arbeiten, erhalten aber für jeden Ausführungsschritt nur den erlaubten Kontext und die erforderlichen Werkzeuge.

**Ausarbeitung:** Private Inhalte, Kundenwissen und Zugänge werden nicht durch eine gemeinsame Mitarbeiteridentität automatisch untereinander freigegeben. Allgemeine Fachkenntnisse dürfen nach Prüfung durch den Lead als bereichsübergreifendes Wissen übernommen werden.

## 5. Oberfläche und Onboarding

### 5.1 Eigenständiges Hauptquartier

Das Hauptquartier verwendet Stahl, Glas, warmes Licht und individuell gestaltete Bereiche einer umgebauten Industriehalle. Deine Logos und eine eigene Designsprache bestimmen die Identität. In der Mitte werden laufende Projekte sichtbar. Mitarbeiter sind stilisierte menschliche 3D-Figuren mit erwachsenen Proportionen und wiedererkennbarer Erscheinung.

**Beschlossen:** Entwurf B „Die Einsatzzentrale“ ist die visuelle Grundlage. Das gefundene Logo-Paket „Logo (1).zip“ liefert das Iron-Geeks-Emblem und den Schriftzug. Im Entwicklungspaket liegen unveränderte Kopien unter `assets/irongeeks-logo-farbe.png`, `assets/irongeeks-logo-sw.png` und `assets/irongeeks-schriftzug.png`; `assets/entwurf-b.png` ist die Gestaltungsreferenz. Bildtexte, Beispielzahlen und abweichende Rollenlabels im Entwurf sind keine Produktanforderungen. Für Rollen gilt Abschnitt 4; für die Umsetzung gilt die ergänzende Oberflächenspezifikation. Figuren werden stärker stilisiert als im Bildentwurf.

Beim Öffnen erscheint ein kompaktes Briefing des Chief of Staff. Es zeigt nötige Entscheidungen, relevante Ergebnisse und Hindernisse. Von dort sind Aufträge und Gespräche direkt erreichbar. Eine kompakte Arbeitsansicht ergänzt die räumliche Darstellung; auf dem Handy stehen Briefing und Arbeit im Vordergrund.

**Ausarbeitung der Darstellung:**

- Sichtbare Arbeit und Besprechungen sind auf tatsächliche Aufträge oder Abstimmungen zurückführbar.
- Dekorative Bewegung wie Gehen oder Kaffeepausen erzeugt keine Modellaufrufe und wird nicht als tatsächliche Agentenaktivität ausgegeben.
- Aktive Arbeit, Warten, Offlinezustand und Fehler erhalten unterscheidbare Zustände.
- Ein Auftrag öffnet eine zusammenhängende Arbeitsfläche mit Team, Gespräch, Aufgaben, Prüfungen und Ergebnisvorschau.
- Die 3D-Ansicht wird nur bei Bedarf geladen und erhält eine funktionale Alternative bei fehlender Grafikunterstützung.
- Tastaturbedienung, reduzierte Bewegung und mobile Bedienung werden berücksichtigt. Konkrete Leistungsgrenzen werden vor Implementierung festgelegt.

### 5.2 Gründung beim ersten Start

Das Onboarding verbindet Gespräch und direkt bearbeitbare Einrichtungskarten. Es umfasst Firma und CEO, Logos und Sprache, Besetzung des Chief of Staff, Modellzugang und Kostenrahmen, Kernteam, Bereiche, Kommunikationskanäle, Fachanbindungen und Befugnisse.

**Technische Ausarbeitung:** Die ersten Schritte funktionieren ohne eingerichtetes Modell. Nach erfolgreicher Einrichtung eines Modellzugangs kann der Chief of Staff das Gespräch übernehmen. Der Fortschritt wird gespeichert; noch fehlende Integrationen können später ergänzt werden. Zugangsdaten werden in geschützten Eingaben erfasst.

**Festlegung für die Umsetzung auf Grundlage des bisherigen Projektwunsches:** Die Oberfläche unterstützt Deutsch und Englisch; Deutsch ist die Voreinstellung. Die Sprache ist im Onboarding und später umstellbar. Interne Zustandskennungen bleiben sprachneutral.

## 6. Aufträge, Mandate und Kommunikation

### 6.1 Auftrag

Ein Auftrag enthält mindestens Ziel, gewünschtes Ergebnis, Bereich/Kunde/Projekt, Anlass, Lead, Team, Kostenrahmen, Abnahmekriterien und erforderliche Freigaben. Der Chief of Staff ergänzt Angaben aus Firmenstandards und Gespräch; relevante Unklarheiten werden geklärt.

Bekannte Abläufe starten innerhalb ihrer Befugnisse direkt. Neue, unklare oder aufwendige Aufgaben erhalten zunächst einen Plan beziehungsweise Entwurf. Der CEO kann das Vorgehen pro Auftrag übersteuern.

**Ausarbeitung des Lebenszyklus:** Eingang → Klärung/Planung → bereit → in Arbeit → Prüfung/Nacharbeit → abgeschlossen. Pausiert, blockiert und abgebrochen sind eigene Zustände. Wartegründe werden getrennt erfasst: CEO-Entscheidung, Budget, externe Antwort, Werkzeugfehler oder Ausführungsrechner nicht erreichbar.

### 6.2 Mandate und Freigaben

Routinen können ausdrücklich freigegeben werden. Mandate erlauben zusätzlich eine selbstständige Wahl des Vorgehens und beschreiben Ziel, Systeme, erlaubte Eingriffe, Budget und Abbruchbedingungen. Ihre genaue Laufzeit und Änderungsregeln werden ausgearbeitet.

Ein Zugriff muss sowohl zum aktiven Mandat als auch zu den technischen Rechten der Ausführungsumgebung passen. Eine Erlaubnis auf einer Ebene ersetzt keine fehlende Erlaubnis auf der anderen.

Freigaben zeigen Handlung, Umfang, Folgen und Empfehlung. Ohne Antwort entsteht keine Zustimmung. Ändert sich der freizugebende Umfang wesentlich, wird erneut gefragt. Unabhängige Arbeit darf weiterlaufen.

**Offen:** Die reservierten Entscheidungen müssen je Fachbereich konkret aufgelistet werden, insbesondere Veröffentlichungen, produktive Änderungen, externe Nachrichten, verbindliche Einreichungen und Zahlungen. Die bisher genannten Beispiele sind keine pauschale Erlaubnis für alle derartigen Handlungen.

### 6.3 Kanäle

Website, Discord, E-Mail und Telegram greifen auf denselben Auftragsstand zu. Nur das verknüpfte CEO-Konto darf CEO-Entscheidungen treffen. Eingehende Kundenmails können Arbeit auslösen, verleihen dem Absender aber keine internen Rechte.

Nötige Entscheidungen und relevante Ergebnisse werden zeitnah gemeldet. Zusammengehörige Anliegen werden gebündelt. Vertrauliche Inhalte gelangen ausschließlich in dafür berechtigte Chats und Empfängerkreise.

**Ausarbeitung:** Nachrichten haben kanalübergreifende Zuordnungen und Versandzustände. Doppelte Zustellung darf keinen zweiten Auftrag oder eine zweite Ausführung derselben Freigabe erzeugen. Priorisierung und Zielkanal der Benachrichtigungen werden konfiguriert; es ist kein gleichzeitiger Versand jeder Meldung auf allen Kanälen beschlossen.

### 6.4 Automatische Auslöser

Aufträge entstehen durch Zeitpläne, Ereignisse und Initiative aus freigegebenen Zielen. Anlass, Lead und Kostenrahmen sind sichtbar. Wiederholungsregeln, Zeitzonen, Zusammenführung gleicher Ereignisse und Grenzen für automatisch erzeugte Folgeaufträge werden in der Laufzeit umgesetzt.

## 7. Qualität, Wissen und Modellwahl

Die Prüfung richtet sich nach Anspruch und Risiko. Routineaufgaben erhalten geeignete Checks; anspruchsvolle Ergebnisse zusätzlich eine unabhängige Gegenprüfung. Der Lead bleibt verantwortlich. Fehlgeschlagene Pflichtprüfungen verhindern den Abschluss und führen zu Nacharbeit oder Eskalation.

Leads übernehmen geprüfte Erfahrungen ins Fachwissen. Änderungen an Firmenregeln werden dem CEO vorgelegt. Wissenseinträge enthalten Quelle, Geltungsbereich, Änderungshistorie und verantwortliche Rolle. Vermutungen aus einem Gespräch dürfen nicht ungeprüft zu globalen Regeln werden.

Die Modellwahl erfolgt automatisch nach Aufgabe, Fähigkeiten, Budget und nachgewiesenen Ergebnissen. Feste Vorgaben pro Auftrag beziehungsweise Mitarbeiter bleiben möglich. Der vollständige verfügbare OpenRouter-Katalog wird live abrufbar, durchsuchbar und filterbar angeboten. Eine frühere Anbieter-Whitelist wird nicht ungeprüft wieder eingeführt.

**Ausarbeitung der Modellauswahl:**

- Fähigkeiten wie Werkzeugaufrufe, strukturierte Ausgabe, Kontext und benötigte Modalitäten werden vor Auswahl berücksichtigt.
- Auswahl, Wechsel und Ausweichversuche sind begründet und protokolliert.
- Neue Modelle ohne eigene Erfahrungswerte werden als solche kenntlich gemacht.
- Kosten und Qualität werden nach Aufgabentyp und Schwierigkeit verglichen; ein globaler Sternemittelwert reicht als Routinggrundlage nicht aus.
- Menschliche Bewertung und Crew-Bewertung bleiben unterscheidbar.
- Junior/Senior/Lead sowie 1–5-Sterne-Bewertungen stammen aus vorherigen Wünschen und wurden im Qualitätsvorschlag aufgegriffen. Genaue Rangregeln, Bewertungsdimensionen und Darstellung sind noch zu spezifizieren.

## 8. Eigene Laufzeit, verteilte Arbeit und Budget

IronCrew führt seine Agenten selbst aus. Die Laufzeit steuert Modellaufrufe, Werkzeuge, Arbeitskontext, Wiederholungen und Fortsetzung unterbrochener Aufgaben. Auch Coding-Aufgaben verwenden diese Grundlage.

Die Zentrale koordiniert Firma, Aufträge und Entscheidungen. Ausführungsrechner führen begrenzte Schritte in ihren Umgebungen aus und liefern Status und Ergebnisse. Zielaufbau sind VPS und Tank; die Architektur muss auch auf einer Maschine funktionieren.

**Ausarbeitung:** Ausführungsrechner werden authentifiziert registriert und mit Fähigkeiten, Rechten und erreichbaren Systemen beschrieben. Ausführungszustände werden dauerhaft gespeichert. Unterbrochene Aktionen werden vor Wiederholung auf bereits eingetretene Wirkungen geprüft. Wo ein Zielsystem keine eindeutige Erkennung ermöglicht, wird ein unklarer Zustand sichtbar eskaliert.

Bei Problemen darf die Crew innerhalb ihres Mandats neu planen, Modelle oder Spezialisten wechseln und alternative Werkzeuge nutzen. Zeit-, Kosten- und Wiederholungsgrenzen verhindern Schleifen. Der Lead eskaliert mit bisherigen Versuchen, Hindernis und empfohlenem nächsten Schritt.

### Gemeinsamer Firmentopf

Der CEO setzt das Gesamtbudget. Der Chief of Staff verteilt es nach Priorität auf Aufträge. Bereichsbudgets und eine gesonderte Reserve sind nicht als Standard beschlossen. Kosten bleiben nach Bereich, Kunde, Auftrag, Modell und Versuch auswertbar.

Planung, Ausführung, Prüfung und Fehlversuche zählen zum Auftrag. Kostenrahmen werden vor aufwendiger Arbeit geschätzt. Eine Erhöhung des Gesamtlimits benötigt den CEO.

**Ausarbeitung:** Parallel laufende Arbeit reserviert vor weiteren Aufrufen einen geschätzten Kostenanteil. Nach Eingang tatsächlicher Verbrauchsdaten erfolgt der Abgleich. Ein Budgetstopp verhindert neue kostenpflichtige Schritte; bereits ausgelöste Aufrufe können noch Kosten verursachen. Diese Abweichung muss sichtbar sein.

**Offen:** Budgetperiode, Eurobeträge, Währungsumrechnung, Einbezug kostenpflichtiger Drittwerkzeuge sowie Umgang mit verzögerten oder fehlenden Preisdaten.

## 9. Integrationen und Artefakte

### 9.1 Verbindliche Zielanbindungen

| Integration | Gewünschter Umfang | Prüfstatus |
| --- | --- | --- |
| OpenRouter | Katalog, Modelle, Ausführung, Fähigkeiten und Kostendaten | Konkrete API- und Modellfähigkeitstests offen. |
| Proton Pass CLI | Begrenzt berechtigter Secrets-Zugriff für Ausführungsdienste | Grundfunktionen anhand offizieller Dokumentation geprüft; Betrieb noch nicht getestet. |
| Discord / Telegram | CEO-Kommunikation, Auftragseingang, Rückfragen, Entscheidungen | Konkrete Authentifizierung und Ereignisverarbeitung offen. |
| E-Mail | Eingang, Zuordnung, Antwortvorbereitung und berechtigter Versand | Konten und Zugriffsverfahren offen. |
| Git | Projektcode, Versionen und prüfbare Änderungen | Hostinganbieter und Veröffentlichungsablauf offen. |
| Nextcloud | Dokumente und fertige Ergebnisdateien | Zielordner, Rechte, Versionierung und Konfliktbehandlung offen. |
| Google Drive | Dateien und gegebenenfalls native Dokumente | Unterstützung nativer Docs/Sheets/Slides und jeweilige APIs offen. |
| Tactical RMM | Meldungen, Gerätestatus und freigegebene Aktionen | Endpunkte und Berechtigungen zu prüfen. |
| Proxmox VE | Hosts, VMs, Container und erlaubte Aktionen | Endpunkte und genaue Aktionsliste zu prüfen. |
| Linux / Docker | Logs, Dienste, Container, Diagnose und erlaubte Reparaturen | Transport, Werkzeuge und unterstützte Distributionen offen. |
| Windows / Windows Server | Ereignisse, Dienste, Aufgaben und erlaubte PowerShell-Aktionen | Ausführungsmodell und unterstützte Versionen offen. |
| Microsoft 365 | Benutzer, Lizenzen, Dienstzustände und ausgewählte Verwaltung | Rechte, Authentifizierung und konkret unterstützte Aktionen offen. |
| sevdesk API | Belege, Finanzverwaltung, offene Posten und Berichtsdaten | Endpunkte, Tarifvoraussetzungen, Schreibmöglichkeiten und Datenabdeckung zu prüfen. |

### 9.2 Secrets über Proton Pass

Proton Pass ist das führende Secrets-System. IronCrew speichert Verweise auf benötigte Einträge. Zugangsdaten werden an der kontrollierten Werkzeuggrenze verwendet; Werte gehören weder in Modellkontext noch in normale Logs oder Ergebnisdateien.

Die offizielle Dokumentation beschreibt Agententokens mit Zugriff auf bestimmte Tresore oder einzelne Einträge, Rollen und protokollierten Zugriffsbegründungen. Agentensitzungen gelten zwei Stunden; Tokens haben Ablaufzeiten. Bei Token-Erneuerung wird ein neuer Token ausgegeben und der alte ungültig. Das Betriebskonzept muss daher Wiederanmeldung, Ablaufwarnungen und geregelten Tokenwechsel behandeln. [Quelle: Proton Pass CLI – agent](https://protonpass.github.io/pass-cli/commands/agent/)

Secret-Verweise können über stabile Tresor- und Eintrags-IDs adressiert werden. Dies vermeidet Mehrdeutigkeiten gleichnamiger Einträge. [Quelle: Proton Pass CLI – Secret references](https://protonpass.github.io/pass-cli/commands/contents/secret-references/)

**Ausarbeitung:** Der anfängliche Zugang zu Proton Pass wird geschützt außerhalb des Agenten-Arbeitskontexts auf dem Ausführungsrechner eingerichtet. Ein freier Shellprozess mit umfassenden Secrets könnte diese ausgeben; Werkzeugrechte, Prozessgrenzen und Filter müssen dieses Risiko konkret begrenzen. Ein bloßer Prompt ist keine technische Zugriffssperre.

### 9.3 Dateien und Versionen

Entwürfe und Zwischenstände liegen in der eigenen Arbeitsablage. Geprüfte Ergebnisse werden je Projekt oder Dokumentart in Git, Nextcloud oder Google Drive abgelegt. Der Auftrag verknüpft Ablageort und Version. Pro Inhalt ist ein System maßgeblich.

Die im Gespräch vorgeschlagene Standardzuordnung – Code nach Git, Dokumente nach Nextcloud, gemeinsam bearbeitete Google-Dokumente nach Drive – ist eine Ausarbeitung, noch keine separat bestätigte Vorgabe.

Externe Änderungen müssen vor dem Zurückschreiben erkannt werden. Übergabefehler bleiben sichtbar. Ein Auftrag darf nicht behaupten, ein Ergebnis sei erfolgreich abgelegt, wenn nur die lokale Erstellung gelungen ist.

### 9.4 Offene Web-Toolchain

HTML/CSS/JavaScript, React und WordPress gehören zum Startumfang. Weitere Frameworks, UI-Bibliotheken und Build-Werkzeuge wie Vite dürfen auftragsbezogen eingesetzt werden. Es gibt keine auf drei Technologiestapel begrenzte Produktidee.

**Ausarbeitung:** Der Lead beurteilt Eignung, Dokumentation, Wartung, Lizenz und Hosting. Neue Werkzeuge werden in getrennten Projektumgebungen ausprobiert. Ein Projekt dokumentiert Versionen, Abhängigkeiten sowie Installations-, Build-, Test- und Bereitstellungsbefehle. Experimentelle Werkzeuge sind als solche sichtbar. Produktive Unterstützung wird anhand funktionierender Projektabläufe nachgewiesen.

## 10. Vier Abnahmeszenarien

Die folgenden Kriterien sind **Ausarbeitung zur Prüfung im nächsten PRD-Schritt**. Sie beschreiben beobachtbare Ergebnisse und verhindern eine Abnahme allein anhand überzeugender Chatantworten.

| ID | Szenario | Abnahmekriterium |
| --- | --- | --- |
| WEB-01 | Website aus Briefing erstellen | Ein Auftrag enthält Lead, Briefing, Team, Kostenrahmen und Kriterien; die Crew liefert eine im Browser aufrufbare Vorschau. |
| WEB-02 | Qualität und Übergabe | Funktion, mobile Darstellung, visuelle Qualität und relevante Barrierefreiheits-/Performancekriterien sind geprüft; Code und Ergebnisversion sind nachvollziehbar. |
| WEB-03 | Veröffentlichung | Die konkrete Zielumgebung und Änderung sind zur erforderlichen Freigabe vorgelegt; fehlende Freigabe verhindert Veröffentlichung. |
| OPS-01 | Störung untersuchen | Eine Meldung wird genau einem nachvollziehbaren Vorgang zugeordnet; Diagnose und verwendete Systemdaten sind dokumentiert. |
| OPS-02 | Reparatur ausführen | Eine erlaubte Reparatur wird im richtigen Zielsystem ausgeführt und durch einen geeigneten Funktionscheck überprüft. Ein Reparaturversuch allein zählt nicht als Erfolg. |
| OPS-03 | Grenzen und Unklarheiten | Maßnahmen außerhalb des Mandats sowie unklare Wirkungen nach Unterbrechung werden eskaliert. |
| FIN-01 | Belege übernehmen | Der Ablauf erkennt wiederholte Eingänge, hält Original und Zuordnung fest und meldet fehlende Angaben. |
| FIN-02 | sevdesk verwenden | Unterstützte Übergaben werden mit Ziel-ID und Status belegt. Nicht unterstützte API-Schritte bleiben ausdrücklich manuell oder offen. |
| FIN-03 | Finanzbriefing | Offene Forderungen/Verbindlichkeiten und daraus abgeleitete Zahlen haben Quellen und Datenstand. Fehlende Bank- oder Zahlungsdaten werden als Lücke ausgewiesen. |
| FIN-04 | Berechtigungen | Entwürfe, externe Erinnerungen, verbindliche Einreichungen und Zahlungen werden gemäß festgelegter Aktionsrechte getrennt behandelt. |
| RES-01 | Recherche | Fragestellung, Quellen, Datenstand, belegte Aussagen und Unsicherheiten sind nachvollziehbar. |
| RES-02 | Ergebnis | Der Lead veranlasst die nötige Prüfung; ein tatsächlich erzeugtes Dokument wird im vorgesehenen Zielsystem abgelegt und verknüpft. |

## 11. Native Installation, Updates und Sicherung

### 11.1 Installation

Zentrale und Ausführungsdienste laufen nativ als Systemdienste. Der Installer erkennt vorhandene Voraussetzungen, richtet benötigte Komponenten ein und führt ins Onboarding. Projektaufgaben können weiterhin Container als Werkzeug beziehungsweise Arbeitsumgebung nutzen.

**Beschlossen:** Linux, macOS und Windows einschließlich Windows Server sind Zielplattformen für Zentrale und Ausführung.

**Offen:** Unterstützte Distributionen, Betriebssystemversionen und Prozessorarchitekturen, Dienstkonten, Installationsrechte, Laufzeitversion, Ports, HTTPS-Zugang und Paketverteilung. Der geprüfte Bestand setzt bereits Node.js 26 voraus; die Laufzeit für den Neubau wird im technischen Bauplan festgelegt.

### 11.2 Automatische Updates

Freigegebene Releasearten werden im Wartungsfenster automatisch installiert. Größere Änderungen, zusätzliche Befugnisse oder neue Voraussetzungen werden vorgelegt. Die konkreten Releasearten sind noch nicht ausgewählt.

Updates berücksichtigen laufende Aufträge, erstellen eine Sicherung, prüfen die Kompatibilität der Komponenten und führen Funktionstests aus. Ein Rückweg einschließlich Datenwiederherstellung bei Migrationen muss vor Freigabe eines Releases getestet sein.

**Ausarbeitung:** Rollout zunächst auf der vorgesehenen Zentrale beziehungsweise einem definierten Prüfpunkt; nicht erreichbare Ausführungsrechner erhalten einen sichtbaren Zustand. Inkompatible Rechner übernehmen keine neuen Aufträge. Downloadintegrität und vertrauenswürdige Releaseherkunft werden geprüft.

### 11.3 Eingebaute Firmensicherung

**Beschlossen ist Variante B: die eigene Firmensicherung.** Sie erstellt zeitgesteuert verschlüsselte Sicherungen und ermöglicht die Wiederherstellung auf einer neuen Installation. Ein vorhandenes Infrastrukturbackup ist keine Voraussetzung.

Zu sichern sind mindestens Firma, Crewprofile, Bereiche, Aufträge, Mandate, Freigabe- und Ausführungszustände, Wissen, Bewertungen, Modellprofile, Budgetdaten, Zeitpläne, Kanalzuordnungen und eigene Arbeitsdateien.

**Ausarbeitung der Wiederherstellung:**

- Eine Sicherung enthält einen konsistenten Stand sowie ein Manifest von Inhalt und Version.
- Externe Git-, Nextcloud-, Drive- und sevdesk-Inhalte sind klar von tatsächlich enthaltenen Dateien unterschieden. Ein Link im Backup ist keine Sicherung des externen Inhalts.
- Der Wiederherstellungsschlüssel muss unabhängig von der verlorenen Installation verfügbar sein; das Verfahren ist noch zu wählen.
- Proton-Pass-Zugänge und Kommunikationsanbindungen werden nach Wiederherstellung geprüft und gegebenenfalls neu eingerichtet.
- Aufträge, Zeitpläne und ausgehende Aktionen bleiben zunächst pausiert, bis ihr Status abgeglichen ist.
- Ein Wiederherstellungstest weist nach, dass Firma, Wissen, Dateien und Auftragszustände auf einer sauberen Installation nutzbar sind.

**Offen:** Sicherungsziel, Häufigkeit, Aufbewahrungsdauer, Schlüsselverwaltung, maximal tolerierter Datenverlust und Zielzeit bis zur Wiederaufnahme.

## 12. Technische Struktur als Vorschlag

Die folgenden Objekte sind eine Arbeitsgrundlage für das spätere Datenmodell, keine bereits festgelegte Datenbank- oder Frameworkwahl.

| Objekt | Zweck |
| --- | --- |
| Company / Area / Customer / Project | Firma und Zuordnung von Kontext, Ergebnissen und Kosten. |
| Employee / Role / Persona | Identität, fachliche Rolle, Rang und Auftreten unabhängig vom Modell. |
| Order / Task / Assignment | Gesamtauftrag, Arbeitsschritte, Team und genau ein verantwortlicher Lead. |
| Mandate / Approval | Zulässiger Handlungsrahmen und konkrete Entscheidungen. |
| Run / ToolAction / Checkpoint | Einzelne Ausführung, externe Wirkungen und Fortsetzung. |
| Worker / Capability | Ausführungsrechner, Fähigkeiten und erlaubte Zielumgebungen. |
| Review / Evaluation | Ergebnisprüfung und getrennte Mitarbeiter-/Modellbewertung. |
| KnowledgeEntry / Decision | Geprüftes Wissen und Firmenentscheidungen mit Herkunft. |
| Artifact / ExternalReference | Arbeitsdatei, Ergebnis, Version und maßgeblicher Ablageort. |
| Conversation / ChannelIdentity | Zugeordnete Gespräche und verifizierte Identität je Kanal. |
| Trigger / Schedule | Ereignisse und wiederkehrende Aufträge. |
| Budget / Reservation / Usage | Gesamtlimit, reservierte Mittel und tatsächlicher Verbrauch. |
| SecretReference / AuditEvent | Secret-Verweis und nachvollziehbare Aktionen ohne geheime Werte. |
| Backup / Restore / Release | Sicherungsstände, Wiederherstellungen und installierte Versionen. |

## 13. Vorschlag zur Umsetzung und Freigabe

Diese Reihenfolge ist noch kein bestätigter Releaseplan und schätzt weder Zeit noch Kosten.

1. **Technische Nachweise konkretisieren:** Die Bestands- und Dokumentationsprüfung ist erfolgt. Als Nächstes Übernahmegrenzen, API-Vertragstests, Lizenz- und Assetherkunft sowie Betriebssystem- und Hostingziele konkretisieren.
2. **Funktionsfähige Firmenbasis:** Ein Auftrag mit genau einem Lead führt über die eigene Laufzeit zu einer echten Dateiänderung, Prüfung und gespeicherten Ergebnisversion. Freigaben, Kostenreservierung und Fortsetzung nach Neustart werden nachgewiesen. Native Installation, Anmeldung, Mandate, Proton Pass und ein Ausführungsrechner bilden die Grundlage; dazu eine kompakte eigene Arbeitsoberfläche.
3. **Zusammenarbeit und Integrationen:** Kernteam, Modellwahl, Qualitätsprüfung, Wissen, Kanäle und Ablage; vier ausgewählte Abläufe durchgängig umsetzen.
4. **Eigenständiges Erlebnis:** Gründungsablauf, Chief-of-Staff-Briefing und 3D-Hauptquartier auf denselben echten Zustandsdaten. Gestaltung kann parallel zur technischen Basis entworfen werden.
5. **Betriebsreife:** Automatische Updates, Firmensicherung, Wiederherstellung, Unterbrechungen, API-Ausfälle und Budgetgrenzen anhand konkreter Szenarien abnehmen.

Die erste als vollständig bezeichnete Version muss die vereinbarten vier Abläufe, die ausgewählten Integrationen und das gewünschte Produktgefühl gemeinsam erfüllen. Interne Zwischenstände sind ausdrücklich als solche zu kennzeichnen.

## 14. Offene Entscheidungen und Prüfaufträge

| Priorität | Offener Punkt | Nächster sinnvoller Schritt |
| --- | --- | --- |
| Vor Modulübernahme | Konkrete Übernahmegrenzen innerhalb der bestätigten Neubaurichtung | Geeignete Module einschließlich Tests und Herkunft prüfen; neue Schnittstellen definieren. |
| Vor Aufwandsschätzung | Praktisch verfügbare API-Funktionen | Auf Grundlage der erfolgten Dokumentationsprüfung gezielte Tests mit berechtigten Testzugängen durchführen. |
| Vor nativer Installation | Versionen, Architekturen und Dienstrechte für Linux, macOS und Windows einschließlich Windows Server | Detaillierte Supportmatrix für Zentrale und Ausführungsrechner festlegen. |
| Vor produktiven Aktionen | Konkrete Mandate und reservierte CEO-Entscheidungen | Aktionsmatrix für Web, IT, Finanzverwaltung und Kommunikation erstellen. |
| Vor Finanzbriefing | sevdesk-Datenabdeckung und mögliche Bankdatenlücken | Endpunkte, Tarif und Quellen jeder Kennzahl bestimmen. |
| Vor Veröffentlichung | Hostingziele für HTML, React und WordPress | Zielumgebungen, Domains, Vorschau, Veröffentlichung und Rückweg festlegen. |
| Vor kanalübergreifendem Betrieb | Mailkonten und Benachrichtigungsrouting | Tatsächliche Konten, Empfänger und Identitätsverknüpfung auswählen. |
| Vor Backupfreigabe | Ziel, Schlüssel, Häufigkeit und Aufbewahrung | Wiederherstellungsziel vereinbaren und Wiederherstellung testen. |
| Vor Updateautomatik | Releasearten und Wartungsfenster | Standard auswählen und Umgang mit nicht erreichbaren Rechnern festlegen. |
| Vor Budgetautomatik | Periode, Beträge und Kostenabdeckung | Gemeinsamen Firmentopf konkret konfigurieren. |
| Vor UI-Abnahme | Konkrete Avatare der bestätigten Crew, eigene Logo-Assets, Sprachen und Leistungsziele | Visuelle Entwürfe und Kriterien auf Grundlage der festgelegten Besetzung auswählen. |
| Vor Qualitätsrouting | Bewertungsregeln und Modellvergleich | Dimensionen, Stichprobenumfang und Umgang mit neuen Modellen festlegen. |

### Empfohlener nächster gemeinsamer Schritt

Die vier Startabläufe sind in den Abschnitten 15 bis 18 konkretisiert. Die Technikprüfung und die Entscheidung für einen neuen Kern mit gezielter Übernahme liegen vor. Als Nächstes wird der erste vollständige Arbeitsweg aus Abschnitt 20.3 in konkrete Umsetzungsschritte übersetzt. Die bestätigten Abläufe und das gewünschte eigene Erscheinungsbild bleiben die Produktvorgaben.

## 15. Gemeinsam entworfener Websiteablauf

Die folgenden Entscheidungen ergänzen die allgemeinen Anforderungen. Das verwendete Beispiel eines Handwerksbetriebs und dessen beispielhaftes 20-Euro-Budget sind keine globalen Produktvorgaben.

### 15.1 Gespräch und Projekt nebeneinander

**Beschlossen:** Links bleibt das Gespräch mit dem Chief of Staff, rechts die Projektfläche. Dort sind passend zum Arbeitsstand Briefing, Team, Fortschritt und Vorschau erreichbar. Auf dem Handy wechseln Gespräch und Projekt über Tabs. Das Hauptquartier bleibt erreichbar.

Der Chief of Staff ordnet Unterlagen, Auftrag, Budget und Befugnisse zu. Rückfragen dienen der Klärung wesentlicher Anforderungen. Änderungen am Briefing bleiben sichtbar.

### 15.2 Mehrere visuelle Richtungen

**Beschlossen:** Vor der vollständigen Umsetzung legt die Crew mehrere visuelle Gestaltungskonzepte vor. Diese zeigen einen beispielhaften Einstieg, Typografie, Farben und Bildsprache mit kurzer Begründung. Der CEO wählt eine Richtung oder kombiniert gezielt Elemente.

Fünf grobe Konzepte wurden als Standard vorgeschlagen; die Anzahl bleibt je Auftrag und Budget anpassbar. Die konkrete Standardzahl ist bei der Detailabnahme zu bestätigen.

Die gewählte Richtung wird als Designentscheidung am Auftrag gespeichert und dient als Grundlage für Design, Entwicklung und spätere Prüfung.

### 15.3 Feedback über Gespräch und Markierungen

**Beschlossen:** Allgemeine Änderungswünsche können im Gespräch beschrieben werden. Zusätzlich lassen sich konkrete Stellen in der Vorschau markieren und kommentieren. Beide Formen landen in derselben Änderungsliste.

Markierungen beziehen sich auf Vorschauversion und Bildschirmgröße. Der CEO kann Kommentare sammeln und gemeinsam zur Umsetzung geben. Die Crew zeigt pro Punkt Umsetzung, Rückfrage oder noch offenen Zustand. Vorherige Versionen bleiben vergleichbar. Direktes Bearbeiten von Texten, Bildern oder Layout durch einen visuellen Editor wurde nicht ausgewählt.

**Ausarbeitung:** Beim Wechsel der Vorschauversion dürfen alte Markierungen nicht stillschweigend an eine unzutreffende Stelle verschoben werden. Sie bleiben ihrer Ursprungsversion zugeordnet; die Umsetzung verweist auf die neue Version.

### 15.4 Abnahme mit Ergebnis und Prüfübersicht

**Beschlossen:** Vorschau und Prüfübersicht stehen gemeinsam zur Verfügung. Eine Zusammenfassung führt zu erfüllten Anforderungen, Änderungen seit der letzten Rückmeldung, Prüfergebnissen, Einschränkungen und Kosten.

Ergebnisabnahme und Veröffentlichungsfreigabe sind getrennte Entscheidungen:

- Ergebnis abnehmen: Die gezeigte Version erfüllt den Auftrag.
- Veröffentlichen: Die konkrete Version darf auf das angegebene Ziel übertragen werden.

Nachträgliche Änderungen machen sichtbar, welche Prüfungen und Freigaben erneuert werden müssen. Eine Veröffentlichung ohne die erforderliche gültige Freigabe wird verhindert.

### 15.5 Bereitstellung vollständig organisieren, Ausnahme Selbsthosting

**Beschlossen:** Standardmäßig organisiert die Crew die Bereitstellung vollständig: benötigte Hostingumgebung einrichten, Domain und HTTPS konfigurieren, die freigegebene Website veröffentlichen und anschließend prüfen. Vorhandene geeignete Ressourcen dürfen verwendet werden. Mandate, Zugangsbeschränkungen und erforderliche Freigaben für neue Kosten gelten weiterhin.

**Ausnahme:** Möchte der Kunde selbst hosten, wird das Ergebnis für dessen Umgebung übergeben. Die Form der Übergabe richtet sich nach Website-System und Zielumgebung; sie kann beispielsweise Repository, Build-Artefakte, Installationsanleitung und Konfigurationsvorlagen umfassen. Kundenseitiges Hosting bedeutet keine automatische Berechtigung für IronCrew, auf die Kundenumgebung zuzugreifen.

**Ausarbeitung:** Falls der Kunde Unterstützung bei der Installation auf seiner Infrastruktur wünscht, wird diese als konkret berechtigter Arbeitsschritt vereinbart. Bis zur dort nachgewiesenen Bereitstellung lautet der Status entsprechend „übergeben“ beziehungsweise „wartet auf kundenseitige Bereitstellung“; die Crew behauptet keinen verifizierten Livebetrieb.

Vor einer durch IronCrew ausgeführten Bereitstellung zeigt die Projektfläche Ziel, Schritte, mögliche Unterbrechungen und Rückweg. Nach Veröffentlichung werden Erreichbarkeit, HTTPS, wichtige Seiten und Kontaktfunktionen geprüft. Erfolgsmeldungen enthalten öffentliche Adresse, veröffentlichte Version und offene Restpunkte.

### 15.6 Zusätzliche Abnahmekriterien – Ausarbeitung

| ID | Kriterium |
| --- | --- |
| WEB-04 | Gespräch und Projekt verwenden denselben Auftragsstand; die gewählte mobile Ansicht verliert den Kontext nicht. |
| WEB-05 | Die ausgewählte Designrichtung ist dokumentiert und den gezeigten Konzeptversionen zugeordnet. |
| WEB-06 | Chatwünsche und markierte Kommentare sind gemeinsam nachverfolgbar; jede Umsetzung verweist auf eine Ergebnisversion. |
| WEB-07 | Eine Ergebnisabnahme allein löst keine Veröffentlichung aus. Eine Freigabe für eine ältere Version autorisiert keine wesentlich veränderte Version. |
| WEB-08 | Der normale Bereitstellungsweg umfasst Hostingvorbereitung, Veröffentlichung und Liveprüfung innerhalb der bestehenden Befugnisse. |
| WEB-09 | Für Selbsthosting wird eine zum System passende Übergabe geliefert; fehlender Zugriff und ungeprüfter Livezustand sind eindeutig ausgewiesen. |

### 15.7 Noch offen

Konkrete Hostingziele, Standardzahl der Konzepte, Einzelheiten der Kundenübergabe sowie technische Realisierung der Vorschau-Kommentare werden im nächsten Entwurf konkretisiert.

### 15.8 Betreuung nach Veröffentlichung

**Beschlossen:** Technischer Betrieb ist der Standard für bei Iron Geeks gehostete Websites. Inhaltliche Weiterentwicklung, SEO und Auswertung werden als zusätzliche Betreuung vereinbart. Bei Selbsthosting richtet sich die weitere Verantwortung nach der Kundenvereinbarung.

Zum technischen Betreuungsumfang gehören im jeweils vereinbarten Rahmen Erreichbarkeit, Backups, Updates und Störungsbearbeitung. Daraus entstehen dauerhafte Mandate. Weiterentwicklung erhält ein eigenes Mandat beziehungsweise konkrete Folgeaufträge. Die technische Betreuung von Kundenwebsites ist von Updates und Firmensicherung der IronCrew-Installation selbst zu unterscheiden.

## 16. Gemeinsam entworfener IT-Störungsablauf

### 16.1 Eingang und Zuständigkeit

Eine Meldung wird einem Kunden, einer betroffenen Umgebung und einem Auftrag mit verantwortlichem Lead zugeordnet. Die Crew prüft bestehende Runbooks und Mandate. Das im Gespräch verwendete Beispiel einer nicht erreichbaren Website mit erlaubtem Dienstneustart ist ein Beispielszenario und erteilt keine globale Neustartberechtigung.

### 16.2 Nachvollziehbare Störungsansicht

**Beschlossen:** Die Ansicht zeigt eine laufende Zeitleiste mit Beobachtung, Diagnose, Maßnahme und Ergebnisprüfung. Jeder Schritt nennt Zielsystem und Ergebnis. Oben bleiben Auswirkung, aktueller Zustand und verantwortlicher Lead sichtbar.

Die Darstellung basiert auf belegbaren Aktionen und Ergebnissen. Geheime Werte werden ausgeblendet. Eine zusätzliche, im Vordergrund stehende Terminal-/Log-Arbeitsfläche wurde nicht als Standard ausgewählt.

### 16.3 Kundenkommunikation mit Freigabe

**Beschlossen:** Die Crew bereitet Störungsmeldungen, Zwischenstände und Abschlussnachrichten vor. Vor einem Versand an den Kunden ist die Freigabe des CEO erforderlich. Die angebotene automatische Kommunikation nach Kundenregeln wurde nicht ausgewählt.

Technische Arbeiten innerhalb bestehender Befugnisse laufen während der ausstehenden Nachrichtenfreigabe weiter. Der Entwurf nennt die betroffenen Empfänger und den konkreten Nachrichteninhalt. Die Freigabe gilt für diese Fassung. Wesentliche Änderungen erfordern erneute Freigabe.

**Ausarbeitung:** Überholte Entwürfe werden vor Versand erkannt. Beispielsweise darf eine inzwischen behobene Störung nicht durch eine alte Meldung als weiterhin ausgefallen dargestellt werden. Versand und Ergebnis werden dem Vorfall zugeordnet.

### 16.4 Beobachtung und Vorbeugung

**Beschlossen:** Nach erfolgreicher Reparatur wechselt der Vorfall zunächst in „Wiederhergestellt – unter Beobachtung“. Die Crew bewertet zusätzlich, ob eine dauerhafte Verbesserung erforderlich ist, und erstellt gegebenenfalls einen verknüpften Folgeauftrag.

Drei Sachverhalte werden getrennt dargestellt:

- Betrieb wiederhergestellt: Die geeignete Funktionsprüfung ist erfolgreich.
- Ursache: Bestätigt, vermutet oder noch unbekannt, mit jeweiliger Begründung.
- Vorbeugung: Erforderlich, umgesetzt oder als Folgeauftrag geplant.

Nach erfolgreicher Beobachtung kann der Störungsauftrag abgeschlossen werden, während eine größere Verbesserung separat weiterläuft. Neue Maßnahmen unterliegen weiterhin Mandat und Budget. Eine unbekannte Ursache wird nicht durch eine erfolgreiche Zwischenreparatur als geklärt ausgegeben.

**Ausarbeitung:** Beobachtungsdauer und Prüffrequenz werden passend zu Dienst und Störung festgelegt. Bei erneutem Fehler während der Beobachtung wird der Vorfall weiterbearbeitet und die Wiederholung dokumentiert. Doppelte Alarme sollen nicht unkontrolliert neue Aufträge oder Reparaturschleifen erzeugen.

### 16.5 Zusätzliche Abnahmekriterien – Ausarbeitung

| ID | Kriterium |
| --- | --- |
| OPS-04 | Die Zeitleiste zeigt tatsächliche Aktionen, Zielsysteme und Ergebnisse mit zugehörigem Vorfall. |
| OPS-05 | Eine vorbereitete Kundenmeldung wird ohne gültige CEO-Freigabe nicht versendet; zulässige technische Arbeit bleibt möglich. |
| OPS-06 | Erfolgreiche Reparatur führt zunächst zur Beobachtung; Beobachtungsdauer und Ergebnis sind nachvollziehbar. |
| OPS-07 | Wiederherstellung, Ursachenstand und Vorbeugung sind getrennt ausgewiesen. |
| OPS-08 | Ein Folgeauftrag zur Verbesserung ist mit dem Vorfall verknüpft und hat Lead, Mandatsbezug und Kostenrahmen. |
| OPS-09 | Der Vorfall kann nach erfolgreicher Beobachtung abgeschlossen werden, ohne einen noch offenen Folgeauftrag als erledigt auszugeben. |

### 16.6 Noch offen

Konkrete Runbooks, Kundenempfänger, Vorlagen für Störungsmeldungen, Beobachtungsregeln und fachlich geeignete Funktionsprüfungen je System sind zu definieren. API-Fähigkeiten und Rechte der ausgewählten IT-Anbindungen bleiben Gegenstand der technischen Prüfung.

## 17. Gemeinsam entworfener Finanzablauf mit sevdesk

### 17.1 Einstieg über die Finanzübersicht

**Beschlossen:** Der Finanzbereich startet mit einer Finanzübersicht. Offene Entscheidungen werden darin als auffällige Hinweise dargestellt. Belege, deren Vorschau und Detailfragen bleiben direkt erreichbar.

**Ausarbeitung der Übersicht:** Offene und überfällige Kundenrechnungen, anstehende Zahlungen nach Fälligkeit, Einnahmen und Ausgaben für einen wählbaren Zeitraum sowie fehlende Unterlagen und Freigaben. Jede Kennzahl hat eine Quelle und einen Datenstand. Liquidität benötigt geeignete Kontostands- und Zahlungsdaten; fehlende Daten werden sichtbar ausgewiesen. Definitionen der Kennzahlen und verfügbare sevdesk-Daten sind vor Implementierung zu prüfen.

### 17.2 Eindeutige Routine automatisch verarbeiten und dazulernen

**Beschlossen:** Freigegebene Belegtypen und bekannte Zuordnungen werden automatisch verarbeitet. Unklare Fälle und wesentliche Abweichungen kommen zum CEO. Die Crew soll aus bestätigten Korrekturen lernen.

Der CEO kann eine Korrektur nur auf den konkreten Beleg anwenden oder ausdrücklich als Regel für künftige passende Fälle übernehmen. Der zuständige Lead prüft vorgeschlagene Regeln auf Widersprüche. Regeln haben einen Geltungsbereich wie Lieferant, Belegtyp oder Projekt. Einzelkorrekturen werden nicht automatisch globale Regeln.

Die Anwendung einer Regel ist nachvollziehbar. Regeln können korrigiert und deaktiviert werden. Bei wesentlichen Abweichungen wird erneut gefragt. Die bisherige Entscheidung, Fachwissen durch Leads pflegen zu lassen, bleibt bestehen; die Bestätigung einer neuen Verarbeitungsregel konkretisiert hier die Automatisierungsbefugnis.

Beleg hochladen, Daten ergänzen, Zuordnung vornehmen und einen Vorgang verbindlich abschließen sind getrennte Aktionen. Welche davon die sevdesk-API unterstützt und welche Rechte benötigt werden, bleibt zu prüfen. Aus der Auswahl folgt kein allgemeines Mandat für beliebige neue Buchhaltungsfälle.

### 17.3 Automatische Zahlungserinnerungen nach Regeln

**Beschlossen:** Die Crew darf Zahlungserinnerungen innerhalb festgelegter Kommunikationsregeln selbst versenden. Diese Entscheidung gilt für Zahlungserinnerungen; Kundenmeldungen zu IT-Störungen bleiben gemäß Abschnitt 16 freigabepflichtig.

Die Regeln bestimmen Zeitpunkt, Empfänger, Ton und zulässige Erinnerungsstufen. Vor dem Versand werden der verfügbare Zahlungsstand und bekannte Absprachen geprüft. Bei widersprüchlichen beziehungsweise veralteten Daten, strittigen Rechnungen oder vereinbarten Zahlungspausen wird der Fall zurückgestellt und dem CEO vorgelegt.

Gebühren oder darüber hinausgehende Eskalationsschritte benötigen eine eigene Regelung. Versand, zugrunde liegender Rechnungsstand und verwendete Regel werden dokumentiert. Bereits versendete Erinnerungen dürfen durch Wiederholungen eines Ausführungsschritts nicht unkontrolliert erneut versendet werden.

### 17.4 Zahlungsvorbereitung für Lieferantenrechnungen

**Beschlossen:** IronCrew bereitet Zahlungsangaben und, soweit unterstützt, einen Import für das Banking vor. Der CEO prüft und bestätigt die Zahlungen im Banking. Eine direkte Banking-Anbindung wurde für diesen Ablauf nicht ausgewählt.

Die Vorbereitung verbindet Betrag, Fälligkeit, Empfänger, Zahlungsangaben und Verwendungszweck mit dem zugehörigen Beleg. Neue oder geänderte Bankverbindungen werden hervorgehoben und zur Prüfung vorgelegt.

Die Zustände vorbereitet, übergeben und tatsächlich bezahlt bleiben getrennt. Eine erzeugte oder importierte Zahlungsdatei gilt nicht als Zahlungsnachweis. Der Zahlungsstatus wird anhand verlässlicher Daten aus dem Zielsystem oder eines entsprechend gekennzeichneten Nachweises aktualisiert.

**Offen:** Bank, Banking-Anwendung und unterstütztes Importformat. Ein bestimmtes Format oder eine fertige Importfunktion ist vor dieser Prüfung nicht zugesagt. Fehlt ein geeigneter Importweg, bleibt die strukturierte Zahlungsvorbereitung nutzbar; die Einschränkung ist sichtbar.

### 17.5 Zusätzliche Abnahmekriterien – Ausarbeitung

| ID | Kriterium |
| --- | --- |
| FIN-05 | Der Finanzbereich startet mit einer Übersicht; jede dargestellte Kennzahl hat nachvollziehbare Herkunft und Datenstand. |
| FIN-06 | Ein freigegebener Routinefall wird ohne erneute Einzelbestätigung verarbeitet; ein wesentlicher Ausnahmefall wird vorgelegt. |
| FIN-07 | Eine Belegkorrektur wird nur nach ausdrücklicher Übernahme als wiederverwendbare Regel gespeichert; Herkunft, Geltungsbereich und Anwendung sind nachvollziehbar. |
| FIN-08 | Automatische Zahlungserinnerungen entsprechen den eingerichteten Regeln; strittige Fälle, Zahlungspausen und unzureichender Zahlungsdatenstand verhindern automatischen Versand. |
| FIN-09 | Die Freigabepflicht von IT-Kundenmeldungen bleibt trotz automatischer Zahlungserinnerungen erhalten. |
| FIN-10 | Eine Zahlungsvorbereitung beziehungsweise Importdatei ist dem Beleg zugeordnet und führt nicht allein zum Status bezahlt. |
| FIN-11 | Neue oder geänderte Bankverbindungen werden vor Nutzung zur Prüfung vorgelegt. |

### 17.6 Noch offen

Konkrete API-Aktionen, Tarifvoraussetzungen, Datenquellen für Zahlungsabgleich und Liquidität, Kennzahlendefinitionen, Regelvorlagen für Belege und Zahlungserinnerungen sowie Banking-Importformat sind zu prüfen beziehungsweise auszuwählen. Verbindliche Einreichungen und weitergehende Zahlungsbefugnisse wurden in diesem Ablauf nicht freigegeben.

## 18. Gemeinsam entworfener Rechercheablauf

### 18.1 Entscheidungsvorlage mit Vertiefung

**Beschlossen:** Das Rechercheergebnis beginnt mit einer kompakten Entscheidungsvorlage. Dahinter stehen ausführlicher Vergleich, Quellenbelege, Methodik und ergänzende Details zur Verfügung. Der Chief of Staff erklärt die Empfehlung kurz; der CEO und die Fachmitarbeiter können sie bei Bedarf vertieft nachvollziehen.

Die Projektfläche zeigt belegte Aussagen, Annahmen und fehlende Informationen unterscheidbar an. Das Ergebnis wird versioniert im vorgesehenen Ablagesystem gespeichert und mit dem Rechercheauftrag verknüpft. Das im Gespräch genannte Beispiel eines Vergleichs von Backupkonzepten ist ein Beispielszenario, keine Einschränkung auf technische Recherchen.

**Ausarbeitung des Ablaufs:**

1. Fragestellung, Entscheidungskriterien, erlaubten internen Kontext und Kostenrahmen klären.
2. Verfügbare interne Informationen und geeignete externe Quellen prüfen.
3. Optionen anhand derselben Kriterien vergleichen; Lücken und widersprüchliche Angaben kenntlich machen.
4. Schlussfolgerungen entsprechend Anspruch und Risiko gegenprüfen lassen; der Lead verantwortet die Qualität.
5. Empfehlung mit Begründung und Vertiefung liefern, Ergebnisdatei erzeugen und die erfolgreiche Ablage nachweisen.

### 18.2 Wiederverwendung und aktive Beobachtung

**Beschlossen:** Ausgewählte Recherchethemen können aktiv beobachtet werden. Entscheidungsrelevante Änderungen führen zu einer Aktualisierung und gegebenenfalls zu einer Nachricht an den CEO. Beobachtung erfolgt über ausdrückliche Aufträge beziehungsweise Mandate; nicht jede abgeschlossene Recherche wird automatisch dauerhaft überwacht.

Als Teil dieser erweiterten Variante wird bei erneuter Verwendung eines älteren Ergebnisses geprüft, ob die entscheidenden Angaben noch aktuell sind. Der Umfang richtet sich nach Fragestellung, Änderungswahrscheinlichkeit und Mandat.

Das Beobachtungsmandat beschreibt Thema, relevante Änderungen, Umfang, Häufigkeit und Kostenrahmen. Es nutzt die bereits beschlossenen Zeitplan- und Ereignisfunktionen. Recherche und Aktualisierung zählen zum gemeinsamen Firmentopf.

Aktualisierungen erzeugen neue Versionen. Der CEO sieht, was sich geändert hat und ob die bisherige Empfehlung noch gilt. Frühere Ergebnisse bleiben mit damaligem Datenstand nachvollziehbar. Die Entscheidung, eine Empfehlung tatsächlich umzusetzen oder eine Firmenregel zu ändern, folgt weiterhin den bestehenden Befugnissen.

### 18.3 Qualität und Änderungsbewertung – Ausarbeitung

- Quellen werden nach fachlicher Eignung und Aktualität ausgewählt; Primärquellen werden für überprüfbare Produkt- oder Schnittstellenangaben bevorzugt.
- Eine Quelle muss die damit belegte Aussage tatsächlich stützen. Fehlender Zugriff wird als Lücke ausgewiesen.
- Veröffentlichungsdatum, untersuchte Version und gegebenenfalls Ereignisdatum werden berücksichtigt.
- Interne Kundeninformationen werden nur im erlaubten Kontext verwendet und nicht ungeprüft in öffentliche Suchanfragen übernommen.
- Quellenänderungen werden auf inhaltliche Relevanz geprüft; eine bloße Layoutänderung soll keine Meldungsflut auslösen.
- Wenn eine geplante Prüfung wegen Quellenzugriff, Budget oder Werkzeugausfall nicht möglich war, wird der letzte erfolgreiche Prüfstand sichtbar gehalten. Eine fehlgeschlagene Prüfung darf nicht als unveränderte Sachlage gelten.
- Änderungen an einer Empfehlung werden vor Übernahme ins Firmenwissen vom zuständigen Lead geprüft. Firmenregeln bleiben dem CEO vorbehalten.

### 18.4 Zusätzliche Abnahmekriterien – Ausarbeitung

| ID | Kriterium |
| --- | --- |
| RES-03 | Die Ergebnisansicht bietet eine kompakte Empfehlung und eine zugängliche Vertiefung mit Vergleich, Quellen und Unsicherheiten. |
| RES-04 | Wesentliche Schlussfolgerungen sind zu Belegen beziehungsweise ausdrücklich gekennzeichneten Annahmen zurückverfolgbar. |
| RES-05 | Die abgelegte Ergebnisversion ist dem Auftrag zugeordnet; eine fehlgeschlagene Ablage bleibt sichtbar. |
| RES-06 | Ein Beobachtungsauftrag hat definierten Umfang, Prüfhäufigkeit und Kostenrahmen. |
| RES-07 | Eine relevante Änderung erzeugt eine neue Version mit Änderungsbeschreibung und Aussage zur bisherigen Empfehlung. |
| RES-08 | Quellen- oder Werkzeugausfälle führen zu einem sichtbaren unvollständigen Prüfstatus statt zu einer unbelegten Entwarnung. |
| RES-09 | Ein aktualisiertes Rechercheergebnis erweitert keine Befugnisse und verändert keine bestätigte Firmenregel ohne den vorgesehenen Entscheidungsprozess. |

### 18.5 Noch offen

Such- und Abrufwerkzeuge, konkrete Exportformate, Umgang mit zugangsbeschränkten Quellen, Regeln zur Aufbewahrung von Quellenmaterial sowie Standardwerte für Beobachtungsintervalle und Meldeschwellen werden technisch geprüft und anschließend festgelegt.

## 19. Stand nach dem gemeinsamen Durchspielen

Websiteerstellung einschließlich Betreuung, IT-Störungsbearbeitung, Finanzverwaltung mit sevdesk und Recherche sind als durchgängige Produkterlebnisse beschrieben. Die konkrete technische Umsetzung, das visuelle Detaildesign und die unter Abschnitt 14 sowie den Fachabläufen aufgeführten Betriebsparameter bleiben offen.

Das Dokument ist die gemeinsam erarbeitete Produktgrundlage einschließlich der bestätigten Neubaurichtung. Es ist weiterhin ein PRD-Entwurf; es meldet keine Implementierung, abgeschlossenen Integrationstests oder bereits verfügbaren Funktionen.

## 20. Bestätigte Neubaurichtung und technische Konsequenzen

### 20.1 Entscheidung

**Beschlossen nach der Technikprüfung:** IronCrew erhält einen neuen Produkt- und Laufzeitkern und eine eigene Oberfläche. Geeignete Grundlagen aus dem bestehenden Repository werden gezielt übernommen. Die Daten- und Bedienmodelle folgen Firma, Chief of Staff, Aufträgen, verantwortlichen Leads und Mandaten.

Die technische Grundlage ist die Prüfung vom 7. September 2026 am Repository-Commit `76160c0e56324d1ec16ebf2956cbeadbc544cfc4`, dokumentiert in „IronCrew-Technikpruefung-und-Neubauempfehlung.md“. Deren Aussagen zur damals noch offenen Richtungsentscheidung werden durch diese Bestätigung fortgeschrieben. Datenbank, Modulgrenzen, Übernahme einzelner Komponenten und Liefertermine bleiben technische Ausarbeitung.

### 20.2 Anforderungen aus den Befunden – Ausarbeitung

| Thema | Anforderung an die Umsetzung |
| --- | --- |
| Eigene Ausführung | Die produktive Modellschleife muss erlaubte Dateiänderungen, Builds, Prüfungen und Integrationsaktionen tatsächlich ausführen können. |
| Fortsetzung | Modellkontext, Werkzeugabsichten und Ergebnisse werden dauerhaft gespeichert. Nach einem Neustart werden offene Wirkungen geprüft, bevor eine möglicherweise bereits ausgeführte Aktion wiederholt wird. |
| Budget | Gleichzeitig laufende Aufrufe reservieren Mittel aus dem gemeinsamen Firmentopf. Fehlende Kostenangaben gelten als ungeklärt und werden nachermittelt. |
| Verantwortung | Jeder Auftrag hat genau einen verantwortlichen Lead; Bearbeiter und Reviewer können wechseln. |
| Integrationen | Dokumentierte Möglichkeiten werden durch gezielte Vertragstests nachgewiesen. Annahme einer Anfrage, tatsächliche Ausführung und fachlicher Erfolg bleiben unterscheidbar. |
| Secrets | pass-cli wird mit festgelegter Version, Anmeldung, Ablauf und Erneuerung praktisch validiert. |
| Sicherung | Verschlüsselung und Wiederherstellung auf einer neuen Installation werden nachgewiesen. Automatische externe Aktionen starten nach einer Wiederherstellung erst kontrolliert. |
| Native Dienste | Installation und Wiederanlauf werden auf jeder zugesagten Plattform geprüft. |

Die Schnittstellenprüfung konkretisiert zwei bestehende offene Punkte: Das Finanzbriefing muss gemeldete Bankstände von berechneten Transaktionssummen unterscheiden. Ein Banking-Import bleibt eine eigene zu prüfende Funktion; die Dokumentationsprüfung hat keinen sevdesk-Export für Zahlungsaufträge nachgewiesen. Quellen und weitere Integrationsgrenzen stehen in der Technikprüfung.

### 20.3 Erster technischer Meilenstein – Vorschlag

Ein Auftrag an den Chief of Staff erhält genau einen Lead, einen Plan und einen Kostenrahmen. Die eigene Laufzeit verändert eine echte Arbeitsdatei, führt eine geeignete Prüfung aus und speichert eine zugeordnete Ergebnisversion. Eine erforderliche Freigabe sowie ein Neustart unterbrechen den Ablauf kontrolliert; anschließend setzt er mit erhaltenem Kontext fort.

Dieser Meilenstein beweist den vollständigen Arbeitsweg. Er verkleinert den bestätigten ersten Lieferumfang nicht: Website, IT-Störung, sevdesk-Finanzverwaltung und Recherche bleiben gemeinsam enthalten. Hauptquartier und neue Nutzerführung können während der technischen Umsetzung bereits visuell ausgearbeitet werden.

### 20.4 Frische Einrichtung und Umgang mit Bestandsdaten

**Beschlossen:** Der Neubau startet mit einem frischen Datenbestand. Alte Daten im Repository dürfen entfernt werden; eine Migration bisheriger Firmen-, Auftrags- oder Wissensdaten ist nicht erforderlich. Der im Technikbericht zunächst vorgeschlagene Importweg entfällt damit als Entwicklungsanforderung.

Diese Entscheidung betrifft Bestandsdaten. Geeigneter Quellcode, zugehörige Tests und benötigte eigene Logos werden weiterhin nach den festgelegten Übernahmegrenzen behandelt. Aktualisierung und Wiederherstellung künftig erzeugter IronCrew-Daten bleiben Bestandteil des Produkts.

## 21. Charaktergestaltung des Kernteams

### 21.1 Gemeinsame Gestaltungsregeln

**Beschlossen:** Alle neun Mitarbeiter erhalten zur gewählten Vorlage passende Optik und Persona. Sie erscheinen als stilisierte menschliche 3D-Figuren in einer gemeinsamen visuellen Welt. Die eigenen Logos des Nutzers bestimmen den Firmenauftritt.

**Ausarbeitung:** Wiedererkennbare Silhouetten, Kleidung, Farben und Gesten unterscheiden die Figuren. Derselbe Charakter bleibt in Hauptquartier, Profil, Gespräch und Auftragsansicht konsistent. Die Profile sind gestaltete IronCrew-Personas; insbesondere bei Steve Jobs wird keine tatsächliche Mitwirkung der realen Person dargestellt.

Die Charakterisierung prägt Ton, Auftreten und Herangehensweise. Fachliche Rechte, Transparenz, Quellenpflichten und Freigaben folgen den Rollen und Mandaten. Figurenkonflikte dürfen als gelegentlicher Humor auftreten, behindern aber keine Aufträge. Wiederkehrende Sprüche werden sparsam verwendet.

### 21.2 Visuelle und persönliche Profile – Ausarbeitung

| Charakter | Visuelle Richtung | Persona und Arbeitsweise |
| --- | --- | --- |
| Cersei Lannister | Goldenes Haar, aufrechte Haltung, elegante Kleidung in Bordeaux und Gold. | Strategisch, selbstbewusst, scharfsinnig und direkt. Behält Prioritäten im Blick, widerspricht begründet und legt Entscheidungen sowie Fehler transparent vor. |
| Mr. Robot | Orientierung an der Darstellung von Christian Slater: Brille, Bart, dunkle Kappe und markante Arbeitsjacke. | Unkonventionell, technisch versiert, hartnäckig und trocken im Humor. Hinterfragt unnötige Komplexität, experimentiert in Testumgebungen und dokumentiert produktive Änderungen. |
| Morpheus | Kahler Kopf, charakteristische randlose Sonnenbrille und langer dunkler Mantel. | Ruhig, präzise, vorausschauend und ein geduldiger Mentor. Versteht zuerst den Systemzustand, greift gezielt ein und prüft die Wiederherstellung. |
| Steve Jobs | Schwarzer Rollkragenpullover, runde Brille, Jeans und Sneakers. | Fokussiert, anspruchsvoll und direkt. Hinterfragt den Nutzen jedes Elements, entwickelt klare Konzepte und prüft vollständige Nutzerwege. Kritik bleibt konkret und respektvoll. |
| Tyrion Lannister | Kleinwüchsige Figur mit gewelltem Haar, kurzem Bart und eleganter dunkelroter Weste mit goldenen Details. | Wortgewandt, scharfsinnig, diplomatisch und trocken im Humor. Erkennt Kundenbedürfnisse, behandelt Einwände und verbindet Geschichten mit überprüfbarem Kundennutzen. Der Austausch mit Cersei bleibt konstruktiv. |
| Saul Goodman | Zurückgekämmtes Haar, auffälliger Anzug, bunte Krawatte und selbstbewusstes Grinsen. | Schlagfertig, pragmatisch und hartnäckig. Erklärt Finanzen verständlich, verfolgt Kosten und Fristen und arbeitet bei Belegen und Zahlen sorgfältig. Macht Unsicherheiten sichtbar. |
| Karla Kolumna | Kurzes dunkles Haar, runde Brille, rote Jacke, Kamera und Notizblock. | Neugierig, lebhaft und ausdauernd. Fragt nach, entdeckt Zusammenhänge, prüft Quellen und trennt Fakten von Vermutungen. Begeisterung ersetzt keinen Beleg. |
| Der Professor | Dunkles, leicht zerzaustes Haar, Bart, markante Brille und schlichtes Hemd. | Analytisch, geduldig und akribisch. Denkt Fehlerfälle voraus, prüft Anforderungen systematisch und verlangt nachvollziehbare Nachweise. Beschreibt erforderliche Nachbesserungen präzise. |
| Nick Fury | Orientierung an der bekannten Marvel-Filmfigur: dunkle Haut, kahler Kopf, Augenklappe und schwarzer Ledermantel. | Direkt, strategisch, wachsam und souverän in Krisen. Prüft Zugriffsgrenzen und technische Risiken, fordert klare Verantwortlichkeiten und koordiniert Sicherheitsvorfälle. Kommuniziert knapp und handlungsorientiert. |

### 21.3 Abnahme der Charakterumsetzung – Ausarbeitung

- Jede der neun Rollen ist mit dem bestätigten Charakter vorbesetzt und weiterhin editierbar.
- Avatar und Profil stimmen in Erscheinung und Zuordnung überein; die Crew besitzt einen gemeinsamen visuellen Stil.
- Beispielgespräche zeigen unterscheidbare Personas bei gleicher fachlicher Sorgfalt und verständlicher Kommunikation.
- Rollenrechte und Modellwahl bleiben unabhängig von Charakter, Kleidung und Gesprächston.
- Temporäre Spezialisten erweitern die feste Besetzung nur im Rahmen des vereinbarten Auftrags- und Einstellungsmodells. John Carmack war eine vorgeschlagene Alternative und ist kein zusätzlich bestätigtes Kernteammitglied.

## 22. Entwicklungsübergabe

Das ergänzende Entwicklungspaket enthält `00-START-HIER.md`, `01-ARCHITEKTUR.md`, `02-OBERFLAECHE.md`, `03-INTEGRATIONEN.md`, `04-ARBEITSPAKETE.md`, `05-ABNAHME.md`, `06-BETRIEB.md` und `STARTPROMPT.md` sowie Vertragsentwürfe, Crew-Vorgaben und originale Logo-Assets. Die technische Prüfung bleibt als historischer Befund beigefügt.

Die technischen Festlegungen sind der konkrete Ausgangspunkt für die beauftragte Implementierung. Begründete Anpassungen werden als Architekturentscheidung dokumentiert; sie verändern keine bestätigten Produktziele. Das Paket enthält Spezifikationen und Referenzen, keine fertig implementierte Anwendung. Seine Erstellung umfasst keinen Release oder produktiven Eingriff.
