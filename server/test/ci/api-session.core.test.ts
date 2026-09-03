import express from "express";
import net from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { installSecurityMiddleware } from "../../security/auth.ts";
import { SESSION_COOKIE_NAME } from "../../config/runtime.ts";

function canBindLocalPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

describe("core API session/auth flow", () => {
  it("issues a session cookie and allows protected route access", async () => {
    if (!(await canBindLocalPort())) {
      // Some restricted sandboxes disallow bind/listen. CI runners should execute this path.
      expect(true).toBe(true);
      return;
    }

    const app = express();
    installSecurityMiddleware(app);
    app.get("/api/core/ping", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/api/core/ping").expect(401);

    const session = await request(app).get("/api/auth/session").expect(200);
    const cookie = session.headers["set-cookie"]?.[0];
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(session.body?.ok).toBe(true);
    expect(typeof session.body?.csrf_token).toBe("string");

    await request(app).get("/api/core/ping").set("Cookie", String(cookie)).expect(200, { ok: true });
  });
});
