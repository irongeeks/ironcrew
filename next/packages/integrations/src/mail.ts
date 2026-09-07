import { readFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import {
  inboundMailId,
  mailPollOptionsSchema,
  parseInboundMail,
  type InboundMail,
  type MailPollOptions,
  type MailPollResult,
} from "./mail-inbound.ts";
import type { OAuthConfiguration, OAuthTokenBroker } from "./oauth.ts";
import { IntegrationError, redact } from "./transport.ts";
import { type SecretRef, type SecretResolver } from "./secrets.ts";
import type { AuthorizedIntegrationAction, IntegrationScope, IntegrationResult } from "./service.ts";

export interface MailConnection {
  id: string;
  scope: IntegrationScope;
  host: string;
  port: number;
  username: string;
  secretRef?: SecretRef;
  oauth?: OAuthConfiguration;
  from: string;
  mailbox?: string;
  tlsMode?: "implicit" | "starttls";
  tlsCaFile?: string;
}
/** Each mailbox gets a dedicated admin configuration. SMTP acceptance never claims delivery. */
export class MailConnector {
  private readonly connection: MailConnection;
  private readonly secrets: SecretResolver;
  private readonly options: { oauth?: OAuthTokenBroker; oauthGeneration?: () => Promise<string | null> };
  private readonly authorize: (action: AuthorizedIntegrationAction) => Promise<void>;
  constructor(
    connection: MailConnection,
    secrets: SecretResolver,
    authorize: (action: AuthorizedIntegrationAction) => Promise<void>,
    options: { oauth?: OAuthTokenBroker; oauthGeneration?: () => Promise<string | null> } = {},
  ) {
    this.connection = structuredClone(connection);
    this.secrets = secrets;
    this.authorize = authorize;
    this.options = options;
  }
  private async check(action: AuthorizedIntegrationAction, toolId: string): Promise<string> {
    const scope = this.connection.scope;
    if (
      action.targetId !== this.connection.id ||
      action.toolId !== toolId ||
      action.scope.companyId !== scope.companyId ||
      action.scope.areaId !== scope.areaId ||
      action.scope.customerId !== scope.customerId ||
      action.scope.projectId !== scope.projectId
    )
      throw new IntegrationError("authorization", "Mailbox liegt außerhalb des erlaubten Bereichs.");
    await this.authorize(structuredClone(action));
    if (this.connection.oauth) {
      if (!this.options.oauth || !this.options.oauthGeneration)
        throw new IntegrationError("configuration", "OAuth-Broker für Mailbox fehlt.");
      return this.options.oauth.accessToken(this.connection.oauth, {
        scope,
        connectionId: this.connection.id,
        generation: await this.options.oauthGeneration(),
        reason: `Action ${action.id}: ${toolId}`.slice(0, 300),
        authorize: () => this.authorize(structuredClone(action)),
      });
    }
    if (!this.connection.secretRef) throw new IntegrationError("configuration", "Mailbox-Zugangsreferenz fehlt.");
    return this.secrets.resolve(this.connection.secretRef, `Action ${action.id}: ${toolId}`.slice(0, 300));
  }
  async send(action: AuthorizedIntegrationAction): Promise<IntegrationResult> {
    const parsed = z
      .object({
        to: z.array(z.email()).min(1).max(20),
        subject: z.string().min(1).max(200),
        text: z.string().min(1).max(100000),
      })
      .strict()
      .safeParse(action.args);
    if (!parsed.success) throw new IntegrationError("validation", "E-Mail-Argumente sind ungültig.");
    const secret = await this.check(action, "mail.send");
    const transport = nodemailer.createTransport({
      host: this.connection.host,
      port: this.connection.port,
      secure: this.connection.tlsMode === "implicit" || (!this.connection.tlsMode && this.connection.port === 465),
      requireTLS: true,
      tls: {
        rejectUnauthorized: true,
        ...(this.connection.tlsCaFile ? { ca: await readFile(this.connection.tlsCaFile) } : {}),
      },
      auth: this.connection.oauth
        ? { type: "OAuth2", user: this.connection.username, accessToken: secret }
        : { user: this.connection.username, pass: secret },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000,
      logger: false,
      debug: false,
    });
    try {
      await this.authorize(structuredClone(action));
    } catch (error) {
      transport.close();
      throw error;
    }
    try {
      const info = await transport.sendMail({
        from: this.connection.from,
        to: parsed.data.to,
        subject: parsed.data.subject,
        text: parsed.data.text,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!info.messageId || info.accepted.length === 0)
        throw new IntegrationError("provider", "SMTP hat keine Empfängerannahme bestätigt.", "effect_unknown");
      return redact(
        {
          observedAt: new Date().toISOString(),
          effectStatus: "accepted",
          externalId: info.messageId,
          evidenceRefs: [],
          data: { accepted: info.accepted, rejected: info.rejected, delivered: false },
        },
        [secret],
      );
    } catch {
      throw new IntegrationError(
        "transport",
        "SMTP-Versand ist fehlgeschlagen oder seine Wirkung ist unklar.",
        "effect_unknown",
      );
    } finally {
      transport.close();
    }
  }
  async read(action: AuthorizedIntegrationAction): Promise<IntegrationResult> {
    const parsed = z
      .object({ limit: z.number().int().min(1).max(100).default(20) })
      .strict()
      .safeParse(action.args);
    if (!parsed.success) throw new IntegrationError("validation", "IMAP-Argumente sind ungültig.");
    const secret = await this.check(action, "mail.read");
    const client = new ImapFlow({
      host: this.connection.host,
      port: this.connection.port,
      secure: this.connection.tlsMode !== "starttls",
      ...(this.connection.tlsMode === "starttls" ? { doSTARTTLS: true } : {}),
      auth: this.connection.oauth
        ? { user: this.connection.username, accessToken: secret }
        : { user: this.connection.username, pass: secret },
      tls: {
        rejectUnauthorized: true,
        ...(this.connection.tlsCaFile ? { ca: await readFile(this.connection.tlsCaFile) } : {}),
      },
      logger: false,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
    });
    await this.authorize(structuredClone(action));
    try {
      await client.connect();
      const lock = await client.getMailboxLock(this.connection.mailbox ?? "INBOX");
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new IntegrationError("provider", "Mailbox wurde nicht geöffnet.");
        const count = mailbox.exists;
        const messages: unknown[] = [];
        if (count > 0)
          for await (const message of client.fetch(`${Math.max(1, count - parsed.data.limit + 1)}:*`, {
            uid: true,
            envelope: true,
            internalDate: true,
          }))
            messages.push({
              externalId: `${mailbox.uidValidity}:${message.uid}`,
              envelope: message.envelope,
              receivedAt: message.internalDate,
              identityVerified: false,
            });
        return redact(
          {
            observedAt: new Date().toISOString(),
            effectStatus: "succeeded",
            evidenceRefs: [],
            data: { messages, mailbox: this.connection.mailbox ?? "INBOX" },
          },
          [secret],
        );
      } finally {
        lock.release();
      }
    } catch {
      throw new IntegrationError("transport", "IMAP-Abruf fehlgeschlagen. Zugang und Verbindung prüfen.");
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
  /** Read-only UID-window ingestion. Callback must durably persist each message before resolving. */
  async pollInbound(
    action: AuthorizedIntegrationAction,
    input: MailPollOptions,
    onMessage: (message: InboundMail) => Promise<void>,
  ): Promise<MailPollResult> {
    const options = mailPollOptionsSchema.parse(input),
      secret = await this.check(action, "mail.read");
    const client = new ImapFlow({
      host: this.connection.host,
      port: this.connection.port,
      secure: this.connection.tlsMode !== "starttls",
      ...(this.connection.tlsMode === "starttls" ? { doSTARTTLS: true } : {}),
      auth: this.connection.oauth
        ? { user: this.connection.username, accessToken: secret }
        : { user: this.connection.username, pass: secret },
      tls: {
        rejectUnauthorized: true,
        ...(this.connection.tlsCaFile ? { ca: await readFile(this.connection.tlsCaFile) } : {}),
      },
      logger: false,
      emitLogs: false,
      logRaw: false,
      disableAutoIdle: true,
      disableCompression: true,
      maxLineLength: 64 * 1024,
      maxLiteralSize: options.maxMessageBytes + 1,
      maxResponseSize: options.maxMessageBytes + 128 * 1024,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
    });
    client.on("error", () => {});
    const timer = setTimeout(() => client.close(), 60000);
    let callbackError: unknown;
    try {
      await this.authorize(structuredClone(action));
      await client.connect();
      const mailboxName = this.connection.mailbox ?? "INBOX",
        lock = await client.getMailboxLock(mailboxName, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox || !mailbox.uidValidity || !Number.isSafeInteger(mailbox.uidNext) || mailbox.uidNext < 1)
          throw new IntegrationError("provider", "IMAP-UID-Metadaten fehlen.");
        const uidValidity = String(mailbox.uidValidity),
          changed = !!options.cursor && options.cursor.uidValidity !== uidValidity;
        let lastUid = !changed && options.cursor ? options.cursor.lastUid : 0;
        if (lastUid > mailbox.uidNext - 1)
          throw new IntegrationError("conflict", "IMAP-UID-Cursor liegt vor dem Serverzustand.");
        const end = Math.min(mailbox.uidNext - 1, lastUid + 1000),
          result: MailPollResult = {
            cursor: { uidValidity, lastUid },
            received: 0,
            rejected: 0,
            uidValidityChanged: changed,
            more: end < mailbox.uidNext - 1,
          };
        if (end <= lastUid) return result;
        await this.authorize(structuredClone(action));
        const rows = await client.fetchAll(
          `${lastUid + 1}:${end}`,
          { uid: true, size: true, internalDate: true },
          { uid: true },
        );
        if (
          rows.length > 1000 ||
          new Set(rows.map((row) => row.uid)).size !== rows.length ||
          rows.some((m) => !Number.isInteger(m.uid) || m.uid <= lastUid || m.uid > end)
        )
          throw new IntegrationError("provider", "IMAP-Server lieferte unerwartete UIDs.");
        let bytes = 0;
        for (const row of rows.sort((a, b) => a.uid - b.uid).slice(0, options.limit)) {
          if (row.size === undefined || !Number.isSafeInteger(row.size) || row.size < 0)
            throw new IntegrationError("provider", "IMAP-Nachrichtengröße fehlt.");
          if (row.size <= options.maxMessageBytes && bytes + row.size > options.maxBatchBytes) {
            result.more = true;
            return result;
          }
          await this.authorize(structuredClone(action));
          const base = {
            id: inboundMailId(this.connection.id, this.connection.scope, mailboxName, uidValidity, row.uid),
            targetId: this.connection.id,
            scope: structuredClone(this.connection.scope),
            mailbox: mailboxName,
            uidValidity,
            uid: row.uid,
            receivedAt: row.internalDate instanceof Date ? row.internalDate.toISOString() : new Date().toISOString(),
            identityVerified: false as const,
            authority: "untrusted_external_content" as const,
            declaredBytes: row.size,
          };
          let message: InboundMail;
          if (row.size > options.maxMessageBytes)
            message = { ...base, state: "rejected", rejection: "message_too_large", attachments: [] };
          else {
            const full = await client.fetchOne(
              String(row.uid),
              { uid: true, source: { start: 0, maxLength: options.maxMessageBytes + 1 } },
              { uid: true },
            );
            if (
              !full ||
              full.uid !== row.uid ||
              !full.source ||
              full.source.length !== row.size ||
              full.source.length > options.maxMessageBytes
            )
              throw new IntegrationError("provider", "IMAP-Originalnachricht fehlt, ist unvollständig oder zu groß.");
            bytes += full.source.length;
            message = await parseInboundMail(base, full.source);
          }
          await this.authorize(structuredClone(action));
          try {
            await onMessage(message);
          } catch (error) {
            callbackError = error;
            throw error;
          }
          lastUid = row.uid;
          result.cursor.lastUid = lastUid;
          if (message.state === "received") result.received++;
          else result.rejected++;
        }
        if (rows.length > options.limit) result.more = true;
        else result.cursor.lastUid = end;
        return result;
      } finally {
        lock.release();
      }
    } catch (error) {
      if (callbackError) throw callbackError;
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(
        "transport",
        "IMAP-Aufnahme abgebrochen. Cursor nicht vor unbestätigte Nachrichten setzen.",
      );
    } finally {
      clearTimeout(timer);
      client.close();
    }
  }
}
