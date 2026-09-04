import { describe, it, expect } from "vitest";
import { GmailProvider } from "./gmail-provider.ts";
import type { MailboxContext } from "./mail-provider.ts";
import type { MailboxRow } from "../domain/mailbox-store.ts";

function mailbox(): MailboxRow {
  return {
    id: "mbx_1",
    company_id: "cmp_1",
    label: "Gmail",
    kind: "gmail",
    email_address: "team@example.com",
    host: "",
    port: 0,
    use_tls: 1,
    username: "",
    smtp_host: "",
    smtp_port: 0,
    session_url: "",
    tenant_id: "",
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

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }, calls: Call[]) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) {
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
  return { mailbox: mailbox(), credentials: { clientSecret: "s3cret", refreshToken: "rt-1" }, ...over };
}

describe("GmailProvider", () => {
  it("refreshes an access token, then lists inbox messages from their metadata", async () => {
    const calls: Call[] = [];
    const provider = new GmailProvider({
      fetchImpl: fakeFetch((url) => {
        if (url.includes("/messages?")) return { status: 200, body: { messages: [{ id: "g1" }] } };
        return {
          status: 200,
          body: {
            id: "g1",
            snippet: "Bitte um ein Angebot",
            internalDate: String(Date.parse("2026-02-01T10:00:00Z")),
            labelIds: ["INBOX", "UNREAD"],
            payload: {
              headers: [
                { name: "Subject", value: "Angebot" },
                { name: "From", value: "Kunde <kunde@example.com>" },
                { name: "To", value: "team@example.com" },
                { name: "Message-ID", value: "<m1@example.com>" },
              ],
            },
          },
        };
      }, calls),
    });

    const messages = await provider.listMessages(ctx(), { limit: 5 });

    const tokenCall = calls.find((c) => c.url.includes("/token"))!;
    expect(String(tokenCall.init?.body)).toContain("grant_type=refresh_token");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      externalId: "g1",
      subject: "Angebot",
      // The display name is stripped; only the bare address is kept.
      from: "kunde@example.com",
      messageId: "<m1@example.com>",
      unread: true,
    });
    expect(messages[0].receivedAt).toBe(Date.parse("2026-02-01T10:00:00Z"));
  });

  it("translates a since filter into Gmail's whole-second after: query", async () => {
    const calls: Call[] = [];
    const provider = new GmailProvider({
      fetchImpl: fakeFetch(() => ({ status: 200, body: { messages: [] } }), calls),
    });
    await provider.listMessages(ctx(), { since: 1_700_000_500_000 });
    const listCall = calls.find((c) => c.url.includes("/messages?"))!;
    expect(decodeURIComponent(listCall.url)).toContain("after:1700000500");
  });

  it("parses a raw message through mailparser", async () => {
    const raw = Buffer.from(
      ["From: kunde@example.com", "Subject: Angebot", "Message-ID: <m1@example.com>", "", "Bitte um ein Angebot."].join(
        "\r\n",
      ),
      "utf8",
    ).toString("base64url");

    const provider = new GmailProvider({
      fetchImpl: fakeFetch(() => ({ status: 200, body: { id: "g1", raw, labelIds: ["UNREAD"] } }), []),
    });
    const body = await provider.getMessage(ctx(), "g1");
    expect(body?.text).toContain("Bitte um ein Angebot.");
    expect(body?.summary.subject).toBe("Angebot");
    expect(body?.summary.from).toBe("kunde@example.com");
    expect(body?.summary.unread).toBe(true);
  });

  it("returns null for a message Gmail no longer has", async () => {
    const provider = new GmailProvider({ fetchImpl: fakeFetch(() => ({ status: 404, body: {} }), []) });
    expect(await provider.getMessage(ctx(), "gone")).toBeNull();
  });

  it("sends a base64url RFC822 message with threading headers", async () => {
    const calls: Call[] = [];
    const provider = new GmailProvider({
      fetchImpl: fakeFetch(() => ({ status: 200, body: { id: "sent-1" } }), calls),
    });

    await provider.send(ctx(), { to: ["kunde@example.com"], subject: "Antwort", text: "Gern.", inReplyTo: "<m1@x>" });

    const sendCall = calls.find((c) => c.url.endsWith("/messages/send"))!;
    const payload = JSON.parse(String(sendCall.init?.body)) as { raw: string };
    const decoded = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(decoded).toContain("From: team@example.com");
    expect(decoded).toContain("To: kunde@example.com");
    expect(decoded).toContain("Subject: Antwort");
    expect(decoded).toContain("In-Reply-To: <m1@x>");
    expect(decoded).toContain("References: <m1@x>");
    expect(decoded).toContain("Gern.");
  });

  it("surfaces a Gmail API error instead of returning an empty list", async () => {
    const provider = new GmailProvider({
      fetchImpl: fakeFetch(() => ({ status: 401, body: { error: { message: "Invalid Credentials" } } }), []),
    });
    await expect(provider.listMessages(ctx())).rejects.toThrow(/401/);
  });

  it("testConnection reads the profile without sending anything", async () => {
    const calls: Call[] = [];
    const provider = new GmailProvider({
      fetchImpl: fakeFetch(
        () => ({ status: 200, body: { emailAddress: "team@example.com", messagesTotal: 42 } }),
        calls,
      ),
    });
    const status = await provider.testConnection(ctx());
    expect(status.ok).toBe(true);
    expect(status.message).toContain("team@example.com");
    expect(calls.some((c) => c.url.includes("/send"))).toBe(false);
  });

  it("refuses plainly when no refresh token is stored — Gmail has no unattended grant", async () => {
    const provider = new GmailProvider({ fetchImpl: fakeFetch(() => ({ status: 200, body: {} }), []) });
    const status = await provider.testConnection(ctx({ credentials: { clientSecret: "s" } }));
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/no refresh token/i);
  });
});
