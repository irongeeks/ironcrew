/**
 * IronCrew — Discord NotificationChannel.
 *
 * Uses a Discord "Incoming Webhook" (Server Settings -> Integrations ->
 * Webhooks) — a single POST to a channel-scoped URL, no bot process, no
 * gateway connection. Discord webhook URLs also answer GET with the
 * webhook's own metadata, which testConnection() uses to prove reachability
 * without ever posting a message.
 */

import type { ChannelConnectionStatus, ChannelMessage, NotificationChannel } from "./notification-channel.ts";

export interface DiscordChannelOptions {
  /** Full webhook URL, e.g. "https://discord.com/api/webhooks/<id>/<token>". */
  webhookUrl: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const SEVERITY_EMOJI: Record<ChannelMessage["severity"], string> = { info: "🔵", warning: "🟡", critical: "🔴" };
// Discord message content is capped at 2000 characters.
const MAX_CONTENT_LENGTH = 2000;

export class DiscordChannel implements NotificationChannel {
  readonly kind = "discord" as const;

  private readonly webhookUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DiscordChannelOptions) {
    this.webhookUrl = opts.webhookUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: ChannelMessage): Promise<void> {
    const content = `${SEVERITY_EMOJI[message.severity]} **${message.title}**\n${message.body}`.slice(
      0,
      MAX_CONTENT_LENGTH,
    );
    const res = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      throw new Error(`Discord webhook returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  async testConnection(): Promise<ChannelConnectionStatus> {
    try {
      const res = await this.fetchImpl(this.webhookUrl, { method: "GET" });
      if (!res.ok) return { ok: false, message: `Discord-Webhook antwortet mit ${res.status}.` };
      const data = (await res.json()) as { name?: string };
      return { ok: true, message: `Webhook "${data.name ?? "unbenannt"}" erreichbar.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
