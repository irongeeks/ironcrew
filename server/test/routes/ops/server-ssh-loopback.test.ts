import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";

// Mock the SSH connector and DB so routes can register without real infra
vi.mock("../../../modules/workflow/ssh/ssh-connector.ts", () => ({
  createSshConnector: vi.fn().mockReturnValue({
    testConnection: vi.fn().mockResolvedValue(true),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    listDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0, isDirectory: false }),
    downloadFile: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { registerServerSshRoutes } from "../../../modules/routes/ops/server-ssh.ts";
import { installSecurityMiddleware } from "../../../security/auth.ts";

function createApp(remoteAddress: string) {
  const app = express();

  // Override the socket remoteAddress for all requests
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress, writable: true });
    next();
  });

  installSecurityMiddleware(app);

  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: "srv-1",
        ssh_config_json: JSON.stringify({ host: "10.0.0.1", port: 22, username: "user", authMethod: "agent" }),
      }),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  };

  registerServerSshRoutes({ app, db: mockDb } as any);
  return app;
}

describe("SSH routes loopback guard", () => {
  it("returns 403 for non-loopback IP on ssh/exec", async () => {
    const app = createApp("10.0.0.5");
    await request(app)
      .post("/api/ops/servers/srv-1/ssh/exec")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .send({ command: "ls" })
      .expect(403);
  });

  it("returns 403 for non-loopback IP on fs/list", async () => {
    const app = createApp("10.0.0.5");
    await request(app)
      .get("/api/ops/servers/srv-1/fs/list")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .expect(403);
  });

  it("returns 403 for non-loopback IP on ssh/status", async () => {
    const app = createApp("10.0.0.5");
    await request(app)
      .get("/api/ops/servers/srv-1/ssh/status")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .expect(403);
  });

  it("allows 127.0.0.1 through on ssh/status", async () => {
    const app = createApp("127.0.0.1");
    const res = await request(app)
      .get("/api/ops/servers/srv-1/ssh/status")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`);
    // Should not be 403 — either 200 (connected) or some other non-403 status
    expect(res.status).not.toBe(403);
  });

  it("allows ::1 through on ssh/status", async () => {
    const app = createApp("::1");
    const res = await request(app)
      .get("/api/ops/servers/srv-1/ssh/status")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`);
    expect(res.status).not.toBe(403);
  });

  it("allows ::ffff:127.0.0.1 through on ssh/status", async () => {
    const app = createApp("::ffff:127.0.0.1");
    const res = await request(app)
      .get("/api/ops/servers/srv-1/ssh/status")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`);
    expect(res.status).not.toBe(403);
  });
});
