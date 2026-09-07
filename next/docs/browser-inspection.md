# Begrenzte Browserprüfung eigener Artefakte

`browser.inspect` rendert eine konkrete intern gebaute Website-Version. Das Tool akzeptiert ausschließlich:

```json
{
  "artifactPreviewId": "ARTIFACT_VERSION_UUID",
  "expectedPackageSha256": "SHA256_DES_EXAKTEN_DATEIMANIFESTS",
  "viewport": "desktop"
}
```

`viewport` ist `desktop` (1440×1000) oder `mobile` (390×844). Es gibt keine URL-, JavaScript-, Klick-, Login- oder Browserflag-Parameter. Auftrag, Firmen-/Bereichs-/Kunden-/Projektscope, Ziel und Mandat stammen aus der persistierten laufenden ToolAction. Das Mandat muss exakt `browser.inspect` am betreffenden Ziel erlauben. Die Quelle muss eine zum Auftrag gehörende Website-Artefaktversion mit unverändertem Paketmanifest sein; jede Datei wird vor Rendering nochmals aus dem sicheren Workspace gelesen und gehasht.

## Administrative Einrichtung

Ein Administrator stellt eine mit Playwright1.61.0 kompatible Chromium-/Chrome-for-Testing-Distribution in einem geschützten Verzeichnis bereit. Programm **und Begleitdateien** dürfen nicht von generierten Arbeitsabläufen verändert werden. Es gibt keinen automatischen Download, keinen Browser aus einer Benutzer-Sitzung und keinen Rückfall auf Entwicklungsabhängigkeiten. Der tatsächliche Executable-Hash wird vor jedem Start geprüft. Eine automatische Browseraktualisierung sperrt die Fähigkeit bis zur administrativen Aktualisierung des Hashes.

`DATA/browser-configuration.json`:

```json
{
  "executable": "/ADMIN/CHROMIUM/chrome",
  "executableSha256": "TATSAECHLICHER_SHA256_DER_EXECUTABLE"
}
```

Die Datei darf kein Link/Hardlink und auf POSIX nicht gruppen-/weltbeschreibbar sein. Sichere administrative Elternpfade beziehungsweise Windows-ACLs sind Betriebsvoraussetzung. Die ausführbare Datei wird nicht über CEO-/Modellinput gesetzt. Fehlt die Konfiguration, liefert das Tool `browser_capability_missing`; bei verändertem Binary `browser_binary_unverified`. Auf Linux ist ein nichtprivilegiertes Dienstkonto mit funktionsfähiger Chromium-Sandbox erforderlich. Root-Ausführung und Sandbox-Abschaltflags werden abgelehnt. Es gibt keinen `--no-sandbox`-Fallback.

## Ausführung und Beleg

Ein frischer Browserprozess und ein privates Browsercontext ohne Cookies, Berechtigungen, Benutzerprofil oder übernommene Geheimnis-Umgebung rendern die Momentaufnahme auf `https://ironcrew-preview.invalid`. Die URL wird ausschließlich durch geprüfte interne Bytes beantwortet; sie wird nicht im Netz aufgelöst. Der gemeinsame `previewSecurityHeaders()`-Helper liefert die identische CSP wie die getrennte Produktionspreview: opaque `sandbox`-Origin, nur bei React lokale Skripte, keine Verbindungs-/Formularrechte und keine fremden Quellen.

Alle anderen Requests und WebSockets werden verworfen; ServiceWorker, Downloads, Popups und fremde Frames sind gesperrt. Zusätzlich verwendet Chromium einen eigenen ausschließlich ablehnenden Loopback-Proxy, deaktivierte Hintergrundkommunikation/QUIC und blockierte Namensauflösung; nicht über Proxy geführtes WebRTC-UDP ist deaktiviert. `chromiumSandbox:true` bleibt aktiv. Der tatsächliche Browserprozess muss seine Kommandozeile zurückmelden, und bekannte Sandbox-/Websecurity-Abschaltflags werden zurückgewiesen. Diese Renderer-Sandbox ist die Browsergrenze, kein Nachweis der freien Linux-Buildisolation.

Es läuft höchstens eine Prüfung pro Repository. Die Eingabe ist auf1024Dateien/32MiB begrenzt, einzelne Dateien auf8MiB. Browserstart maximal15Sekunden, anschließend gesamter Browserdialog maximal20Sekunden. Screenshot nur sichtbarer Viewport, maximal8MiB; strukturierter DOM-Ausschnitt maximal500Elemente/512KiB. Ein reduziertes V8-Heapbudget und die Prozessbegrenzung sind zusätzliche Schutzmaßnahmen, keine plattformübergreifende harte RAM-/CPU-Quote.

Der unveränderliche Report `browser-inspection` bindet Action, Scope über Dokumentablage, Quellversion, Paket-SHA256, tatsächliche Browserversion/Binaryhash, Viewport, Screenshot-/DOM-SHA256 und einzelne überprüfte Eigenschaften. PNG und strukturierter DOM werden normale CAS-Artefakte. Gleiches Action-Replay verwendet denselben Report; ein widerrufenes Mandat oder eine während der Prüfung geänderte administrative Konfiguration erlaubt keine neue Belegveröffentlichung.

Prüfungen umfassen Titel, Sprache, Überschrift, horizontales Überlaufen, Altattribute, geladene Bilder und Sitzungstrennung. Fehler werden einzeln ausgewiesen. `state` bleibt stets `review_required`: DOM-Inhalte sind ausdrücklich fremder Artefaktinhalt, nicht vertrauenswürdige Arbeitsanweisungen; ein Screenshot ist keine automatische Lead-Abnahme.

## Nachweis und offene Breite

`tests/integration/browser-inspect.test.ts` läuft mit tatsächlichem Chromium und ohne stille Skips. Der Testharness darf über `IRONCREW_TEST_CHROMIUM` einen ausdrücklich gewählten Browser verwenden; sonst wählt nur der Test die installierte Playwright-Distribution. Produktion besitzt diesen Fallback nicht. Die Tests bestätigen PNG/DOM, Origin `null`, keinen Storage, null Requests an eine echte externe Loopback-HTTP-Fixture, blockierten WebSocket, mobile Layoutfehler, Scope-/Hashschutz, Replay und Widerruf während der Prüfung. Belege liegen unter `docs/test-evidence/browser-inspect/`; die defekte Bildanzeige im Fixture-Screenshot zeigt die absichtlich geblockte externe Bildquelle.

Der native Nachweis wurde auf macOS ARM64 mit Chromium149.0.7827.55 erbracht. Linux-/Windows-Chromium-Sandboxläufe dieser neuen Fähigkeit stehen noch aus. Freie öffentliche URLs, beliebige Browseraktionen, authentifizierte Sitzungen und WordPress-Backend-Bedienung bleiben außerhalb dieser Fähigkeit.

Technische Verträge: [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype), [ServiceWorker-Interzeption](https://playwright.dev/docs/service-workers), [Chromium Sandboxdesign](https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md) und [macOS-Sandboxdesign](https://www.chromium.org/developers/design-documents/sandbox/osx-sandboxing-design/).
