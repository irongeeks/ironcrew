# Verifizierte Eingangskanäle

Der lokale HTTP-Eingang legt authentifizierte Discord-/Telegram-Ereignisse und Nachrichten einer authentifizierten Mailbridge als Inbox-Aufträge an. Die Webhook-Nachricht kann weder einen Run starten noch eine Freigabe erteilen. Wiederholte Provider-Ereignisse werden dauerhaft in SQLite dedupliziert; eine veränderte Nachricht mit derselben Ereignis-ID wird mit 409 abgewiesen.

## Administrative Konfiguration

`channel-config.example.json` enthält ausschließlich Platzhalter und deaktivierte Kanäle. Als `channel-config.json` im Datenverzeichnis der Zentrale ablegen; nur der Betreiber darf diese Datei schreiben (Dateimodus 0600). Echte IDs einsetzen und genau die benötigten Kanäle aktivieren. Die Datei wird als Rückfallkonfiguration gelesen, solange keine CEO-Konfiguration in der Datenbank besteht. Die Oberfläche unter Einstellungen → Kanäle liest `/api/v1/channels/config` und speichert `{config}` per PUT mit der aktuellen `If-Match`-Revision (initial 0). Datenbankkonfiguration hat Vorrang. Paralleländerungen führen zu Konflikt statt Überschreiben. Eine fehlende Konfiguration aktiviert keine Kanäle; ungültige Konfiguration führt zu 503.

- `id`: eigene UUID des Eingangs. Sie ist Teil der Webhook-URL und kein Geheimnis.
- `scope`: bestehende Firmen-/Bereichs-IDs, gegebenenfalls zusätzlicher Kunden-/Projektbereich. Der externe Payload kann diesen Bereich nicht ändern.
- `accountId`: fester Provider-Account. Ein Provider-Account darf in dieser Datei nur einmal vorkommen, damit derselbe Eingang keinem zweiten Bereich zugeordnet wird.
- `conversationIds`: explizit erlaubte Telegram-Chat- bzw. Discord-Kanal-IDs. Kein Wildcard-Modus.
- `kind`: Auftragstyp `research`, `website`, `incident` oder `finance`; Standard `research`.
- `budgetLimitUsdMicros`: ganzzahlige USD-Mikrobeträge als Zeichenkette; Standard `"0"`. Der Eingang erzeugt einen Auftrag, er autorisiert keine Ausführung.
- `proton`: absoluter Pfad zur unterstützten `pass-cli` 2.3.3 und optional ein eigenes Sitzungsverzeichnis. Die Zentrale löst Telegram-/Mailbridge-Geheimnisse über `SecretRef` auf. Rohgeheimnisse gehören nicht in die Konfiguration.

`registerChannelRoutes(app, { repo, directory, assertWritable })` muss **vor** `express.json()` und der CEO-Session-/CSRF-Middleware registriert werden. Die Signaturprüfung benötigt die unveränderten JSON-Bytes. `assertWritable` bindet den Backup-/Restore-Schreibschutz ein. Nur `/api/v1/channel-webhooks/:provider/:id` verwendet Provider-Authentifizierung; die übrigen API-Wege bleiben hinter der CEO-Anmeldung.

## HTTPS und Provider-Anmeldung

Öffentliche Provider erreichen einen administrierten HTTPS-Reverse-Proxy mit gültigem Zertifikat. Die Zentrale bleibt am lokalen Interface. Der Proxy muss Request-Body und Signaturheader unverändert weiterreichen und darf keine JSON-Neukodierung vornehmen. Request-Bodies, Bindetoken und Authentifizierungsheader dürfen nicht in Proxy-Logs erscheinen. Webhooks akzeptieren höchstens 1 MiB unkomprimiertes `application/json`.

Telegram: Beim Einrichten von `setWebhook` die URL `https://HOST/api/v1/channel-webhooks/telegram/CHANNEL_UUID` und ein eigenes Webhook-Secret verwenden. Dasselbe Secret steht in dem referenzierten Proton-Feld. Es ist **nicht** der Bot-Token. IronCrew vergleicht `X-Telegram-Bot-Api-Secret-Token`; unterstützt werden Textnachrichten menschlicher Absender in erlaubten Chats.

Discord: Die Interactions Endpoint URL lautet `https://HOST/api/v1/channel-webhooks/discord/CHANNEL_UUID`. `publicKeyHex` ist der echte öffentliche Ed25519-Schlüssel der Anwendung (64 Hexzeichen, kein Bot-Token). IronCrew prüft `X-Signature-Ed25519` über `timestamp || rawBody` und `X-Signature-Timestamp` innerhalb von fünf Minuten. Ein signierter Ping erhält `{ "type": 1 }`. Unterstützt sind Application Commands mit einfachen String-/Zahl-/Boolean-Optionen. Antworten sind ephemere Empfangsbestätigungen mit deaktivierter Veröffentlichung des Eingangstextes.

Diese Implementierung registriert keine Webhooks oder Slash Commands beim Provider. Diese administrative Einrichtung und ein Test mit einem eigenen Provider-Konto bleiben erforderlich.

