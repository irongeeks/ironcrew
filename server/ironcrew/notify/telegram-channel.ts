/**
 * IronCrew — Telegram NotificationChannel.
 *
 * Uses the Telegram Bot API directly over HTTPS (no bot framework, no
 * long-polling) — a bot token from @BotFather plus the numeric chat id to
 * post into. send() calls sendMessage; testConnection() calls getMe, which
 * proves the token is valid without ever posting.
 */

import type { ChannelConnectionStatus, ChannelMessage, NotificationChannel } from "./notification-channel.ts";

export interface TelegramChannelOptions {
  /** Bot token from @BotFather, e.g. "123456:ABC-DEF...". */
  botToken: string;
  /** Numeric chat id (a user, group or channel) sendMessage posts into. */
  chatId: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const SEVERITY_EMOJI: Record<ChannelMessage["severity"], string> = { info: "🔵", warning: "🟡", critical: "🔴" };
// MarkdownV2 requires these characters to be backslash-escaped outside of entities.
const MARKDOWN_V2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_RESERVED, (ch) => `\\${ch}`);
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: { username?: string };
}

export class TelegramChannel implements NotificationChannel {
  readonly kind = "telegram" as const;

  private readonly botToken: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramChannelOptions) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  async send(message: ChannelMessage): Promise<void> {
    const text =
      `${SEVERITY_EMOJI[message.severity]} *${escapeMarkdownV2(message.title)}*\n${escapeMarkdownV2(message.body)}`.slice(
        0,
        4096, // Telegram's own message length cap
      );
    const res = await this.fetchImpl(this.apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "MarkdownV2" }),
    });
    const data = (await res.json()) as TelegramApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram: ${data.description ?? `HTTP ${res.status}`}`);
    }
  }

  async testConnection(): Promise<ChannelConnectionStatus> {
    try {
      const res = await this.fetchImpl(this.apiUrl("getMe"));
      const data = (await res.json()) as TelegramApiResponse;
      if (!res.ok || !data.ok) return { ok: false, message: data.description ?? `HTTP ${res.status}` };
      return { ok: true, message: `Bot @${data.result?.username ?? "?"} erreichbar.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
