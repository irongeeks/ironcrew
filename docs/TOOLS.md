# Werkzeuge: Register, Risikoklassen und Freigaben

Bis hierher konnte die Firma sagen, auf welchem Modell ein Agent läuft, wie
lange er laufen darf und ob eine Handlung eine Freigabe braucht. Was sie nicht
sagen konnte, ist genau das, was einen Betreiber umtreibt: _dieser_ Agent darf
im Web suchen, _jener_ nicht, und niemand veröffentlicht etwas, ohne vorher zu
fragen.

Vorher galt: ein Werkzeug war entweder einkompiliert oder aus einem Marktplatz
installiert — und sobald es da war, hatten es alle. Das ist dieselbe Form, die
Postfach-Freigaben und Messenger-Pairings schon abgelehnt haben: **Vorhandensein
ist keine Erlaubnis.**

## Zwei Tabellen, zwei Aussagen

| Tabelle            | Sagt                               |
| ------------------ | ---------------------------------- |
| `crew_tools`       | Was dieser Server ausführen _kann_ |
| `crew_tool_grants` | Wer es benutzen _darf_             |

Beim Start registriert IronCrew alle eingebauten Werkzeuge. Das vergibt nichts:
Ein frisch installierter Server kann suchen und browsen, und kein Agent darf
es, bis du es sagst.

## Risikoklassen

Die Klasse hängt am Werkzeug, nicht an der Freigabe — sie beschreibt, was das
Werkzeug der Welt antun kann, und das ändert sich nicht pro Agent.

| Klasse     | Bedeutung                                             | Beispiel           |
| ---------- | ----------------------------------------------------- | ------------------ |
| `read`     | Beobachtet nur                                        | `web.search`       |
| `write`    | Verändert etwas im eigenen Arbeitsbereich             | `browser.interact` |
| `external` | Löst außerhalb etwas aus, das als echt behandelt wird | `browser.external` |

**`external` ist standardmäßig freigabepflichtig.** Das ist der Punkt, an dem
die Spalte `requires_approval` bewusst NULL-fähig ist: Weglassen bedeutet
„was die Risikoklasse impliziert", nicht „nein". Ein externes Werkzeug bleibt
also durch Auslassen gesichert, und wer die Pflicht abschalten will, muss beim
Anlegen der Freigabe zusätzlich `allowUnapprovedExternal` setzen. Den Riegel
vor etwas wegzunehmen, das Geld ausgeben kann, soll mehr verlangen als ein
vergessenes Feld.

Warum die Freigabepflicht trotzdem an der _Freigabe_ hängt und nicht nur am
Werkzeug: Dasselbe Werkzeug ist in verschiedenen Händen ein anderes Risiko. Der
Recherche-Agent, der mit dem Browser Dokumentation liest, und der
Vertriebs-Agent, der damit ein Formular abschickt, tun nicht dasselbe. Eine
pauschale Einstellung müsste pessimistisch genug für den schlimmsten Fall sein
— und wird dann abgeschaltet.

## Drei Geltungsbereiche

Eine Freigabe nennt genau einen davon:

- **Agent** — dieser Posten.
- **Projekt** — jeder Agent, der in diesem Projekt arbeitet. Genau das, was ein
  MSP braucht: Der Kunden-MCP-Server gilt im Kundenprojekt und nirgends sonst.
- **Talent** — die Rolle allgemein. „Jeder CTO darf im Web suchen" überlebt es,
  wenn ein Agent in ein anderes Vessel umgezogen wird.

Bei Überschneidung gilt **Agent > Projekt > Talent**: das Spezifischere gewinnt,
weil wer es geschrieben hat, es so gemeint hat.

## MCP-Server sind Werkzeuge

Ein MCP-Server ist eine Werkzeugquelle. Er landet deshalb im selben Register
(`origin: "mcp"`, Risikoklasse `external`) und hinter demselben Gate — statt in
einem zweiten Berechtigungssystem, das irgendwann eine andere Antwort gibt als
dieses. Genau so wird aus einem Gate eine Empfehlung.

Verschwindet ein Server aus der Konfiguration, wird sein Werkzeug
**deaktiviert, nicht gelöscht**. Löschen würde die Freigaben stillschweigend
mitnehmen; ein später wieder hinzugefügter Server käme mit gelöschten Rechten
zurück, und niemand wüsste warum.

## Websuche

Zwei Anbieter, beide über injizierbaren `fetch` testbar:

| Anbieter | Env                    | Anmerkung                                                 |
| -------- | ---------------------- | --------------------------------------------------------- |
| SearXNG  | `SEARXNG_URL`          | Selbst gehostet, kein Schlüssel, Anfragen bleiben im Haus |
| Brave    | `BRAVE_SEARCH_API_KEY` | Schlüssel geht im Header, nie in der URL                  |

**Suchergebnisse sind Text, den ein Fremder geschrieben hat.** Jeder kann eine
Seite ins Netz stellen, auf der „ignoriere deine Anweisungen" steht. Deshalb
werden Titel, Ausschnitt und URL an der Anbieter-Grenze von Steuertokens und
unsichtbaren Zeichen befreit, Ergebnisse ohne `http(s)`-URL fliegen ganz raus,
Länge und Anzahl sind gedeckelt, und was in einen Prompt geht, ist gefencet
(`wrapSearchResults`). Bereinigt ist nicht dasselbe wie vertrauenswürdig.

## Browser

Der Browser ist das gefährlichste Werkzeug, nicht weil er mächtig ist, sondern
weil seine Handlungen gleich _aussehen_: Eine Seite lesen und „Kaufen" klicken
sind dieselben drei Zeilen Playwright.

- **Host-Allowlist, deny-by-default.** Keine Liste heißt keine Navigation, nicht
  „überall". Ein Eintrag mit führendem Punkt (`.example.com`) erlaubt
  Subdomains, ein blanker Hostname nur sich selbst.
- **Nur `http`/`https`.** `file:` wäre ein lokaler Dateizugriff, `data:` und
  `javascript:` wären Skriptausführung.
- **Eigenes Profil.** Nie Chromiums Standardprofil — sonst erbt der Agent deine
  Cookies und angemeldeten Sitzungen, und aus „lies diese Seite" wird „handle
  als der Betreiber".
- **`submit` gilt als `external`**, auch wenn das Formular offensichtlich eine
  Suchbox ist. Der Code kann eine Suche nicht von einem Checkout unterscheiden,
  also nimmt er den teureren Fall an.

## REST

```
GET    /api/crew/tools                      Register mit Freigaben
POST   /api/crew/tools/:id/grants           { agentId | talentId | projectId, requiresApproval?, allowUnapprovedExternal? }
DELETE /api/crew/tool-grants/:id            Freigabe entziehen
POST   /api/crew/tools/:id/enabled          { enabled }
GET    /api/crew/agents/:id/tools[?projectId=]   Was dieser Agent (in diesem Projekt) darf
GET    /api/crew/search-providers
POST   /api/crew/search                     { agentId, query, … }
```

`POST /search` nimmt eine Agenten-ID und geht durch dasselbe Gate — die API ist
kein Weg an einer Freigabe vorbei, die du nicht erteilt hast. Antworten: `200`
mit Treffern, `403` wenn der Agent es nicht darf, `202` mit `approvalId` wenn du
die Suche freigabepflichtig gemacht hast.
