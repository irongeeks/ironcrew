# IronCrew — neuer Produktkern

Eigenständiger Neubau nach dem Entwicklungspaket vom 7. September 2026. Der alte Root bleibt Referenz; dieser Workspace verwendet eine eigene SQLite-Datenbank und eigene Modell-/Werkzeugausführung. **Entwicklungsstand, noch kein freigegebener Release.** Den detaillierten Abnahmezustand führen `../docs/progress.md` und `docs/release-readiness.md`.

## Lokal starten

Voraussetzung: Node **26.4.0**, pnpm **10.30.1**. Alle direkten Abhängigkeiten sind exakt festgelegt, transitive Versionen im Lockfile. Falls pnpm nicht installiert ist, kann jeder pnpm-Befehl als `npx --yes pnpm@10.30.1 …` ausgeführt werden; eine globale Installation ist nicht nötig.

```sh
cd next
npx --yes pnpm@10.30.1 install --frozen-lockfile
npx --yes pnpm@10.30.1 build
npx --yes pnpm@10.30.1 start
```

Die Zentrale läuft unter `http://127.0.0.1:8790`. Beim ersten Start wird ein einmaliges Setup-Token ausgegeben (15 Minuten gültig). Dort Firma/CEO und ein Passwort mit mindestens zwölf Zeichen einrichten. Das Onboarding funktioniert ohne Modellkonto. Daten liegen standardmäßig in `next/.var/`; `IRONCREW_DATA_DIR` kann ein eigenes Datenverzeichnis festlegen. Es gibt keinen Altdatenimport.

Für Entwicklung: `pnpm dev` startet dieselbe eigene Zentrale direkt aus TypeScript. `pnpm dev:web` startet den Vite-Frontendserver. Für einen ausgelieferten Dienst werden gebaute JavaScript-Dateien genutzt, kein Watcher.

Konfigurierbare Betriebswerte: `IRONCREW_DATA_DIR`, `IRONCREW_HOST`, `IRONCREW_PORT`, `IRONCREW_PUBLIC_URL`, `IRONCREW_TLS_CERT`, `IRONCREW_TLS_KEY`, `IRONCREW_PREVIEW_PORT`, `IRONCREW_UPDATER_CONFIG`. Externer Zugriff benötigt tatsächliches TLS und eine HTTPS-URL. Standard bleibt Loopback. Generierte Websitevorschauen laufen getrennt auf Port 8792 mit restriktiver CSP; untrusted Inhalte erhalten keinen CEO-API-Zugang.

## Eigene Laufzeit

Modellkonfiguration in Einstellungen → Modelle: absoluter Pfad zu geprüftem **pass-cli 2.3.3**, optional eigener Sessionpfad, Proton-SecretRef mit Tresor-/Eintrags-/Feld-ID und gemeinsames Budget. Zugangsdaten werden im Proton-Broker aufgelöst, nicht als normale Konfigurationswerte gespeichert. Liveausführung ist standardmäßig ausgeschaltet und muss ausdrücklich aktiviert werden. Vollständiger OpenRouter-Katalog wird ohne Provider-Whitelist geladen und regelmäßig im 15-Minuten-Intervall erneut geprüft. Fehlgeschlagene Aktualisierung bleibt als veralteter Stand sichtbar.

Ein Auftrag erhält einen Lead, einen versionierten Plan und ein Mandat für konkrete Werkzeuge/Ziele. Firmen-, Auftrags- und kumulatives Mandatslimit werden atomar reserviert. Budgetperioden sperren Kosten vor Beginn und nach Ablauf; nur die ausdrücklich gesetzte Option `renewal: "fixed_duration"` erneuert die bestätigte Zeitspanne. Offene Reservierungen werden dabei weiter berücksichtigt. Die eigene OpenRouter-Schleife speichert Modellrequest, Kostenreservierung, vollständige Antwort, Werkzeugabsicht und Resultat. Freigaben binden Argumente, Ziel, Mandatsversion und gegebenenfalls Artefaktversion. Unbekannte Kosten oder Wirkungen stoppen weitere Arbeit und bleiben nach Neustart sichtbar.

`workspace.list`, `workspace.read`, hashgeprüfte `workspace.apply_patch`, registrierte `workspace.test_fixture` und immutable `artifact.stage` funktionieren lokal. `workspace.execute` bleibt ohne nachgewiesene OS-Isolation gesperrt. Der erste Testablauf verwendet echte, vom Testadministrator vorgegebene Prüfmodule; diese Ausnahme ist kein Nachweis einer Sandbox für beliebigen Modellcode. Die Architektur enthält keine Claude-/Codex-/OpenClaw-CLI als Agentenmotor.

