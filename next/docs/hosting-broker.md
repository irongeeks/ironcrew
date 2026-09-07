# Hostingprofile und kontrollierte Veröffentlichung (AP09)

`HostingService` verbindet gespeicherte CEO-Profile, `ManagedActions`, `WebsiteWorkflow.packageArchive` und einen typisierten HTTPS-Broker. Die implementierte Schnittstelle `ironcrew-hosting-v1` ist ein eigenes, versioniertes Brokerprotokoll. Sie ist keine Behauptung einer nativen Hetzner-, Cloudflare-, Proxmox- oder WordPress-Hosting-API. Ein produktiver Broker mit dem unten beschriebenen Vertrag und die administrativ eingerichteten Zugänge müssen bereitgestellt werden. Die Tests veröffentlichen ausschließlich auf einem temporären lokalen TLS-Server.

## Administratives Zielprofil

`POST /api/v1/hosting/profiles` erstellt ein dauerhaftes Profil; `PUT /api/v1/hosting/profiles/:id` verlangt die Revision als `If-Match`. Lesen: `GET /api/v1/hosting/profiles`. Sämtliche Konfigurationsschreibzugriffe verlangen CEO-Sitzung, CSRF und Idempotenzschlüssel.

Pflichtfelder: `name`, `scope`, `provider: "ironcrew-hosting-v1"`, HTTPS-`endpoint`, HTTPS-`publicUrl` mit Rootpfad, `expectedDnsAddresses`, `stack: static|react|wordpress`, `plan`, `monthlyCostLimitUsdMicros` und mindestens eine `healthContains`-Prüfung. `timeoutMs` gilt pro HTTPS-Anfrage, Standard 30 Sekunden. Optional: Proton-Pass-`secretRef` und `trustedCaPem` für eine administrativ vertraute private CA. Ohne Secretreferenz ist der Brokerzugriff ausdrücklich ohne Authorization-Header; diese Option ist nur für passend netzseitig abgesicherte Broker geeignet. Schlüssel oder Token werden weder im Profil noch in Aktionen gespeichert. Eine konfigurierte Secretreferenz ohne auflösbaren Zugang scheitert geschlossen.

Endpunkt, öffentlicher Host, erlaubte DNS-Adressen und private CA stammen ausschließlich aus diesem CEO-Profil, nie aus Modellargumenten. Damit sind auch explizit administrierte private Hostingziele möglich. Öffentliches DNS wird vor der Gesundheitsprüfung aufgelöst; alle gefundenen Adressen müssen im Profil stehen. Die HTTP-Verbindung wird auf eine der geprüften Adressen festgelegt, während TLS weiterhin die ursprüngliche Hostidentität prüft. Es gibt keine Weiterleitung und kein `rejectUnauthorized: false`.

## Freigaben und Auslieferung

Ein Profil bezeichnet genau ein Hostingziel für einen Websiteauftrag. Ein neuer Auftrag erhält ein eigenes Profil. `GET /api/v1/orders/:id/hosting` liefert Ressourcen und Deployments samt nachprüfbaren Gesundheitsnachweisen.

1. `POST /api/v1/orders/:id/hosting/provision` mit `{actionId,profileId,mandateId,mandateVersion}` schlägt `hosting.provision` vor. Die Freigabe enthält Zielfingerprint, URL, Stack, Tarif und monatliche Kostenobergrenze. Vor Ausführung werden Mandat, Freigabe und Kostenobergrenze erneut geprüft. Ein persistenter Ziel-Intent verhindert parallele oder ungeklärte zweite Provisionierungen mit einer anderen Aktion. Unklare Vorgänge erfordern einen administrativen Abgleich; es gibt kein automatisches Zurücksetzen dieses Intents.
2. Nach fachlicher Websiteabnahme: `POST .../hosting/publish` ergänzt `artifactVersionId` und `packageSha256`. Eine separate `website.publish`-Freigabe bindet genau diese Version, den Manifesthash, den tatsächlichen Archivhash, Ressourcen-ID, Ziel-URL und Konfigurationsfingerprint. Profil- oder Artefaktänderungen entwerten diese Bindung.
3. Das deterministische tgz enthält alle manifestierten Dateien. Dateigrößen und SHA-256 werden unmittelbar vor Archivierung geprüft. Der Broker erhält die tatsächlichen Archivbytes, maximal 50 MiB, und muss Archivhash sowie freigegebenes Manifest vor Aktivierung prüfen. Dateipfade, Symlinks und Archiveinträge muss auch der Broker sicher validieren; er darf keine Hostshelleinträge aus diesem Vertrag ausführen.
4. Eine positive Deploymentantwort allein genügt nicht. Die Zentrale prüft über HTTPS die Rootseite, erwartete Textmerkmale, DNS, Zertifikatskette/Hostname und den Versionsnachweis `/.well-known/ironcrew-deployment.json`. Bei statischen und React-Seiten muss zusätzlich der ausgelieferte HTML-SHA-256 dem gebauten Artefakt entsprechen. WordPress liefert dynamisches HTML; dort werden konkrete konfigurierte Textprüfungen und der Paketnachweis verwendet. Dies ersetzt keine anwendungsspezifischen Login-, Formular- oder Plugin-Abnahmetests.
5. Erst danach wird die Website `published`. Die Datenbank speichert Zeitpunkt, DNS-Antwort, verbundene IP, Zertifikatsfingerprint und Ablauf, Seitenhash, Nachweishash und ausgeführte Prüfungen. Ein Timeout, ein unterbrochener Schreibvorgang oder eine fehlgeschlagene Nachprüfung bleibt `effect_unknown`. Wiederholung derselben Aktions-ID sendet nicht erneut.
6. `POST .../hosting/rollback` mit zusätzlichen `deploymentId` schlägt `hosting.rollback` als eigene konkrete Freigabe vor. Die akzeptierte Brokerantwort ist als `rollback_accepted` mit `requiresFreshHealthCheck` gespeichert. Die vorherige Veröffentlichung wird bei passender aktueller Version zurückgenommen; ein erfolgreicher Rückweg wird nicht als unabhängig gesund dargestellt.

