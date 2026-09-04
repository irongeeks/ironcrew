import { describe, it, expect, vi } from "vitest";
import { ImapProvider, type ImapClientLike } from "./imap-provider.ts";
import type { MailboxContext } from "./mail-provider.ts";
import type { MailboxRow } from "../domain/mailbox-store.ts";

function mailbox(over: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: "mbx_1",
    company_id: "cmp_1",
    label: "Support",
    kind: "imap",
    email_address: "support@example.com",
    host: "imap.example.com",
    port: 993,
    use_tls: 1,
    username: "support@example.com",
    smtp_host: "smtp.example.com",
    smtp_port: 587,
    session_url: "",
    tenant_id: "",
    client_id: "",
    poll_enabled: 0,
    poll_interval_seconds: 300,
    auto_triage: 0,
    last_polled_at: null,
    last_error: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
}

function ctx(over: Partial<MailboxContext> = {}): MailboxContext {
  return { mailbox: mailbox(), credentials: { password: "hunter2" }, ...over };
}

/** A message as ImapFlow hands it back. */
function imapMessage(uid: number, over: Record<string, unknown> = {}) {
  return {
    seq: uid,
    uid,
    envelope: {
      date: new Date("2026-02-01T10:00:00Z"),
      subject: `Betreff ${uid}`,
      messageId: `<msg-${uid}@example.com>`,
      from: [{ address: "kunde@example.com", name: "Kunde" }],
      to: [{ address: "support@example.com" }],
    },
    flags: new Set<string>(),
    ...over,
  };
}

function fakeClient(over: Partial<ImapClientLike> = {}, log: string[] = []): ImapClientLike {
  return {
    connect: vi.fn(async () => {
      log.push("connect");
    }),
    logout: vi.fn(async () => {
      log.push("logout");
    }),
    getMailboxLock: vi.fn(async () => {
      log.push("lock");
      return {
        release: () => {
          log.push("release");
        },
      };
    }),
    // eslint-disable-next-line require-yield
    fetch: vi.fn(async function* () {
      return;
    }) as unknown as ImapClientLike["fetch"],
    fetchOne: vi.fn(async () => false),
    ...over,
  } as ImapClientLike;
}

describe("ImapProvider", () => {
  it("lists messages newest-first, mapped from the IMAP envelope", async () => {
    const provider = new ImapProvider({
      clientFactory: () =>
        fakeClient({
          fetch: () =>
            (async function* () {
              // Deliberately yielded oldest-first: the provider is what
              // guarantees newest-first, not the server's order.
              yield imapMessage(1, {
                envelope: { ...imapMessage(1).envelope, date: new Date("2026-01-01T10:00:00Z") },
              });
              yield imapMessage(2);
            })() as never,
        }),
    });

    const messages = await provider.listMessages(ctx());
    expect(messages).toHaveLength(2);
    expect(messages[0].externalId).toBe("2");
    expect(messages[0].subject).toBe("Betreff 2");
    expect(messages[0].from).toBe("kunde@example.com");
    expect(messages[0].unread).toBe(true);
  });

  it("treats a message flagged \\Seen as read", async () => {
    const provider = new ImapProvider({
      clientFactory: () =>
        fakeClient({
          fetch: () =>
            (async function* () {
              yield imapMessage(7, { flags: new Set(["\\Seen"]) });
            })() as never,
        }),
    });
    const [message] = await provider.listMessages(ctx());
    expect(message.unread).toBe(false);
  });

  it("honours the since filter and the limit", async () => {
    const provider = new ImapProvider({
      clientFactory: () =>
        fakeClient({
          fetch: () =>
            (async function* () {
              yield imapMessage(1, { envelope: { ...imapMessage(1).envelope, date: new Date("2020-01-01") } });
              yield imapMessage(2);
              yield imapMessage(3);
            })() as never,
        }),
    });
    const since = await provider.listMessages(ctx(), { since: Date.parse("2026-01-01T00:00:00Z") });
    expect(since.map((m) => m.externalId).sort()).toEqual(["2", "3"]);

    const limited = await provider.listMessages(ctx(), { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("parses a fetched message body through mailparser", async () => {
    const source = Buffer.from(
      ["From: kunde@example.com", "To: support@example.com", "Subject: Angebot", "", "Bitte um ein Angebot."].join(
        "\r\n",
      ),
      "utf8",
    );
    const provider = new ImapProvider({
      clientFactory: () => fakeClient({ fetchOne: async () => imapMessage(5, { source }) as never }),
    });

    const body = await provider.getMessage(ctx(), "5");
    expect(body?.text).toContain("Bitte um ein Angebot.");
    expect(body?.summary.externalId).toBe("5");
    expect(body?.summary.snippet).toContain("Bitte um ein Angebot.");
  });

  it("returns null when the uid no longer resolves", async () => {
    const provider = new ImapProvider({ clientFactory: () => fakeClient({ fetchOne: async () => false }) });
    expect(await provider.getMessage(ctx(), "999")).toBeNull();
  });

  it("releases the mailbox lock and logs out even when the work throws", async () => {
    const log: string[] = [];
    const provider = new ImapProvider({
      clientFactory: () =>
        fakeClient(
          {
            fetch: () => {
              throw new Error("server went away");
            },
          },
          log,
        ),
    });

    await expect(provider.listMessages(ctx())).rejects.toThrow("server went away");
    expect(log).toEqual(["connect", "lock", "release", "logout"]);
  });

  it("refuses to connect a mailbox with no password stored", async () => {
    const provider = new ImapProvider({ clientFactory: () => fakeClient() });
    await expect(provider.listMessages(ctx({ credentials: {} }))).rejects.toThrow(/no IMAP password/);
  });

  it("sends over SMTP with the mailbox address as the sender", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const provider = new ImapProvider({
      clientFactory: () => fakeClient(),
      createTransport: () => ({ sendMail }) as never,
    });

    await provider.send(ctx(), { to: ["kunde@example.com"], subject: "Antwort", text: "Gern.", inReplyTo: "<m1@x>" });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "support@example.com",
        to: ["kunde@example.com"],
        subject: "Antwort",
        inReplyTo: "<m1@x>",
        references: ["<m1@x>"],
      }),
    );
  });

  it("testConnection reports ok on a clean connect, and the error otherwise", async () => {
    const good = new ImapProvider({ clientFactory: () => fakeClient() });
    expect((await good.testConnection(ctx())).ok).toBe(true);

    const bad = new ImapProvider({
      clientFactory: () =>
        fakeClient({
          connect: async () => {
            throw new Error("auth failed");
          },
        }),
    });
    const status = await bad.testConnection(ctx());
    expect(status.ok).toBe(false);
    expect(status.message).toBe("auth failed");
  });
});
