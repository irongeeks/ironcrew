/**
 * IronCrew — access-token minting for OAuth mail backends.
 *
 * Microsoft 365 and Gmail both hand out short-lived access tokens against a
 * durable credential (a refresh token for delegated access, or a client
 * secret for an unattended app registration). Both flows are plain
 * form-encoded POSTs, so this is shared rather than written twice.
 *
 * The refreshed token is cached back into the mailbox's own encrypted
 * credentials through `saveCredentials`, with the same 60-second early
 * window the upstream `refreshGoogleToken` helper uses — a token that
 * expires mid-request is worse than one refreshed slightly early.
 */

import type { MailCredentials } from "./mail-credentials.ts";
import { MailProviderError, type MailboxContext } from "./mail-provider.ts";

/** Refresh this long before the token actually expires. */
const EARLY_REFRESH_MS = 60_000;

export interface TokenEndpointConfig {
  tokenUrl: string;
  /** Space-separated OAuth scopes. */
  scope: string;
  /**
   * Client-credentials is only correct for an app registration with
   * application permissions (Microsoft 365). Gmail always needs a user's
   * refresh token, so it leaves this false.
   */
  allowClientCredentials?: boolean;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Returns a usable access token, minting one if the cached token is missing
 * or about to expire. `ctx.saveCredentials` is optional by contract, so a
 * caller running read-only simply loses the cache, never the ability to
 * fetch.
 */
export async function ensureAccessToken(
  ctx: MailboxContext,
  config: TokenEndpointConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const { credentials, mailbox } = ctx;

  const cached = credentials.accessToken;
  const expiresAt = credentials.accessTokenExpiresAt ?? 0;
  if (cached && expiresAt - EARLY_REFRESH_MS > Date.now()) return cached;

  const body = new URLSearchParams();
  body.set("client_id", mailbox.client_id);
  if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);

  if (credentials.refreshToken) {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", credentials.refreshToken);
    body.set("scope", config.scope);
  } else if (config.allowClientCredentials && credentials.clientSecret) {
    body.set("grant_type", "client_credentials");
    body.set("scope", config.scope);
  } else {
    throw new MailProviderError(
      `Mailbox "${mailbox.label}" has no refresh token stored — reconnect it to grant access.`,
    );
  }

  const res = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    // The description is the useful half and carries no secret of ours.
    throw new MailProviderError(
      `Token request failed (${res.status}): ${data.error_description ?? data.error ?? "unknown error"}`,
    );
  }

  const next: MailCredentials = {
    ...credentials,
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    // Providers may rotate the refresh token itself; keep the newest.
    refreshToken: data.refresh_token ?? credentials.refreshToken,
  };
  ctx.credentials.accessToken = next.accessToken;
  ctx.credentials.accessTokenExpiresAt = next.accessTokenExpiresAt;
  ctx.credentials.refreshToken = next.refreshToken;
  ctx.saveCredentials?.(next);

  return data.access_token;
}