## Brokervertrag Version 1

Alle schreibenden Requests sind HTTPS-POST mit JSON, `protocolVersion: 1`, stabiler `actionId` und optionalem Bearer-Header aus Proton Pass. Der Broker muss Aktions-IDs dauerhaft deduplizieren: dieselbe ID und identischer Inhalt liefern dasselbe Ergebnis; veränderter Inhalt wird abgewiesen. Zentrale Replays sind zusätzlich durch das lokale ExecutionJournal gesichert. Endgültige Antworten haben HTTP 200 oder 201; ein nur angenommenes asynchrones Provisioning/Deployment ist kein endgültiger Erfolg.

- `/v1/resources`: Request enthält `targetId,publicUrl,stack,plan,monthlyCostLimitUsdMicros`. Antwort: `{id,publicUrl,stack,monthlyCostUsdMicros,state:"ready"}`. URL und Stack müssen exakt passen und Kosten dürfen die Obergrenze nicht überschreiten.
- `/v1/resources/:id/deployments`: Request enthält `targetId,publicUrl,artifactVersionId,packageSha256,archiveSha256,archiveBase64`. Antwort: `{id,resourceId,publicUrl,artifactVersionId,packageSha256,archiveSha256,rollbackRef}`. Alle Paket- und Zielidentitäten müssen exakt passen. Der Broker muss die vorige Version unter `rollbackRef` vor Aktivierung sichern.
- `/v1/resources/:id/rollback`: Request enthält `targetId,rollbackRef`. Antwort: `{rollbackRef,state:"accepted"}`. Dies bestätigt nur den angenommenen Rückweg.
- Öffentlicher Nachweis `GET /.well-known/ironcrew-deployment.json`: HTTP 200 mit `{artifactVersionId,packageSha256,archiveSha256}` der tatsächlich aktivierten Version. Keine Zugangsdaten in dieser Datei.

Das Profil kann einen Pfadpräfix im `endpoint` enthalten. Die `/v1/...`-Pfade werden daran angehängt. Der öffentliche Versionsnachweis liegt ausschließlich unter `publicUrl`, nicht am authentifizierten Brokerendpunkt.

## Ausgeführte Nachweise

`tests/integration/hosting.test.ts` erzeugt lokal ein kurzlebiges Zertifikat, startet einen echten HTTPS-Server, provisioniert eine Ressourcendatei, überträgt und entpackt echte tgz-Archive, liefert deren HTML und Versionsdatei aus und stellt die vorige HTML-Version beim Rollback wieder her. Getestet werden getrennte Freigaben, API-Authentifizierung/CSRF/Revisionen, Ziel- und Versionsbindung, DNS und Zertifikatsvertrauen, falscher Inhalt/Nachweis, unvollständige Providerantworten, konservativer Wirkungsstatus und konkurrierende Provisionierung. Es werden keine echten Hostingkonten verwendet. Voraussetzung für diese lokalen TLS-Tests ist `openssl` im PATH.

Die native HTTPS- und TLS-Nutzung folgt den offiziellen [Node.js HTTPS-Optionen](https://nodejs.org/api/https.html) und der [TLS-Hostnamenprüfung](https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert). Der externe Brokervertrag wird durch lokale Vertragsfixtures geprüft; ein produktiver Broker oder Drittanbieter wurde nicht live validiert.
