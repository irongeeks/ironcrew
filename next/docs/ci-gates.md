# Reproduzierbare CI-Prüfungen

Seit 0.4.2 laufen die Vitest-Suiten unter Windows mit höchstens zwei parallelen
Workern; Linux und macOS bleiben bei vier. Zwei Windows-Läufe mit vier Workern
überschritten Zeitlimits in wechselnden SQLite-, Hash-, Datei- und TLS-Fixtures.
Die geringere Parallelität begrenzt gleichzeitig laufende aufwendige Fixtures.
Testumfang, Assertions, Zeitlimits und das Verbot ausgelassener Tests bleiben
unverändert. Maßgeblich ist weiterhin der erfolgreiche vollständige Matrixlauf.

`.github/workflows/rebuild.yml` bereitet Ubuntu 24.04, macOS 15 und Windows 2025 vor. `actions/setup-node` stellt Node 26.4.0 bereit; Python 3.13 und pnpm 10.30.1 sind fest angegeben. `scripts/ci-tools.py` lädt age **1.3.2** ausschließlich aus dem [offiziellen Release](https://github.com/FiloSottile/age/releases/tag/v1.3.2). Die SHA-256-Werte der sechs unterstützten OS-/Architekturarchive sind im Skript fest gespeichert und stammen aus den offiziellen Release-Asset-Metadaten. CI lädt keine veränderliche Prüfsummenliste nach.

Vor dem Entpacken wird das gesamte begrenzte Archiv geprüft. Danach werden ausschließlich `age` und `age-keygen` aus den erwarteten regulären Dateien extrahiert und ihre Versionen tatsächlich ausgeführt. Die absoluten Pfade werden als `IRONCREW_TEST_AGE`, `IRONCREW_TEST_AGE_KEYGEN` und `IRONCREW_TEST_NODE` in `GITHUB_ENV` geschrieben. Downloads und Testprogramme bleiben im eigenen Runner-Verzeichnis. Das Skript verändert keine globale Installation.

Der Workflow führt anschließend `python scripts/verify-local.py --require-tools` vollständig aus. Die Vorprüfung verlangt alle drei Programme in den exakten Versionen. Testgates ohne bestandene Tests oder mit ausgelassenen Tests schlagen fehl. Installations-, Format-, Lint-, Typ-, Vertrags-, Integrations-, Browser-, Recovery-, Installations- und Buildprüfungen sowie OpenAPI, Abhängigkeitsaudit und Quellintegrität bleiben Bestandteil des gemeinsamen Runners. Windows startet den `npx.cmd`-Shim ausdrücklich über `cmd.exe`; Protokolle werden plattformübergreifend als UTF-8 gespeichert.

Prüfprotokolle, Zähler, Audit, Quellmanifest und Werkzeughashes werden auch bei Fehlern als Matrixartefakt hochgeladen. Ein fehlendes age-Programm darf somit keinen grünen Lauf mit ausgelassenen Backup-/Updatetests erzeugen. Ein Betriebssystemfehler wird als solcher sichtbar und nicht durch eine weitere Skip-Ausnahme versteckt.

Lokal geprüft wurden fünf Python-Regressionsfälle, die YAML-Struktur, die SHA-256-Werte und erwarteten Programmdateien aller sechs echten Releasearchive sowie die native macOS-Versionsprüfung. Die Belege stehen in [ci-bootstrap.json](test-evidence/ci-bootstrap.json). Windows- und Linuxarchive wurden dabei nicht auf macOS ausgeführt. Ein GitHub-Actions-Lauf wurde nicht gestartet; tatsächliche Matrixergebnisse stehen noch aus.
