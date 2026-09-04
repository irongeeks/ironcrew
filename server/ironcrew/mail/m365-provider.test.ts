import { describe, it, expect, vi } from "vitest";
import { M365Provider } from "./m365-provider.ts";
import type { MailboxContext } from "./mail-provider.ts";
import type { MailboxRow } from "../domain/mailbox-store.ts";

function mailbox(): MailboxRow {
  return {
    id: "mbx_1",
    company_id: "cmp_1",
    label: "M365",
    kind: "m365",
    email_address: "team@example.com",
    host: "",
    port: 0,
    use_tls: 1,
    username: "",
    smtp_host: "",
    smtp_port: 0,
    session_url: "",
    tenant_id: "tenant-1",
    client_id: "client-1",
    poll_enabled: 0,
    poll_interval_seconds: 300,
    auto_triage: 0,
    last_polled_at: null,
    last_error: "",
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

/** Answers the token endpoint, then delegates everything else to `handler`. */
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }, calls: Call[]) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/oauth2/v2.0/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "at-1", expires_in: 3600 }),
        text: async () => "",
      } as Response;
    }
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
}

function ctx(over: Partial<MailboxContext> = {}): MailboxContext {
  return { mailbox: mailbox(), credentials: { clientSecret: "s3cret" }, ...over };
}

describe("M365Provider", () => {
  it("mints a client-credentials token and lists inbox messages", async () => {
    const calls: Call[] = [];
    const provider = new M365Provider({
      fetchImpl: fakeFetch(
        () => ({
          status: 200,
          body: {
            value: [
              {
                id: "AAMk1",
                internetMessageId: "<m1@example.com>",
                subject: "Angebot",
                from: { emailAddress: { address: "kunde@example.com" } },
                toRecipients: [{ emailAddress: { address: "team@example.com" } }],
                receivedDateTime: "2026-02-01T10:00:00Z",
                isRead: false,
                bodyPreview: "Bitte um  ein   Angebot",
              },
            ],
          },
        }),
        calls,
      ),
    });

    const messages = await provider.listMessages(ctx(), { limit: 5 });

    const tokenCall = calls.find((c) => c.url.includes("/oauth2/v2.0/token"))!;
    expect(tokenCall.url).toContain("tenant-1");
    expect(String(tokenCall.init?.body)).toContain("grant_type=client_credentials");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      externalId: "AAMk1",
      messageId: "<m1@example.com>",
      subject: "Angebot",
      from: "kunde@example.com",
      unread: true,
    });
    // Whitespace in the preview is collapsed by the shared snippet helper.
    expect(messages[0].snippet).toBe("Bitte um ein Angebot");
    expect(calls.some((c) => c.url.includes("mailFolders/inbox/messages"))).toBe(true);
  });

  it("passes a since filter to Graph as an OData receivedDateTime filter", async () => {
    const calls: Call[] = [];
    const provider = new M365Provider({ fetchImpl: fakeFetch(() => ({ status: 200, body: { value: [] } }), calls) });
    await provider.listMessages(ctx(), { since: Date.parse("2026-02-01T00:00:00Z") });
    const listCall = calls.find((c) => c.url.includes("messages?"))!;
    expect(decodeURIComponent(listCall.url)).toContain("receivedDateTime ge 2026-02-01T00:00:00.000Z");
  });

  it("caches the access token across calls instead of re-minting it", async () => {
    const calls: Call[] = [];
    const saveCredentials = vi.fn();
    const provider = new M365Provider({ fetchImpl: fakeFetch(() => ({ status: 200, body: { value: [] } }), calls) });
    const context = ctx({ saveCredentials });

    await provider.listMessages(context);
    await provider.listMessages(context);

    expect(calls.filter((c) => c.url.includes("/token"))).toHaveLength(1);
    expect(saveCredentials).toHaveBeenCalledTimes(1);
    expect(saveCredentials.mock.calls[0][0].accessToken).toBe("at-1");
  });

  it("reads a message body and reports html separately", async () => {
    const calls: Call[] = [];
    const provider = new M365Provider({
      fetchImpl: fakeFetch(
        () => ({
          status: 200,
          body: {
            id: "AAMk1",
            subject: "Angebot",
            from: { emailAddress: { address: "kunde@example.com" } },
            body: { contentType: "html", content: "<p>Hallo</p>" },
          },
        }),
        calls,
      ),
    });
    const body = await provider.getMessage(ctx(), "AAMk1");
    expect(body?.html).toBe("<p>Hallo</p>");
    expect(body?.summary.subject).toBe("Angebot");
  });

  it("returns null for a message Graph reports as gone", async () => {
    const provider = new M365Provider({ fetchImpl: fakeFetch(() => ({ status: 404, body: {} }), []) });
    expect(await provider.getMessage(ctx(), "missing")).toBeNull();
  });

  it("sends through Graph sendMail and keeps a copy in Sent Items", async () => {
    const calls: Call[] = [];
    const provider = new M365Provider({ fetchImpl: fakeFetch(() => ({ status: 202, body: {} }), calls) });

    await provider.send(ctx(), { to: ["kunde@example.com"], subject: "Antwort", text: "Gern.", inReplyTo: "<m1@x>" });

    const sendCall = calls.find((c) => c.url.endsWith("/sendMail"))!;
    const payload = JSON.parse(String(sendCall.init?.body)) as {
      message: {
        subject: string;
        toRecipients: Array<{ emailAddress: { address: string } }>;
        internetMessageHeaders?: Array<{ name: string; value: string }>;
      };
      saveToSentItems: boolean;
    };
    expect(payload.message.subject).toBe("Antwort");
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("kunde@example.com");
    expect(payload.message.internetMessageHeaders?.[0]).toEqual({ name: "In-Reply-To", value: "<m1@x>" });
    expect(payload.saveToSentItems).toBe(true);
  });

  it("surfaces a Graph error rather than swallowing it", async () => {
    const provider = new M365Provider({
      fetchImpl: fakeFetch(() => ({ status: 403, body: { error: { message: "Access denied" } } }), []),
    });
    await expect(provider.listMessages(ctx())).rejects.toThrow(/403/);
  });

  it("testConnection probes the inbox folder without sending", async () => {
    const calls: Call[] = [];
    const provider = new M365Provider({
      fetchImpl: fakeFetch(() => ({ status: 200, body: { displayName: "Posteingang", totalItemCount: 12 } }), calls),
    });
    const status = await provider.testConnection(ctx());
    expect(status.ok).toBe(true);
    expect(status.message).toContain("Posteingang");
    expect(calls.some((c) => c.url.includes("/sendMail"))).toBe(false);
  });

  it("says plainly when no credential can mint a token", async () => {
    const provider = new M365Provider({ fetchImpl: fakeFetch(() => ({ status: 200, body: {} }), []) });
    const status = await provider.testConnection(ctx({ credentials: {} }));
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/no refresh token/i);
  });
});
