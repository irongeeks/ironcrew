# Oberfläche – B, die Einsatzzentrale

## 1. Gestaltungsgrundlage

Verbindliche Richtung: dunkle Industriehalle, Stahl, Glas, warme bernsteinfarbene Beleuchtung, sichtbares Iron-Geeks-Emblem. `assets/entwurf-b.png` zeigt Stimmung und räumlichen Aufbau. Dessen Bildtexte, Figurenabweichungen und Beispielstände werden korrigiert. Die Anwendung heißt IronCrew, die Unternehmensmarke Iron Geeks. Es gibt keine Oktopusmarke und keine Pixel-Art.

Originale: `irongeeks-logo-farbe.png`, `irongeeks-logo-sw.png`, `irongeeks-schriftzug.png`. Proportionen erhalten; Emblem groß an Hallenwand und im Onboarding, Schriftzug in der Navigation. Kleine Symbole nur aus einer bewusst abgenommenen Ableitung, nicht das detaillierte Emblem auf unlesbare 16 px verkleinern. Quelle und Hashes stehen im Manifest. Die Namen der Originaldateien sind keine Farbgarantie; tatsächliche Assets prüfen.

Tokens: Hintergrund #111416, Fläche #1A2024, erhöhte Fläche #242B30, Text #F3F0E8, sekundär #B6BEC4, Akzent #EFB34B mit dunkler Schrift, Erfolg #77C5A1, Fehler #F18E8E. Systemschrift für Bedienung, kein dekorativer Font für längere Texte. Mindestschrift 14 px, Fließtext 16 px; 8-px-Abstandsraster, Kontrollen 44 px Zielhöhe. Kontrast wird gemessen, Status zusätzlich mit Text/Icon vermittelt. Weitere Werte in `contracts/design.tokens.json`.

## 2. Navigation und Zustände

Fünf Hauptbereiche: Hauptquartier, Aufträge, Crew, Wissen, Einstellungen. Entscheidungen und Finanzen sind klar benannte Unteransichten von Hauptquartier/Aufträgen; keine zweite Büro-/Zentrale-Navigation auf dasselbe Ziel. Persistente Navigation mit aktiver Kennzeichnung, Suche, CEO-Menü und Benachrichtigungen. URL bestimmt geöffneten Auftrag und Tab, damit Reload und Links funktionieren.

| Route | Inhalt und Hauptaktion |
| --- | --- |
| `/setup` | Fortsetzbares Onboarding; nächster Schritt. |
| `/hq` | Briefing, Entscheidungen, aktive Aufträge und 3D-Halle; mit Cersei sprechen. |
| `/orders` | Liste/Kanban umschaltbar, Filter nach Status/Lead/Bereich; neuer Auftrag. |
| `/orders/:id` | Chat links, Arbeitsfläche rechts; auftragsabhängige nächste Aktion. |
| `/decisions` | Gebündelte offene Entscheidungen; einzeln prüfen. |
| `/finance` | Quellenbelegte Finanzübersicht; Belege und offene Fragen. |
| `/crew`, `/crew/:id` | Neun Mitarbeiter, Aufgaben, Persona, Modellprofil und Bewertungen. |
| `/knowledge` | Quellen, Geltungsbereich, geprüfte Versionen und Vorschläge. |
| `/settings/:section` | Firma, Modelle, Budget, Worker, Kanäle, Integrationen, Mandate, Routinen, Sicherung/Updates. |

Jede Datenansicht hat Loading, Empty, Ready, Stale, Error, Offline und Berechtigungszustand, soweit fachlich sinnvoll. Kein leerer Spinner ohne Ausweg. Beispielmodus trägt dauerhaft „Demo · Beispieldaten“ und lässt sich nicht mit echten Aufträgen vermischen. Null Euro ist ein belegter Nullwert, fehlende Kosten sind „noch ungeklärt“.

## 3. Hauptquartier

