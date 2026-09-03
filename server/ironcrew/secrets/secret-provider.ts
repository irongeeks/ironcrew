/**
 * IronCrew — SecretProvider contract.
 *
 * The provider-agnostic shape both password-manager integrations
 * (vaultwarden-provider.ts, protonpass-provider.ts) implement. Modeled after
 * this project's existing AgentRuntime contract (runtime/run-events.ts):
 * `testConnection()` plays the same role as `AgentRuntime.authStatus()` — a
 * cheap, secret-free probe the Settings UI can call to tell an operator
 * whether an integration actually works, without ever resolving (or
 * needing) a real item.
 */

import type { SecretRef } from "./secret-ref.ts";

export class SecretResolutionError extends Error {}

export interface SecretConnectionStatus {
  ok: boolean;
  /** Human-readable, and contractually never a secret value — same rule as AuthStatus.detail. */
  message: string;
}

export interface SecretProvider {
  readonly kind: SecretRef["provider"];
  /** Resolve a SecretRef to its live value. Throws SecretResolutionError on any failure. Never logs the value. */
  resolve(ref: SecretRef): Promise<string>;
  /** Reachability/auth check. Never resolves or requires a real item to succeed. */
  testConnection(): Promise<SecretConnectionStatus>;
}
