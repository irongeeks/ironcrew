import { describe, it, expect } from "vitest";
import { DiscordChannel } from "./discord-channel.ts";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown; isJson?: boolean },
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const { status, body, isJson = true } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (isJson ? JSON.stringify(body) : String(body)),
    } as Response;
  }) as typeof fetch;
}

describe("DiscordChannel", () => {
  it("posts a formatted message to the webhook URL", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/1/token",
      fetchImpl: fakeFetch((url, init) => {
        calls.push({ url, init });
        return { status: 204, body: "" };
      }),
    });

    await channel.send({ title: "Freigabe nötig", body: "4.500 EUR Überweisung", severity: "critical" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/1/token");
    const payload = JSON.parse(String(calls[0].init?.body)) as { content: string };
    expect(payload.content).toContain("Freigabe nötig");
    expect(payload.content).toContain("4.500 EUR Überweisung");
    expect(payload.content).toContain("🔴");
  });

  it("throws when the webhook rejects the message", async () => {
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/1/token",
      fetchImpl: fakeFetch(() => ({ status: 401, body: "Unauthorized", isJson: false })),
    });
    await expect(channel.send({ title: "x", body: "y", severity: "info" })).rejects.toThrow(/401/);
  });

  it("testConnection reports ok and the webhook name on a successful GET", async () => {
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/1/token",
      fetchImpl: fakeFetch(() => ({ status: 200, body: { name: "IronCrew Alerts" } })),
    });
    const status = await channel.testConnection();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("IronCrew Alerts");
  });

  it("testConnection reports not-ok when the webhook URL is invalid", async () => {
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/bad",
      fetchImpl: fakeFetch(() => ({ status: 404, body: "Unknown Webhook", isJson: false })),
    });
    const status = await channel.testConnection();
    expect(status.ok).toBe(false);
  });
});
