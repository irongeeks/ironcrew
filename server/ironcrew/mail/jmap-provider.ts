/**
 * IronCrew — JMAP MailProvider (RFC 8620 core, RFC 8621 mail).
 *
 * Plain HTTPS + JSON, so no client library: fetch the session resource to
 * learn the API URL and account id, then batch method calls. Works against
 * Fastmail, Stalwart, Cyrus and anything else that speaks JMAP.
 *
 * Sending is a genuine `EmailSubmission/set` — draft created with
 * `Email/set`, submitted through the identity that matches the mailbox
 * address, then moved to Sent via `onSuccessUpdateEmail`. That is more
 * round-trips than handing the message to SMTP, but it is what JMAP
 * actually specifies, and it keeps the sent copy where the user's other
 * clients expect it.
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

const CAPABILITY_CORE = "urn:ietf:params:jmap:core";
const CAPABILITY_MAIL = "urn:ietf:params:jmap:mail";
const CAPABILITY_SUBMISSION = "urn:ietf:params:jmap:submission";

export interface JmapProviderOptions {
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface JmapSession {
  apiUrl?: string;
  primaryAccounts?: Record<string, string>;
}

interface JmapAddress {
  name?: string;
  email?: string;
}

interface JmapEmail {
  id?: string;
  messageId?: string[];
  subject?: string;
  from?: JmapAddress[];
  to?: JmapAddress[];
  receivedAt?: string;
  preview?: string;
  keywords?: Record<string, boolean>;
  bodyValues?: Record<string, { value?: string }>;
  textBody?: Array<{ partId?: string }>;
  htmlBody?: Array<{ partId?: string }>;
}

type MethodCall = [string, Record<string, unknown>, string];

function toSummary(email: JmapEmail): MailMessageSummary {
  const received = email.receivedAt ? Date.parse(email.receivedAt) : NaN;
  return {
    externalId: email.id ?? "",
    messageId: email.messageId?.[0] ?? "",
    subject: email.subject ?? "",
    from: email.from?.[0]?.email ?? "",
    to: (email.to ?? []).map((a) => a.email ?? "").filter(Boolean),
    receivedAt: Number.isNaN(received) ? null : received,
    snippet: snippetOf(email.preview ?? ""),
    // JMAP models "read" as the presence of the $seen keyword.
    unread: !(email.keywords?.["$seen"] ?? false),
  };
}

export class JmapProvider implements MailProvider {
  readonly kind = "jmap" as const;

  private readonly fetchImpl: typeof fetch;
  /** Session resources are stable per mailbox; cached per instance, keyed by mailbox id. */
  private readonly sessions = new Map<string, { apiUrl: string; accountId: string }>();

  constructor(opts: JmapProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private authHeader(ctx: MailboxContext): string {
    const token = ctx.credentials.bearerToken ?? ctx.credentials.accessToken;
    if (!token) throw new MailProviderError(`Mailbox "${ctx.mailbox.label}" has no JMAP bearer token stored.`);
    return `Bearer ${token}`;
  }

  private async session(ctx: MailboxContext): Promise<{ apiUrl: string; accountId: string }> {
    const cached = this.sessions.get(ctx.mailbox.id);
    if (cached) return cached;

    const res = await this.fetchImpl(ctx.mailbox.session_url, {
      headers: { Authorization: this.authHeader(ctx), Accept: "application/json" },
    });
    if (!res.ok) throw new MailProviderError(`JMAP session request failed (${res.status}).`);
    const session = (await res.json()) as JmapSession;

    const apiUrl = session.apiUrl;
    const accountId = session.primaryAccounts?.[CAPABILITY_MAIL];
    if (!apiUrl || !accountId) {
      throw new MailProviderError("JMAP session did not advertise a mail account — is the token scoped for mail?");
    }
    const resolved = { apiUrl: new URL(apiUrl, ctx.mailbox.session_url).toString(), accountId };
    this.sessions.set(ctx.mailbox.id, resolved);
    return resolved;
  }

  /** One batched JMAP request; returns the method responses in order. */
  private async request(
    ctx: MailboxContext,
    using: string[],
    methodCalls: MethodCall[],
  ): Promise<Array<[string, Record<string, unknown>, string]>> {
    const { apiUrl } = await this.session(ctx);
    const res = await this.fetchImpl(apiUrl, {
      method: "POST",
      headers: { Authorization: this.authHeader(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new MailProviderError(`JMAP request failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { methodResponses?: Array<[string, Record<string, unknown>, string]> };
    const responses = data.methodResponses ?? [];
    const error = responses.find(([name]) => name === "error");
    if (error) throw new MailProviderError(`JMAP error: ${JSON.stringify(error[1]).slice(0, 300)}`);
    return responses;
  }

  async listMessages(ctx: MailboxContext, opts: ListMessagesOptions = {}): Promise<MailMessageSummary[]> {
    const { accountId } = await this.session(ctx);
    const filter: Record<string, unknown> = { inMailbox: null };
    // A null mailbox filter means "everything"; JMAP wants the key absent.
    delete filter.inMailbox;
    if (opts.since) filter.after = new Date(opts.since).toISOString();

    const responses = await this.request(
      ctx,
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      [
        [
          "Email/query",
          {
            accountId,
            ...(Object.keys(filter).length > 0 ? { filter } : {}),
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: boundedLimit(opts.limit),
          },
          "0",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
            properties: ["id", "messageId", "subject", "from", "to", "receivedAt", "preview", "keywords"],
          },
          "1",
        ],
      ],
    );

    const get = responses.find(([, , id]) => id === "1");
    const list = (get?.[1]?.list ?? []) as JmapEmail[];
    return list.map(toSummary);
  }

  async getMessage(ctx: MailboxContext, externalId: string): Promise<MailMessageBody | null> {
    const { accountId } = await this.session(ctx);
    const responses = await this.request(
      ctx,
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      [
        [
          "Email/get",
          {
            accountId,
            ids: [externalId],
            properties: [
              "id",
              "messageId",
              "subject",
              "from",
              "to",
              "receivedAt",
              "preview",
              "keywords",
              "textBody",
              "htmlBody",
              "bodyValues",
            ],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
          },
          "0",
        ],
      ],
    );

    const email = ((responses[0]?.[1]?.list ?? []) as JmapEmail[])[0];
    if (!email) return null;

    const bodyValue = (parts?: Array<{ partId?: string }>): string => {
      const partId = parts?.[0]?.partId;
      return (partId && email.bodyValues?.[partId]?.value) || "";
    };
    const text = bodyValue(email.textBody);
    return { summary: toSummary(email), text, html: bodyValue(email.htmlBody) };
  }

  async send(ctx: MailboxContext, mail: OutgoingMail): Promise<void> {
    const { accountId } = await this.session(ctx);

    // Identity and the Drafts/Sent mailboxes have to be resolved first:
    // JMAP submits *an existing email* through *a known identity*.
    const setup = await this.request(
      ctx,
      [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
      [
        ["Identity/get", { accountId }, "i"],
        ["Mailbox/get", { accountId, properties: ["id", "role", "name"] }, "m"],
      ],
    );

    const identities = (setup.find(([, , id]) => id === "i")?.[1]?.list ?? []) as Array<{
      id?: string;
      email?: string;
    }>;
    const identity =
      identities.find((i) => i.email?.toLowerCase() === ctx.mailbox.email_address.toLowerCase()) ?? identities[0];
    if (!identity?.id) throw new MailProviderError("JMAP account has no identity to send from.");

    const mailboxes = (setup.find(([, , id]) => id === "m")?.[1]?.list ?? []) as Array<{ id?: string; role?: string }>;
    const roleId = (role: string): string | undefined => mailboxes.find((b) => b.role === role)?.id;
    const draftsId = roleId("drafts");
    const sentId = roleId("sent");
    if (!draftsId) throw new MailProviderError("JMAP account has no drafts mailbox to stage the message in.");

    await this.request(
      ctx,
      [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
      [
        [
          "Email/set",
          {
            accountId,
            create: {
              draft: {
                mailboxIds: { [draftsId]: true },
                keywords: { $draft: true },
                from: [{ email: ctx.mailbox.email_address }],
                to: mail.to.map((email) => ({ email })),
                subject: mail.subject,
                ...(mail.inReplyTo ? { inReplyTo: [mail.inReplyTo] } : {}),
                bodyStructure: { type: "text/plain", partId: "body" },
                bodyValues: { body: { value: mail.text } },
              },
            },
          },
          "0",
        ],
        [
          "EmailSubmission/set",
          {
            accountId,
            create: { submission: { emailId: "#draft", identityId: identity.id } },
            // Once sent it is no longer a draft; move it where the user's
            // other clients will look for it.
            onSuccessUpdateEmail: {
              "#submission": {
                "keywords/$draft": null,
                ...(sentId ? { [`mailboxIds/${sentId}`]: true, [`mailboxIds/${draftsId}`]: null } : {}),
              },
            },
          },
          "1",
        ],
      ],
    );
  }

  async testConnection(ctx: MailboxContext): Promise<MailConnectionStatus> {
    try {
      const { accountId } = await this.session(ctx);
      // Proves the token works for actual mail methods, not just the session.
      await this.request(
        ctx,
        [CAPABILITY_CORE, CAPABILITY_MAIL],
        [["Mailbox/get", { accountId, properties: ["id", "name", "role"] }, "0"]],
      );
      return { ok: true, message: `JMAP erreichbar (Konto ${accountId}).` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
