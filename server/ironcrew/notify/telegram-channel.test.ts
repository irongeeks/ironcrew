import { describe, it, expect } from "vitest";
import { TelegramChannel } from "./telegram-channel.ts";

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
}

describe("TelegramChannel", () => {
  it("posts an escaped MarkdownV2 message to sendMessage", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const channel = new TelegramChannel({
      botToken: "123:abc",
      chatId: "42",
      fetchImpl: fakeFetch((url, init) => {
        calls.push({ url, init });
        return { status: 200, body: { ok: true, result: {} } };
      }),
    });

    await channel.send({ title: "Freigabe (dringend!)", body: "4.500 EUR", severity: "warning" });

    expect(calls[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const payload = JSON.parse(String(calls[0].init?.body)) as { chat_id: string; text: string };
    expect(payload.chat_id).toBe("42");
    // Reserved MarkdownV2 characters ( and ) and ! must be escaped.
    expect(payload.text).toContain("Freigabe \\(dringend\\!\\)");
    expect(payload.text).toContain("🟡");
  });

  it("throws with the API's own description when sendMessage fails", async () => {
    const channel = new TelegramChannel({
      botToken: "bad",
      chatId: "42",
      fetchImpl: fakeFetch(() => ({ status: 400, body: { ok: false, description: "chat not found" } })),
    });
    await expect(channel.send({ title: "x", body: "y", severity: "info" })).rejects.toThrow(/chat not found/);
  });

  it("testConnection reports ok and the bot's username via getMe", async () => {
    const channel = new TelegramChannel({
      botToken: "123:abc",
      chatId: "42",
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe("https://api.telegram.org/bot123:abc/getMe");
        return { status: 200, body: { ok: true, result: { username: "ironcrew_bot" } } };
      }),
    });
    const status = await channel.testConnection();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("ironcrew_bot");
  });

  it("testConnection reports not-ok for an invalid token", async () => {
    const channel = new TelegramChannel({
      botToken: "invalid",
      chatId: "42",
      fetchImpl: fakeFetch(() => ({ status: 401, body: { ok: false, description: "Unauthorized" } })),
    });
    const status = await channel.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toBe("Unauthorized");
  });
});