Entfernte Worker verbinden ausgehend über WSS. TLS-Zentrale erforderlich; Enrollment erstellt eine kurzlebige einmalige Geräteaufnahme. CLI: `node dist/apps/worker/main.js /absoluter/pfad/worker.json`. Weitere Felder im Workerquellvertrag und Betriebshandbuch. Die Zentrale kann unter Einstellungen → Modelle einen aufgenommenen `remoteWorkerId` auswählen. Eingaben, Ausgaben und begrenzte Logs werden über eigene authentifizierte HTTPS-Streams übertragen; WSS steuert den Auftrag. Ergebnisse werden erst nach Hashprüfung und dauerhafter Speicherung quittiert. Alte Generationen oder unbekannte Wirkungen werden nicht blind neu ausgeführt.

## Prüfungen

```sh
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
pnpm openapi:check
```

`test:e2e` benötigt vorher `build` und Chromium (`pnpm exec playwright install chromium`). Es verwendet eine temporäre Testfirma und lässt produktive Daten unangetastet. UI-Vertragsfixtures und die Browserabläufe gegen echte lokale Server/SQLite sind getrennt bezeichnet. Die [Anforderungszuordnung](docs/workflow-acceptance.md) ordnet Oberfläche und Fachabläufe den einzelnen Belegen zu. `test:recovery` benötigt für die Verschlüsselungstests echte geprüfte age-1.3.2-Binaries; `IRONCREW_TEST_AGE` und `IRONCREW_TEST_AGE_KEYGEN` setzen. Ohne diese Werkzeuge werden die betreffenden Tests ausdrücklich übersprungen und das Backup-Gate gilt auf diesem System als offen.

Für die vollständigen Update-/Distributionstests ist zusätzlich eine eigenständige Node-26.4.0-Runtime erforderlich (`IRONCREW_TEST_NODE`). Eine Homebrew-Node-Datei allein ist wegen ihrer externen Bibliotheken kein portables Paket. Mit allen drei expliziten Werkzeugpfaden prüft `python3 scripts/verify-local.py --require-tools` die Voraussetzungen vorab. Die [CI-Anleitung](docs/ci-gates.md) beschreibt den hashgeprüften Werkzeugdownload und die strikten Matrixgates.

Live-Modelltests sind getrennt und kostenbegrenzt:

```sh
pnpm test:live -- --profile /absoluter/pfad/testprofil.json
```

Ein gültiges Profil enthält `name`, `authorized: true`, `maxCostUsdMicros`, `proton: { executable, sessionDirectory? }`, `openrouter: { modelId, secretRef: { provider: "proton-pass", shareId, itemId, field } }`. Keine Rohsecrets. Der Befehl prüft Katalog und konservative Reservierung, sendet genau einen kleinen Modellrequest und protokolliert Generation-ID/Kosten lokal in `.var/live-evidence/`. Ohne gültiges Profil kein Liveaufruf. Für Konten anderer Provider sind eigene konkrete Wirkungstests erforderlich.

## Betrieb und Übergabe

Die [Kanalanleitung](docs/channels.md) beschreibt signierte Eingänge und Identitätsbindung; [Integrationsdetails](docs/integration-reuse.md) beschreiben die unterstützten Adapter.

Die [Betriebsanleitung](packages/operations/README.md) erklärt Servicebundles, verschlüsselte Offline-Sicherung, Stagingrestore, Signaturprüfung und Rückweg. Ein Servicebundle ist ein ausführbares Installationsartefakt, aber noch kein auf allen Zielsystemen getestetes Release. Nach Restore bleiben Modell-/Tooldispatch und Routinen pausiert, Sitzungen werden entwertet und mögliche externe Wirkungen müssen geprüft werden.

Das Produkt behält alle vier Zielabläufe: Websites, IT-Störungen, sevdesk-Finanzen und Recherche. Die implementierten lokalen Funktionsketten, ihre Nachweisgrenzen und die getrennten produktiven Abnahmen stehen in [Anforderungszuordnung](docs/workflow-acceptance.md) und [Releasebereitschaft](docs/release-readiness.md). Fehlende Kundenkonten, der manuelle Screenreader-Hörtest und noch nicht geprüfte Plattformen bleiben gesondert ausgewiesen.

## Erweiterte lokale Abläufe

React-/WordPress-Builds benötigen entweder ein bei jedem Start tatsächlich attestiertes lokales Linux-Profil (`isolationProfilePath`) oder einen entsprechend attestierten entfernten Linux-Worker (`remoteWorkerId`). Beide Optionen sind gegenseitig ausgeschlossen. Der lokale Linuxkern prüft Namespaces, seccomp, Hostzugriffe und Ressourcenlimits vor freier Ausführung. Eine Mac-Zentrale kann einen Linux-Worker ohne Hostmounts über das Netzwerk nutzen; alternativ läuft die gesamte Zentrale in einer eigenen Linux-VM. Eine direkte macOS-Shell wird dadurch nicht freigegeben.

