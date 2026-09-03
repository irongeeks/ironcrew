import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpConnector } from "../../connectors/built-in/mcp/mcp-connector.ts";
import type { McpServerConfig } from "../../connectors/built-in/mcp/mcp-config.ts";

// Mock the MCP SDK modules
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: "read_file", description: "Read a file from disk", inputSchema: { type: "object" } },
        { name: "write_file", description: "Write a file to disk", inputSchema: { type: "object" } },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "file contents here" }],
      isError: false,
    }),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

function makeStdioConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    name: "test-server",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    enabled: true,
    autoConnect: true,
    timeout_ms: 30_000,
    ...overrides,
  };
}

function makeSseConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    name: "test-sse",
    transport: "sse",
    url: "http://localhost:3001/sse",
    enabled: true,
    autoConnect: true,
    timeout_ms: 30_000,
    ...overrides,
  };
}

describe("McpConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("sets name with mcp: prefix", () => {
      const connector = new McpConnector(makeStdioConfig());
      expect(connector.name).toBe("mcp:test-server");
    });

    it("starts disconnected with no capabilities", () => {
      const connector = new McpConnector(makeStdioConfig());
      expect(connector.connected).toBe(false);
      expect(connector.capabilities).toEqual([]);
    });
  });

  describe("connect (stdio)", () => {
    it("connects and discovers tools", async () => {
      const connector = new McpConnector(makeStdioConfig());
      await connector.connect();

      expect(connector.connected).toBe(true);
      expect(connector.capabilities).toHaveLength(2);
      expect(connector.capabilities[0].name).toBe("read_file");
      expect(connector.capabilities[1].name).toBe("write_file");
    });

    it("throws if command is missing for stdio", async () => {
      const connector = new McpConnector(makeStdioConfig({ command: undefined }));
      await expect(connector.connect()).rejects.toThrow(/stdio transport requires a command/);
    });
  });

  describe("connect (SSE)", () => {
    it("connects via SSE transport", async () => {
      const connector = new McpConnector(makeSseConfig());
      await connector.connect();

      expect(connector.connected).toBe(true);
      expect(connector.capabilities).toHaveLength(2);
    });

    it("throws if url is missing for SSE", async () => {
      const connector = new McpConnector(makeSseConfig({ url: undefined }));
      await expect(connector.connect()).rejects.toThrow(/SSE transport requires a url/);
    });
  });

  describe("execute", () => {
    it("calls the tool and returns success result", async () => {
      const connector = new McpConnector(makeStdioConfig());
      await connector.connect();

      const result = await connector.execute("read_file", { path: "/tmp/test.txt" }, {});

      expect(result.status).toBe("success");
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].type).toBe("text");
      expect(result.artifacts[0].metadata?.output).toBe("file contents here");
    });

    it("returns error when not connected", async () => {
      const connector = new McpConnector(makeStdioConfig());
      const result = await connector.execute("read_file", {}, {});

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/not connected/);
    });
  });

  describe("getAgentGuidance", () => {
    it("returns guidance with tool description", async () => {
      const connector = new McpConnector(makeStdioConfig());
      await connector.connect();

      const guidance = connector.getAgentGuidance("read_file", {}, "en");

      expect(guidance).toContain("read_file");
      expect(guidance).toContain("test-server");
      expect(guidance).toContain("Read a file from disk");
    });

    it("returns generic guidance for unknown tools", () => {
      const connector = new McpConnector(makeStdioConfig());
      const guidance = connector.getAgentGuidance("unknown_tool", {}, "en");

      expect(guidance).toContain("unknown_tool");
      expect(guidance).toContain("test-server");
    });
  });

  describe("testConnection", () => {
    it("reports success when connected", async () => {
      const connector = new McpConnector(makeStdioConfig());
      await connector.connect();

      const result = await connector.testConnection({});
      expect(result.ok).toBe(true);
      expect(result.message).toContain("2 tools");
    });
  });

  describe("disconnect", () => {
    it("cleans up resources", async () => {
      const connector = new McpConnector(makeStdioConfig());
      await connector.connect();
      expect(connector.connected).toBe(true);

      await connector.disconnect();
      expect(connector.connected).toBe(false);
      expect(connector.capabilities).toEqual([]);
    });
  });

  describe("getStatus", () => {
    it("returns status with tool list when connected", async () => {
      const connector = new McpConnector(makeStdioConfig({ label: "Test Server" }));
      await connector.connect();

      const status = connector.getStatus();
      expect(status.name).toBe("test-server");
      expect(status.label).toBe("Test Server");
      expect(status.transport).toBe("stdio");
      expect(status.connected).toBe(true);
      expect(status.tools).toHaveLength(2);
    });

    it("returns disconnected status before connect", () => {
      const connector = new McpConnector(makeStdioConfig());
      const status = connector.getStatus();

      expect(status.connected).toBe(false);
      expect(status.tools).toEqual([]);
    });
  });
});
