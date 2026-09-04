/**
 * IronCrew — Gmail MailProvider.
 *
 * Speaks the Gmail REST API directly with a user's OAuth refresh token
 * (Google has no unattended client-credentials path for consumer or
 * Workspace mailboxes without domain-wide delegation, so a refresh token is
 * the honest requirement — `ensureAccessToken` says so plainly if one is
 * missing).
 *
 * Bodies are fetched as `format=raw` and handed to mailparser, the same
 * parser the IMAP provider uses. That avoids re-implementing Gmail's
 * nested MIME-part walk and base64url decoding, and means both providers
 * produce identical text/html for the same message.
 */

import { simpleParser } from "mailparser";
import {
  boundedLimit,
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
import { ensureAccessToken } from "./oauth-mail-token.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send";

export interface GmailProviderOptions {
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
  tokenUrl?: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  raw?: string;
  payload?: { headers?: GmailHeader[] };
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** "Display Name <a@b.c>" → "a@b.c"; a bare address passes through. */
function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function toSummary(message: GmailMessage): MailMessageSummary {
  const internal = message.internalDate ? Number(message.internalDate) : NaN;
  return {
    externalId: message.id ?? "",
    messageId: header(message, "Message-ID"),
    subject: header(message, "Subject"),
    from: bareAddress(header(message, "From")),
    to: header(message, "To")
      .split(",")
      .map((a) => bareAddress(a))
      .filter(Boolean),
    receivedAt: Number.isNaN(internal) ? null : internal,
    snippet: snippetOf(message.snippet ?? ""),
    unread: (message.labelIds ?? []).includes("UNREAD"),
  };
}

/** RFC 2045 base64url, as the Gmail API expects for `raw`. */
function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class GmailProvider implements MailProvider {
  readonly kind = "gmail" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly tokenUrl: string;

  constructor(opts: GmailProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? GMAIL_BASE;
    this.tokenUrl = opts.tokenUrl ?? GOOGLE_TOKEN_URL;
  }

  private async call(ctx: MailboxContext, url: string, init?: RequestInit): Promise<Response> {
    const token = await ensureAccessToken(ctx, { tokenUrl: this.tokenUrl, scope: GMAIL_SCOPE }, this.fetchImpl);
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new MailProviderError(`Gmail API returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
  }

  async listMessages(ctx: MailboxContext, opts: ListMessagesOptions = {}): Promise<MailMessageSummary[]> {
    const params = new URLSearchParams({ maxResults: String(boundedLimit(opts.limit)), labelIds: "INBOX" });
    // Gmail's search grammar takes whole seconds, not milliseconds.
    if (opts.since) params.set("q", `after:${Math.floor(opts.since / 1000)}`);

    const listRes = await this.call(ctx, `${this.apiBase}/messages?${params.toString()}`);
    const list = (await listRes.json()) as { messages?: Array<{ id?: string }> };

    // The list endpoint returns ids only; metadata format fetches just the
    // headers we display, rather than whole bodies for a listing.
    const summaries: MailMessageSummary[] = [];
    for (const entry of list.messages ?? []) {
      if (!entry.id) continue;
      const res = await this.call(
        ctx,
        `${this.apiBase}/messages/${encodeURIComponent(entry.id)}?format=metadata` +
          "&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID",
      );
      if (res.status === 404) continue;
      summaries.push(toSummary((await res.json()) as GmailMessage));
    }
    return summaries;
  }

  async getMessage(ctx: MailboxContext, externalId: string): Promise<MailMessageBody | null> {
    const res = await this.call(ctx, `${this.apiBase}/messages/${encodeURIComponent(externalId)}?format=raw`);
    if (res.status === 404) return null;
    const message = (await res.json()) as GmailMessage;
    if (!message.raw) return null;

    const parsed = await simpleParser(Buffer.from(message.raw, "base64url"));
    const text = parsed.text ?? "";
    const html = typeof parsed.html === "string" ? parsed.html : "";
    return {
      summary: {
        externalId: message.id ?? externalId,
        messageId: parsed.messageId ?? "",
        subject: parsed.subject ?? "",
        from: parsed.from?.value?.[0]?.address ?? "",
        to: [],
        receivedAt: parsed.date ? parsed.date.getTime() : null,
        snippet: snippetOf(text),
        unread: (message.labelIds ?? []).includes("UNREAD"),
      },
      text,
      html,
    };
  }

  async send(ctx: MailboxContext, mail: OutgoingMail): Promise<void> {
    const headers = [
      `From: ${ctx.mailbox.email_address}`,
      `To: ${mail.to.join(", ")}`,
      `Subject: ${mail.subject}`,
      ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`] : []),
      'Content-Type: text/plain; charset="utf-8"',
    ];
    const raw = base64url(`${headers.join("\r\n")}\r\n\r\n${mail.text}`);
    const res = await this.call(ctx, `${this.apiBase}/messages/send`, {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    if (res.status === 404) throw new MailProviderError("Gmail rejected the send request (404).");
  }

  async testConnection(ctx: MailboxContext): Promise<MailConnectionStatus> {
    try {
      const res = await this.call(ctx, `${this.apiBase}/profile`);
      if (res.status === 404) return { ok: false, message: "Gmail-Profil nicht gefunden." };
      const profile = (await res.json()) as { emailAddress?: string; messagesTotal?: number };
      return {
        ok: true,
        message: `Gmail erreichbar: ${profile.emailAddress ?? ctx.mailbox.email_address} (${profile.messagesTotal ?? 0} Nachrichten)`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