Desktop ab 1200 px: linke Navigation 208 px; räumliche Halle mittig; Briefing rechts 320–380 px; darunter aktive Aufträge. Bei wenig Höhe keine fünf übereinanderliegenden Statistikreihen. Cersei fasst Entscheidungen, neue Ergebnisse und relevante Hindernisse zusammen. CTA öffnet das persistente CEO-Gespräch als Arbeitsfläche. Firmentopf einmal mit verbraucht, reserviert und verfügbar; Zeitperiode ist sichtbar.

3D: zentraler Besprechungstisch, unterschiedliche Arbeitsbereiche hinter Glas, Verbindungsgänge, klare Blickachsen. Augenhöhe bis moderat erhöhte Perspektive, begrenztes Orbit/Pan und vordefinierte Kamerapositionen. Keine notwendige Ego-Steuerung. Klick auf Mitarbeiter öffnet Profil/aktive Arbeit; Klick auf Auftragsmarker öffnet Auftrag. Hoverdaten sind auch per Tastatur und Touch erreichbar. Browser-Zurück funktioniert.

Arbeitspositionen leiten sich aus echten Zuständen ab. Besprechung nur bei tatsächlich zugeordnetem Abstimmungsschritt. Dekoratives Gehen/Pausen sind lokale Animation ohne Modellkosten. Crew-Mitglied kann als offline/wartend/prüfend markiert sein; Renderbewegung darf nicht als Arbeitserfolg gelten. WebGL-Verlust führt zur kompakten Ansicht, nicht zum Verlust des Auftrags.

Figuren erhalten erwachsene stilisierte Proportionen und individuelle Kleidung nach `crew.seed.json`. Mr. Robot folgt Christian Slaters Figur. Nick Fury und Morpheus müssen durch Augenklappe/Brille, Kleidung und Silhouette klar unterscheidbar sein. Neun editierbare Profile sind Pflicht; Charakterdetailgrad darf in Zwischenständen reduziert sein, aber kein fertiger Release mit neun identischen Platzhalterfiguren. Idle, Gehen, Arbeiten und Besprechen mit passenden reduzierten Bewegungsalternativen.

## 4. Onboarding ohne Modellabhängigkeit

1. Einmaliges Setup-Token prüfen; CEO-Konto und Sprache DE/EN einrichten.
2. Firma, eigene Logos und Zeitzone bestätigen; keine automatische Geolokalisierungsannahme.
3. Cersei und die acht weiteren vorbesetzten Rollen anzeigen; Namen/Persona editierbar.
4. Proton Pass lokal geschützt verbinden; nur SecretRefs in Firmendaten. OpenRouter-Verweis zuordnen, Verbindung und Katalog testen. Bei fehlendem Zugang Einrichtung weiter speichern, Live-Arbeit bleibt blockiert.
5. Gemeinsamen Budgetzeitraum und Betrag setzen. Keine stillschweigende kostenpflichtige Standardfreigabe.
6. Lokalen Worker aktivieren oder entfernten Worker mit einmaligem Enrollment verbinden; Fähigkeiten und Isolation prüfen.
7. Bereiche und optionale Kunden anlegen; Kanäle und Fachintegrationen einzeln verbinden oder sichtbar zurückstellen.
8. Mandate/Routinen mit konkreten Aktionen prüfen. Zusammenfassung zeigt aktiv, fehlt, später ergänzbar. Abschluss führt ins HQ; ein Einführungsauftrag verwendet nur ausdrücklich genehmigte Testdaten und Budget.

Jeder Schritt wird gespeichert; Reload/Neustart setzt fort. Tokens/Passwörter verschwinden nach Übernahme aus UI-State und Logs. Validierung neben dem betreffenden Feld; Zurücknavigation verliert keine normalen Eingaben. Hilfe erklärt Nutzen statt Implementierungsdetails.

## 5. Auftragsfläche und vier Fachansichten

Desktop: Chat 32 %, Projekt 68 %, Trennlinie verschiebbar mit sinnvollen Minima. Kopf zeigt Ziel, Lead, Zustand/Wartegrund, Kostenrahmen, Planversion. Projekt-Tabs: Überblick, Ergebnis, Verlauf, Dateien, Prüfungen; je Ablauf ergänzende Ansichten. Chat wird nicht bei jedem Tabwechsel neu erzeugt. Quellen, Artefakte und Entscheidungen sind direkt verlinkt.

