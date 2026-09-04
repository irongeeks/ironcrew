/**
 * IronCrew — Microsoft 365 (Exchange Online) MailProvider.
 *
 * Speaks Microsoft Graph over HTTPS directly — no SDK, because the three
 * calls this needs (list, get, sendMail) are ordinary REST and an SDK would
 * add a large dependency for no gain.
 *
 * Authentication takes either shape an operator is likely to have:
 *   - an app registration with application permissions (Mail.Read,
 *     Mail.Send) and a client secret → client-credentials, no user
 *     interaction, which is what an unattended crew usually wants;
 *   - a delegated refresh token → refresh_token grant.
 * `ensureAccessToken` picks whichever the mailbox actually has.
 */

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

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SELECT_FIELDS = "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,internetMessageId";

export interface M365ProviderOptions {
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Overridable for sovereign clouds; defaults to the public endpoints. */
  graphBase?: string;
  loginBase?: string;
}

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
}

/**
 * URLSearchParams encodes a space as "+", which is form-encoding, not URI
 * encoding. Graph's OData `$filter` takes literal spaces, and "+" inside a
 * filter expression is ambiguous at best — so emit unambiguous %20.
 */
function toQuery(params: URLSearchParams): string {
  return params.toString().replace(/\+/g, "%20");
}

function toSummary(message: GraphMessage): MailMessageSummary {
  const received = message.receivedDateTime ? Date.parse(message.receivedDateTime) : NaN;
  return {
    externalId: message.id,
    messageId: message.internetMessageId ?? "",
    subject: message.subject ?? "",
    from: message.from?.emailAddress?.address ?? "",
    to: (message.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
    receivedAt: Number.isNaN(received) ? null : received,
    snippet: snippetOf(message.bodyPreview ?? ""),
    unread: message.isRead === false,
  };
}

export class M365Provider implements MailProvider {
  readonly kind = "m365" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly graphBase: string;
  private readonly loginBase: string;

  constructor(opts: M365ProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.graphBase = opts.graphBase ?? GRAPH_BASE;
    this.loginBase = opts.loginBase ?? "https://login.microsoftonline.com";
  }

  private async token(ctx: MailboxContext): Promise<string> {
    return ensureAccessToken(
      ctx,
      {
        tokenUrl: `${this.loginBase}/${ctx.mailbox.tenant_id}/oauth2/v2.0/token`,
        scope: "https://graph.microsoft.com/.default",
        allowClientCredentials: true,
      },
      this.fetchImpl,
    );
  }

  /** Graph addresses a mailbox by the user it belongs to. */
  private userPath(ctx: MailboxContext): string {
    return `${this.graphBase}/users/${encodeURIComponent(ctx.mailbox.email_address)}`;
  }

  private async call(ctx: MailboxContext, url: string, init?: RequestInit): Promise<Response> {
    const token = await this.token(ctx);
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new MailProviderError(`Microsoft Graph returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
  }

  async listMessages(ctx: MailboxContext, opts: ListMessagesOptions = {}): Promise<MailMessageSummary[]> {
    const params = new URLSearchParams({
      $top: String(boundedLimit(opts.limit)),
      $select: SELECT_FIELDS,
      $orderby: "receivedDateTime desc",
    });
    if (opts.since) {
      params.set("$filter", `receivedDateTime ge ${new Date(opts.since).toISOString()}`);
    }
    const res = await this.call(ctx, `${this.userPath(ctx)}/mailFolders/inbox/messages?${toQuery(params)}`);
    const data = (await res.json()) as { value?: GraphMessage[] };
    return (data.value ?? []).map(toSummary);
  }

  async getMessage(ctx: MailboxContext, externalId: string): Promise<MailMessageBody | null> {
    const res = await this.call(
      ctx,
      `${this.userPath(ctx)}/messages/${encodeURIComponent(externalId)}?$select=${SELECT_FIELDS},body`,
    );
    if (res.status === 404) return null;
    const message = (await res.json()) as GraphMessage;
    const isHtml = message.body?.contentType?.toLowerCase() === "html";
    const content = message.body?.content ?? "";
    const text = isHtml ? snippetOf(content, 100_000) : content;
    return { summary: toSummary(message), text, html: isHtml ? content : "" };
  }

  async send(ctx: MailboxContext, mail: OutgoingMail): Promise<void> {
    await this.call(ctx, `${this.userPath(ctx)}/sendMail`, {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: "Text", content: mail.text },
          toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
          ...(mail.inReplyTo ? { internetMessageHeaders: [{ name: "In-Reply-To", value: mail.inReplyTo }] } : {}),
        },
        saveToSentItems: true,
      }),
    });
  }

  async testConnection(ctx: MailboxContext): Promise<MailConnectionStatus> {
    try {
      // A single-message probe proves token, permissions and mailbox
      // addressing at once, without sending anything.
      const res = await this.call(ctx, `${this.userPath(ctx)}/mailFolders/inbox?$select=displayName,totalItemCount`);
      if (res.status === 404) return { ok: false, message: `Postfach ${ctx.mailbox.email_address} nicht gefunden.` };
      const folder = (await res.json()) as { displayName?: string; totalItemCount?: number };
      return {
        ok: true,
        message: `Microsoft 365 erreichbar: ${folder.displayName ?? "Posteingang"} (${folder.totalItemCount ?? 0} Nachrichten)`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