## CEO-Identität verknüpfen

Als angemeldeter CEO im Kanalformular den konkreten Bereich auswählen und Challenge erzeugen, oder `POST /api/v1/channels/challenge` mit `{ "provider": "telegram", "scope": { "companyId": "…", "areaId": "…" } }` bzw. `discord` senden. Die normale Mutations-API verlangt gültige Session, `X-CSRF-Token` und `Idempotency-Key`. Der zurückgegebene `challenge`-Wert ist zehn Minuten gültig und einmalig verwendbar.

Im erlaubten Telegram-Chat exakt senden:

```text
/ironcrew_bind CHALLENGE
```

Die Variante `/ironcrew_bind@BOTNAME CHALLENGE` ist ebenfalls zulässig. In Discord den Application Command `ironcrew-bind` mit einer String-Option namens `token` und dem Challengewert registrieren und ausführen. Die Zentrale übernimmt ausschließlich die Benutzer-ID aus dem signierten Provider-Ereignis. Ein zweiter Verbrauch desselben Challenges wird abgewiesen. Ein erfolgreicher Bindevorgang erzeugt keinen Auftrag.

Auch Nachrichten eines so verknüpften CEOs bleiben Inbox-Aufträge und haben `approvalAllowed: false`. Freigaben erfolgen in der geschützten Weboberfläche an der konkreten Aktion.

## Vertrag der authentifizierten Mailbridge

Der Mail-Eingang ist kein öffentliches SMTP-Postfach und übernimmt keine behauptete IronCrew-Identität aus dem E-Mail-Absender. Ein vom Betreiber eingerichteter Transport liest das Postfach über seine authentifizierte Verbindung und übergibt:

```json
{ "eventId": "MAILBOX_UIDVALIDITY:UID", "sender": "sender@example.org", "subject": "Betreff", "text": "Nachricht" }
```

`eventId` bleibt bei Wiederholung gleich; bei IMAP empfiehlt sich `UIDVALIDITY:UID`. Zusätzliche Felder wie `role`, `scope`, `authenticated` oder `userId` werden abgewiesen. Das Schema erlaubt einen Betreff bis 500 und Text bis 19.000 Zeichen. Jede angenommene Mail ist ein externer Auftrag, selbst wenn `sender` der CEO-Adresse entspricht.

Für `POST https://HOST/api/v1/channel-webhooks/email/CHANNEL_UUID`:

1. `X-IronCrew-Timestamp`: aktuelle Unixzeit in ganzen Sekunden, maximal fünf Minuten Abweichung.
2. `X-IronCrew-Signature`: hexadezimales `HMAC-SHA256(secret, timestamp + "." + rawBody)` ohne Präfix.
3. `Content-Type: application/json`; exakt die signierten Bytes übertragen.

Das Bridge-Secret muss mindestens 32 Zeichen haben und liegt ausschließlich im authentifizierten Transport und im referenzierten Proton-Pass-Feld. Signaturen laufen ab; bereits gespeicherte Ereignisse bleiben auch nach Server-/Datenbankneustart dedupliziert. Die Mailbridge selbst ist ein gesondert zu betreibender Transport; dieser Eingang behauptet keine implementierte automatische IMAP-Polling-Schleife.

## Ausgehende Nachrichten

Die Eingangsdatei ist keine Versandberechtigung. Ausgehende Verbindungen werden separat in der Runtime-Konfiguration angelegt, mit eigenem Ziel, Bereich, Proton-SecretRef und expliziten Toolrechten:

| Tool              | Parameter                         | Geheimnis           |
| ----------------- | --------------------------------- | ------------------- |
| `telegram.send`   | `chatId`, `text`                  | Bot-Token           |
| `discord.send`    | `channelId`, `text`               | Bot-Token           |
| `graph.mail.send` | `userId`, `to`, `subject`, `text` | Graph-Zugriffstoken |

Diese Tools sind `external_send`: persistenter Aktionsdatensatz, passendes Mandat und konkrete Freigabe sind erforderlich. Ein akzeptierter Versand wird nicht automatisch als zugestellt gewertet. Der separate `MailConnector` unterstützt authentifiziertes TLS-SMTP/IMAP als Bibliothek; seine Existenz bedeutet keine automatische Registrierung als Runtime-Tool.

## Lokaler Nachweis

`tests/integration/channels-http.test.ts`: sechs Tests mit echtem HTTP-Listener, echtem SQLite-Worker, lokalen Ed25519-Schlüsseln und dem Proton-Resolver mit einem ausdrücklich lokalen CLI-Testadapter. Geprüft sind Signaturen, Ping, Tampering, veraltete Zeitstempel, Allowlist, deaktivierte Kanäle, CEO-Bindung, Replay inklusive vollständig neu gestartetem HTTP-Server und Datenbank, Mailtransport und Wartungssperre. Keine externen Nachrichten wurden versandt und kein Livekonto wurde als geprüft ausgegeben.
