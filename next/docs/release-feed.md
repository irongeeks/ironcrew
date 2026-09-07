# Signierte Releaseentdeckung

Die Zentrale liest ausschließlich die separat administrativ bereitgestellte Datei `DATA/release-feed.json`. Es gibt keinen CEO-Endpunkt zum Setzen eines Vertrauensankers. Die Datei muss regulär, ohne Hard-/Symlink und auf POSIX nicht gruppen-/weltbeschreibbar sein; die administrativen ACLs beziehungsweise geschützten Elternpfade bleiben Voraussetzung des Betriebs. Ohne Datei gibt es keinen Abruf. Testschlüssel sind keine produktiven Vertrauensanker.

```json
{
  "id": "00000000-0000-4000-a000-000000000001",
  "indexUrl": "https://releases.example.org/ironcrew/index.json",
  "archiveBaseUrl": "https://releases.example.org/ironcrew/archives/",
  "trustedPublicKeyPem": "-----BEGIN PUBLIC KEY-----\nADMIN_ED25519_PUBLIC_KEY\n-----END PUBLIC KEY-----\n",
  "channel": "stable"
}
```

URLs akzeptieren nur HTTPS ohne Zugangsdaten, Query und Fragment. Archive müssen innerhalb der administrativen Herkunft und des Pfadpräfixes liegen. Redirects werden abgelehnt. Ein optionales `caCertificatePem` dient einer administrativ verwalteten privaten Zertifizierungsstelle. Die Ed25519-Release-Policy muss denselben öffentlichen Schlüssel binden. Schlüsselwechsel erfordern eine neue administrative Feed-ID und passende Policy; die persistente Sequenzsperre wird nicht zurückgesetzt.

Der vollständige Wirevertrag wird aus `releaseFeedEnvelopeSchema` und `releaseFeedPayloadSchema` in `packages/operations/src/release-feed.ts` abgeleitet. Das Envelope enthält `signed` und eine Base64-Ed25519-`signature`. Signiert werden die UTF-8-Bytes von `releaseFeedSigningBytes(signed)`; dies verwendet die kanonische JSON-Darstellung. Der Index bindet Format/Version, monoton steigende `sequence`, `publishedAt`, `expiresAt` (maximal sieben Tage Laufzeit), Kanal und höchstens 100 Plattform-/Architektur-Releases. Jedes Release bindet Version, Schema/Protokoll, Node26.4.0, Archiv-URL/-Bytezahl/-SHA256 und Manifest-SHA256. Das Archiv enthält außerdem das unabhängig signierte Release-Manifest und ausschließlich dessen Dateien.

Die bestehende Hintergrund-Wartung ruft alle 15 Minuten aktive passende Policies ab. `release-discovery-status` hält Versuch, nächsten Zeitpunkt, letzten Erfolg und begrenzte Fehlercodes dauerhaft fest. Gleichzeitige Ticks und Neustarts lösen innerhalb des Fensters keinen erneuten Abruf aus. Fehlertexte, Serverantworten und mögliche Geheimnisse werden nicht gespeichert. Die Firmen-Wiederherstellungspause blockiert Abrufe.

Die CEO-API trennt die Schritte:

- `GET /api/v1/maintenance/releases`: aktuelle gültige Kandidaten.
- `POST /api/v1/maintenance/releases/discover` mit `{ "policyId": "UUID" }`: Index prüfen und Kandidaten entdecken.
- `POST /api/v1/maintenance/releases/candidates/UUID/stage-plan` mit `{}`: exakt signierte Bytes herunterladen, prüfen und einen vorhandenen/neuen `planned`-Updateplan zurückgeben.

Discovery lädt keine Archive. Staging genehmigt keinen Updateplan. Wartungsfenster, Backuppolicy, Restoreprobe, unabhängiger administrativer Updater und konkrete Freigabe gelten unverändert. Die erneute Konfigurationsprüfung nach einem längeren Download verhindert ein Planangebot mit inzwischen ersetztem Vertrauensanker. Zwei parallele Stagingaufrufe erzeugen nur einen Plan.

Grenzen: Kontrollindex maximal1MiB; Archiv maximal512MiB; entpackter Datenstrom maximal2GiB und100002 Einträge. Dateien werden gestreamt, vor Extraktion auf unsichere Pfade, Links, Groß-/Kleinschreibungskollisionen und Datei-/Ordnerkollisionen geprüft und anschließend vollständig manifest-/signaturgeprüft. Alte, entfernte, abgelaufene oder zu einer widerrufenen Policy gehörende Kandidaten sind gesperrt. Ein Cache ist kein selbständiger Vertrauensanker. Kein produktiver Feed und kein Release wurden veröffentlicht.

`tests/integration/release-feed.test.ts` verwendet echte HTTPS-Requests, Ed25519, Tar-Archive und SQLite-Neustarts. Es prüft Signaturfehler, Ablauf, Sequenzrollback, entfernte Kandidaten, Archivmanipulation, falschen CEO/Scope, Widerruf, gleichzeitiges Staging, dauerhafte Abrufkadenz und redigierte Fehler.
