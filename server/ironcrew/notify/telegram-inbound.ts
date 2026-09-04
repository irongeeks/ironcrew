/**
 * IronCrew — Telegram MessengerChannel (inbound).
 *
 * The receiving counterpart to TelegramChannel (telegram-channel.ts), same
 * Bot API, same bare-HTTPS approach: no bot framework, no webhook endpoint
 * to expose. Reading uses `getUpdates`, Telegram's long-poll: each call
 * passes an `offset` one higher than the highest update it has seen, which
 * both selects the next batch and tells Telegram the previous one was
 * handled. That single number is the whole cursor, so `poll()` never
 * re-delivers a message it already returned.
 *
 * The offset lives in memory. After a restart Telegram simply re-serves its
 * queue from the last offset it was told about, so nothing is lost — a
 * message may be delivered twice, which is why InboundMessage carries a
 * stable `externalId` for callers that must not act twice.
 *
 * `fetchImpl` and `apiBase` are injectable for the same reason
 * ImapProvider injects its client factory: the tests exercise this class's
 * real code path — offset arithmetic, update mapping, sanitising, error
 * surfacing — without a socket.
 */

import {
  MessengerChannelError,
  sanitiseInboundText,
  sanitiseSenderName,
  type ChannelConnectionStatus,
  type InboundMessage,
  type MessengerChannel,
} from "./messenger-channel.ts";

const TELEGRAM_API_BASE = "https://api.telegram.org";
/** Telegram's own cap on getUpdates. */
const MAX_UPDATE_LIMIT = 100;
/** Telegram's own message length cap, applied to replies. */
const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramInboundOptions {
  /** Bot token from @BotFather, e.g. "123456:ABC-DEF...". */
  botToken: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Overridable for a local Bot API server; defaults to api.telegram.org. */
  apiBase?: string;
  /** Updates per call, 1..100. Defaults to 100. */
  limit?: number;
  /**
   * Seconds Telegram may hold the request open waiting for an update.
   * Defaults to 0 — this channel is driven by a scheduler that calls
   * `poll()` on its own interval, and a held-open request would occupy a
   * socket and stall that caller for no gain. Raise it for push-like
   * latency when a dedicated loop, not the scheduler, owns the calls.
   */
  timeoutSeconds?: number;
}

interface TelegramUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  chat?: { id?: number };
  from?: TelegramUser;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  description?: string;
  result?: T;
}

/** Telegram has no single display-name field; this is the order a user expects to see. */
function displayName(user: TelegramUser | undefined): string {
  const full = [user?.first_name, user?.last_name].filter(Boolean).join(" ");
  return full || user?.username || String(user?.id ?? "");
}

export class TelegramInboundChannel implements MessengerChannel {
  readonly kind = "telegram" as const;

  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly limit: number;
  private readonly timeoutSeconds: number;
  /** Next update_id to ask for. 0 means "whatever Telegram still has queued". */
  private offset = 0;

  constructor(opts: TelegramInboundOptions) {
    this.botToken = opts.botToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = (opts.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
    this.limit = Math.min(Math.max(opts.limit ?? MAX_UPDATE_LIMIT, 1), MAX_UPDATE_LIMIT);
    this.timeoutSeconds = Math.max(opts.timeoutSeconds ?? 0, 0);
  }

  private apiUrl(method: string): string {
    return `${this.apiBase}/bot${this.botToken}/${method}`;
  }

  private async call<T>(method: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.apiUrl(method), init);
    const data = (await res.json()) as TelegramApiResponse<T>;
    if (!res.ok || !data.ok) {
      throw new MessengerChannelError(`Telegram ${method}: ${data.description ?? `HTTP ${res.status}`}`);
    }
    return data.result as T;
  }

  async poll(since?: number): Promise<InboundMessage[]> {
    const params = new URLSearchParams({ limit: String(this.limit), timeout: String(this.timeoutSeconds) });
    if (this.offset > 0) params.set("offset", String(this.offset));
    const updates = (await this.call<TelegramUpdate[]>(`getUpdates?${params.toString()}`)) ?? [];

    const messages: InboundMessage[] = [];
    for (const update of updates) {
      // The offset advances for every update, including the ones dropped
      // below: an update this channel cannot use would otherwise be served
      // again on every future poll, forever.
      if (update.update_id >= this.offset) this.offset = update.update_id + 1;

      const mapped = this.toInbound(update);
      if (!mapped) continue;
      if (since !== undefined && mapped.receivedAt !== null && mapped.receivedAt < since) continue;
      messages.push(mapped);
    }
    // getUpdates is already ascending by update_id; sorting would only hide
    // a provider surprise, so the order is left as delivered.
    return messages;
  }

  private toInbound(update: TelegramUpdate): InboundMessage | null {
    // Edits are treated as new messages: a caller decides by externalId
    // whether it has already acted on that message. channel_post has no
    // `from`, so there is nobody to authorise — it is dropped.
    const message = update.message ?? update.edited_message;
    const chatId = message?.chat?.id;
    const senderId = message?.from?.id;
    if (!message || chatId === undefined || senderId === undefined) return null;

    const text = sanitiseInboundText(message.text ?? message.caption ?? "");
    // Photos, stickers and joins arrive as messages with no text at all —
    // nothing for an agent to act on, and an empty task would be noise.
    if (text === "") return null;

    return {
      externalId: `${chatId}:${message.message_id ?? update.update_id}`,
      chatId: String(chatId),
      senderId: String(senderId),
      senderName: sanitiseSenderName(displayName(message.from)),
      text,
      // Telegram dates are unix seconds.
      receivedAt: typeof message.date === "number" ? message.date * 1000 : null,
    };
  }

  async reply(chatId: string, text: string): Promise<void> {
    // Deliberately no parse_mode: a reply is plain text. MarkdownV2 would
    // mean escaping agent-written output correctly on every path, and a
    // missed escape turns a message into markup — or into an error from
    // Telegram that the operator sees instead of the answer.
    await this.call("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, MAX_MESSAGE_LENGTH) }),
    });
  }

  async testConnection(): Promise<ChannelConnectionStatus> {
    try {
      const me = await this.call<{ username?: string }>("getMe");
      return { ok: true, message: `Bot @${me?.username ?? "?"} erreichbar.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
