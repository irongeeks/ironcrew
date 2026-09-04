import { createHash } from "node:crypto";
import {
  BUILTIN_GOOGLE_CLIENT_ID,
  BUILTIN_GOOGLE_CLIENT_SECRET,
  decryptSecret,
  encryptSecret,
} from "../../../../oauth/helpers.ts";
import type { DecryptedOAuthToken } from "./types.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
    all: (...args: any[]) => unknown;
    run: (...args: any[]) => unknown;
  };
};

type CreateOAuthToolsDeps = {
  db: DbLike;
  nowMs: () => number;
  ensureOAuthActiveAccount: (provider: string) => void;
  getActiveOAuthAccountIds: (provider: string) => string[];
};

export function createOAuthTools(deps: CreateOAuthToolsDeps) {
  const { db, nowMs, ensureOAuthActiveAccount, getActiveOAuthAccountIds } = deps;

  const ANTIGRAVITY_ENDPOINTS = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  ];
  const ANTIGRAVITY_DEFAULT_PROJECT = "rising-fact-p41fc";
  let copilotTokenCache: { token: string; baseUrl: string; expiresAt: number; sourceHash: string } | null = null;
  let antigravityProjectCache: { projectId: string; tokenHash: string } | null = null;

  function oauthProviderPrefix(provider: string): string {
    return provider === "github" ? "Copi" : "Anti";
  }

  function normalizeOAuthProvider(provider: string): "github" | "google_antigravity" | null {
    if (provider === "github-copilot" || provider === "github" || provider === "copilot") return "github";
    if (provider === "antigravity" || provider === "google_antigravity") return "google_antigravity";
    return null;
  }

  function getOAuthAccountDisplayName(account: DecryptedOAuthToken): string {
    if (account.label) return account.label;
    if (account.email) return account.email;
    const prefix = oauthProviderPrefix(account.provider);
    return `${prefix}-${(account.id ?? "unknown").slice(0, 6)}`;
  }

  function getNextOAuthLabel(provider: string): string {
    const normalizedProvider = normalizeOAuthProvider(provider) ?? provider;
    const prefix = oauthProviderPrefix(normalizedProvider);
    const rows = db.prepare("SELECT label FROM oauth_accounts WHERE provider = ?").all(normalizedProvider) as Array<{
      label: string | null;
    }>;
    let maxSeq = 0;
    for (const row of rows) {
      if (!row.label) continue;
      const m = row.label.match(new RegExp(`^${prefix}-(\\d+)$`));
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
    return `${prefix}-${maxSeq + 1}`;
  }

  function getOAuthAutoSwapEnabled(): boolean {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'oauthAutoSwap'").get() as
      | { value: string }
      | undefined;
    if (!row) return true;
    const v = String(row.value).toLowerCase().trim();
    return !(v === "false" || v === "0" || v === "off" || v === "no");
  }

  const oauthDispatchCursor = new Map<string, number>();

  function rotateOAuthAccounts(provider: string, accounts: DecryptedOAuthToken[]): DecryptedOAuthToken[] {
    if (accounts.length <= 1) return accounts;
    const current = oauthDispatchCursor.get(provider) ?? -1;
    const next = (current + 1) % accounts.length;
    oauthDispatchCursor.set(provider, next);
    if (next === 0) return accounts;
    return [...accounts.slice(next), ...accounts.slice(0, next)];
  }

  function prioritizeOAuthAccount(
    accounts: DecryptedOAuthToken[],
    preferredAccountId?: string | null,
  ): DecryptedOAuthToken[] {
    if (!preferredAccountId || accounts.length <= 1) return accounts;
    const idx = accounts.findIndex((a) => a.id === preferredAccountId);
    if (idx <= 0) return accounts;
    const [picked] = accounts.splice(idx, 1);
    return [picked, ...accounts];
  }

  function markOAuthAccountFailure(accountId: string, message: string): void {
    db.prepare(
      `
    UPDATE oauth_accounts
    SET failure_count = COALESCE(failure_count, 0) + 1,
        last_error = ?,
        last_error_at = ?,
        updated_at = ?
    WHERE id = ?
  `,
    ).run(message.slice(0, 1500), nowMs(), nowMs(), accountId);
  }

  function markOAuthAccountSuccess(accountId: string): void {
    db.prepare(
      `
    UPDATE oauth_accounts
    SET failure_count = 0,
        last_error = NULL,
        last_error_at = NULL,
        last_success_at = ?,
        updated_at = ?
    WHERE id = ?
  `,
    ).run(nowMs(), nowMs(), accountId);
  }

  function getOAuthAccounts(provider: string, includeDisabled = false): DecryptedOAuthToken[] {
    const normalizedProvider = normalizeOAuthProvider(provider);
    if (!normalizedProvider) return [];
    const rows = db
      .prepare(
        `
    SELECT
      id, provider, source, label, email, scope, expires_at,
      access_token_enc, refresh_token_enc, status, priority,
      model_override, failure_count, last_error, last_error_at, last_success_at
    FROM oauth_accounts
    WHERE provider = ?
      ${includeDisabled ? "" : "AND status = 'active'"}
    ORDER BY priority ASC, updated_at DESC
  `,
      )
      .all(normalizedProvider) as Array<{
      id: string;
      provider: string;
      source: string | null;
      label: string | null;
      email: string | null;
      scope: string | null;
      expires_at: number | null;
      access_token_enc: string | null;
      refresh_token_enc: string | null;
      status: string;
      priority: number;
      model_override: string | null;
      failure_count: number;
      last_error: string | null;
      last_error_at: number | null;
      last_success_at: number | null;
    }>;

    const accounts: DecryptedOAuthToken[] = [];
    for (const row of rows) {
      try {
        accounts.push({
          id: row.id,
          provider: row.provider,
          source: row.source,
          label: row.label,
          accessToken: row.access_token_enc ? decryptSecret(row.access_token_enc) : null,
          refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
          expiresAt: row.expires_at,
          email: row.email,
          status: row.status,
          priority: row.priority,
          modelOverride: row.model_override,
          failureCount: row.failure_count,
          lastError: row.last_error,
          lastErrorAt: row.last_error_at,
          lastSuccessAt: row.last_success_at,
        });
      } catch {
        // skip undecryptable account
      }
    }
    return accounts;
  }

  function getPreferredOAuthAccounts(provider: string, opts: { includeStandby?: boolean } = {}): DecryptedOAuthToken[] {
    const normalizedProvider = normalizeOAuthProvider(provider);
    if (!normalizedProvider) return [];
    ensureOAuthActiveAccount(normalizedProvider);
    const accounts = getOAuthAccounts(normalizedProvider, false);
    if (accounts.length === 0) return [];
    const activeIds = getActiveOAuthAccountIds(normalizedProvider);
    if (activeIds.length === 0) return accounts;
    const activeSet = new Set(activeIds);
    const selected = accounts.filter((a) => a.id && activeSet.has(a.id));
    if (selected.length === 0) return accounts;
    if (!opts.includeStandby) return selected;
    const standby = accounts.filter((a) => !(a.id && activeSet.has(a.id)));
    return [...selected, ...standby];
  }

  function getDecryptedOAuthToken(provider: string): DecryptedOAuthToken | null {
    const preferred = getPreferredOAuthAccounts(provider)[0];
    if (preferred) return preferred;

    // Legacy fallback for existing installations before oauth_accounts migration.
    const row = db
      .prepare(
        "SELECT access_token_enc, refresh_token_enc, expires_at, email FROM oauth_credentials WHERE provider = ?",
      )
      .get(provider) as
      | {
          access_token_enc: string | null;
          refresh_token_enc: string | null;
          expires_at: number | null;
          email: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: null,
      provider,
      source: "legacy",
      label: null,
      accessToken: row.access_token_enc ? decryptSecret(row.access_token_enc) : null,
      refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
      expiresAt: row.expires_at,
      email: row.email,
    };
  }

  function getProviderModelConfig(): Record<
    string,
    { model: string; subModel?: string; reasoningLevel?: string; subModelReasoningLevel?: string }
  > {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'providerModelConfig'").get() as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : {};
  }

  async function refreshGoogleToken(credential: DecryptedOAuthToken): Promise<string> {
    const expiresAtMs =
      credential.expiresAt && credential.expiresAt < 1e12 ? credential.expiresAt * 1000 : credential.expiresAt;
    if (credential.accessToken && expiresAtMs && expiresAtMs > Date.now() + 60_000) {
      return credential.accessToken;
    }
    if (!credential.refreshToken) {
      throw new Error("Google OAuth token expired and no refresh_token available");
    }
    const clientId = process.env.OAUTH_GOOGLE_CLIENT_ID ?? BUILTIN_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? BUILTIN_GOOGLE_CLIENT_SECRET;
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credential.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Google token refresh failed (${resp.status}): ${text}`);
    }
    const data = (await resp.json()) as { access_token: string; expires_in?: number };
    const newExpiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
    // Update DB with new access token
    const now = nowMs();
    const accessEnc = encryptSecret(data.access_token);
    if (credential.id) {
      db.prepare(
        `
      UPDATE oauth_accounts
      SET access_token_enc = ?, expires_at = ?, updated_at = ?, last_success_at = ?, last_error = NULL, last_error_at = NULL
      WHERE id = ?
    `,
      ).run(accessEnc, newExpiresAt, now, now, credential.id);
    }
    db.prepare(
      "UPDATE oauth_credentials SET access_token_enc = ?, expires_at = ?, updated_at = ? WHERE provider = 'google_antigravity'",
    ).run(accessEnc, newExpiresAt, now);
    return data.access_token;
  }

  async function exchangeCopilotToken(
    githubToken: string,
  ): Promise<{ token: string; baseUrl: string; expiresAt: number }> {
    const sourceHash = createHash("sha256").update(githubToken).digest("hex").slice(0, 16);
    if (
      copilotTokenCache &&
      copilotTokenCache.expiresAt > Date.now() + 5 * 60_000 &&
      copilotTokenCache.sourceHash === sourceHash
    ) {
      return copilotTokenCache;
    }
    const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/json",
        "User-Agent": "ironcrew",
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Copilot token exchange failed (${resp.status}): ${text}`);
    }
    const data = (await resp.json()) as { token: string; expires_at: number; endpoints?: { api?: string } };
    let baseUrl = "https://api.individual.githubcopilot.com";
    const proxyMatch = data.token.match(/proxy-ep=([^;]+)/);
    if (proxyMatch) {
      baseUrl = `https://${proxyMatch[1].replace(/^proxy\./, "api.")}`;
    }
    if (data.endpoints?.api) {
      baseUrl = data.endpoints.api.replace(/\/$/, "");
    }
    const expiresAt = data.expires_at * 1000;
    copilotTokenCache = { token: data.token, baseUrl, expiresAt, sourceHash };
    return copilotTokenCache;
  }

  async function loadCodeAssistProject(accessToken: string, signal?: AbortSignal): Promise<string> {
    const tokenHash = createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
    if (antigravityProjectCache && antigravityProjectCache.tokenHash === tokenHash) {
      return antigravityProjectCache.projectId;
    }
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const resp = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
            "Client-Metadata": JSON.stringify({
              ideType: "ANTIGRAVITY",
              platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
              pluginType: "GEMINI",
            }),
          },
          body: JSON.stringify({
            metadata: {
              ideType: "ANTIGRAVITY",
              platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
              pluginType: "GEMINI",
            },
          }),
          signal,
        });
        if (!resp.ok) continue;
        const data = (await resp.json()) as any;
        const proj = data?.cloudaicompanionProject?.id ?? data?.cloudaicompanionProject;
        if (typeof proj === "string" && proj) {
          antigravityProjectCache = { projectId: proj, tokenHash };
          return proj;
        }
      } catch {
        /* try next endpoint */
      }
    }
    antigravityProjectCache = { projectId: ANTIGRAVITY_DEFAULT_PROJECT, tokenHash };
    return ANTIGRAVITY_DEFAULT_PROJECT;
  }

  return {
    ANTIGRAVITY_ENDPOINTS,
    ANTIGRAVITY_DEFAULT_PROJECT,
    oauthProviderPrefix,
    normalizeOAuthProvider,
    getOAuthAccountDisplayName,
    getNextOAuthLabel,
    getOAuthAutoSwapEnabled,
    rotateOAuthAccounts,
    prioritizeOAuthAccount,
    markOAuthAccountFailure,
    markOAuthAccountSuccess,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    loadCodeAssistProject,
  };
}