**Website:** Briefing → mehrere unterscheidbare Konzepte (Default fünf, konfigurierbar) → ausgewählte Richtung → Umsetzung → unabhängige Prüfung → Abnahme → Veröffentlichung. Vorschau mit Desktop/Tablet/Mobil, gepinnten Kommentaren mit Artefaktversion, Viewport und Elementanker. Kommentar zu alter Version ist erkennbar. Vor Abnahme Zusammenfassung der Änderungen, Prüfbelege und Restpunkte. Veröffentlichung separat mit Ziel, Domain, Artefakthash und Rückweg. Eigenhosting umfasst Provisionierung und technische Pflege; bei Kundenselbsthosting reproduzierbares Übergabepaket. SEO/Inhaltspflege ist Zusatzmandat.

**IT:** Zeitleiste Beobachtung → Diagnose → Aktion → Funktionsprüfung → Beobachtungsphase. Zielsystem, Quellenzeitpunkt und Befugnis sichtbar. „Befehl angenommen“ ist kein behobener Vorfall. Kundenmeldung bleibt als konkrete Versandfreigabe offen; Prävention wird verknüpfter Folgeauftrag.

**Finanzen:** Einstieg `/finance`: Forderungen, Verbindlichkeiten, Fälligkeiten, Belege und Datenstand. Betrag und Währung je Kennzahl. Quellenhinweis unterscheidet Buchungsdaten, Transaktionssumme und gemeldeten Bankstand. Belegvorschau neben Zuordnung; Korrektur nur diesmal / als Regel vorschlagen. Zahlungserinnerungen zeigen verwendete Regel und letzten geprüften Zahlungsstand. Zahlungsvorbereitung und Bankimport niemals als bezahlt anzeigen.

**Recherche:** Oben knappe Empfehlung mit wesentlichen Gründen, darunter Vergleich, Quellen, Methodik und Unsicherheiten. Tatsächliches Ergebnisdokument mit Version/Ablage. Monitoring zeigt letzte erfolgreiche Prüfung und relevante Änderungen. Fehlender Quellenzugriff erhält sichtbaren unvollständigen Status.

## 6. Entscheidungen, mobile Bedienung und Abnahme

Freigabekarte: Wer schlägt was vor, welches System/Objekt, genauer Umfang, Kosten/Folgen, relevante Version, Ablaufzeit, Empfehlung. Aktionen Freigeben/Ablehnen/Rückfrage. Geänderte Argumente machen alte Karte ungültig. Mehrere Entscheidungen können gruppiert dargestellt werden; keine pauschale Zustimmung zu unbekannten späteren Änderungen.

768–1199 px: Navigation kompakt, Briefing vor Hallenansicht; Arbeitsflächen bei Bedarf über Tabs. Unter 768 px: Hauptquartier startet kompakt, 3D nur auf Wunsch; Chat/Projekt als Tabs mit erhaltenem Scroll-/Eingabestand. Kein horizontales Scrollen der Gesamtsite bei 360 px. Touchziele 44 px, Tastaturfokus sichtbar, Dialoge mit Fokusmanagement. Reduzierte Bewegung, 200 % Zoom und Screenreader werden geprüft.

Messbare Zielwerte für die definierte Testumgebung: initiale Nicht-3D-JS-Auslieferung höchstens 350 KiB gzip; 3D separat nachladen. HQ-Anfangsassetbudget höchstens 15 MiB komprimiert, weitere Detailassets bedarfsweise. P95 Eingabereaktion unter 200 ms bei vorbereiteter lokaler Testdatenmenge von 1.000 Aufträgen. 3D-Ziel 30 fps auf dokumentiertem Referenzgerät; Qualitätsstufe senkt Schatten/Auflösung und pausiert bei unsichtbarem Tab. Dies sind Abnahmeziele, noch keine gemessenen Eigenschaften. Screenshots bei 1440×900, 1024×768 und 390×844, inklusive leerem und blockiertem Zustand.
