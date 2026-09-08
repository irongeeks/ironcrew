# IronCrew

## Version 0.4.3 — Laufzeit, Sicherheit und Nachtest-Korrekturen

IronCrew 0.4.3 bearbeitet die zwölf Issues aus dem Linux-/macOS-Nachtest von 0.4.2:
Modellläufe, Datenbankrechte, Mail-Zeitstempel, Katalogabrufe, generierte Websites
und Einrichtung sowie Proton-, QA- und Mobiltest-Korrekturen im Hauptserver.
Der neue Produktkern läuft im eigenständigen Workspace [`next/`](next/README.md).
[Modellzugang prüfen](next/docs/model-access-troubleshooting.md) ·
[Update von 0.4.0–0.4.2](docs/releases/v0.4.3.md#update-von-04x).

Der [Release v0.4.3](https://github.com/irongeeks/ironcrew/releases/tag/v0.4.3)
enthält den vollständigen Git-Quellstand als Archiv, ein Release-Manifest und
`SHA256SUMS`. Der Einstieg für diese Version ist **`next/`**. Voraussetzung sind
**Node.js 26.4.0** und **pnpm 10.30.1**. Nach dem Entpacken im Repositoryverzeichnis:

```sh
cd next
npx --yes pnpm@10.30.1 install --frozen-lockfile
npx --yes pnpm@10.30.1 build
npx --yes pnpm@10.30.1 start
```

Die Oberfläche öffnet sich unter `http://127.0.0.1:8790`; das lokale Startprotokoll
liefert das einmalige Setup-Token. 0.4.3 verwendet eine eigene Datenbank und
übernimmt keine Daten aus 0.3.x. Es wird kein neues OCI-Image und kein produktiv
signiertes natives Installationspaket mit diesem Quellrelease veröffentlicht.

[Änderungen und Releaseumfang](docs/releases/v0.4.3.md) ·
[Einrichtung und Bedienung von 0.4.3](next/README.md) ·
[Prüfnachweise](next/docs/verification.md) ·
[Offene externe Abnahmen](next/docs/release-readiness.md)

## Legacy 0.3.x — bisheriger Produktkern

Die folgenden Anleitungen, Screenshots und Funktionsbeschreibungen beziehen sich
auf den bisherigen Produktkern im Repository-Root. Seine `package.json` bleibt
bei 0.3.1; die folgenden Docker- und Updateanleitungen gehören zu dieser älteren
Produktlinie. Für 0.4.3 gilt der Einstieg in `next/` oben.

**Deine virtuelle AI-Firma. Ein Ansprechpartner, eine Crew und ein gemeinsamer Arbeitsstand.**

IronCrew ist ein selbst gehostetes Multi-Agent-Company-OS für Linux und macOS.
Du bist der CEO. Dein Executive Assistant nimmt Aufträge entgegen, plant und
delegiert sie. Fachagenten bearbeiten die Aufgaben; Ergebnisse, Reviews,
Freigaben und Kosten bleiben nachvollziehbar.

[Erste Schritte](docs/GETTING_STARTED.md) · [Bedienung](docs/USER_GUIDE.md) ·
[Dokumentation](docs/README.md) · [Releases](https://github.com/irongeeks/ironcrew/releases) ·
[Installation und Updates](docs/RELEASES.md)

![IronCrew: modernes Firmengebäude mit Abteilungsbüros, Crew und CEO-Chat](docs/screenshots/ironcrew-office.png)

*Browseraufnahme aus Version 0.3.0 in der isolierten Testinstallation: originale Seed-Crew und ein
gekennzeichneter Dokumentationsauftrag. Die Bilder zeigen keine produktive Firma
und belegen keine Ausführung mit einem echten Providerkonto.*

## Version 0.3.1

Die OpenRouter-Modellauswahl zeigt den vollständigen Live-Katalog mit Suche,
Autocomplete und Filtern. Die Oberfläche ist durchgehend auf Deutsch und Englisch
verfügbar; selten benötigte Ansichten werden bei Bedarf geladen. Installation,
Docker und CI verwenden jetzt **Node.js 26**.
[Alle Änderungen und Update-Hinweise](docs/releases/v0.3.1.md).

IronCrew beginnt seine eigene Produktversionierung bei **0.1.0**. Die zuvor
veröffentlichte `2.8.0` folgte noch der übernommenen Versionsreihe. Sie bleibt
als historische Veröffentlichung erhalten; die Weiterentwicklung läuft ab jetzt
über `0.1.x` und spätere Versionen.

**Bereits 2.8.0 installiert?** Verwende den
[einmaligen Versionswechsel](docs/RELEASES.md#wechsel-von-280-auf-010).
Der alte Updater kennt diesen Übergang noch nicht. Die Datenbank wird dabei
nicht auf einen früheren Stand zurückgesetzt.

`0.3.1` bezeichnet einen frühen Entwicklungsstand mit getesteten Kernabläufen.
Ein vollständiger automatisierter Betrieb deines Geschäfts ist damit nicht zugesichert.
Den konkreten Umfang und die verbleibenden Grenzen dokumentieren
[Implementierungsstand](IMPLEMENTATION_STATUS.md) und
[Produktabnahme](docs/PRODUCT_ACCEPTANCE.md).

## Was du damit machen kannst

| Bereich | Funktionen |
| --- | --- |
| **CEO und Aufgaben** | EA-Chat, Projektplanung mit Freigabe, persistente Tasks, Abhängigkeiten, Kanban, Ergebnisse und Revisionen |
| **Lebendiges Office** | Unterschiedlich eingerichtete Abteilungsbüros, Flure, Lounge, Meetings, Raumfokus und Figuren mit echten Agentenzuständen |
| **Mitarbeiter** | Getrennte Fachrolle, Junior/Senior/Lead-Level, Modellprofil, Berechtigungen und visuelle Figur |
| **Delegation und Qualität** | Leads verteilen Aufgaben und vergeben 1–5 Sterne; separate versionierte Text-/JSON-Prüfungen messen gespeicherte Run-Ergebnisse reproduzierbar |
| **Runtimes** | MockRuntime sowie Adapter für Claude Code, Codex, Antigravity und OpenRouter; Health, Streaming, Abbruch, Rate-Limit-Queue und Recovery |
| **Governance** | Technische Freigabegates, Budgets, atomare Task-Claims, Vendor-Policy, Owner-Konfiguration für Laufzeiten/Tools/Memory und prüfbarer Audit-Trail |
| **Wissen und Integrationen** | Obsidian-kompatibler Vault, optional Honcho, Tools/MCP, Mail und Business-Packs; der Umfang einzelner Adapter ist dokumentiert |
| **Geschäftsdaten** | Expliziter Abruf vorhandener MSP-/Rechnungsadapter mit Quelle, Zeitpunkt, begrenzter Datengrundlage und ehrlichen Fehler-/Leerzuständen |
| **Betrieb** | Nativ oder Docker Compose, nativer Host-Runner, versionierte Releases, Sicherungen und Wiederherstellung |

Die Lead-Steuerung wird pro Abteilung eingerichtet und ausdrücklich aktiviert.
Sterne sind Modellreviews mit Arbeitsbelegen. Die zusätzlichen objektiven Prüfungen
werten festgelegte Kriterien aus; auch deren Quote ist kein allgemeiner Qualitätsbenchmark.
[Team und Leistung](docs/CAREER_REVIEWS.md) erklärt die Auswertung.

## Ein Auftrag durch die Firma

1. Du beschreibst das gewünschte Ergebnis im CEO-Chat.
2. Der EA triagiert den Auftrag. Größere Projekte erhalten einen Plan zur Freigabe.
3. Aufgaben werden an passende Fachagenten delegiert; bei aktivierter
   Abteilungssteuerung übernimmt der Lead die Verteilung.
4. Runs liefern Live-Events, Arbeitsprodukte und ihren tatsächlichen Status.
5. Ergebnisse gehen ins Review. Du kannst sie annehmen oder eine Revision anfordern.
6. Aufgaben, Nachrichten, Entscheidungen und Audit bleiben nach einem Neustart erhalten.

[Der erste Auftrag](docs/GETTING_STARTED.md) ·
[Projektplanung](docs/PROJECT_PLANNING.md) · [Modellrouting](docs/RUNTIME_ROUTING.md)

## Ein Blick in IronCrew

**Abteilungsbüro im Raumfokus.** Einrichtung und Arbeitsplätze unterscheiden sich
je nach Fachbereich. Bereitschaftsbewegungen und Gesprächsgesten kosten keine
Modellaufrufe; echte Arbeit und Meetings haben Vorrang.

![Engineering-Abteilung im Raumfokus](docs/screenshots/ironcrew-department.png)

**Team und Leistung.** Level, Fachrolle, Modellprofil und Bewertungen bleiben
getrennt. Die neue Testfirma zeigt ehrlich „Unbewertet“, bis Arbeits- und Review-Runs vorliegen.

![Mitarbeiterübersicht mit Leveln, Modellprofilen und Bewertungsstatus](docs/screenshots/ironcrew-crew.png)

<details>
<summary>Mobile Ansicht und Versionsverwaltung</summary>

Auf kleinen Bildschirmen steht dieselbe Crew als bedienbare Liste bereit.

<img src="docs/screenshots/ironcrew-mobile.png" alt="Mobile Crew-Liste in IronCrew" width="390" />

Die Einstellungen zeigen Version und Updateweg. Die externe Release-Prüfung
ist in dieser isolierten Aufnahme bewusst deaktiviert.

![Version 0.3.0 und Hinweise zum Update auf dem Host](docs/screenshots/ironcrew-updates.png)

</details>

Du kannst **20 originale Figuren** zuweisen oder eigene private Medien hochladen.
Ein kopierbarer Generator-Prompt hilft bei der Erstellung in deinem Bildmodell.
[Figuren und private Assets](docs/CHARACTERS.md) · [Office-Bedienung](docs/LIVING_OFFICE.md)

Aufnahmeverfahren, Herkunft und Reproduktion: [Screenshot-Dokumentation](docs/SCREENSHOTS.md).

## Automatisches Setup im aktuellen Quellcode

Fehlende Voraussetzungen lassen sich jetzt automatisch installieren:

```bash
bash scripts/setup.sh
# Nur prüfen, ohne etwas zu installieren:
bash scripts/setup.sh --check
```

Das Setup prüft Node.js, pnpm, Git, Python und native Build-Werkzeuge. Es verwendet
vorhandene passende Versionen und installiert nur Fehlendes. Diese Ergänzung ist
im aktuellen Quellcode nach Release 0.3.1 enthalten;
[Installation ohne vorab eingerichtetes Node/Git](docs/INSTALLER.md).

## Lokal starten (Release 0.3.1)

Voraussetzungen: **Node.js 26+**, Git und die in `package.json` festgelegte
**pnpm-Version 10.30.1**. Native Abhängigkeiten können Compilerwerkzeuge benötigen.

```bash
git clone --branch v0.3.1 https://github.com/irongeeks/ironcrew.git
cd ironcrew
npm install --global pnpm@10.30.1
pnpm install --frozen-lockfile
cp .env.example .env
```

Trage eigene zufällige Werte für `OAUTH_ENCRYPTION_SECRET` und `API_AUTH_TOKEN`
in `.env` ein. Der [Schnellstart](docs/GETTING_STARTED.md) führt dich durch die
Konfiguration. Nutze für den ersten lokalen Versuch MockRuntime; dafür ist kein
Providerkonto erforderlich.

```bash
pnpm dev:local
# Web: http://127.0.0.1:8800 · API: http://127.0.0.1:8790
```

Node.js 26 liefert Corepack nicht mit. Die Installation oben verwendet deshalb
die festgelegte pnpm-Version direkt.
`pnpm dev` bindet den Entwicklungsserver an alle Interfaces;
`dev:local` bleibt auf dem lokalen Rechner.

**Dauerbetrieb:** [Linux](docs/LINUX_INSTALL.md) · [macOS](docs/MACOS_INSTALL.md) ·
[Docker und Updates](docs/RELEASES.md) · [Native Runner](docs/RUNNER_PROTOCOL.md)

CLI-Logins bleiben beim nativen Runner unter dessen Betriebssystemkonto.
Ein Container erhält dafür keinen Zugriff auf dein gesamtes Home-Verzeichnis.
Echte CLI-Starts mit deinem Konto prüfst du anhand der
[Runtime-Abnahme](docs/CLI_RUNTIME_ACCEPTANCE.md).

## Entwickeln und testen

```bash
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

Die GitHub-Prüfungen decken Frontend, Backend, Skripte, Browser sowie Linux,
macOS und Docker ab. Screenshots werden in einer separaten Testfirma erzeugt.
Aktuelle Ergebnisse: [CI](https://github.com/irongeeks/ironcrew/actions/workflows/ci.yml) ·
[Plattformprüfung](https://github.com/irongeeks/ironcrew/actions/workflows/platform-production.yml).

## Dokumentation und Herkunft

Der [Docs-Index](docs/README.md) bündelt Bedienung, Konfiguration, Betrieb,
Architektur, Sicherheit und Entwicklung. Für Updates lies zusätzlich die
[Release-Hinweise](docs/releases/README.md) und den [Changelog](CHANGELOG.md).

IronCrew baut auf [OctoOffice](https://github.com/Chepko932/OctoOffice) auf.
OneManCompany und Paperclip dienen als konzeptionelle Referenzen für Firmenmodell
und Governance. Honcho bleibt eine optionale externe Memory-Integration.

Lizenz: **Apache-2.0**. Copyright- und Lizenzhinweise bleiben erhalten.
Details: [LICENSE](LICENSE) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) ·
[Upstream-Analyse](docs/UPSTREAM_ANALYSIS.md).
