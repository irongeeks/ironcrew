import { describe, it, expect } from "vitest";
import { JmapProvider } from "./jmap-provider.ts";
import type { MailboxContext } from "./mail-provider.ts";
import type { MailboxRow } from "../domain/mailbox-store.ts";

function mailbox(): MailboxRow {
  return {
    id: "mbx_1",
    company_id: "cmp_1",
    label: "JMAP",
    kind: "jmap",
    email_address: "team@example.com",
    host: "",
    port: 0,
    use_tls: 1,
    username: "",
    smtp_host: "",
    smtp_port: 0,
    session_url: "https://jmap.example.com/.well-known/jmap",
    tenant_id: "",
    client_id: "",
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

type MethodResponse = [string, Record<string, unknown>, string];

/** Answers the session resource, then delegates API POSTs to `handler`. */
function fakeFetch(handler: (calls: MethodResponse[]) => MethodResponse[], calls: Call[], sessionOk = true) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes(".well-known/jmap")) {
      return {
        ok: sessionOk,
        status: sessionOk ? 200 : 401,
        json: async () => ({
          apiUrl: "https://jmap.example.com/api/",
          primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
        }),
        text: async () => "",
      } as Response;
    }
    const body = JSON.parse(String(init?.body)) as { methodCalls: MethodResponse[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({ methodResponses: handler(body.methodCalls) }),
      text: async () => "",
    } as Response;
  }) as typeof fetch;
}

function ctx(over: Partial<MailboxContext> = {}): MailboxContext {
  return { mailbox: mailbox(), credentials: { bearerToken: "tok-1" }, ...over };
}

const email = {
  id: "e1",
  messageId: ["<m1@example.com>"],
  subject: "Angebot",
  from: [{ email: "kunde@example.com", name: "Kunde" }],
  to: [{ email: "team@example.com" }],
  receivedAt: "2026-02-01T10:00:00Z",
  preview: "Bitte um ein Angebot",
  keywords: {},
};

