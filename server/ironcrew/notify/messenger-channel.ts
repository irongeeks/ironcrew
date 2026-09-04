/**
 * IronCrew — MessengerChannel contract (inbound).
 *
 * The receiving half of the messenger integrations whose sending half is
 * NotificationChannel (notification-channel.ts). It is a separate contract
 * rather than a `poll()` bolted onto NotificationChannel, because the two
 * directions have genuinely different trust properties:
 *
 *   - **Outbound is fire-and-forget fan-out with no identity.** A channel
 *     takes an already-created, already-audited notification and pushes it
 *     at a webhook or a chat id. Nobody is on the other end as far as the
 *     contract is concerned; failure is best-effort and never blocks the
 *     flow that triggered it (company.ts#fanOutNotification).
 *   - **Inbound carries a sender, and that sender's identity decides
 *     whether the message is acted on at all.** Every InboundMessage is
 *     unauthenticated text from outside the company until a caller has
 *     matched `senderId` against a grant. The interesting field is not the
 *     text, it is who wrote it — and a NotificationChannel has no such
 *     field, no such check, and must never grow one implicitly.
 *
 * Fusing them would mean one object where half the methods are safe to call
 * anywhere and half return attacker-controlled data, with nothing in the
 * type to say which is which. Two contracts keep that distinction visible:
 * a component that only sends cannot accidentally hold a source of
 * untrusted input, and an inbound implementation cannot be handed to the
 * fan-out path.
 *
 * What an implementation owes its callers:
 *   - `poll()` returns each message exactly once. The cursor (Telegram's
 *     update offset, Discord's `after` snowflake) lives in the channel, so
 *     a repeated poll never re-delivers.
 *   - `text` and `senderName` are already stripped of control tokens and
 *     invisible characters (policy/untrusted-content.ts). Stripped is not
 *     the same as trusted: text destined for a prompt still has to be
 *     fenced — `wrapInboundForPrompt()` below is that step.
 */

import { MAX_UNTRUSTED_CHARS, sanitiseLine, stripControlTokens, wrapUntrusted } from "../policy/untrusted-content.ts";
import type { ChannelConnectionStatus } from "./notification-channel.ts";

/**
 * Reused rather than redeclared: "reachable / not reachable, plus a line an
 * operator can read" means exactly the same thing in both directions, and
 * the Settings UI calls both through the same probe.
 */
export type { ChannelConnectionStatus } from "./notification-channel.ts";

export interface InboundMessage {
  /** Provider-stable locator, unique within the channel: Telegram "<chat>:<message>", Discord snowflake. */
  externalId: string;
  /** Where the message arrived, and where `reply()` sends an answer. */
  chatId: string;
  /**
   * The sender, as the provider identifies them. This is the field a caller
   * matches against its grants — never `senderName`, which the sender picks
   * themselves and can change at will.
   */
  senderId: string;
  /** Display name. Untrusted, cosmetic, already flattened to one line. */
  senderName: string;
  /** Message body, already stripped. Not yet fenced — see wrapInboundForPrompt(). */
  text: string;
  /** Epoch-ms, or null when the provider gave nothing parseable (same convention as MailMessageSummary). */
  receivedAt: number | null;
}

/** Thrown when the provider's API refuses a call. Mirrors MailProviderError. */
export class MessengerChannelError extends Error {}

export interface MessengerChannel {
  readonly kind: string;
  /**
   * New messages since the last call, oldest first. `since` is an optional
   * epoch-ms floor on top of the channel's own cursor — a hint, not the
   * cursor: neither provider offers a time-based query, so it is applied
   * client-side after fetching.
   */
  poll(since?: number): Promise<InboundMessage[]>;
  /** Answers into a chat. Plain text — replies are never markup. */
  reply(chatId: string, text: string): Promise<void>;
  /** Reachability/auth check. Never posts a message to succeed. */
  testConnection(): Promise<ChannelConnectionStatus>;
}

/**
 * Shared helper: an inbound body, made safe to hold.
 *
 * Kept here rather than in each implementation so that "what a channel does
 * to inbound text" is one decision in one place — a channel that forgot the
 * strip would be indistinguishable from one that did it, from the outside.
 * Newlines survive (a chat message is allowed to have lines); everything
 * that could forge a turn boundary does not.
 */
export function sanitiseInboundText(raw: string, maxChars = MAX_UNTRUSTED_CHARS): string {
  const text = stripControlTokens(raw ?? "").text.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Shared helper: a display name, flattened to a single safe line. */
export function sanitiseSenderName(raw: string): string {
  return sanitiseLine(raw ?? "");
}

/**
 * Fences a message for use in a prompt.
 *
 * The strip that `poll()` already did stops the text from *forging* a turn
 * boundary; this stops it from being read as one of ours. The source line
 * names the sender so the model — and an operator reading the transcript —
 * can see whose text this is, which is the same identity a caller had to
 * check before acting on it.
 */
export function wrapInboundForPrompt(message: InboundMessage, kind = "Chat-Nachricht"): string {
  return wrapUntrusted(message.text, {
    kind,
    source: `${message.senderName || "unbekannt"} (${message.senderId})`,
  }).text;
}
