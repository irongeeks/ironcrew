# Erste Schritte mit IronCrew

Diese Anleitung startet IronCrew lokal unter Linux oder macOS und führt einen ersten Auftrag mit der mitgelieferten MockRuntime aus. Dafür ist kein Providerkonto erforderlich. Die MockRuntime liefert gekennzeichnete Testantworten; sie bearbeitet keine echten Infrastruktur- oder Kundenaufträge.

Für einen dauerhaften Dienst oder Docker nutze anschließend [Releases und Updates](RELEASES.md) und [Sicherer Betrieb](SECURITY_OPERATIONS.md).

## 1. Voraussetzungen und Installation

Benötigt werden ein aktueller Patchstand von Node.js 22 oder neuer, Git und pnpm **10.30.1**, entsprechend `package.json`. Für native Abhängigkeiten können Compilerwerkzeuge nötig sein: unter macOS die Xcode Command Line Tools, unter Linux die Build-Werkzeuge der Distribution.

```bash
git clone --branch v0.1.0 https://github.com/irongeeks/ironcrew.git
cd ironcrew
pnpm install --frozen-lockfile
cp .env.example .env
```

Dieser Einstieg ist für eine neue Installation. Eine vorhandene Installation mit Daten und der alten Versionsnummer `2.8.0` wird nach der [Wechselanleitung](RELEASES.md) aktualisiert.

## 2. Lokale Konfiguration

Erzeuge drei unabhängige Zufallswerte:

```bash
node -e "const {randomBytes}=require('node:crypto'); for (const key of ['OAUTH_ENCRYPTION_SECRET','API_AUTH_TOKEN','INBOX_WEBHOOK_SECRET']) console.log(key+'='+randomBytes(32).toString('hex'))"
```

Übernimm die ausgegebenen Werte in die entsprechenden Einträge der lokalen `.env`. Entferne bei `API_AUTH_TOKEN` das Kommentarzeichen. Verwende die erzeugten Werte selbst; die `.env` führt keine Shell-Ausdrücke wie `$(openssl ...)` aus. Bewahre den Verschlüsselungsschlüssel zusammen mit einer geschützten Konfigurationssicherung auf.

Belasse für den lokalen Einstieg:

```dotenv
HOST=127.0.0.1
PORT=8790
```

Ohne expliziten `DB_PATH` liegt die Datenbank einer neuen Installation unter `ironcrew.sqlite` im Checkout. Private Figuren liegen standardmäßig unter `data/private-assets/characters/`. Die lokale `.env` und diese Daten gehören nicht in einen öffentlichen Commit.

## 3. Oberfläche starten

```bash
pnpm dev:local
```

Öffne **http://127.0.0.1:8800** und schließe den angezeigten Einrichtungsassistenten ab. Das Frontend auf Port 8800 leitet API-Anfragen an Port 8790 weiter. `dev:local` bindet beide Prozesse ausschließlich an Loopback; `pnpm dev` ist für einen im Netzwerk erreichbaren Entwicklungsserver ausgelegt.

Öffne **COMMAND**. Dort liegen die gemeinsame Crew, das Office, das Aufgabenboard und der CEO-Kanal. Prüfe im Mitarbeiterprofil unter **Vessel**, dass für den ersten Versuch die Runtime `mock` zugewiesen ist. Ein vorhandenes echtes Providerprofil kann bereits externe Modellaufrufe auslösen.

## 4. Ersten Auftrag durchlaufen

1. Schreibe im **CEO-Kanal**: „Bitte dokumentiere unser Backup-Verfahren für Proxmox.“
2. Prüfe die Antwort des Executive Assistant, die erzeugte Aufgabe und den zugewiesenen Mitarbeiter. Mit MockRuntime ist das Ergebnis ausdrücklich ein Testresultat.
3. Verfolge die Ausführung im Board und in den Run-Ereignissen. Wenn eine bereite Aufgabe noch nicht gestartet ist, steht **Nächste Aufgabe ausführen** zur Verfügung.
4. Öffne das Ergebnis unter **Zur Abnahme**. Wähle **Abnehmen**, oder beschreibe unter **Was soll überarbeitet werden?** eine Änderung und wähle **Revision**.
5. Beende den Entwicklungsserver mit `Ctrl+C`, starte ihn erneut mit `pnpm dev:local` und prüfe, dass Aufgabe, Nachrichten und Run-Historie erhalten sind.

Projektaufträge können zunächst einen Plan erzeugen. Dieser wird unter **Projektpläne** geprüft und freigegeben, bevor daraus Fachaufgaben entstehen. Siehe [Projektplanung](PROJECT_PLANNING.md).

## 5. Eine echte Runtime anschließen

Öffne die Provider-/Runtime-Statusansicht und prüfe Installation, Anmeldung und Fähigkeiten. Ein gelisteter Adapter bedeutet noch nicht, dass die zugehörige CLI auf deinem System verfügbar und authentifiziert ist.

Für Claude Code, Codex und Antigravity bleiben die offiziellen Logins beim Betriebssystemkonto des nativen Runners. OpenRouter verwendet eine SecretRef und die zentrale Vendor-Policy. Einrichtung: [Provider-Anmeldung](PROVIDER_AUTH.md), [Runner-Protokoll](RUNNER_PROTOCOL.md) und [OpenRouter](OPENROUTER_RUNTIME.md).

Lege unter **Vessels & Talente** den Ausführungsrahmen an, ordne ihn dem Mitarbeiter zu und konfiguriere gegebenenfalls **Modell-Routing**. Für CLI-Arbeit braucht das Projekt einen absoluten, vom Runner erlaubten Workspace. Beginne mit einer kleinen Aufgabe in diesem Workspace und führe die [CLI-Abnahme](CLI_RUNTIME_ACCEPTANCE.md) durch. Die Mock-Tests ersetzen diesen Test mit deinem echten Login nicht.

## Häufige Fragen

| Beobachtung | Nächster Schritt |
| --- | --- |
| Portkonflikt beim Start | `PORT=8790` für die API belassen; Port 8800 gehört zum Entwicklungsfrontend. |
| Aufgabe bleibt wartend | **Warteschlange** und Runtime-Status prüfen: Kapazität, Rate Limit, Anmeldung und Workspace können den Start verhindern. |
| Aufgabe benötigt Freigabe | **Entscheidungen** öffnen und die konkrete Aktion prüfen. Ein Verschieben im Board ersetzt die Freigabe nicht. |
| Keine Sterne vorhanden | Lead-Delegation und unabhängige Reviewer einrichten; nur abgeschlossene echte Review-Workflows erzeugen Bewertungen. |
| Eigenes Bild erscheint nicht | Im Figureneditor Vorschau und Zuordnung speichern; [Uploadgrenzen](CHARACTERS.md) prüfen. |

Weiter: [Bedienungsleitfaden](USER_GUIDE.md) · [Dokumentationsübersicht](README.md)
