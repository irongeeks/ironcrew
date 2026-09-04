/**
 * IronCrew — IMAP MailProvider (reading) with SMTP for sending.
 *
 * Reading uses ImapFlow (MIT), sending reuses nodemailer, which this
 * project already depends on for the email notification channel. Both are
 * from the same well-maintained lineage and speak the protocols directly —
 * no vendor API in between, so this works against Dovecot, Cyrus, Mailcow,
 * Fastmail, or any other IMAP server the operator points it at.
 *
 * `clientFactory` and `createTransport` are injectable for exactly the same
 * reason VaultwardenSecretProvider injects its CliRunner: the tests here
 * exercise this class's own logic — envelope mapping, UID handling, lock
 * release, error surfacing — against a fake, without opening a socket. The
 * real client is what runs in production; nothing about the code path
 * changes between the two.
 */

import { ImapFlow, type FetchMessageObject, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import {
  boundedLimit,
  firstAddress,
  snippetOf,
  MailProviderError,
  type ListMessagesOptions,
  type MailboxContext,
  type MailConnectionStatus,
  type MailMessageBody,
  type MailMessageSummary,
  type MailProvider,
  type OutgoingMail,
} from "./mail-provider.ts";

/**
 * The slice of ImapFlow this provider actually uses. Narrow on purpose: a
 * test fake implements five members instead of the whole client, and the
 * compiler still checks the real ImapFlow satisfies it.
 */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release: () => void }>;
  fetch(
    range: string | number[],
    query: Record<string, boolean>,
    options?: { uid?: boolean },
  ): AsyncIterableIterator<FetchMessageObject>;
  fetchOne(
    seq: string | number,
    query: Record<string, boolean>,
    options?: { uid?: boolean },
  ): Promise<FetchMessageObject | false>;
}

export interface ImapProviderOptions {
  /** Injectable for tests — defaults to a real ImapFlow client. */
  clientFactory?: (options: ImapFlowOptions) => ImapClientLike;
  /** Injectable for tests — defaults to nodemailer.createTransport. */
  createTransport?: (options: SMTPTransport.Options) => Transporter<SMTPTransport.SentMessageInfo>;
  /** Which IMAP folder to read. Defaults to INBOX. */
  folder?: string;
}

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 587;

function toSummary(message: FetchMessageObject, snippet = ""): MailMessageSummary {
  const envelope = message.envelope ?? {};
  const received = envelope.date ?? (message.internalDate ? new Date(message.internalDate) : null);
  return {
    externalId: String(message.uid),
    messageId: envelope.messageId ?? "",
    subject: envelope.subject ?? "",
    from: firstAddress(envelope.from),
    to: (envelope.to ?? []).map((a) => a.address ?? "").filter(Boolean),
    receivedAt: received instanceof Date && !Number.isNaN(received.getTime()) ? received.getTime() : null,
    snippet,
    // ImapFlow exposes flags as a Set; absence of \Seen is what "unread" means.
    unread: !(message.flags?.has("\\Seen") ?? false),
  };
}

export class ImapProvider implements MailProvider {
  readonly kind = "imap" as const;

  private readonly clientFactory: (options: ImapFlowOptions) => ImapClientLike;
  private readonly createTransport: (options: SMTPTransport.Options) => Transporter<SMTPTransport.SentMessageInfo>;
  private readonly folder: string;

  constructor(opts: ImapProviderOptions = {}) {
    this.clientFactory = opts.clientFactory ?? ((options) => new ImapFlow(options) as unknown as ImapClientLike);
    this.createTransport = opts.createTransport ?? nodemailer.createTransport;
    this.folder = opts.folder ?? "INBOX";
  }

  private client(ctx: MailboxContext): ImapClientLike {
    const { mailbox, credentials } = ctx;
    if (!credentials.password && !credentials.accessToken) {
      throw new MailProviderError(`Mailbox "${mailbox.label}" has no IMAP password stored.`);
    }
    return this.clientFactory({
      host: mailbox.host,
      port: mailbox.port || DEFAULT_IMAP_PORT,
      secure: mailbox.use_tls === 1,
      auth: credentials.accessToken
        ? { user: mailbox.username, accessToken: credentials.accessToken }
        : { user: mailbox.username, pass: credentials.password },
      logger: false,
    });
  }

  /**
   * Every IMAP operation follows the same connect → lock → work → release →
   * logout shape, and the release/logout must happen even when the work
   * throws — otherwise a failed poll leaks a socket and, worse, holds the
   * mailbox lock. Centralised here so no call site can forget it.
   */
  private async withMailbox<T>(ctx: MailboxContext, work: (client: ImapClientLike) => Promise<T>): Promise<T> {
    const client = this.client(ctx);
    await client.connect();
    let lock: { release: () => void } | null = null;
    try {
      lock = await client.getMailboxLock(this.folder);
      return await work(client);
    } finally {
      lock?.release();
      await client.logout().catch(() => {
        /* the work's own result matters more than a noisy logout */
      });
    }
  }

  async listMessages(ctx: MailboxContext, opts: ListMessagesOptions = {}): Promise<MailMessageSummary[]> {
    const limit = boundedLimit(opts.limit);
    return this.withMailbox(ctx, async (client) => {
      const summaries: MailMessageSummary[] = [];
      for await (const message of client.fetch(
        // "1:*" over UIDs is every message; newest are last, so collect all
        // matching and clip after sorting rather than trusting server order.
        "1:*",
        { uid: true, envelope: true, flags: true, internalDate: true },
        { uid: true },
      )) {
        const summary = toSummary(message);
        if (opts.since && summary.receivedAt !== null && summary.receivedAt < opts.since) continue;
        summaries.push(summary);
      }
      summaries.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0));
      return summaries.slice(0, limit);
    });
  }

  async getMessage(ctx: MailboxContext, externalId: string): Promise<MailMessageBody | null> {
    return this.withMailbox(ctx, async (client) => {
      const message = await client.fetchOne(
        externalId,
        { uid: true, envelope: true, flags: true, internalDate: true, source: true },
        { uid: true },
      );
      if (!message) return null;

      // mailparser turns the raw RFC822 source into text/html without us
      // hand-rolling MIME, transfer-encoding and charset handling.
      const parsed = message.source ? await simpleParser(message.source) : null;
      const text = parsed?.text ?? "";
      const html = typeof parsed?.html === "string" ? parsed.html : "";
      return { summary: toSummary(message, snippetOf(text)), text, html };
    });
  }

  async send(ctx: MailboxContext, mail: OutgoingMail): Promise<void> {
    const { mailbox, credentials } = ctx;
    const host = mailbox.smtp_host || mailbox.host;
    if (!host) throw new MailProviderError(`Mailbox "${mailbox.label}" has no SMTP host configured.`);
    const port = mailbox.smtp_port || DEFAULT_SMTP_PORT;

    const transporter = this.createTransport({
      host,
      port,
      secure: port === 465,
      auth: mailbox.username ? { user: mailbox.username, pass: credentials.password } : undefined,
    });
    await transporter.sendMail({
      from: mailbox.email_address,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      inReplyTo: mail.inReplyTo,
      references: mail.inReplyTo ? [mail.inReplyTo] : undefined,
    });
  }

  async testConnection(ctx: MailboxContext): Promise<MailConnectionStatus> {
    try {
      await this.withMailbox(ctx, async () => undefined);
      return { ok: true, message: `IMAP erreichbar: ${ctx.mailbox.host}:${ctx.mailbox.port || DEFAULT_IMAP_PORT}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
