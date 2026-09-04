import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpManager } from "../../connectors/built-in/mcp/mcp-manager.ts";
import type { McpConnector as _McpConnectorType } from "../../connectors/built-in/mcp/mcp-connector.ts";
import { ConnectorRegistry } from "../../connectors/registry.ts";

// Mock McpConnector to avoid real MCP connections
vi.mock("../../connectors/built-in/mcp/mcp-connector.ts", () => ({
  McpConnector: vi.fn().mockImplementation((config) => ({
    name: `mcp:${config.name}`,
    capabilities: [
      { name: "tool_a", description: "Tool A", inputSchema: {}, outputSchema: {} },
      { name: "tool_b", description: "Tool B", inputSchema: {}, outputSchema: {} },
    ],
    connected: true,
    error: undefined,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      name: config.name,
      label: config.label,
      transport: config.transport,
      connected: true,
      tools: [
        { name: "tool_a", description: "Tool A" },
        { name: "tool_b", description: "Tool B" },
      ],
    }),
  })),
}));

function makeMockDb(settingsValue?: string) {
  const store = new Map<string, string>();
  if (settingsValue) store.set("mcp_servers", settingsValue);

  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      get: vi.fn().mockImplementation((...args: string[]) => {
        const key = args[0];
        if (sql.includes("SELECT") && store.has(key)) {
          return { value: store.get(key), key };
        }
        return undefined;
      }),
      run: vi.fn().mockImplementation((...args: string[]) => {
        if (sql.includes("INSERT") || sql.includes("UPDATE")) {
          // For INSERT: args = [key, value] or for UPDATE: args = [value, key]
          if (sql.includes("INSERT")) {
            store.set(args[0], args[1]);
          } else {
            store.set(args[1], args[0]);
          }
        }
      }),
    })),
  } as any;
}

describe("McpManager", () => {
  let manager: McpManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new McpManager();
  });

  describe("loadFromSettings", () => {
    it("loads server configs from the settings table", () => {
      const settings = JSON.stringify({
        servers: [
          {
            name: "fs",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@mcp/server-filesystem"],
            enabled: true,
            autoConnect: true,
            timeout_ms: 30000,
          },
          {
            name: "search",
            transport: "sse",
            url: "http://localhost:3002/sse",
            enabled: true,
            autoConnect: false,
            timeout_ms: 15000,
          },
        ],
      });
      const db = makeMockDb(settings);

      manager.loadFromSettings(db);

      const configs = manager.getAllConfigs();
      expect(configs).toHaveLength(2);
      expect(configs[0].name).toBe("fs");
      expect(configs[1].name).toBe("search");
    });

    it("handles missing settings gracefully", () => {
      const db = makeMockDb();
      manager.loadFromSettings(db);
      expect(manager.getAllConfigs()).toHaveLength(0);
    });

    it("handles invalid JSON gracefully", () => {
      const db = makeMockDb("not json");
      manager.loadFromSettings(db);
      expect(manager.getAllConfigs()).toHaveLength(0);
    });
  });

  describe("addServer / removeServer", () => {
    it("adds a server config", () => {
      manager.addServer({
        name: "test",
        transport: "stdio",
        command: "node",
        enabled: true,
        autoConnect: true,
        timeout_ms: 30000,
      });
      expect(manager.getConfig("test")).toBeDefined();
      expect(manager.getConfig("test")!.command).toBe("node");
    });

    it("removes a server config and disconnects", async () => {
      manager.addServer({
        name: "test",
        transport: "stdio",
        command: "node",
        enabled: true,
        autoConnect: true,
        timeout_ms: 30000,
      });
      await manager.removeServer("test");
      expect(manager.getConfig("test")).toBeUndefined();
    });
  });

  describe("connectAll", () => {
    it("connects enabled autoConnect servers", async () => {
      manager.addServer({
        name: "auto",
        transport: "stdio",
        command: "node",
        enabled: true,
        autoConnect: true,
        timeout_ms: 30000,
      });
      manager.addServer({
        name: "manual",
        transport: "stdio",
        command: "node",
        enabled: true,
        autoConnect: false,
        timeout_ms: 30000,
      });
      manager.addServer({
        name: "disabled",
        transport: "stdio",
        command: "node",
        enabled: false,
        autoConnect: true,
        timeout_ms: 30000,
      });

      await manager.connectAll();

      // Only "auto" should have a connector
      expect(manager.getConnector("auto")).toBeDefined();
      expect(manager.getConnector("manual")).toBeUndefined();
      expect(manager.getConnector("disabled")).toBeUndefined();
    });
  });

  describe("registerAll", () => {
    it("registers connectors and binds capabilities to the registry", async () => {
      manager.addServer({
        name: "test",
        transport: "stdio",
        command: "node",
        enabled: true,
        autoConnect: true,
        timeout_ms: 30000,
      });
      await manager.connectAll();

      const registry = new ConnectorRegistry();
      manager.registerAll(registry);

      // The mocked connector has tool_a and tool_b
      expect(registry.getConnector("mcp:test")).toBeDefined();
    });
  });

  describe("getStatuses", () => {
    it("returns status for all configured servers", async () => {
      manager.addServer({
        name: "connected",
        transport: "stdio",
        command: "node",
        enabled: true,
        autoConnect: true,
        timeout_ms: 30000,
      });
      manager.addServer({
        name: "pending",
        transport: "sse",
        url: "http://localhost:3001/sse",
        enabled: true,
        autoConnect: false,
        timeout_ms: 30000,
      });

      await manager.connectAll();

      const statuses = manager.getStatuses();
      expect(statuses).toHaveLength(2);

      const connectedStatus = statuses.find((s) => s.name === "connected");
      expect(connectedStatus?.connected).toBe(true);

      const pendingStatus = statuses.find((s) => s.name === "pending");
      expect(pendingStatus?.connected).toBe(false);
    });
  });

  describe("saveToSettings", () => {
    it("persists configs to the database", () => {
      const db = makeMockDb();
      manager.addServer({
        name: "save-test",
        transport: "stdio",
        command: "npx",
        enabled: true,
        autoConnect: true,
        timeout_ms: 30000,
      });
      manager.saveToSettings(db);

      expect(db.prepare).toHaveBeenCalled();
    });
  });

  describe("getServerTools", () => {
    it("returns tools from a connected server", async () => {
      manager.addServer({
        name: "tooled",
        transport: "stdio",
        command: "node",
        enabled: true,
        autoConnect: true,
        timeout_ms: 30000,
      });
      await manager.connectAll();

      const tools = manager.getServerTools("tooled");
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("tool_a");
    });

    it("returns empty array for unknown server", () => {
      expect(manager.getServerTools("unknown")).toEqual([]);
    });
  });
});

