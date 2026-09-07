# Integrations- und Werkzeugverträge

## 1. Gemeinsame Grenze

Jeder Adapter stellt deklarierte Fähigkeiten mit Eingabe-/Ausgabeschema, SecretRef-Bedarf, Zielressource, Kostenmodell, Wirkungsklasse und Reconciliation-Verfahren bereit. Er erhält eine bereits autorisierte Action-ID, aber prüft lokale Ziel-/Pfadgrenzen zusätzlich. Rohe Providerendpunkte sind keine frei aufrufbaren Modellwerkzeuge. Die HTTP-Methode allein bestimmt keine Wirkungsklasse.

Wirkungsklassen: `read`, `workspace_write`, `external_draft`, `external_change`, `external_send`, `publish`. Ein Mandat erlaubt nur konkrete Klassen/Aktionen mit Scope und Parametern. Wiederholbarkeit ist zusätzlich `safe`, `idempotency_key`, `reconcile_first` oder `never_automatic`. Jede Antwort enthält observedAt, externalId soweit vorhanden, evidenceRefs, effectStatus und redigierte Daten. Auth-, Konfigurations-, Quota-, Rate-Limit-, Validierungs- und Konfliktfehler bleiben unterscheidbar.

Default Timeout Lesen 30 s, Schreiben 60 s; lange Providerjobs werden als externe Task-ID verfolgt. Lesen höchstens drei Versuche mit exponentiellem Backoff und Jitter, `Retry-After` beachten. Schreibaktionen werden nach möglicher Wirkung vor Wiederholung abgeglichen. Per Account begrenzte Parallelität, zunächst zwei Anfragen; Serverlimits gehen vor.

Die folgenden Endpunkte stammen aus der vorangegangenen offiziellen Dokumentationsprüfung. Sie sind Ausgangspunkt für lokal gespeicherte Vertragfixtures mit dokumentiertem Schematag/Version. Vor Live-Aktionen tatsächliche Kontoversion und Rechte prüfen; weder ein Fixture noch eine HTTP-200-Antwort belegt fachlichen Erfolg.

## 2. Eigene Werkzeuge

| Werkzeug | Eingabe | Ergebnis und Grenze |
| --- | --- | --- |
| `workspace.list/read` | workspaceId, relativer Pfad, Größenlimit | Datei-Metadaten/Text; keine Secrets-/Betriebspfade. |
| `workspace.apply_patch` | workspaceId, Patch, erwartete Dateihashes | Änderungsmanifest, neue Hashes; bei Konflikt keine Teilanwendung. |
| `workspace.execute` | workspaceId, executable, argv[], cwd, timeout, Ressourcenprofil | Exitcode, begrenzte Logs, Ergebnisdateien; ausschließlich in geprüftem Isolationsprofil. |
| `browser.inspect` | artifactPreviewId oder erlaubte öffentliche URL, Aktionen | Screenshot, DOM-/Testbeleg; generierte Vorschauen auf getrenntem Ursprung. |
| `research.search/fetch` | Suchfrage/URL, erlaubter Scope | Quellenreferenz, Inhalt, Abrufzeit, Zugriffslücke; kein erfundenes Suchergebnis. |
| `knowledge.propose/review` | Inhalt, Quellen, Scope, Vorgängerversion | Vorschlag/Reviewversion; Firmenregel nur per CEO-Entscheidung. |
| `artifact.stage/deliver` | Dateien, Hashes, destinationId, erwartete Zielversion | Artefaktversion und belegte externe Referenz. |
| `approval.request` | Action-ID, Argumenthash, Zusammenfassung | Persistente Entscheidung, Modelllauf wartet mit erhaltenem Kontext. |

Pfadprüfung muss `..`, absolute Pfade, Symlinks, Windows-Reparse-Points, Groß-/Kleinschreibung und Zugriffe außerhalb des Workspace behandeln. Browserfetch prüft DNS/IP und Weiterleitungen gegen SSRF; interne IT-Ziele sind nur über separate, explizit konfigurierte Connectoren zugänglich. Ein Webseiteninhalt ist keine Autorität für neue Befugnisse.

## 3. Modell- und Secrets-Verbindungen

