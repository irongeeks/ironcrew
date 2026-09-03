import type { DatabaseSync } from "node:sqlite";
import { createOAuthTools } from "../modules/workflow/agents/providers/oauth-tools.ts";
import { createCredentialTools } from "../modules/workflow/agents/providers/credential-tools.ts";
import { createOAuthRouteHelpers } from "../modules/routes/ops/oauth/helpers.ts";
import { createOAuthStatusBuilder } from "../modules/routes/ops/oauth/status.ts";
import type { OAuthContext } from "../types/runtime-context-domains.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
    all: (...args: any[]) => unknown;
    run: (...args: any[]) => unknown;
  };
};

/**
 * Dependencies required to build an OAuthContext.
 *
 * Combines what `createOAuthTools` needs with the BaseRuntimeContext
 * OAuth management helpers that come from `initializeOAuthRuntime`.
 */
export interface OAuthDeps {
  db: DbLike;
  nowMs: () => number;
  ensureOAuthActiveAccount: (provider: string) => void;
  getActiveOAuthAccountIds: (provider: string) => string[];
  setActiveOAuthAccount: (provider: string, accountId: string) => void;
  setOAuthActiveAccounts: (provider: string, accountIds: string[]) => void;
  removeActiveOAuthAccount: (provider: string, accountId: string) => void;
}

/**
 * Creates a partial OAuthContext by composing `createCredentialTools()` and
 * `createOAuthTools()`.
 *
 * Properties that originate from `createOAuthRouteHelpers` (helpers.ts) and
 * `createOAuthStatusBuilder` (status.ts) are NOT included here — they will
 * be added in Task 3. The return type is cast to `OAuthContext` so that
 * downstream consumers can program against the full interface; missing
 * properties will throw at runtime until Task 3 wires them in.
 *
 * Cache properties (`copilotTokenCache`, `antigravityProjectCache`,
 * `geminiProjectCache`, `oauthDispatchCursor`) are exposed as standalone
 * state containers. The internal factories maintain their own copies; when
 * the full RuntimeContext migration lands (Phase 4), these will be unified.
 */
export function createOAuthContext(deps: OAuthDeps): OAuthContext {
  const credentialTools = createCredentialTools();
  const oauthTools = createOAuthTools({
    db: deps.db,
    nowMs: deps.nowMs,
    ensureOAuthActiveAccount: deps.ensureOAuthActiveAccount,
    getActiveOAuthAccountIds: deps.getActiveOAuthAccountIds,
  });

  const helpers = createOAuthRouteHelpers({
    db: deps.db as unknown as DatabaseSync,
    nowMs: deps.nowMs,
    getNextOAuthLabel: oauthTools.getNextOAuthLabel,
    normalizeOAuthProvider: oauthTools.normalizeOAuthProvider,
    setActiveOAuthAccount: deps.setActiveOAuthAccount,
    ensureOAuthActiveAccount: deps.ensureOAuthActiveAccount,
  });

  const statusBuilder = createOAuthStatusBuilder({
    db: deps.db as unknown as DatabaseSync,
    ensureOAuthActiveAccount: deps.ensureOAuthActiveAccount,
    getActiveOAuthAccountIds: deps.getActiveOAuthAccountIds,
    setActiveOAuthAccount: deps.setActiveOAuthAccount,
    setOAuthActiveAccounts: deps.setOAuthActiveAccounts,
    getOAuthAccounts: oauthTools.getOAuthAccounts,
  });

  return {
    // ── Constants ──────────────────────────────────────────────────────
    GEMINI_OAUTH_CLIENT_ID: process.env.GEMINI_OAUTH_CLIENT_ID ?? process.env.OAUTH_GOOGLE_CLIENT_ID ?? "",
    GEMINI_OAUTH_CLIENT_SECRET: process.env.GEMINI_OAUTH_CLIENT_SECRET ?? process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? "",
    GEMINI_PROJECT_TTL: 300_000,

    // ── Caches (standalone state containers) ───────────────────────────
    antigravityProjectCache: null,
    copilotTokenCache: null,
    geminiProjectCache: null,
    oauthDispatchCursor: new Map<string, number>(),

    // ── Functions from oauthTools ──────────────────────────────────────
    exchangeCopilotToken: oauthTools.exchangeCopilotToken,
    getOAuthAccountDisplayName: oauthTools.getOAuthAccountDisplayName,
    getOAuthAutoSwapEnabled: oauthTools.getOAuthAutoSwapEnabled,
    loadCodeAssistProject: oauthTools.loadCodeAssistProject,
    markOAuthAccountFailure: oauthTools.markOAuthAccountFailure,
    markOAuthAccountSuccess: oauthTools.markOAuthAccountSuccess,
    normalizeOAuthProvider: oauthTools.normalizeOAuthProvider,
    getNextOAuthLabel: oauthTools.getNextOAuthLabel,
    getOAuthAccounts: oauthTools.getOAuthAccounts,
    getPreferredOAuthAccounts: oauthTools.getPreferredOAuthAccounts,
    getDecryptedOAuthToken: oauthTools.getDecryptedOAuthToken,
    oauthProviderPrefix: oauthTools.oauthProviderPrefix,
    prioritizeOAuthAccount: oauthTools.prioritizeOAuthAccount,
    refreshGoogleToken: oauthTools.refreshGoogleToken,
    rotateOAuthAccounts: oauthTools.rotateOAuthAccounts,

    // ── Functions from credentialTools ─────────────────────────────────
    fileExistsNonEmpty: credentialTools.fileExistsNonEmpty,
    freshGeminiToken: credentialTools.freshGeminiToken,
    getGeminiProjectId: credentialTools.getGeminiProjectId,
    jsonHasKey: credentialTools.jsonHasKey,
    readClaudeToken: credentialTools.readClaudeToken,
    readCodexTokens: credentialTools.readCodexTokens,
    readGeminiCreds: credentialTools.readGeminiCreds,
    readGeminiCredsFromFile: credentialTools.readGeminiCredsFromFile,
    readGeminiCredsFromKeychain: credentialTools.readGeminiCredsFromKeychain,

    // ── Functions from helpers ─────────────────────────────────────────
    consumeOAuthState: helpers.consumeOAuthState,
    upsertOAuthCredential: helpers.upsertOAuthCredential,
    startGitHubOAuth: helpers.startGitHubOAuth,
    startGoogleAntigravityOAuth: helpers.startGoogleAntigravityOAuth,
    handleGitHubCallback: helpers.handleGitHubCallback,
    handleGoogleAntigravityCallback: helpers.handleGoogleAntigravityCallback,

    // ── Functions from statusBuilder ───────────────────────────────────
    buildOAuthStatus: statusBuilder.buildOAuthStatus,
  };
}