describe("JmapProvider", () => {
  it("resolves the session, then queries and fetches emails in one batch", async () => {
    const calls: Call[] = [];
    const provider = new JmapProvider({
      fetchImpl: fakeFetch(
        () => [
          ["Email/query", { ids: ["e1"] }, "0"],
          ["Email/get", { list: [email] }, "1"],
        ],
        calls,
      ),
    });

    const messages = await provider.listMessages(ctx(), { limit: 10 });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      externalId: "e1",
      messageId: "<m1@example.com>",
      subject: "Angebot",
      from: "kunde@example.com",
      unread: true,
    });

    const apiCall = calls.find((c) => c.url.endsWith("/api/"))!;
    const sent = JSON.parse(String(apiCall.init?.body)) as { using: string[]; methodCalls: MethodResponse[] };
    expect(sent.using).toContain("urn:ietf:params:jmap:mail");
    // The Email/get call back-references the query rather than round-tripping ids.
    expect(sent.methodCalls[1][1]["#ids"]).toEqual({ resultOf: "0", name: "Email/query", path: "/ids" });
  });

  it("treats the $seen keyword as read", async () => {
    const provider = new JmapProvider({
      fetchImpl: fakeFetch(
        () => [
          ["Email/query", { ids: ["e1"] }, "0"],
          ["Email/get", { list: [{ ...email, keywords: { $seen: true } }] }, "1"],
        ],
        [],
      ),
    });
    const [message] = await provider.listMessages(ctx());
    expect(message.unread).toBe(false);
  });

  it("caches the session resource instead of re-fetching it per call", async () => {
    const calls: Call[] = [];
    const provider = new JmapProvider({
      fetchImpl: fakeFetch(
        () => [
          ["Email/query", { ids: [] }, "0"],
          ["Email/get", { list: [] }, "1"],
        ],
        calls,
      ),
    });
    const context = ctx();
    await provider.listMessages(context);
    await provider.listMessages(context);
    expect(calls.filter((c) => c.url.includes(".well-known"))).toHaveLength(1);
  });

  it("reads a body out of bodyValues", async () => {
    const provider = new JmapProvider({
      fetchImpl: fakeFetch(
        () => [
          [
            "Email/get",
            {
              list: [
                {
                  ...email,
                  textBody: [{ partId: "1" }],
                  htmlBody: [{ partId: "2" }],
                  bodyValues: { "1": { value: "Bitte um ein Angebot." }, "2": { value: "<p>Bitte</p>" } },
                },
              ],
            },
            "0",
          ],
        ],
        [],
      ),
    });
    const body = await provider.getMessage(ctx(), "e1");
    expect(body?.text).toBe("Bitte um ein Angebot.");
    expect(body?.html).toBe("<p>Bitte</p>");
  });

  it("returns null when the id is not in the account", async () => {
    const provider = new JmapProvider({ fetchImpl: fakeFetch(() => [["Email/get", { list: [] }, "0"]], []) });
    expect(await provider.getMessage(ctx(), "missing")).toBeNull();
  });

  it("sends by creating a draft and submitting it through a matching identity", async () => {
    const calls: Call[] = [];
    const provider = new JmapProvider({
      fetchImpl: fakeFetch((methodCalls) => {
        if (methodCalls[0][0] === "Identity/get") {
          return [
            ["Identity/get", { list: [{ id: "id-1", email: "team@example.com" }] }, "i"],
            [
              "Mailbox/get",
              {
                list: [
                  { id: "mb-drafts", role: "drafts" },
                  { id: "mb-sent", role: "sent" },
                ],
              },
              "m",
            ],
          ];
        }
        return [
          ["Email/set", { created: { draft: { id: "e-new" } } }, "0"],
          ["EmailSubmission/set", { created: { submission: { id: "s1" } } }, "1"],
        ];
      }, calls),
    });

    await provider.send(ctx(), { to: ["kunde@example.com"], subject: "Antwort", text: "Gern.", inReplyTo: "<m1@x>" });

    const submitCall = calls.at(-1)!;
    const sent = JSON.parse(String(submitCall.init?.body)) as { methodCalls: MethodResponse[] };
    const emailSet = sent.methodCalls[0][1] as { create: { draft: Record<string, unknown> } };
    expect(emailSet.create.draft.mailboxIds).toEqual({ "mb-drafts": true });
    expect(emailSet.create.draft.inReplyTo).toEqual(["<m1@x>"]);

    const submission = sent.methodCalls[1][1] as {
      create: { submission: { emailId: string; identityId: string } };
      onSuccessUpdateEmail: Record<string, Record<string, unknown>>;
    };
    expect(submission.create.submission).toEqual({ emailId: "#draft", identityId: "id-1" });
    // Sent mail must stop being a draft and move to Sent.
    expect(submission.onSuccessUpdateEmail["#submission"]["keywords/$draft"]).toBeNull();
    expect(submission.onSuccessUpdateEmail["#submission"]["mailboxIds/mb-sent"]).toBe(true);
  });

  it("refuses to send when the account exposes no drafts mailbox", async () => {
    const provider = new JmapProvider({
      fetchImpl: fakeFetch(
        () => [
          ["Identity/get", { list: [{ id: "id-1", email: "team@example.com" }] }, "i"],
          ["Mailbox/get", { list: [{ id: "mb-inbox", role: "inbox" }] }, "m"],
        ],
        [],
      ),
    });
    await expect(provider.send(ctx(), { to: ["x@example.com"], subject: "s", text: "t" })).rejects.toThrow(/drafts/);
  });

  it("surfaces a JMAP method-level error", async () => {
    const provider = new JmapProvider({
      fetchImpl: fakeFetch(() => [["error", { type: "accountNotFound" }, "0"]], []),
    });
    await expect(provider.listMessages(ctx())).rejects.toThrow(/accountNotFound/);
  });

  it("says plainly when no bearer token is stored", async () => {
    const provider = new JmapProvider({ fetchImpl: fakeFetch(() => [], []) });
    const status = await provider.testConnection(ctx({ credentials: {} }));
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/no JMAP bearer token/);
  });

  it("testConnection proves mail methods work, not just the session", async () => {
    const calls: Call[] = [];
    const provider = new JmapProvider({
      fetchImpl: fakeFetch(() => [["Mailbox/get", { list: [{ id: "mb-inbox", role: "inbox" }] }, "0"]], calls),
    });
    const status = await provider.testConnection(ctx());
    expect(status.ok).toBe(true);
    expect(status.message).toContain("acc-1");
    const apiCall = calls.find((c) => c.url.endsWith("/api/"))!;
    expect(String(apiCall.init?.body)).toContain("Mailbox/get");
  });
});
