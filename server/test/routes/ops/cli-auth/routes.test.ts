import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockStartSession = vi.fn();
const mockGetStatus = vi.fn();
const mockCancelSession = vi.fn();
vi.mock("../../../../modules/routes/ops/cli-auth/cli-auth-runner.ts", () => ({
  CliAuthRunner: vi.fn().mockImplementation(() => ({
    startSession: mockStartSession,
    getStatus: mockGetStatus,
    cancelSession: mockCancelSession,
    dispose: vi.fn(),
  })),
}));

import { registerCliAuthRoutes } from "../../../../modules/routes/ops/cli-auth/routes.ts";

describe("CLI Auth Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    registerCliAuthRoutes({
      app,
      detectAllCli: vi.fn().mockResolvedValue({}),
    } as any);
  });

  describe("POST /api/ops/cli-auth/:provider/start", () => {
    it("returns 200 with session data for valid provider", async () => {
      mockStartSession.mockResolvedValue({
        sessionId: "test-uuid",
        verificationUrl: "https://claude.com/cai/oauth/authorize?test",
        deviceCode: null,
        rawOutput: "Opening browser...",
      });
      const res = await request(app).post("/api/ops/cli-auth/claude/start").expect(200);
      expect(res.body.sessionId).toBe("test-uuid");
      expect(res.body.verificationUrl).toMatch(/claude\.com/);
    });

    it("returns 400 for unsupported provider", async () => {
      mockStartSession.mockRejectedValue(new Error("Unsupported provider: unknown"));
      await request(app).post("/api/ops/cli-auth/unknown/start").expect(400);
    });

    it("returns 409 when session already running", async () => {
      mockStartSession.mockRejectedValue(new Error("Auth session already running for claude"));
      await request(app).post("/api/ops/cli-auth/claude/start").expect(409);
    });
  });

  describe("GET /api/ops/cli-auth/:provider/status/:sessionId", () => {
    it("returns session status", async () => {
      mockGetStatus.mockResolvedValue({ status: "pending", authenticated: false, error: null });
      const res = await request(app).get("/api/ops/cli-auth/claude/status/test-uuid").expect(200);
      expect(res.body.status).toBe("pending");
    });
  });

  describe("POST /api/ops/cli-auth/:provider/cancel/:sessionId", () => {
    it("cancels a session", async () => {
      mockCancelSession.mockReturnValue({ cancelled: true });
      const res = await request(app).post("/api/ops/cli-auth/claude/cancel/test-uuid").expect(200);
      expect(res.body.cancelled).toBe(true);
    });
  });
});