Websitepakete enthalten Quellen, feste Laufzeitversionen, Build-/Startanleitung und ein geprüftes Dateimanifest. Der Download erfolgt an der Artefaktversion als `.tar.gz`. React wurde aus dem tatsächlichen Linux-Build auf Desktop/Mobil und in der getrennten Vorschau geprüft. Das WordPress-Blocktheme wurde zusätzlich in WordPress 7.0.4/PHP/MariaDB installiert. Hostingprofile und ihr eigener typisierter Brokervertrag sind in [Hosting](docs/hosting-broker.md) beschrieben; jede Veröffentlichung bleibt an Ziel, Profil, Artefaktversion und Freigabe gebunden.

Workerzugänge, Kanalzuordnungen, Quellenbeobachtungen, Originalbelege einschließlich PDF-Seiten, Benachrichtigungsverlauf und Wartungsrichtlinien sind in der Oberfläche erreichbar. Backuppläne starten deaktiviert und benötigen eine echte Restoreprobe vor Aktivierung. Der [separate Updaterdienst](docs/production-updater.md) übernimmt konkret freigegebene signierte Updates mit Offline-Backup, Dienstwechsel und Healthrollback. Mit `autoApplyApproved` werden bereits freigegebene Pläne innerhalb ihres Wartungsfensters automatisch eingereiht. Die ausdrückliche Freigabe bleibt 24 Stunden gültig; es wird keine Zustimmung automatisch erteilt oder verlängert. Ohne eingerichteten Updater bleibt Apply gesperrt.

Die optionale `mailConnections`-Konfiguration verbindet eigene IMAP-/SMTP-Ziele über TLS und Proton-Referenzen. Der [IMAP-Eingang](docs/mail-inbox-oauth.md) speichert MIME-Originale und Anhänge mit Deduplizierung; die automatische Aufnahme wird pro Mailbox durch eine eigene begrenzte CEO-Policy aktiviert. Allein das Eintragen eines Postfachs aktiviert sie nicht. `mail.send` benötigt eine konkrete Freigabe; SMTP-Annahme wird als Annahme, nicht als zugestellte Nachricht gespeichert. Der signierte Mailbridge-Eingang bleibt als separater Weg bestehen.

[OAuth-Profile](docs/oauth-profile-ui.md) für Google Drive, Graph und Mail lassen sich unter Integrationen über Proton-Pass-Verweise konfigurieren. Die Oberfläche zeigt die Recoverygeneration und verlangt ausdrückliche Bestätigung; Tokenrotation bleibt im verschlüsselten Broker. Native Google-Dateien verwenden eigene typisierte [Workspace-Werkzeuge](docs/google-workspace.md), keine stillschweigende Binärkonvertierung.

Die [Einrichtung](docs/onboarding-validation.md) speichert Crewprofile, Bereiche und Modellkonfiguration tatsächlich; fehlende Zugänge oder Worker werden ausdrücklich zurückgestellt. Kunden und Projekte lassen sich verwalten und beim neuen Auftrag auswählen. [Finanzregeln und Korrekturen](docs/finance-automation-ui.md) wirken auf die tatsächliche Belegklassifikation, benötigen für Wiederverwendung eine echte Finanzlead-Prüfung und eine gesonderte CEO-Aktivierung. [Suchkosten](docs/search-api-costs.md) und [ungeklärte Modellkosten](docs/model-cost-reconciliation.md) bleiben im Budget sichtbar und lassen sich nur mit nachvollziehbarem Beleg klären.

Website-Rückmeldungen aus Chat und Vorschau teilen eine versionsgebundene Änderungsliste. Gesammelte Kommentare werden ausdrücklich zur Umsetzung übergeben; alte Artefakte bleiben unverändert. Prüfung und Abnahme sind von Veröffentlichung getrennt und können nicht versehentlich auf eine andere angezeigte Version wirken; siehe [Website-Prüfung](docs/website-review-validation.md). Die technische Betreuung besitzt einen eigenen Auftrag und begrenzte Richtlinien; deren aktueller Abschlussstatus steht in [Releasebereitschaft](docs/release-readiness.md).

Die [HTTP-Dokumentation](docs/http-api.md) und [OpenAPI-Datei](docs/openapi.json) beschreiben die registrierten HTTP-Operationen; ihre Vollständigkeit wird automatisch gegen die montierten Routen geprüft. `python3 scripts/verify-local.py` führt die gesamte Suite mit Audit aus, lehnt übersprungene Testfälle ab und bindet den geprüften Quellstand per SHA-256.
