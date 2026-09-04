/**
 * IronCrew — MailProvider contract.
 *
 * The provider-agnostic shape every mailbox backend implements: IMAP
 * (imap-provider.ts), JMAP (jmap-provider.ts), Microsoft 365 Exchange
 * Online via Graph (m365-provider.ts) and Gmail (gmail-provider.ts).
 * Modeled after this project's SecretProvider/MemoryProvider/
 * NotificationChannel contracts — `testConnection()` is the same cheap,
 * credential-free probe the Settings UI calls to tell an operator whether
 * an integration actually works.
 *
 * Why this lives in IronCrew rather than plugging into the upstream
 * `Connector` interface (server/connectors/connector-interface.ts): a
 * Connector's capabilities are registered globally, with no notion of
 * *which agent* may use them. Mailboxes are explicitly n:n against agents
 * (crew_mailbox_agents), and that grant has to be enforced on every call —
 * so mailbox access goes through CompanyOrchestrator, which holds both the
 * grants and the audit chain. Exposing a granted mailbox to an agent as a
 * Connector capability is a sensible later addition, not a substitute.
 *
 * A provider never reads or writes the database. It receives a
 * `MailboxContext` (the row plus its decrypted credentials) and, for OAuth
 * backends, may hand back rotated tokens through `saveCredentials` — which
 * is the only write it can perform, and only of its own credentials.
 */

import type { MailboxKind, MailboxRow } from "../domain/mailbox-store.ts";
import type { MailCredentials } from "./mail-credentials.ts";

export interface MailMessageSummary {
  /** Provider-stable locator: IMAP UID, JMAP Email id, Graph id, Gmail id. */
  externalId: string;
  /** RFC 5322 Message-ID, when the provider exposes one. */
  messageId: string;
  subject: string;
  /** Sender address, bare (no display name). */
  from: string;
  to: string[];
  receivedAt: number | null;
  /** Short preview. Deliberately not persisted — see the migration header. */
  snippet: string;
  unread: boolean;
}

export interface MailMessageBody {
  summary: MailMessageSummary;
  text: string;
  html: string;
}

export interface OutgoingMail {
  to: string[];
  subject: string;
  text: string;
  /** Message-ID this is a reply to, so threading survives. */
  inReplyTo?: string;
}

export interface MailConnectionStatus {
  ok: boolean;
  /** Human-readable, and contractually never a password or token. */
  message: string;
}

export interface MailboxContext {
  mailbox: MailboxRow;
  credentials: MailCredentials;
  /**
   * Persist rotated credentials (an OAuth access token refresh). Optional
   * so a caller can run a provider read-only — a provider must treat its
   * absence as "cannot cache", never as a reason to fail.
   */
  saveCredentials?: (credentials: MailCredentials) => void;
}

export interface ListMessagesOptions {
  limit?: number;
  /** Only messages received at or after this epoch-ms timestamp. */
  since?: number;
}

export class MailProviderError extends Error {}

export interface MailProvider {
  readonly kind: MailboxKind;
  listMessages(ctx: MailboxContext, opts?: ListMessagesOptions): Promise<MailMessageSummary[]>;
  /** Null when the id no longer resolves — a message moved or deleted is not an error. */
  getMessage(ctx: MailboxContext, externalId: string): Promise<MailMessageBody | null>;
  send(ctx: MailboxContext, mail: OutgoingMail): Promise<void>;
  /** Reachability/auth check. Never sends and never needs a specific message to succeed. */
  testConnection(ctx: MailboxContext): Promise<MailConnectionStatus>;
}

/** Shared helper: bound a caller-supplied limit to something a mail server will accept. */
export function boundedLimit(limit: number | undefined, fallback = 25): number {
  return Math.min(Math.max(limit ?? fallback, 1), 200);
}

/** Shared helper: first address of a list, bare, for the summary's `from`. */
export function firstAddress(addresses: Array<{ address?: string }> | undefined): string {
  return addresses?.find((a) => a.address)?.address ?? "";
}

/** Shared helper: a preview line, collapsed and clipped, never a whole body. */
export function snippetOf(text: string, max = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
