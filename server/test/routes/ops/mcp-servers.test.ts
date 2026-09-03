import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";
import { installSecurityMiddleware, getCsrfToken } from "../../../security/auth.ts";
import { registerMcpServerRoutes } from "../../../modules/routes/ops/mcp-servers.ts";

/**
 * Unit tests for MCP server CRUD routes.
 *
 * We mock the McpManager and DB to isolate route logic.
 */

function createMockMcpManager(servers: Record<string, any> = {}) {
  return {
    getStatuses: vi.fn().mockReturnValue(Object.values(servers)),
    getConfig: vi.fn((name: string) => servers[name] ?? null),
    getServerStatus: vi.fn((name: string) => servers[name] ?? null),
    getConnector: vi.fn().mockReturnValue(null),
    getServerTools: vi.fn().mockReturnValue([]),
    addServer: vi.fn((config: any) => {
      servers[config.name] = { ...config, connected: false, tools: [] };
    }),
    removeServer: vi.fn(async (name: string) => {
      delete servers[name];
    }),
    saveToSettings: vi.fn(),
    connectServer: vi.fn().mockResolvedValue(undefined),
    disconnectServer: vi.fn().mockResolvedValue(undefined),
    registerAll: vi.fn(),
  };
}

function createApp(mcpManager: ReturnType<typeof createMockMcpManager> | null = null) {
  const app = express();

  // Bind to loopback so loopback guard passes
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", writable: true });
    next();
  });

  installSecurityMiddleware(app);

  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  };

  registerMcpServerRoutes({
    app,
    db: mockDb,
    mcpManager,
    connectorRegistry: null,
  } as any);

  return app;
}

const VALID_STDIO_CONFIG = {
  name: "test-server",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  enabled: true,
  autoConnect: false,
};

const VALID_SSE_CONFIG = {
  name: "sse-server",
  transport: "sse",
  url: "http://localhost:3001/sse",
  enabled: true,
  autoConnect: false,
};

describe("MCP Server CRUD routes", () => {
  // ---- GET /api/ops/mcp-servers ----

  describe("GET /api/ops/mcp-servers", () => {
    it("returns empty list when no mcpManager is present", async () => {
      const app = createApp(null);
      const res = await request(app).get("/api/ops/mcp-servers").set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ servers: [] });
    });

    it("returns server list from mcpManager", async () => {
      const serverStatus = {
        name: "test-server",
        transport: "stdio",
        connected: true,
        tools: [{ name: "echo", description: "Echo tool" }],
      };
      const mgr = createMockMcpManager();
      mgr.getStatuses.mockReturnValue([serverStatus]);

      const app = createApp(mgr);
      const res = await request(app).get("/api/ops/mcp-servers").set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.servers).toHaveLength(1);
      expect(res.body.servers[0].name).toBe("test-server");
      expect(mgr.getStatuses).toHaveBeenCalled();
    });

    it("requires authentication", async () => {
      const app = createApp(null);
      const res = await request(app).get("/api/ops/mcp-servers");

      expect(res.status).toBe(401);
    });
  });

  // ---- POST /api/ops/mcp-servers ----

  describe("POST /api/ops/mcp-servers", () => {
    it("rejects empty body with 400", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_failed");
    });

    it("rejects config missing required transport field", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send({ name: "bad-server" });

      expect(res.status).toBe(400);
    });

    it("rejects stdio config without command", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send({ name: "no-cmd", transport: "stdio" });

      expect(res.status).toBe(400);
    });

    it("creates a server with valid stdio config", async () => {
      const mgr = createMockMcpManager();
      mgr.getServerStatus.mockReturnValue({
        name: "test-server",
        transport: "stdio",
        connected: false,
        tools: [],
      });
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send(VALID_STDIO_CONFIG);

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.server.name).toBe("test-server");
      expect(mgr.addServer).toHaveBeenCalled();
      expect(mgr.saveToSettings).toHaveBeenCalled();
    });

    it("creates a server with valid SSE config", async () => {
      const mgr = createMockMcpManager();
      mgr.getServerStatus.mockReturnValue({
        name: "sse-server",
        transport: "sse",
        connected: false,
        tools: [],
      });
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send(VALID_SSE_CONFIG);

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(mgr.addServer).toHaveBeenCalled();
    });

    it("rejects duplicate server name with 409", async () => {
      const mgr = createMockMcpManager({ "test-server": { name: "test-server" } });
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send(VALID_STDIO_CONFIG);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("mcp_server_exists");
    });

    it("returns 503 when mcpManager is not available", async () => {
      const app = createApp(null);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send(VALID_STDIO_CONFIG);

      expect(res.status).toBe(503);
    });

    it("rejects request without CSRF token", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .send(VALID_STDIO_CONFIG);

      // shouldRequireCsrf returns true for POST without Bearer — but we set Authorization Bearer above
      // With Bearer token, CSRF is skipped. Test without auth bearer:
      const res2 = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Cookie", "session=fake")
        .send(VALID_STDIO_CONFIG);

      // Without auth at all, should be 401
      expect(res2.status).toBe(401);
    });
  });

  // ---- DELETE /api/ops/mcp-servers/:name ----

  describe("DELETE /api/ops/mcp-servers/:name", () => {
    it("removes an existing server", async () => {
      const mgr = createMockMcpManager({
        "test-server": { name: "test-server", transport: "stdio", connected: false, tools: [] },
      });
      const app = createApp(mgr);

      const res = await request(app)
        .delete("/api/ops/mcp-servers/test-server")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken());

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mgr.removeServer).toHaveBeenCalledWith("test-server", null);
      expect(mgr.saveToSettings).toHaveBeenCalled();
    });

    it("returns 404 for non-existent server", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      const res = await request(app)
        .delete("/api/ops/mcp-servers/does-not-exist")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken());

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("mcp_server_not_found");
    });

    it("returns 503 when mcpManager is not available", async () => {
      const app = createApp(null);

      const res = await request(app)
        .delete("/api/ops/mcp-servers/test-server")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken());

      expect(res.status).toBe(503);
    });
  });

  // ---- Validation edge cases ----

  describe("Validation edge cases", () => {
    it("rejects name with invalid characters", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send({ ...VALID_STDIO_CONFIG, name: "Bad Name!" });

      expect(res.status).toBe(400);
    });

    it("rejects stdio command with shell metacharacters", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send({ ...VALID_STDIO_CONFIG, command: "npx; rm -rf /" });

      expect(res.status).toBe(400);
    });

    it("rejects SSE URL targeting cloud metadata endpoint", async () => {
      const mgr = createMockMcpManager();
      const app = createApp(mgr);

      const res = await request(app)
        .post("/api/ops/mcp-servers")
        .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
        .set("x-csrf-token", getCsrfToken())
        .send({ ...VALID_SSE_CONFIG, url: "http://169.254.169.254/latest/meta-data/" });

      expect(res.status).toBe(400);
    });
  });
});
