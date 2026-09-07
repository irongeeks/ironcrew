# IronCrew – Entwicklungsübergabe 1.0

Stand: 7. September 2026. Produktgrundlage: PRD 0.9. Referenzsoftware: 0.3.1; die Dokumentversionen legen keine neue Softwareversion fest.

## Auftrag und Ergebnis

Baue IronCrew als eigenständige digitale Firma mit eigener Agentenlaufzeit und der ausgewählten Einsatzzentrale B. Ein Mensch führt über Cersei als Chief of Staff neun feste Mitarbeiter. Jeder Auftrag besitzt genau einen Lead. Websiteerstellung, IT-Störungsbearbeitung, sevdesk-Finanzverwaltung und Recherche gehören gemeinsam zur ersten vollständigen Version. Linux, macOS, Windows und Windows Server sind native Zielsysteme.

Das Paket ist ein konkreter Bauauftrag. Es enthält keine ausführbare Anwendung. Starte mit AP-00 bis AP-03 und arbeite anschließend entlang der Abhängigkeiten weiter. Ein visueller Prototyp allein erfüllt den Auftrag nicht.

## Lesereihenfolge

1. [PRD](IronCrew-PRD-Entwurf-01.md): bestätigtes Produkt und Fachabläufe.
2. [Architektur](01-ARCHITEKTUR.md): technische Entscheidungen und Zustände.
3. [Oberfläche](02-OBERFLAECHE.md): Gestaltung B, Ansichten und Interaktionen.
4. [Integrationen](03-INTEGRATIONEN.md) und [Betrieb](06-BETRIEB.md).
5. [Arbeitspakete](04-ARBEITSPAKETE.md) und [Abnahme](05-ABNAHME.md).
6. [Startprompt](STARTPROMPT.md): vollständiger Auftrag für den Entwicklungsagenten.

Die Technikprüfung ist historischer Quellcodebefund. Ihre inzwischen entschiedenen offenen Fragen werden durch PRD 0.9 und dieses Paket fortgeschrieben. Insbesondere gibt es keinen Altdatenimport; alte Daten im Repository dürfen beim Neubau entfernt werden. Produktvorgaben und konkrete Nutzerentscheidungen gehen technischen Vorschlägen vor. Bildtexte sind unverbindliche Beispieldaten.

## Paketinhalt

| Datei | Verwendung |
| --- | --- |
| `contracts/crew.seed.json` | Neun bestätigte Identitäten, Rollen und Persona-Vorgaben; kein Seed mit echten Nutzerdaten. |
| `contracts/contracts.ts` | Ausgangsvertrag für Zustände, Werkzeugaktionen und Worker-Nachrichten. Laufzeitvalidierung und weitere Schemas sind zu implementieren. |
| `contracts/design.tokens.json` | Farb-, Größen- und Bewegungswerte für Entwurf B. |
| `contracts/config.example.json` | Einrichtung ohne Zugangsdaten; Live-Ausführung standardmäßig ausgeschaltet. |
| `assets/entwurf-b.png` | Gewählte räumliche und visuelle Richtung, keine pixelgenaue Funktionsspezifikation. |
| `assets/irongeeks-*.png` | Unveränderte originale Logo-Dateien aus dem Nutzerpaket. |
| `MANIFEST.json` | Dateigrößen und SHA-256 zur Überprüfung der Paketvollständigkeit. |

## Sofort beginnen ohne weitere Nutzerentscheidungen

Technische Defaults sind festgelegt. Fehlende Kundenkonten verhindern nur den betreffenden Live-Test. Implementiere Clients und dokumentierte Testserver, kennzeichne Fähigkeiten als noch nicht live validiert und arbeite an unabhängigen Paketen weiter. Keine erfundenen Konto-, Bank-, Domain- oder Hostingwerte einsetzen. Zugangsdaten gehören nicht in dieses Paket oder in Agentenprompts.

Offene Betriebswerte sind im Betriebshandbuch nach dem Zeitpunkt ihrer Notwendigkeit geordnet. Die Implementierung darf ihre Eingaben und Validierung bereits bereitstellen. Ein fehlender Dienstzugang rechtfertigt keine Attrappe, die Erfolg meldet.
