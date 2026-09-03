import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DecryptedOAuthToken } from "../../shared/types.ts";

export interface OAuthStatusDeps {
  db: DatabaseSync;
  ensureOAuthActiveAccount: (provider: string) => void;
  getActiveOAuthAccountIds: (provider: string) => string[];
  setActiveOAuthAccount: (provider: string, accountId: string) => void;
  setOAuthActiveAccounts: (provider: string, accountIds: string[]) => void;
  getOAuthAccounts: (provider: string, includeDisabled?: boolean) => DecryptedOAuthToken[];
}

type OAuthProviderKey = "github" | "google_antigravity";

type OAuthAccountRow = {
  id: string;
  label: string | null;
  email: string | null;
  source: string | null;
  scope: string | null;
  status: string;
  priority: number;
  expires_at: number | null;
  refresh_token_enc: string | null;
  model_override: string | null;
  failure_count: number;
  last_error: string | null;
  last_error_at: number | null;
  last_success_at: number | null;
  created_at: number;
  updated_at: number;
};

export function createOAuthStatusBuilder(deps: OAuthStatusDeps) {
  const {
    db,
    ensureOAuthActiveAccount,
    getActiveOAuthAccountIds,
    setActiveOAuthAccount,
    setOAuthActiveAccounts,
    getOAuthAccounts,
  } = deps;

  const home = os.homedir();

  function detectFileCredential(provider: OAuthProviderKey) {
    if (provider === "github") {
      try {
        const hostsPath = path.join(home, ".config", "gh", "hosts.yml");
        const raw = fs.readFileSync(hostsPath, "utf8");
        const userMatch = raw.match(/user:\s*(\S+)/);
        if (userMatch) {
          const stat = fs.statSync(hostsPath);
          return {
            detected: true,
            source: "file-detected",
            email: userMatch[1],
            scope: "github.com",
            created_at: stat.birthtimeMs,
            updated_at: stat.mtimeMs,
          };
        }
      } catch {
        // ignore local gh hosts parsing failures
      }

      const copilotPaths = [
        path.join(home, ".config", "github-copilot", "hosts.json"),
        path.join(home, ".config", "github-copilot", "apps.json"),
      ];
      for (const cp of copilotPaths) {
        try {
          const raw = JSON.parse(fs.readFileSync(cp, "utf8"));
          if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
            const stat = fs.statSync(cp);
            const firstKey = Object.keys(raw)[0];
            return {
              detected: true,
              source: "file-detected",
              email: raw[firstKey]?.user ?? null,
              scope: "copilot",
              created_at: stat.birthtimeMs,
              updated_at: stat.mtimeMs,
            };
          }
        } catch {
          // ignore local copilot file parsing failures
        }
      }
    } else {
      const agPaths = [
        path.join(home, ".antigravity", "auth.json"),
        path.join(home, ".config", "antigravity", "auth.json"),
        path.join(home, ".config", "antigravity", "credentials.json"),
      ];
      for (const ap of agPaths) {
        try {
          const raw = JSON.parse(fs.readFileSync(ap, "utf8"));
          if (raw && typeof raw === "object") {
            const stat = fs.statSync(ap);
            return {
              detected: true,
              source: "file-detected",
              email: raw.email ?? raw.user ?? null,
              scope: raw.scope ?? null,
              created_at: stat.birthtimeMs,
              updated_at: stat.mtimeMs,
            };
          }
        } catch {
          // ignore local antigravity file parsing failures
        }
      }
    }
    return {
      detected: false,
      source: null as string | null,
      email: null as string | null,
      scope: null as string | null,
      created_at: 0,
      updated_at: 0,
    };
  }

  function buildProviderStatus(internalProvider: OAuthProviderKey) {
    ensureOAuthActiveAccount(internalProvider);
    let activeAccountIds = getActiveOAuthAccountIds(internalProvider);
    let activeSet = new Set(activeAccountIds);

    const rows = db
      .prepare(
        `
      SELECT
        id, label, email, source, scope, status, priority, expires_at,
        refresh_token_enc, model_override, failure_count, last_error, last_error_at, last_success_at, created_at, updated_at
      FROM oauth_accounts
      WHERE provider = ?
      ORDER BY priority ASC, updated_at DESC
    `,
      )
      .all(internalProvider) as OAuthAccountRow[];

    const decryptedById = new Map(
      (getOAuthAccounts(internalProvider, true) as DecryptedOAuthToken[]).map((a: DecryptedOAuthToken) => [
        a.id as string,
        a,
      ]),
    );
    const accounts = rows.map((row) => {
      const dec = decryptedById.get(row.id);
      const expiresAtMs = row.expires_at && row.expires_at < 1e12 ? row.expires_at * 1000 : row.expires_at;
      const hasRefreshToken = Boolean(dec?.refreshToken);
      const hasFreshAccessToken = Boolean(dec?.accessToken) && (!expiresAtMs || expiresAtMs > Date.now() + 60_000);
      const executionReady = row.status === "active" && (hasFreshAccessToken || hasRefreshToken);
      return {
        id: row.id,
        label: row.label,
        email: row.email,
        source: row.source,
        scope: row.scope,
        status: row.status as "active" | "disabled",
        priority: row.priority,
        expires_at: row.expires_at,
        hasRefreshToken,
        executionReady,
        active: activeSet.has(row.id),
        modelOverride: row.model_override,
        failureCount: row.failure_count,
        lastError: row.last_error,
        lastErrorAt: row.last_error_at,
        lastSuccessAt: row.last_success_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    if (accounts.length > 0) {
      const activeIdsPresent = activeAccountIds.filter((id) =>
        accounts.some((a) => a.id === id && a.status === "active"),
      );
      if (activeIdsPresent.length === 0) {
        const fallback = accounts.find((a) => a.status === "active");
        if (fallback) {
          setActiveOAuthAccount(internalProvider, fallback.id);
          activeAccountIds = getActiveOAuthAccountIds(internalProvider);
        }
      } else if (activeIdsPresent.length !== activeAccountIds.length) {
        setOAuthActiveAccounts(internalProvider, activeIdsPresent);
        activeAccountIds = activeIdsPresent;
      }
    }
    activeSet = new Set(activeAccountIds);
    const activeAccountId = activeAccountIds[0] ?? null;
    const accountsWithActive = accounts.map((a) => ({ ...a, active: activeSet.has(a.id) }));
    const runnable = accountsWithActive.filter((a) => a.executionReady);
    const primary = accountsWithActive.find((a) => a.active) ?? runnable[0] ?? accountsWithActive[0] ?? null;
    const fileDetected = detectFileCredential(internalProvider);
    const detected = accountsWithActive.length > 0 || fileDetected.detected;
    const connected = runnable.length > 0;

    return {
      connected,
      detected,
      executionReady: connected,
      requiresWebOAuth: detected && !connected,
      source: primary?.source ?? fileDetected.source,
      email: primary?.email ?? fileDetected.email,
      scope: primary?.scope ?? fileDetected.scope,
      expires_at: primary?.expires_at ?? null,
      created_at: primary?.created_at ?? fileDetected.created_at,
      updated_at: primary?.updated_at ?? fileDetected.updated_at,
      webConnectable: true,
      hasRefreshToken: primary?.hasRefreshToken ?? false,
      refreshFailed: primary?.lastError ? true : undefined,
      lastRefreshed: primary?.lastSuccessAt ?? null,
      activeAccountId,
      activeAccountIds,
      accounts: accountsWithActive,
    };
  }

  async function buildOAuthStatus() {
    return {
      "github-copilot": buildProviderStatus("github"),
      antigravity: buildProviderStatus("google_antigravity"),
    };
  }

  return { buildOAuthStatus };
}