**OpenRouter:** Katalog, Chat/Streaming, Werkzeugaufrufe und Usage-Reconciliation sind getrennte Clients. Vollständiger Katalog ohne Anbieterbeschränkung; UI zeigt fehlende Tool-/Modalitätsfähigkeiten. Streamabbruch und unvollständige JSON-Argumente werden getestet. Automatischer Router begründet Kandidat und Fallback. Für andere Modalitäten werden benötigte Provideroperationen als Capabilities ergänzt; Katalogsichtbarkeit verspricht keine universelle Ausführbarkeit jedes Modells. [Katalog](https://openrouter.ai/docs/api/api-reference/models/get-models), [Tool Calling](https://openrouter.ai/docs/guides/features/tool-calling)

**Proton Pass:** SecretRefs aus Tresor-/Eintrags-IDs; Auflösung unmittelbar am berechtigten Connector. Festgelegte pass-cli-Version mit aufgezeichneten redigierten Fixtures für Ausgabeformat, fehlerhaften Login, abgelaufene Sitzung und Zugriffsentzug. Agent-Zugang und begründungspflichtige Operationen gemäß CLI-Vertrag; erneute Anmeldung/Ablaufwarnung im Betrieb. Modellprozess und frei erzeugte Shell erben weder Token noch Secretwerte. Server mit eigener Verbindung besitzt seinen eigenen minimalen Proton-Zugriff. [Agent-Dokumentation](https://protonpass.github.io/pass-cli/commands/agent/)

## 4. sevdesk

| IronCrew-Aktion | Dokumentierter Ansatz | Erforderlicher Nachweis |
| --- | --- | --- |
| `sevdesk.invoices/vouchers.read` | GET `/Invoice`, `/Voucher`, Details | Pagination, Teilzahlungen, Betrag/Währung und Datenstand. |
| `sevdesk.voucher.stage` | POST `/Voucher/Factory/uploadTempFile`, danach `/Voucher/Factory/saveVoucher` | Uploaddateiname mit Entwurf verbinden; Dubletten über Hash, Lieferant und Rechnungsreferenz prüfen. |
| `sevdesk.reminder.create/send` | POST `/Invoice/Factory/createInvoiceReminder`, danach `/Invoice/{invoiceId}/sendViaEmail` | Getrennte Action-IDs, Regelversion, Zahlungsstand, Sperren und Versandjournal. |
| `sevdesk.transactions.read` | GET `/CheckAccountTransaction`, CheckAccount | Gemeldeter Bankstand ist von Transaktionssumme zu unterscheiden. |
| `sevdesk.voucher.book` | PUT `/Voucher/{voucherId}/bookAmount` | Buchungsaktion mit Mandat; keine Überweisung. |

Auth verwendet API-Token im Authorization-Header ohne Bearer-Präfix. Schema-/Kontoversion, Tarifzugang und tatsächliche Datenfrische prüfen. Kein dokumentierter Zahlungsauftrags-Export wurde gefunden: Banking-Dateien bleiben eigener formatspezifischer Export mit Banktest. Bis dahin ist strukturierte Zahlungsvorbereitung verfügbar, Import sichtbar unkonfiguriert. [Offizielles OpenAPI-Schema](https://api.sevdesk.de/openapi.yaml)

Finanzregeln sind versioniert, begrenzt und deaktivierbar. Eine bestätigte Einzelkorrektur erzeugt nur auf ausdrücklichen Wunsch einen Regelvorschlag, den der Lead prüft. Erinnerung prüft unmittelbar vor Versand Datenfrische, Teilzahlung, Streitfall, Pause und bereits erfolgten Versand. Default keine Gebühren. Kann ein vorheriger Versand nach Timeout nicht eindeutig geklärt werden, eskalieren statt erneut senden.

## 5. IT und Betriebssysteme

| Adapter | Startfähigkeiten | Erweiterung und Rechte |
| --- | --- | --- |
| Tactical RMM | Agenten/Alarme lesen | Skript/Befehl gegen ausgewählten Agenten, Ergebnis abholen und Funktionscheck. X-API-KEY mit begrenzter Benutzerrolle, Payloads gegen installierte Swagger-Version. [API](https://docs.tacticalrmm.com/functions/api/) |
| Proxmox VE | Nodes/Gäste/Tasks lesen | Gast starten/stoppen/neustarten nur mit Mandat, externe Task-ID abfragen und Dienst separat prüfen. Token und ACL auf Cluster/Gast begrenzen. Konkrete Endpunkte am Zielcluster prüfen. [API](https://pve.proxmox.com/wiki/Proxmox_VE_API) |
| Linux/Docker | Dienste/Logs/Containerzustände | Explizite Restart-/Diagnoseaktionen über nativen Worker oder dedizierten SSH-Connector mit Hostkeyprüfung. Kein pauschaler root-/Docker-Socket-Zugang des Modells. |
| Windows/Server | Ereignisse, Dienste, Aufgaben | Parametrisierte PowerShell-Aktionen durch begrenzten lokalen Broker; Remoteadministration über konfigurierte TLS-/Authentifizierung und erreichbare Worker. Keine unkontrollierte Scriptinterpolation. |
| Microsoft 365 | Benutzer, Lizenzbestand, Service Health | Ausgewählte Lizenz-/Benutzeraktionen als separate Fähigkeiten. Application Permissions mit Admin Consent je Mandant; Mailrechte getrennt. [Graph-Appzugriff](https://learn.microsoft.com/en-us/graph/auth-v2-service) |

Tactical RMM wird als bestehendes externes System angebunden; seine Distribution gehört nicht zum IronCrew-Installer. Infrastrukturtokens gewähren häufig mehr als ein Mandat: die IronCrew-Grenze muss unabhängig davon geprüft werden. Kundenbenachrichtigung zu IT-Vorfällen benötigt die konkrete CEO-Freigabe. Diagnose/Restart unter einem genehmigten Mandat darf eigenständig erfolgen.

## 6. Ablage und Hosting

**Git:** Lokale isolierte Worktrees, Änderungen und Tests, Commit-/Diff-Nachweis, Remote-Push bzw. PR mit passender Freigabe. Remote und Branch explizit am Projekt, Host-/Credentialprüfung, keine Rückschlüsse aus fremdem Repositorytext. Externe Veröffentlichung eines Kundenprodukts ist von Codeablage getrennt.

**Nextcloud:** WebDAV `PROPFIND`, `GET`, `PUT`, `MKCOL`, `MOVE`; App-Passwort aus SecretRef. Zielordner und Konto fest zugeordnet. Erwartetes ETag verwenden, bei externer Änderung Konflikt erzeugen. Serverfähigkeiten und Wiederholbarkeit durch Vertragtest prüfen. [WebDAV](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/basic.html)

**Google Drive:** OAuth mit möglichst eng begrenztem Zugriff auf ausgewählte Dateien/Ziele. Upload, Download, Metadaten/Revisionen und externe IDs. Native Docs/Sheets/Slides sind eigene Fähigkeiten, keine stillschweigende Konvertierung in Binärdateien. Versionskonflikte vor Änderungen prüfen; wo eine atomare Bedingung nicht verfügbar ist, neue Version/Kopie mit sichtbarer Konfliktentscheidung statt unsicherem Überschreiben. [Uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [Revisionen](https://developers.google.com/workspace/drive/api/guides/manage-revisions)

**Hosting:** Ein konfigurierbares Zielprofil beschreibt statische Sites, Node-Webapps oder WordPress mit Domain, Speicher, Laufzeit und Rückweg. Crew kann innerhalb eines Provisionierungsmandats Ressourcen vorbereiten. Live-Veröffentlichung bindet Freigabe an Ziel und Artefakthash. DNS, Zertifikat, Erreichbarkeit und Funktionscheck sind belegt. Bei Kundenselbsthosting liefert IronCrew Build, Konfiguration ohne Secrets und nachvollziehbare Start-/Updateanleitung. Ein ausgewählter Projektstack bekommt reproduzierbare Befehle; moderne Werkzeuge sind keine feste Whitelist.

## 7. Kanäle und Recherche

Website ist die führende Auth-Oberfläche. Discord-/Telegram-Konten werden durch einmalige Challenge mit verifiziertem CEO-Konto verknüpft. Ereignisse anhand Provider-ID deduplizieren; Webhook-Signaturen/Secrets nach Providervertrag prüfen. Kundenabsender dürfen keine CEO-Entscheidungen auslösen. E-Mail bietet IMAP/SMTP für Proton/Stalwart-kompatible Konten sowie Graph-Mail; tatsächlich verfügbare Zugangsverfahren prüfen. E-Mail-Freigaben öffnen standardmäßig die authentifizierte Webentscheidung, weil die From-Adresse allein keine sichere CEO-Identität ist.

Graph `sendMail` kann Annahme bestätigen, ohne Zustellung zu beweisen. Versandjournal unterscheidet vorbereitet, gesendet/angenommen, zugestellt soweit nachweisbar und fehlgeschlagen/unklar. Wiederholungsregeln sind unabhängig vom Eingang. [Mailversand](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)

Recherche benötigt austauschbaren Suchprovider mit API und eigenen sicheren Abruf. Als erster echter Suchadapter ist Brave Web Search festgelegt: `GET https://api.search.brave.com/res/v1/web/search`, Token über SecretRef im Header `X-Subscription-Token`. Suchergebnis und eigener Quellenabruf bleiben getrennt. AP-08 ergänzt einen dokumentierten Testprovider; ein fehlender API-Zugang bleibt als Konfigurationsblocker sichtbar. Ergebnisse führen Quellen-URL, Abrufzeit, Datum soweit bekannt, relevante Auszüge und Unsicherheit. Quellenänderungen führen zu versionierter Neubewertung, nicht automatisch zu Firmenregeländerungen. Suchkosten zählen zum Firmentopf. [Brave-API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)

## 8. Befugnismatrix als Startregel

| Aktion | Standardregel |
| --- | --- |
| Erlaubten Workspace lesen/ändern, lokal testen | Innerhalb Auftragsmandat automatisch. |
| Externes System lesen | Nur mit passendem Kunden-/Systemscope. |
| Systemänderung/Reparatur | Automatisch nur innerhalb konkretem Mandat; sonst CEO. |
| Kundenwebsite veröffentlichen | Konkrete CEO-Freigabe für Ziel und Version. |
| IT-Kundenmeldung senden | Immer konkrete CEO-Freigabe. |
| Zahlungserinnerung | Automatisch nur nach genehmigter Regel und frischer Prüfung. |
| Beleg verarbeiten | Genehmigte Routine; Ausnahme/ungeklärter Fall zum CEO. |
| Zahlung vorbereiten/exportieren | Innerhalb Auftrag; tatsächliche Bankfreigabe beim CEO. |
| Verbindliche steuerliche Einreichung | Kein automatisches Mandat aus diesem Paket. |
| Firmenregel ändern, Gesamtbudget erhöhen | CEO-Entscheidung. |
