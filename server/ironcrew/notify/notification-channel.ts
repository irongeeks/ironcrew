/**
 * IronCrew — NotificationChannel contract.
 *
 * Fan-out targets for the decision inbox (crew_notifications — see its own
 * doc-comment, "decision inbox / Discord fan-out"). Modeled after this
 * project's SecretProvider/MemoryProvider contracts: a channel only ever
 * sends and reports reachability, never anything governance-relevant by
 * itself — the notification it forwards was already created (and, for an
 * approval, already audited) by NotificationStore before this runs. Fan-out
 * is always best-effort: CompanyOrchestrator never lets a broken channel
 * block the approval/notification flow that triggered it (see
 * company.ts#fanOutNotification).
 */

export type ChannelSeverity = "info" | "warning" | "critical";

export interface ChannelMessage {
  title: string;
  body: string;
  severity: ChannelSeverity;
}

export interface ChannelConnectionStatus {
  ok: boolean;
  /** Human-readable; never a token, webhook URL or password. */
  message: string;
}

export interface NotificationChannel {
  readonly kind: string;
  send(message: ChannelMessage): Promise<void>;
  /** Reachability check. Never sends a real message to succeed. */
  testConnection(): Promise<ChannelConnectionStatus>;
}