describe("McpManager — where a server runs", () => {
  const withSecret = {
    name: "github",
    transport: "stdio" as const,
    command: "npx",
    env: { GITHUB_TOKEN: { $secret: { provider: "vaultwarden" as const, itemRef: "GitHub MCP" } } },
    enabled: true,
    autoConnect: true,
    timeout_ms: 30_000,
  };
  const plain = { ...withSecret, name: "files", env: { NODE_ENV: "production" } };

  beforeEach(() => vi.clearAllMocks());

  it("marks a server whose credentials are references as needing the runner", () => {
    const manager = new McpManager();
    manager.addServer(withSecret);
    manager.addServer(plain);

    expect(manager.getServerStatus("github")?.needsRunner).toBe(true);
    expect(manager.getServerStatus("files")?.needsRunner).toBe(false);
  });

  it("builds connections through the injected factory, so a runner-backed one is possible", async () => {
    const built: string[] = [];
    const manager = new McpManager({
      createConnector: (config) => {
        built.push(config.name);
        return {
          name: `mcp:${config.name}`,
          capabilities: [],
          connect: async () => {},
          disconnect: async () => {},
          execute: async () => ({ status: "success" as const, artifacts: [] }),
          testConnection: async () => ({ ok: true, message: "" }),
          getStatus: () => ({ name: config.name, transport: config.transport, connected: true, tools: [] }),
        };
      },
    });
    manager.addServer(withSecret);
    await manager.connectServer("github");

    expect(built).toEqual(["github"]);
    expect(manager.getServerStatus("github")?.connected).toBe(true);
  });

  it("keeps the reason a connection failed, so a reload still explains the red dot", async () => {
    const manager = new McpManager({
      createConnector: (config) => ({
        name: `mcp:${config.name}`,
        capabilities: [],
        connect: async () => {
          throw new Error("Start it through the IronCrew runner (IRONCREW_RUNNER_SOCKET)");
        },
        disconnect: async () => {},
        execute: async () => ({ status: "success" as const, artifacts: [] }),
        testConnection: async () => ({ ok: true, message: "" }),
        getStatus: () => ({ name: config.name, transport: config.transport, connected: false, tools: [] }),
      }),
    });
    manager.addServer(withSecret);

    await expect(manager.connectServer("github")).rejects.toThrow();
    expect(manager.getServerStatus("github")?.error).toContain("IRONCREW_RUNNER_SOCKET");
    expect(manager.getServerStatus("github")?.connected).toBe(false);
  });
});
