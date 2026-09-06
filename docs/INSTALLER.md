# Automatisches Setup unter Linux und macOS

Das Setup prüft die vorhandenen Voraussetzungen und installiert fehlende oder
inkompatible Werkzeuge. Eine passende vorhandene Version wird weiterverwendet.

Diese Erweiterung gehört zum aktuellen Entwicklungsstand nach 0.3.1. Das bereits
veröffentlichte Release-Archiv von 0.3.1 wird nicht nachträglich verändert.
Verwende einen Checkout von `main` oder lade dessen
[Quellarchiv](https://github.com/irongeeks/ironcrew/archive/refs/heads/main.zip)
herunter und entpacke es. Für den Archiv-Weg ist Git noch nicht erforderlich.

Im entpackten Projektordner:

```bash
bash scripts/setup.sh
```

Das Skript installiert die Voraussetzungen, installiert die Projektabhängigkeiten
mit dem Lockfile und öffnet anschließend den vorhandenen Einrichtungsassistenten.
Mit `--start` startet es danach den lokalen Entwicklungsserver. Für den dauerhaften
Betrieb gelten weiterhin die [Service-Anleitung](SERVICE.md) und die
[Release-/Update-Anleitung](RELEASES.md).

## Was geprüft und installiert wird

| Voraussetzung | Verhalten |
| --- | --- |
| Node.js und npm | Vorhandenes Node >=26 mit npm verwenden; andernfalls neuestes Node 26 für x64/arm64 von nodejs.org herunterladen, SHA-256 prüfen und lokal installieren. |
| pnpm | Exakte Version aus `package.json` verwenden; bei fehlender oder abweichender Version im Benutzerverzeichnis installieren. Corepack wird nicht benötigt. |
| Git | Ausführbarkeit prüfen; bei Bedarf über den Systempaketmanager beziehungsweise Apple Command Line Tools installieren. |
| Python | Mindestens 3.8 für native Module prüfen; fehlende Version über den Systempaketmanager beziehungsweise Homebrew installieren. |
| Native Build-Werkzeuge | `make` und C++-Compiler prüfen; Linux-Build-Pakete beziehungsweise Apple Command Line Tools installieren. |
| Download und Entpacken | curl, tar, gzip und eine SHA-256-Prüfung prüfen; fehlende Linux-Pakete installieren. |

Linux unterstützt apt-get, dnf, yum, pacman und zypper auf x64/arm64-Systemen,
auf denen die offiziellen Node-26-Binärdateien laufen. Der Paketmanager wird nur
aufgerufen, wenn Systemwerkzeuge fehlen. Dafür kann `sudo` ein Passwort anfordern.
Ein reiner Node-/pnpm-Wechsel benötigt keine systemweite Installation.

Unter macOS muss gegebenenfalls der Apple-Installationsdialog für Command Line
Tools bestätigt werden. Das Skript wartet auf den Abschluss und setzt das Setup
fort. Fehlt danach Python, wird Homebrew verwendet und bei Bedarf über dessen
offiziellen Installer eingerichtet. Betriebssysteme, die Node 26 nicht ausführen
können, werden durch die Installation von Node nicht auf eine neue OS-Version
aktualisiert. Für Windows ist dieser automatische Weg innerhalb von WSL2 vorgesehen.

## Prüfen, wiederholen und automatisieren

```bash
# Nur prüfen; Exit-Code 0 = vollständig, 1 = etwas fehlt oder ist inkompatibel.
bash scripts/setup.sh --check

# Nur Voraussetzungen installieren; Konfiguration und Projektpakete auslassen.
bash scripts/setup.sh --requirements-only

# Projekt einrichten, Standardwerte verwenden und lokal starten.
bash scripts/setup.sh --yes --start

# Kein Eintrag in das Shell-Profil, zum Beispiel in CI.
bash scripts/setup.sh --requirements-only --no-profile
```

`--check` und `--help` installieren nichts. Der Prüfmodus schaltet automatische
Paketmanager-Downloads ab und öffnet keinen macOS-Installationsdialog.
Wiederholte Aufrufe verwenden die bereits eingerichtete Toolchain; der pnpm-
Lockfile-Abgleich bei einem vollständigen Setup bleibt beabsichtigt.
`--requirements-only` eignet sich auch zur Vorbereitung eines nativen Updates,
ohne den Einrichtungsassistenten erneut auf eine bestehende Firma anzuwenden.

## Installationsort und Shell

Zusätzlich installierte Node-/pnpm-Werkzeuge liegen standardmäßig unter
`~/.local/share/ironcrew/toolchain`. Ein anderer absoluter Pfad kann über
`IRONCREW_TOOLCHAIN_DIR` gesetzt werden. Systemweit vorhandene Node- oder pnpm-
Installationen werden dadurch nicht überschrieben.

Das Setup schreibt eine `env.sh` in dieses Verzeichnis und trägt sie einmalig in
`.bashrc` beziehungsweise `.zshrc` ein. Für eine bereits offene andere Shell oder
bei `--no-profile`:

```bash
source ~/.local/share/ironcrew/toolchain/env.sh
```

Bei einem eigenen Installationspfad verwende die vom Setup ausgegebene `env.sh`.
Für Systemdienste muss der tatsächlich verwendete absolute Node-Pfad eingetragen
werden; ein Dienst liest keine interaktive Shell-Konfiguration.

Das Setup zeigt die benötigten Installationen an und prüft sie anschließend
nochmals. Ein fehlgeschlagener Paketmanager, Download oder SHA-Abgleich stoppt
den Vorgang vor Projektinstallation und Konfiguration. Bereits erfolgreich
installierte Voraussetzungen bleiben für den nächsten Aufruf verfügbar.

Quellen: [Node.js-Downloads](https://nodejs.org/en/download),
[Apple Command Line Tools](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools),
[Homebrew-Installation](https://docs.brew.sh/Installation).
