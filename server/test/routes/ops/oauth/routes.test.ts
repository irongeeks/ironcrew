import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock oauth/helpers (module-level constants + crypto helpers)
// ---------------------------------------------------------------------------

/**
 * Mutable state object for controlling mock returns.
 * Declared before vi.mock so hoisted factory closures can reference it.
 */
const _oauthMockState = {
  encryptionSecret: "test-secret-key",
  githubClientId: "gh-client-id",
  googleClientId: "google-client-id",
  googleClientSecret: "google-client-secret",
};

vi.mock("../../../../oauth/helpers.ts", () => ({
  get OAUTH_ENCRYPTION_SECRET() {
    return _oauthMockState.encryptionSecret;
  },
  get BUILTIN_GITHUB_CLIENT_ID() {
    return _oauthMockState.githubClientId;
  },
  get BUILTIN_GOOGLE_CLIENT_ID() {
    return _oauthMockState.googleClientId;
  },
  get BUILTIN_GOOGLE_CLIENT_SECRET() {
    return _oauthMockState.googleClientSecret;
  },
  OAUTH_BASE_URL: "http://localhost:8790",
  OAUTH_STATE_TTL_MS: 600_000,
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => v.replace(/^enc:/, ""),
  sanitizeOAuthRedirect: (raw: string | undefined) => raw || "/",
  appendOAuthQuery: (url: string, key: string, val: string) => {
    const u = new URL(url);
    u.searchParams.set(key, val);
    return u.toString();
  },
  b64url: (buf: Buffer) => buf.toString("base64url"),
  pkceVerifier: () => "test-pkce-verifier",
}));

// ---------------------------------------------------------------------------
// Mock functions for OAuth helpers & status (injected via OAuthContext)
// ---------------------------------------------------------------------------

