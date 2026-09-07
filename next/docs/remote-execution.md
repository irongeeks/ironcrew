# Getrennte Zentrale und Linux-Worker

`remoteWorkerId` in der Administratorkonfiguration verbindet Runtime- und Website-Ausführung mit einem eingeschriebenen Worker derselben Firma. Ein lokales `isolationProfilePath` und `remoteWorkerId` schließen sich aus. Der Worker läuft mit einem tatsächlich geprüften Linux-Isolationsprofil; die Zentrale kann auf macOS laufen. Auf dem Worker muss kein eingehender Port geöffnet werden.

## Einrichtung

1. Linux-Worker gemäß [Isolationsprofil](../packages/tools/isolation/README.md) vorbereiten; unter macOS kann dafür eine eigene Lima-VM ohne Hostmounts dienen. Vorhandene Colima-Instanzen werden nicht benötigt oder geändert.
2. Worker über die CEO-Oberfläche einschreiben, Capability `workspace.execute` auswählen und die einmalig ausgegebene Konfiguration samt öffentlichem CA-Zertifikat auf den Worker übertragen. Token und CA-Privatschlüssel gehören niemals ins Projekt oder Modellkontext.
3. In der Worker-Konfiguration `isolationProfilePath` auf das dortige Profil setzen und die erreichbare `wss://`-Adresse der Zentrale verwenden. `caFile` enthält die vertrauenswürdige Zertifikatskette. Der Hostname muss zum Zertifikat passen; es gibt keine TLS-Prüfungsabschaltung.
4. Worker über den delegierten Linux-Dienst starten. In der Zentrale seine ID als `remoteWorkerId` speichern. Der Worker führt beim Prozessstart die echten Kernelproben aus; ohne vollständigen gültigen Nachweis wird freie Ausführung abgelehnt.

Die Attestation ist höchstens eine Stunde gültig. Nach Ablauf muss das Profil durch einen Worker-Neustart erneut geprüft werden. Die Zentrale vertraut dem ausdrücklich eingeschriebenen Workerbetriebssystem und seiner authentisierten Probequittierung. Dies ist keine Hardware-Fernattestierung und schützt nicht gegen einen kompromittierten Workeradministrator.

## Dateien und Befugnisse

WSS-Kontrollnachrichten bleiben auf 1 MiB begrenzt. Eingaben und Artefakte werden über getrennte TLS-Streams übertragen: GET `/api/v1/worker-transfers/{jobId}/input/{index}`, PUT `.../output/{index}`. Die HMAC-Tickets binden Firma, Bereich, Kunde/Projekt, Auftrag, Worker, Generation, Richtung, Manifest und Ablauf. Sie können keine anderen Dateien oder Jobs adressieren. PUT verlangt exakte Content-Length; erst vollständige Bytes, SHA-256-Prüfung, Datei-fsync und atomare Umbenennung führen zu 204. Jeder Stream endet spätestens nach 15 Sekunden. Downloads und Uploads sind in die Wartungsbarriere der Zentrale eingebunden.

Pro Eingabe- oder Artefaktmanifest gelten 32 MiB, höchstens 1024 Dateien und 300.000 Byte Manifest-JSON. Zwei zusätzliche Logstreams enthalten stdout/stderr mit zusammen höchstens 1 MiB. Kleine Protokollmetadaten erlauben höchstens 4096 Zeichen je Logfeld; der native Worker sendet seine Logs vollständig über die Streams. Pfade sind relativ, ohne Links, Hardlinks, Traversal, versteckte Secretverzeichnisse oder kollidierende Namen nach Unicode-Normalisierung und Groß-/Kleinschreibung. Leere Verzeichnisse sind nicht Teil des Dateimanifests. Ausführungsparameter sind zusätzlich auf 128.000 Byte JSON begrenzt.

