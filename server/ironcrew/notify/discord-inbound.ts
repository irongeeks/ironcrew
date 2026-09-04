/**
 * IronCrew — Discord MessengerChannel (inbound).
 *
 * **The honest limitation first.** Discord's supported way to receive
 * messages — and the only way to receive arbitrary DMs — is a Gateway
 * websocket: a process that stays connected, heartbeats, resumes after
 * disconnects, and holds session state. This channel does not do that. It
 * polls one channel over REST:
 * `GET /channels/{id}/messages?after={snowflake}`.
 *
 * What that buys and what it costs:
 *   - It works for a *dedicated channel* — a crew channel in a guild the
 *     bot was invited to, or a single DM channel whose id is known and
 *     configured. That is the case IronCrew actually needs: an operator
 *     talks to their crew in one place.
 *   - It does **not** work for arbitrary DMs. Without the Gateway, a bot is
 *     never told that a DM channel it has never seen exists, so a user
 *     messaging the bot out of the blue is invisible here. That needs a
 *     Gateway client, which is a different (and much larger) component.
 *   - Latency is the polling interval, not milliseconds, and the bot needs
 *     Read Message History on the channel.
 *
 * The trade is deliberate: no persistent connection means no reconnect
 * logic, no session resumption, no separate long-lived process to
 * supervise, and a channel whose entire behaviour is testable through an
 * injected `fetchImpl` — the same pattern M365Provider uses for Graph.
 *
 * The cursor is the newest message id seen (a snowflake, monotonically
 * increasing), passed back as `after`, so `poll()` never re-delivers.
 */

import {
  MessengerChannelError,
  sanitiseInboundText,
  sanitiseSenderName,
  type ChannelConnectionStatus,
  type InboundMessage,
  type MessengerChannel,
} from "./messenger-channel.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
/** Discord's own cap on the messages endpoint. */
const MAX_MESSAGE_LIMIT = 100;
/** Discord's own message content cap, applied to replies. */
const MAX_CONTENT_LENGTH = 2000;

export interface DiscordInboundOptions {
  /** Bot token (Developer Portal -> Bot), sent as "Authorization: Bot <token>". */
  botToken: string;
  /** The one channel this polls. A guild channel, or a known DM channel id. */
  channelId: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Overridable for a proxy or an API version bump; defaults to discord.com/api/v10. */
  apiBase?: string;
  /** Messages per call, 1..100. Defaults to 50. */
  limit?: number;
  /**
   * Resume from a persisted cursor. Without it the first poll returns up to
   * `limit` messages of existing history — pass this, or a `since` floor,
   * when enabling the channel on a busy channel should not replay its
   * backlog.
   */
  afterMessageId?: string;
}

interface DiscordAuthor {
  id?: string;
  username?: string;
  global_name?: string;
  bot?: boolean;
}

interface DiscordMessage {
  id?: string;
  channel_id?: string;
  content?: string;
  timestamp?: string;
  author?: DiscordAuthor;
}

/** Snowflakes exceed Number.MAX_SAFE_INTEGER, so "newest" is a BigInt comparison. */
function isNewer(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    return false;
  }
}

export class DiscordInboundChannel implements MessengerChannel {
  readonly kind = "discord" as const;

  private readonly botToken: string;
  private readonly channelId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly limit: number;
  /** Newest message id seen; "" before the first poll. */
  private after: string;

  constructor(opts: DiscordInboundOptions) {
    this.botToken = opts.botToken;
    this.channelId = opts.channelId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = (opts.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, "");
    this.limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_MESSAGE_LIMIT);
    this.after = opts.afterMessageId ?? "";
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bot ${this.botToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new MessengerChannelError(`Discord returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
  }

  async poll(since?: number): Promise<InboundMessage[]> {
    const params = new URLSearchParams({ limit: String(this.limit) });
    if (this.after) params.set("after", this.after);
    const res = await this.call(`/channels/${encodeURIComponent(this.channelId)}/messages?${params.toString()}`);
    const raw = ((await res.json()) as DiscordMessage[]) ?? [];

    const messages: InboundMessage[] = [];
    for (const message of raw) {
      // The cursor tracks every id in the batch, including the ones dropped
      // below — a bot message left out of the cursor would be re-fetched on
      // every poll for as long as it stays the newest in the channel.
      if (message.id && (!this.after || isNewer(message.id, this.after))) this.after = message.id;

      const mapped = this.toInbound(message);
      if (!mapped) continue;
      if (since !== undefined && mapped.receivedAt !== null && mapped.receivedAt < since) continue;
      messages.push(mapped);
    }
    // Discord returns this endpoint newest-first, and the ordering with
    // `after` is not something to rely on — sort by snowflake so callers
    // always see a conversation in the order it was written.
    return messages.sort((a, b) => (isNewer(a.externalId, b.externalId) ? 1 : -1));
  }

  private toInbound(message: DiscordMessage): InboundMessage | null {
    if (!message.id || !message.author?.id) return null;
    // Bots are skipped, and that includes this channel's own replies: an
    // answer posted by reply() would otherwise come straight back on the
    // next poll and could be answered again.
    if (message.author.bot) return null;

    const text = sanitiseInboundText(message.content ?? "");
    // Attachment-only and embed-only posts carry no text to act on.
    if (text === "") return null;

    const received = message.timestamp ? Date.parse(message.timestamp) : NaN;
    return {
      externalId: message.id,
      chatId: message.channel_id ?? this.channelId,
      senderId: message.author.id,
      senderName: sanitiseSenderName(message.author.global_name || message.author.username || message.author.id),
      text,
      receivedAt: Number.isNaN(received) ? null : received,
    };
  }

  async reply(chatId: string, text: string): Promise<void> {
    await this.call(`/channels/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: text.slice(0, MAX_CONTENT_LENGTH) }),
    });
  }

  async testConnection(): Promise<ChannelConnectionStatus> {
    try {
      // Reading the channel object proves token, bot permissions and the
      // configured id in one call, without posting anything.
      const res = await this.call(`/channels/${encodeURIComponent(this.channelId)}`);
      const channel = (await res.json()) as { name?: string };
      return { ok: true, message: `Discord-Kanal "${channel.name ?? this.channelId}" erreichbar.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
