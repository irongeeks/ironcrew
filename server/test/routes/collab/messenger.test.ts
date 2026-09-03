import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Unit tests for messenger session/send routes defined in
 * server/modules/routes/core.ts (GET /api/messenger/sessions, POST /api/messenger/send).
 *
 * The routes are inline inside registerRoutesPartA which requires a full
 * RuntimeContext. Instead of wiring up the entire context we build a minimal
 * Express app that mirrors the route handlers and mock the gateway/client and
 * messenger/channels dependencies directly.
 */

// ---------------------------------------------------------------------------
// Mocks for gateway client functions
// ---------------------------------------------------------------------------

const listMessengerSessionsMock = vi.fn<() => unknown[]>().mockReturnValue([]);
const sendMessengerMessageMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const sendMessengerSessionMessageMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

vi.mock("../../../gateway/client.ts", () => ({
  listMessengerSessions: (...args: unknown[]) => listMessengerSessionsMock(...(args as [])),
  sendMessengerMessage: (...args: unknown[]) => sendMessengerMessageMock(...(args as [])),
  sendMessengerSessionMessage: (...args: unknown[]) => sendMessengerSessionMessageMock(...(args as [])),
}));

// ---------------------------------------------------------------------------
// Re-use real channel helpers — they are pure functions with no side-effects
// ---------------------------------------------------------------------------

import { isMessengerChannel, isNativeMessengerChannel } from "../../../messenger/channels.ts";

// ---------------------------------------------------------------------------
// Minimal normalizeTextField (mirrors the one on RuntimeContext)
// ---------------------------------------------------------------------------

function normalizeTextField(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim();
}

// ---------------------------------------------------------------------------
// Build Express app that mirrors the messenger routes from core.ts
// ---------------------------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json());

  // GET /api/messenger/sessions
  app.get("/api/messenger/sessions", (_req, res) => {
    try {
      const sessions = listMessengerSessionsMock();
      res.json({ ok: true, sessions });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // POST /api/messenger/send — mirrors the handler in core.ts lines 155–203
  app.post("/api/messenger/send", async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        sessionKey?: string;
        channel?: string;
        targetId?: string;
        text?: string;
      };
      const text = normalizeTextField(body.text);
      if (!text) {
        return res.status(400).json({ ok: false, error: "text required" });
      }

      const sessionKey = normalizeTextField(body.sessionKey);
      if (sessionKey) {
        const sessionChannelHint = sessionKey.split(":", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          sessionChannelHint &&
          isMessengerChannel(sessionChannelHint) &&
          !isNativeMessengerChannel(sessionChannelHint)
        ) {
          return res.status(400).json({ ok: false, error: `channel transport not implemented: ${sessionChannelHint}` });
        }
        await sendMessengerSessionMessageMock(sessionKey, text);
        return res.json({ ok: true });
      }

      const channel = normalizeTextField(body.channel);
      const targetId = normalizeTextField(body.targetId);
      if (!channel || !targetId) {
        return res.status(400).json({ ok: false, error: "sessionKey or channel/targetId required" });
      }
      if (!isMessengerChannel(channel)) {
        return res.status(400).json({ ok: false, error: "unsupported channel" });
      }
      if (!isNativeMessengerChannel(channel)) {
        return res.status(400).json({ ok: false, error: `channel transport not implemented: ${channel}` });
      }

      await sendMessengerMessageMock({ channel, targetId, text });
      return res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Messenger routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMessengerSessionsMock.mockReturnValue([]);
    sendMessengerMessageMock.mockResolvedValue(undefined);
    sendMessengerSessionMessageMock.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // GET /api/messenger/sessions
  // -------------------------------------------------------------------------

  describe("GET /api/messenger/sessions", () => {
    it("returns an empty session list", async () => {
      const app = createApp();
      const res = await request(app).get("/api/messenger/sessions");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, sessions: [] });
      expect(listMessengerSessionsMock).toHaveBeenCalledOnce();
    });

    it("returns populated session list", async () => {
      const sessions = [
        { channel: "telegram", targetId: "12345", active: true },
        { channel: "discord", targetId: "67890", active: false },
      ];
      listMessengerSessionsMock.mockReturnValue(sessions);

      const app = createApp();
      const res = await request(app).get("/api/messenger/sessions");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, sessions });
    });

    it("returns 500 when listMessengerSessions throws", async () => {
      listMessengerSessionsMock.mockImplementation(() => {
        throw new Error("db gone");
      });

      const app = createApp();
      const res = await request(app).get("/api/messenger/sessions");

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("db gone");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/messenger/send — validation
  // -------------------------------------------------------------------------

  describe("POST /api/messenger/send", () => {
    it("rejects empty body with 400", async () => {
      const app = createApp();
      const res = await request(app).post("/api/messenger/send").send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "text required" });
    });

    it("rejects when text is missing", async () => {
      const app = createApp();
      const res = await request(app).post("/api/messenger/send").send({ channel: "telegram", targetId: "123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("text required");
    });

    it("rejects when text is whitespace-only", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/messenger/send")
        .send({ text: "   ", channel: "telegram", targetId: "123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("text required");
    });

    it("rejects when neither sessionKey nor channel/targetId are provided", async () => {
      const app = createApp();
      const res = await request(app).post("/api/messenger/send").send({ text: "hello" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("sessionKey or channel/targetId required");
    });

    it("rejects unsupported channel", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/messenger/send")
        .send({ text: "hello", channel: "pigeon", targetId: "123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("unsupported channel");
    });

    // -----------------------------------------------------------------------
    // Successful sends
    // -----------------------------------------------------------------------

    it("sends via sessionKey and returns ok", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/messenger/send")
        .send({ text: "hello world", sessionKey: "telegram:abc123" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(sendMessengerSessionMessageMock).toHaveBeenCalledWith("telegram:abc123", "hello world");
    });

    it("sends via channel/targetId and returns ok", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/messenger/send")
        .send({ text: "hi there", channel: "telegram", targetId: "55555" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(sendMessengerMessageMock).toHaveBeenCalledWith({
        channel: "telegram",
        targetId: "55555",
        text: "hi there",
      });
    });

    it("returns 500 when sendMessengerSessionMessage throws", async () => {
      sendMessengerSessionMessageMock.mockRejectedValue(new Error("no token configured"));

      const app = createApp();
      const res = await request(app).post("/api/messenger/send").send({ text: "hello", sessionKey: "telegram:abc" });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("no token configured");
    });

    it("returns 500 when sendMessengerMessage throws", async () => {
      sendMessengerMessageMock.mockRejectedValue(new Error("network error"));

      const app = createApp();
      const res = await request(app)
        .post("/api/messenger/send")
        .send({ text: "hello", channel: "discord", targetId: "999" });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("network error");
    });
  });
});
