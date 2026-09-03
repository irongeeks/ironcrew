import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyBaseSchema } from "../../modules/bootstrap/schema/base-schema.ts";
import { createOAuthContext, type OAuthDeps } from "../../contexts/oauth-context.ts";

// Ensure encryption secret is available for oauth helpers
process.env.OAUTH_ENCRYPTION_SECRET = "test-secret-for-oauth-context-tests-12345";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  // Add columns that initializeOAuthRuntime would normally add via ALTER TABLE
  try {
    db.exec("ALTER TABLE oauth_credentials ADD COLUMN access_token_enc TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE oauth_credentials ADD COLUMN refresh_token_enc TEXT");
  } catch {
    /* already exists */
  }
  return db;
}

function createTestDeps(db: DatabaseSync): OAuthDeps {
  return {
    db: db as unknown as OAuthDeps["db"],
    nowMs: () => Date.now(),
    ensureOAuthActiveAccount: () => {},
    getActiveOAuthAccountIds: () => [],
    setActiveOAuthAccount: () => {},
    setOAuthActiveAccounts: () => {},
    removeActiveOAuthAccount: () => {},
  };
}

describe("createOAuthContext", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns an object with expected credential tool functions", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(typeof ctx.readClaudeToken).toBe("function");
    expect(typeof ctx.readCodexTokens).toBe("function");
    expect(typeof ctx.readGeminiCreds).toBe("function");
    expect(typeof ctx.readGeminiCredsFromFile).toBe("function");
    expect(typeof ctx.readGeminiCredsFromKeychain).toBe("function");
    expect(typeof ctx.freshGeminiToken).toBe("function");
    expect(typeof ctx.getGeminiProjectId).toBe("function");
    expect(typeof ctx.fileExistsNonEmpty).toBe("function");
    expect(typeof ctx.jsonHasKey).toBe("function");
  });

  it("returns an object with expected OAuth tool functions", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(typeof ctx.normalizeOAuthProvider).toBe("function");
    expect(typeof ctx.oauthProviderPrefix).toBe("function");
    expect(typeof ctx.getOAuthAccountDisplayName).toBe("function");
    expect(typeof ctx.getNextOAuthLabel).toBe("function");
    expect(typeof ctx.getOAuthAutoSwapEnabled).toBe("function");
    expect(typeof ctx.rotateOAuthAccounts).toBe("function");
    expect(typeof ctx.prioritizeOAuthAccount).toBe("function");
    expect(typeof ctx.markOAuthAccountFailure).toBe("function");
    expect(typeof ctx.markOAuthAccountSuccess).toBe("function");
    expect(typeof ctx.getOAuthAccounts).toBe("function");
    expect(typeof ctx.getPreferredOAuthAccounts).toBe("function");
    expect(typeof ctx.getDecryptedOAuthToken).toBe("function");
    expect(typeof ctx.refreshGoogleToken).toBe("function");
    expect(typeof ctx.exchangeCopilotToken).toBe("function");
    expect(typeof ctx.loadCodeAssistProject).toBe("function");
  });

  it("exposes constants with correct values", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(typeof ctx.GEMINI_OAUTH_CLIENT_ID).toBe("string");
    expect(typeof ctx.GEMINI_OAUTH_CLIENT_SECRET).toBe("string");
    expect(ctx.GEMINI_PROJECT_TTL).toBe(300_000);
  });

  it("exposes cache properties with correct initial values", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(ctx.antigravityProjectCache).toBeNull();
    expect(ctx.copilotTokenCache).toBeNull();
    expect(ctx.geminiProjectCache).toBeNull();
    expect(ctx.oauthDispatchCursor).toBeInstanceOf(Map);
    expect(ctx.oauthDispatchCursor.size).toBe(0);
  });

  it("credential tools are callable — readClaudeToken returns string or null", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    // readClaudeToken looks for a keychain entry / file on disk; in CI it returns null
    const result = ctx.readClaudeToken();
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("credential tools are callable — fileExistsNonEmpty returns boolean", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(ctx.fileExistsNonEmpty("/nonexistent/path/to/file")).toBe(false);
  });

  it("credential tools are callable — jsonHasKey returns boolean", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(ctx.jsonHasKey("/nonexistent/path/to/file.json", "key")).toBe(false);
  });

  it("OAuth tools are callable — normalizeOAuthProvider normalises known providers", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(ctx.normalizeOAuthProvider("github")).toBe("github");
    expect(ctx.normalizeOAuthProvider("github-copilot")).toBe("github");
    expect(ctx.normalizeOAuthProvider("copilot")).toBe("github");
    expect(ctx.normalizeOAuthProvider("antigravity")).toBe("google_antigravity");
    expect(ctx.normalizeOAuthProvider("google_antigravity")).toBe("google_antigravity");
    expect(ctx.normalizeOAuthProvider("unknown")).toBeNull();
  });

  it("OAuth tools are callable — oauthProviderPrefix returns correct prefix", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(ctx.oauthProviderPrefix("github")).toBe("Copi");
    expect(ctx.oauthProviderPrefix("google_antigravity")).toBe("Anti");
  });

  it("OAuth tools are callable — getOAuthAccounts returns empty array for unknown provider", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(ctx.getOAuthAccounts("unknown_provider")).toEqual([]);
  });

  it("OAuth tools are callable — getOAuthAutoSwapEnabled returns boolean", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    // Default (no setting row) should return true
    expect(ctx.getOAuthAutoSwapEnabled()).toBe(true);
  });

  it("OAuth tools are callable — getDecryptedOAuthToken returns null when no accounts exist", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(ctx.getDecryptedOAuthToken("github")).toBeNull();
  });

  it("returns OAuth helper functions from createOAuthRouteHelpers", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(typeof ctx.consumeOAuthState).toBe("function");
    expect(typeof ctx.upsertOAuthCredential).toBe("function");
    expect(typeof ctx.startGitHubOAuth).toBe("function");
    expect(typeof ctx.startGoogleAntigravityOAuth).toBe("function");
    expect(typeof ctx.handleGitHubCallback).toBe("function");
    expect(typeof ctx.handleGoogleAntigravityCallback).toBe("function");
  });

  it("returns buildOAuthStatus from createOAuthStatusBuilder", () => {
    const ctx = createOAuthContext(createTestDeps(db));

    expect(typeof ctx.buildOAuthStatus).toBe("function");
  });
});