Jede Ausführung erhält eine eigene persistente `workspace.execute`-Kindaktion, gebunden an Argumenthash und Eingabemanifest. Ein Modellwerkzeug liefert den Kontext nicht selbst: Die Runtime bindet die tatsächlich gespeicherte Elternaktion und ihr Mandat. Ein expliziter CEO-Websitebuild erhält eine einmalige, auf exakt diese Ausführung begrenzte CEO-Autorität. WordPress-PHP-Prüfung und Build sind getrennte Kindaktionen. Unmittelbar vor dem Start verlangt der Worker POST `.../{jobId}/start` mit dem Eingabeticket und `Content-Length: 0`. Die Zentrale prüft Mandat, Elternaktion, Sperrzustand, Worker-Generation und Fristen erneut. Während des Auftrags kontrolliert sie den Befugnisbestand weiter; Widerruf löst Abbruch aus.

Die Zentrale importiert nur vollständige manifesteigene Dateien in ihr privates Ausgabeverzeichnis. Ein Workerpfad wird nie als lokal lesbarer Pfad übernommen. Runtime-Artefakte werden vor der Journalquittierung zusätzlich in den zentralen Content-Addressed-Blobstore übernommen; Websiteversionen übernehmen ihre geprüften Dateien in die Artefaktablage.

## Wiederaufnahme und Abbruch

Job-ID, Autorität, Eingabe-/Ausgabemanifeste, Kindaktion, Worker-Generation und Quittierungen bleiben in SQLite erhalten. Worker-Journal, Mailbox und Uploadbelege sind lokal dauerhaft. Ein Reconnect wiederholt nur fehlende Übertragung oder Quittierung. Derselbe Job mit gleichem Manifest und Parametern erzeugt keinen zweiten Effekt. Ein begonnenes Journal ohne Ergebnis wird als unbekannt behandelt und niemals automatisch erneut ausgeführt.

Rotation oder Widerruf der Workeridentität sperrt alte Tickets. Abbruch adressiert Kind- oder Elternaktion und beendet die native cgroup samt Kindprozessen. Uploadcontroller werden ebenfalls abgebrochen. Eine unbestätigte Ausführung bleibt `effect_unknown`; verspätete Ergebnisse werden quittiert, aber nicht als Erfolg importiert. Bei Shutdown sperrt die Zentrale neue Remoteaufträge dauerhaft, schreibt die offenen Zustände und sendet Abbruch, bevor sie den HTTP-Drain abwartet. Ein Verbindungsabbruch allein startet keine zweite Ausführung.

Transferstaging und `worker-transfers/ticket-key` sind keine Backup-Nutzdaten. Eine Wiederherstellung sperrt alte Worker und offene Jobs; bereits übernommene Runtime-/Website-Artefakte bleiben über ihre reguläre Blob-/Artefaktsicherung verfügbar. Ein Prozessneustart im gleichen Datenverzeichnis kann laufende Übertragungen fortsetzen. Windows hat keine portable Verzeichnis-fsync-API: Datei-fsync bleibt vorgeschrieben, die Stromausfall-Dauerhaftigkeit der Verzeichnisumbenennung ist dort noch nicht live abgenommen. Windows-/Hyper-V-Produktbetrieb bleibt eine separate Plattformabnahme.

## Nachweise

`tests/integration/remote-execution.test.ts` prüft echte TLS/WSS-Streams mit einem ausdrücklich synthetischen Protokollpeer: große Dateien, falsche Tokens/Hashes/Indizes, Generation, Reconnect, Zentralen-Neustart, manipulierte Ergebnisablage, fehlende Autorität, widerrufene Startberechtigung, Parallelitätsgrenze und Shutdown. Dieser Peer ist kein Isolationsnachweis.

`tests/isolation/remote-host.ts` startet einen echten nativen Workerprozess mit dem attesten Linuxprofil. Der Test wurde sowohl mit macOS-Zentrale und eigener Linux-Lima-VM als auch mit getrennten Linuxprozessen ausgeführt. Er prüft 3 MiB Eingabe/3 MiB Ausgabe, 400.000 Byte gestreamte Logs, idempotente Rückgabe, reale React- und WordPressbuilds samt PHP-Lint sowie Abbruch eines bereits angelegten Jobcgroups und dessen vollständige Bereinigung. Die bereinigten Belege und Archive stehen unter [test-evidence/remote-execution](test-evidence/remote-execution/remote-execution.json). Die Linuxvariante ist im Isolation-CI-Job eingetragen; ein GitHub-CI-Lauf wird damit nicht behauptet.