const mockStartGitHubOAuth = vi.fn();
const mockStartGoogleAntigravityOAuth = vi.fn();
const mockHandleGitHubCallback = vi.fn();
const mockHandleGoogleAntigravityCallback = vi.fn();
const mockUpsertOAuthCredential = vi.fn();
const mockBuildOAuthStatus = vi.fn();

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock("../../../../observability/logger.ts", () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Mock auth — allow all requests through in tests
// ---------------------------------------------------------------------------

vi.mock("../../../../security/auth.ts", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ---------------------------------------------------------------------------
// Mock fetch (global)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

type DbGetResult = unknown;
type DbAllResult = unknown[];
type DbRunResult = { changes: number };

let dbGetResult: DbGetResult = undefined;
let dbAllResult: DbAllResult = [];
let dbRunResult: DbRunResult = { changes: 0 };
let dbGetFn: ReturnType<typeof vi.fn>;
let dbRunFn: ReturnType<typeof vi.fn>;

function createMockDb() {
  dbGetFn = vi.fn(() => dbGetResult);
  dbRunFn = vi.fn(() => dbRunResult);
  return {
    prepare: () => ({
      get: dbGetFn,
      all: () => dbAllResult,
      run: dbRunFn,
    }),
  };
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

import { registerOAuthRoutes } from "../../../../modules/routes/ops/oauth/routes.ts";

function createTestApp() {
  const app = express();
  app.use(express.json());
  const db = createMockDb();

  const ensureOAuthActiveAccount = vi.fn();
  const getActiveOAuthAccountIds = vi.fn(() => [] as string[]);
  const setOAuthActiveAccounts = vi.fn();
  const setActiveOAuthAccount = vi.fn();
  const removeActiveOAuthAccount = vi.fn();

  const base = {
    db,
    nowMs: () => Date.now(),
    firstQueryValue: (v: unknown) => {
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      return undefined;
    },
    ensureOAuthActiveAccount,
    getActiveOAuthAccountIds,
    setOAuthActiveAccounts,
    setActiveOAuthAccount,
    removeActiveOAuthAccount,
  } as any;

  const oauth = {
    normalizeOAuthProvider: (p: string) => {
      if (p === "github" || p === "github-copilot") return "github";
      if (p === "antigravity" || p === "google_antigravity") return "google_antigravity";
      return null;
    },
    getOAuthAccounts: vi.fn(() => []),
    getPreferredOAuthAccounts: vi.fn(() => []),
    refreshGoogleToken: vi.fn(),
    handleGitHubCallback: mockHandleGitHubCallback,
    handleGoogleAntigravityCallback: mockHandleGoogleAntigravityCallback,
    startGitHubOAuth: mockStartGitHubOAuth,
    startGoogleAntigravityOAuth: mockStartGoogleAntigravityOAuth,
    upsertOAuthCredential: mockUpsertOAuthCredential,
    buildOAuthStatus: mockBuildOAuthStatus,
  } as any;

  // Expose a merged ctx for backward-compatible test assertions
  const ctx = { ...base, ...oauth, app };

  registerOAuthRoutes(app, oauth, base);
  return { app, db, ctx };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth Routes", () => {
  let app: express.Express;
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    _oauthMockState.encryptionSecret = "test-secret-key";
    _oauthMockState.githubClientId = "gh-client-id";
    _oauthMockState.googleClientId = "google-client-id";
    _oauthMockState.googleClientSecret = "google-client-secret";
    dbGetResult = undefined;
    dbAllResult = [];
    dbRunResult = { changes: 0 };
    const testApp = createTestApp();
    app = testApp.app;
    ctx = testApp.ctx;
  });

  // =========================================================================
  // GET /api/oauth/status
  // =========================================================================

  describe("GET /api/oauth/status", () => {
    it("returns status with storageReady true when encryption secret is set", async () => {
      const mockStatus = {
        "github-copilot": { connected: false, detected: false },
        antigravity: { connected: false, detected: false },
      };
      mockBuildOAuthStatus.mockResolvedValue(mockStatus);

      const res = await request(app).get("/api/oauth/status");

      expect(res.status).toBe(200);
      expect(res.body.storageReady).toBe(true);
      expect(res.body.providers).toEqual(mockStatus);
    });

    it("returns 500 when buildOAuthStatus throws", async () => {
      mockBuildOAuthStatus.mockRejectedValue(new Error("db error"));

      const res = await request(app).get("/api/oauth/status");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to build OAuth status");
    });
  });

  // =========================================================================
  // GET /api/oauth/start
  // =========================================================================

  describe("GET /api/oauth/start", () => {
    it("redirects to GitHub authorize URL for github-copilot provider", async () => {
      mockStartGitHubOAuth.mockReturnValue("https://github.com/login/oauth/authorize?client_id=gh-client-id");

      const res = await request(app).get("/api/oauth/start?provider=github-copilot");

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://github.com/login/oauth/authorize?client_id=gh-client-id");
      expect(mockStartGitHubOAuth).toHaveBeenCalledWith("/", "/api/oauth/callback/github-copilot");
    });

    it("redirects to Google authorize URL for antigravity provider", async () => {
      mockStartGoogleAntigravityOAuth.mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?foo=bar");

      const res = await request(app).get("/api/oauth/start?provider=antigravity");

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://accounts.google.com/o/oauth2/v2/auth?foo=bar");
      expect(mockStartGoogleAntigravityOAuth).toHaveBeenCalledWith("/", "/api/oauth/callback/antigravity");
    });

    it("passes redirect_to parameter through", async () => {
      mockStartGitHubOAuth.mockReturnValue("https://github.com/login/oauth/authorize");

      await request(app).get("/api/oauth/start?provider=github-copilot&redirect_to=/settings");

      expect(mockStartGitHubOAuth).toHaveBeenCalledWith("/settings", "/api/oauth/callback/github-copilot");
    });

    it("returns 400 for unsupported provider", async () => {
      const res = await request(app).get("/api/oauth/start?provider=unknown");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported provider");
    });

    it("returns 400 when provider is missing", async () => {
      const res = await request(app).get("/api/oauth/start");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported provider");
    });

    it("returns 503 when GitHub client ID is not configured", async () => {
      _oauthMockState.githubClientId = "";

      const testApp = createTestApp();

      const res = await request(testApp.app).get("/api/oauth/start?provider=github-copilot");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("oauth_not_configured");
    });

    it("returns 503 when Google client ID is not configured", async () => {
      _oauthMockState.googleClientId = "";

      const testApp = createTestApp();

      const res = await request(testApp.app).get("/api/oauth/start?provider=antigravity");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("oauth_not_configured");
    });

    it("returns 503 when Google client secret is not configured", async () => {
      _oauthMockState.googleClientSecret = "";

      const testApp = createTestApp();

      const res = await request(testApp.app).get("/api/oauth/start?provider=antigravity");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("oauth_not_configured");
    });

    it("returns 500 when startGitHubOAuth throws", async () => {
      mockStartGitHubOAuth.mockImplementation(() => {
        throw new Error("OAuth start failed");
      });

      const res = await request(app).get("/api/oauth/start?provider=github-copilot");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("OAuth start failed");
    });
  });

  // =========================================================================
  // GET /api/oauth/callback/github-copilot
  // =========================================================================

  describe("GET /api/oauth/callback/github-copilot", () => {
    it("redirects to result URL on successful callback", async () => {
      mockHandleGitHubCallback.mockResolvedValue({
        redirectTo: "http://localhost:8790/?oauth=github-copilot",
      });

      const res = await request(app).get("/api/oauth/callback/github-copilot?code=abc123&state=state-uuid");

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("http://localhost:8790/?oauth=github-copilot");
      expect(mockHandleGitHubCallback).toHaveBeenCalledWith(
        "abc123",
        "state-uuid",
        "/api/oauth/callback/github-copilot",
      );
    });

    it("redirects with oauth_error when code is missing", async () => {
      const res = await request(app).get("/api/oauth/callback/github-copilot?state=state-uuid");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("oauth_error=missing_code");
    });

    it("redirects with oauth_error when state is missing", async () => {
      const res = await request(app).get("/api/oauth/callback/github-copilot?code=abc123");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("oauth_error=missing_code");
    });

    it("redirects with oauth_error when error query param is present", async () => {
      const res = await request(app).get("/api/oauth/callback/github-copilot?error=access_denied&code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("oauth_error=access_denied");
    });

    it("redirects with error message when handleGitHubCallback throws", async () => {
      mockHandleGitHubCallback.mockRejectedValue(new Error("Invalid or expired state"));

      const res = await request(app).get("/api/oauth/callback/github-copilot?code=abc123&state=bad-state");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("oauth_error=Invalid+or+expired+state");
    });
  });

  // =========================================================================
  // GET /api/oauth/callback/antigravity
  // =========================================================================

  describe("GET /api/oauth/callback/antigravity", () => {
    it("redirects to result URL on successful callback", async () => {
      mockHandleGoogleAntigravityCallback.mockResolvedValue({
        redirectTo: "http://localhost:8790/?oauth=antigravity",
      });

      const res = await request(app).get("/api/oauth/callback/antigravity?code=gcode&state=gstate");

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("http://localhost:8790/?oauth=antigravity");
      expect(mockHandleGoogleAntigravityCallback).toHaveBeenCalledWith(
        "gcode",
        "gstate",
        "/api/oauth/callback/antigravity",
      );
    });

    it("redirects with oauth_error when code is missing", async () => {
      const res = await request(app).get("/api/oauth/callback/antigravity?state=gstate");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("oauth_error=missing_code");
    });

    it("redirects with oauth_error when error param is present", async () => {
      const res = await request(app).get("/api/oauth/callback/antigravity?error=access_denied&code=x&state=y");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("oauth_error=access_denied");
    });

    it("returns 503 when Google credentials are not configured", async () => {
      _oauthMockState.googleClientId = "";
      _oauthMockState.googleClientSecret = "";

      const testApp = createTestApp();

      const res = await request(testApp.app).get("/api/oauth/callback/antigravity?code=x&state=y");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("oauth_not_configured");
    });

    it("redirects with error when handleGoogleAntigravityCallback throws", async () => {
      mockHandleGoogleAntigravityCallback.mockRejectedValue(new Error("Token exchange failed"));

      const res = await request(app).get("/api/oauth/callback/antigravity?code=gcode&state=gstate");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("oauth_error=Token+exchange+failed");
    });
  });

  // =========================================================================
  // POST /api/oauth/github-copilot/device-start
  // =========================================================================

  describe("POST /api/oauth/github-copilot/device-start", () => {
    it("returns device code info on success", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          device_code: "dev-code-123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      });

      const res = await request(app).post("/api/oauth/github-copilot/device-start");

      expect(res.status).toBe(200);
      expect(res.body.userCode).toBe("ABCD-1234");
      expect(res.body.verificationUri).toBe("https://github.com/login/device");
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.interval).toBe(5);
      expect(res.body.stateId).toBeDefined();
    });

    it("returns 400 when OAUTH_ENCRYPTION_SECRET is not set", async () => {
      _oauthMockState.encryptionSecret = "";

      const testApp = createTestApp();

      const res = await request(testApp.app).post("/api/oauth/github-copilot/device-start");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("missing_OAUTH_ENCRYPTION_SECRET");
    });

    it("returns 503 when GitHub client ID is missing", async () => {
      _oauthMockState.githubClientId = "";

      const testApp = createTestApp();

      const res = await request(testApp.app).post("/api/oauth/github-copilot/device-start");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("oauth_not_configured");
    });

    it("returns 502 when GitHub device code request fails", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 422 });

      const res = await request(app).post("/api/oauth/github-copilot/device-start");

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("github_device_code_failed");
    });

    it("returns 502 when device code response is invalid", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ device_code: null, user_code: null }),
      });

      const res = await request(app).post("/api/oauth/github-copilot/device-start");

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("github_device_code_invalid");
    });

    it("returns 500 when fetch throws", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const res = await request(app).post("/api/oauth/github-copilot/device-start");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("github_device_start_failed");
    });
  });

  // =========================================================================
  // POST /api/oauth/github-copilot/device-poll
  // =========================================================================

  describe("POST /api/oauth/github-copilot/device-poll", () => {
    it("returns 400 when stateId is missing", async () => {
      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("stateId is required");
    });

    it("returns 400 when stateId is not a string", async () => {
      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_failed");
    });

    it("returns invalid_state when state row not found", async () => {
      dbGetResult = undefined;

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "nonexistent" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_state");
    });

    it("returns expired when state TTL exceeded", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now() - 700_000, // exceeds 600_000 TTL
      };

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "expired-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
    });

    it("returns pending when authorization_pending", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ error: "authorization_pending" }),
      });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
    });

    it("returns slow_down status", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ error: "slow_down" }),
      });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("slow_down");
    });

    it("returns complete with email on successful token exchange", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "gho_abc123", scope: "repo user:email" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ email: "user@example.com", primary: true, verified: true }],
        });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("complete");
      expect(res.body.email).toBe("user@example.com");
      expect(mockUpsertOAuthCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "github",
          access_token: "gho_abc123",
          scope: "repo user:email",
        }),
      );
    });

    it("returns complete with null email when email fetch fails", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "gho_abc123", scope: "" }),
        })
        .mockResolvedValueOnce({ ok: false });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("complete");
      expect(res.body.email).toBeNull();
    });

    it("returns expired when token is expired_token", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ error: "expired_token" }),
      });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
    });

    it("returns denied when access_denied", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ error: "access_denied" }),
      });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("denied");
    });

    it("returns 502 when GitHub poll request fails", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("github_poll_failed");
    });

    it("returns 500 when fetch throws", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch.mockRejectedValue(new Error("Network error"));

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("github_poll_error");
    });

    it("returns error status for unknown error types", async () => {
      dbGetResult = {
        provider: "github",
        verifier_enc: "enc:device-code",
        redirect_to: null,
        created_at: Date.now(),
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ error: "some_other_error" }),
      });

      const res = await request(app).post("/api/oauth/github-copilot/device-poll").send({ stateId: "valid-state" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("error");
      expect(res.body.error).toBe("some_other_error");
    });
  });

  // =========================================================================
  // POST /api/oauth/disconnect
  // =========================================================================

  describe("POST /api/oauth/disconnect", () => {
    it("disconnects entire provider when no account_id given", async () => {
      const res = await request(app).post("/api/oauth/disconnect").send({ provider: "github" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("disconnects specific account by account_id", async () => {
      // Simulate remaining accounts = 0 after deletion
      dbGetResult = { cnt: 0 };

      const res = await request(app)
        .post("/api/oauth/disconnect")
        .send({ provider: "github-copilot", account_id: "acc-123" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ctx.ensureOAuthActiveAccount).toHaveBeenCalledWith("github");
    });

    it("returns 400 for invalid provider", async () => {
      const res = await request(app).post("/api/oauth/disconnect").send({ provider: "invalid" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid provider");
    });

    it("returns 400 for empty provider", async () => {
      const res = await request(app).post("/api/oauth/disconnect").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_failed");
    });
  });

  // =========================================================================
  // POST /api/oauth/refresh
  // =========================================================================

  describe("POST /api/oauth/refresh", () => {
    it("returns 400 for non-google_antigravity provider", async () => {
      const res = await request(app).post("/api/oauth/refresh").send({ provider: "github" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported provider for refresh");
    });

    it("returns 404 when no credential found", async () => {
      ctx.getPreferredOAuthAccounts.mockReturnValue([]);

      const res = await request(app).post("/api/oauth/refresh").send({ provider: "antigravity" });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No credential found");
    });

    it("returns 400 when no refresh token available", async () => {
      ctx.getPreferredOAuthAccounts.mockReturnValue([
        { id: "acc-1", provider: "google_antigravity", accessToken: "at", refreshToken: null },
      ]);

      const res = await request(app).post("/api/oauth/refresh").send({ provider: "antigravity" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No refresh token available");
    });

    it("refreshes token successfully", async () => {
      ctx.getPreferredOAuthAccounts.mockReturnValue([
        { id: "acc-1", provider: "google_antigravity", accessToken: "at", refreshToken: "rt" },
      ]);
      ctx.refreshGoogleToken.mockResolvedValue(undefined);
      dbGetResult = { expires_at: Date.now() + 3600_000, updated_at: Date.now() };

      const res = await request(app).post("/api/oauth/refresh").send({ provider: "antigravity" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.account_id).toBe("acc-1");
      expect(ctx.refreshGoogleToken).toHaveBeenCalled();
    });

    it("refreshes with specific account_id", async () => {
      ctx.getOAuthAccounts.mockReturnValue([
        { id: "acc-2", provider: "google_antigravity", accessToken: "at", refreshToken: "rt" },
      ]);
      ctx.refreshGoogleToken.mockResolvedValue(undefined);
      dbGetResult = { expires_at: Date.now() + 3600_000, updated_at: Date.now() };

      const res = await request(app).post("/api/oauth/refresh").send({ provider: "antigravity", account_id: "acc-2" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.account_id).toBe("acc-2");
    });

    it("returns 500 when refreshGoogleToken throws", async () => {
      ctx.getPreferredOAuthAccounts.mockReturnValue([
        { id: "acc-1", provider: "google_antigravity", accessToken: "at", refreshToken: "rt" },
      ]);
      ctx.refreshGoogleToken.mockRejectedValue(new Error("Refresh failed"));

      const res = await request(app).post("/api/oauth/refresh").send({ provider: "antigravity" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Refresh failed");
    });
  });

  // =========================================================================
  // POST /api/oauth/accounts/activate
  // =========================================================================

  describe("POST /api/oauth/accounts/activate", () => {
    it("returns 400 when provider is missing", async () => {
      const res = await request(app).post("/api/oauth/accounts/activate").send({ account_id: "acc-1" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_failed");
    });

    it("returns 400 when account_id is missing", async () => {
      const res = await request(app).post("/api/oauth/accounts/activate").send({ provider: "github" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_failed");
    });

    it("returns 404 when account not found", async () => {
      dbGetResult = undefined;

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "nonexistent" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("account_not_found");
    });

    it("returns 400 when account is disabled and mode is exclusive", async () => {
      dbGetResult = { id: "acc-1", status: "disabled" };

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "acc-1", mode: "exclusive" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("account_disabled");
    });

    it("activates account in exclusive mode (default)", async () => {
      dbGetResult = { id: "acc-1", status: "active" };
      ctx.getActiveOAuthAccountIds.mockReturnValue(["acc-1"]);

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "acc-1" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ctx.setOAuthActiveAccounts).toHaveBeenCalledWith("github", ["acc-1"]);
    });

    it("activates account in add mode", async () => {
      dbGetResult = { id: "acc-2", status: "active" };
      ctx.getActiveOAuthAccountIds.mockReturnValue(["acc-1", "acc-2"]);

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "acc-2", mode: "add" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ctx.setActiveOAuthAccount).toHaveBeenCalledWith("github", "acc-2");
    });

    it("deactivates account in remove mode", async () => {
      dbGetResult = { id: "acc-1", status: "active" };
      ctx.getActiveOAuthAccountIds.mockReturnValue(["acc-2"]);

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "acc-1", mode: "remove" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ctx.removeActiveOAuthAccount).toHaveBeenCalledWith("github", "acc-1");
    });

    it("toggles account off when currently active", async () => {
      dbGetResult = { id: "acc-1", status: "active" };
      ctx.getActiveOAuthAccountIds
        .mockReturnValueOnce(new Set(["acc-1"]) as any) // for toggle check
        .mockReturnValue(["acc-2"]); // after toggle

      // The route reads getActiveOAuthAccountIds into a Set for toggle check
      // but actually it calls getActiveOAuthAccountIds which returns an array
      ctx.getActiveOAuthAccountIds.mockReturnValue(["acc-1"]);

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "acc-1", mode: "toggle" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ctx.removeActiveOAuthAccount).toHaveBeenCalledWith("github", "acc-1");
    });

    it("returns 400 for invalid mode", async () => {
      dbGetResult = { id: "acc-1", status: "active" };

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "acc-1", mode: "invalid" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_failed");
    });

    it("falls back to ensureOAuthActiveAccount when remove leaves no active accounts and no fallback", async () => {
      // First get: find the account; second get: fallback query returns undefined
      let getCallCount = 0;
      dbGetFn.mockImplementation(() => {
        getCallCount++;
        if (getCallCount === 1) return { id: "acc-1", status: "active" };
        return undefined; // no fallback account
      });
      ctx.getActiveOAuthAccountIds.mockReturnValue([]);

      const res = await request(app)
        .post("/api/oauth/accounts/activate")
        .send({ provider: "github", account_id: "acc-1", mode: "remove" });

      expect(res.status).toBe(200);
      expect(ctx.ensureOAuthActiveAccount).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // PUT /api/oauth/accounts/:id
  // =========================================================================

  describe("PUT /api/oauth/accounts/:id", () => {
    it("returns 404 when account does not exist", async () => {
      dbGetResult = undefined;

      const res = await request(app).put("/api/oauth/accounts/nonexistent").send({ label: "My Account" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("account_not_found");
    });

    it("updates label successfully", async () => {
      // First call: get existing, second call: get provider after update
      let callCount = 0;
      dbGetFn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { id: "acc-1" };
        return { provider: "github" };
      });

      const res = await request(app).put("/api/oauth/accounts/acc-1").send({ label: "My GitHub" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ctx.ensureOAuthActiveAccount).toHaveBeenCalledWith("github");
    });

    it("updates status to disabled", async () => {
      let callCount = 0;
      dbGetFn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { id: "acc-1" };
        return { provider: "google_antigravity" };
      });

      const res = await request(app).put("/api/oauth/accounts/acc-1").send({ status: "disabled" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("updates priority with rounding", async () => {
      let callCount = 0;
      dbGetFn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { id: "acc-1" };
        return { provider: "github" };
      });

      const res = await request(app).put("/api/oauth/accounts/acc-1").send({ priority: 3.7 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("updates model_override", async () => {
      let callCount = 0;
      dbGetFn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { id: "acc-1" };
        return { provider: "github" };
      });

      const res = await request(app).put("/api/oauth/accounts/acc-1").send({ model_override: "gpt-4o" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
