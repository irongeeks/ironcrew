import { describe, expect, it } from "vitest";
import { McpServerConfigSchema, McpSettingsSchema } from "../../connectors/built-in/mcp/mcp-config.ts";

// ---------------------------------------------------------------------------
// McpServerConfigSchema — valid configs
// ---------------------------------------------------------------------------
describe("McpServerConfigSchema", () => {
  describe("valid stdio config", () => {
    it("passes with command and name", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "my-server",
        transport: "stdio",
        command: "npx",
        args: ["@modelcontextprotocol/server-filesystem", "/home/user"],
      });
      expect(result.success).toBe(true);
    });

    it("passes with command only (no args)", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "simple",
        transport: "stdio",
        command: "node",
      });
      expect(result.success).toBe(true);
    });

    it("passes with env variables", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "with-env",
        transport: "stdio",
        command: "python",
        env: { API_KEY: "secret" },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("valid SSE config", () => {
    it("passes with url", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "remote-server",
        transport: "sse",
        url: "http://localhost:3001/sse",
      });
      expect(result.success).toBe(true);
    });

    it("passes with url and headers", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "remote-auth",
        transport: "sse",
        url: "https://mcp.example.com/sse",
        headers: { Authorization: "Bearer token123" },
      });
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Refinement failures
  // ---------------------------------------------------------------------------
  describe("stdio without command fails refinement", () => {
    it("rejects stdio transport with no command", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "no-command",
        transport: "stdio",
      });
      expect(result.success).toBe(false);
    });

    it("rejects stdio transport with empty command", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "empty-cmd",
        transport: "stdio",
        command: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SSE without url fails refinement", () => {
    it("rejects sse transport with no url", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "no-url",
        transport: "sse",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Name validation
  // ---------------------------------------------------------------------------
  describe("name regex validation", () => {
    it("accepts lowercase alphanumeric with hyphens", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "my-server-123",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(true);
    });

    it("accepts underscores", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "my_server",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(true);
    });

    it("rejects uppercase characters", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "MyServer",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(false);
    });

    it("rejects spaces", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "my server",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(false);
    });

    it("rejects special characters", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "my.server!",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("empty name fails", () => {
    it("rejects empty string name", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------
  describe("defaults applied", () => {
    it("defaults enabled to true", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "defaults-test",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
      }
    });

    it("defaults autoConnect to true", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "defaults-test",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoConnect).toBe(true);
      }
    });

    it("defaults timeout_ms to 30000", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "defaults-test",
        transport: "stdio",
        command: "npx",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout_ms).toBe(30_000);
      }
    });

    it("allows overriding defaults", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "override",
        transport: "stdio",
        command: "npx",
        enabled: false,
        autoConnect: false,
        timeout_ms: 60_000,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
        expect(result.data.autoConnect).toBe(false);
        expect(result.data.timeout_ms).toBe(60_000);
      }
    });
  });

  describe("streamable HTTP transport", () => {
    it("accepts http with a url", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "gateway",
        transport: "http",
        url: "http://localhost:3001/mcp",
      });
      expect(result.success).toBe(true);
    });

    it("fails http without a url — the same rule as sse", () => {
      const result = McpServerConfigSchema.safeParse({ name: "gateway", transport: "http" });
      expect(result.success).toBe(false);
    });

    it("blocks the cloud metadata endpoint over http, not only over sse", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "meta",
        transport: "http",
        url: "http://169.254.169.254/latest/meta-data/",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("credentials as references", () => {
    it("accepts a SecretRef as an env value", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "github",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: { $secret: { provider: "vaultwarden", itemRef: "GitHub MCP", field: "password" } } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a SecretRef as a header value", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "gateway",
        transport: "http",
        url: "http://localhost:3001/mcp",
        headers: { Authorization: { $secret: { provider: "protonpass", itemRef: "share:item" } } },
      });
      expect(result.success).toBe(true);
    });

    it("rejects an unknown provider rather than storing it as an opaque object", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "github",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: { $secret: { provider: "sticky-note", itemRef: "GitHub MCP" } } },
      });
      expect(result.success).toBe(false);
    });

    it("still accepts a literal, because not every env value is a credential", () => {
      const result = McpServerConfigSchema.safeParse({
        name: "github",
        transport: "stdio",
        command: "npx",
        env: { NODE_ENV: "production" },
      });
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// McpSettingsSchema
// ---------------------------------------------------------------------------
describe("McpSettingsSchema", () => {
  it("accepts empty servers array", () => {
    const result = McpSettingsSchema.safeParse({ servers: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers).toEqual([]);
    }
  });

  it("defaults servers to empty array when not provided", () => {
    const result = McpSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers).toEqual([]);
    }
  });

  it("validates nested server configs", () => {
    const result = McpSettingsSchema.safeParse({
      servers: [
        { name: "stdio-server", transport: "stdio", command: "npx" },
        { name: "sse-server", transport: "sse", url: "http://localhost:3001/sse" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers).toHaveLength(2);
    }
  });

  it("rejects when any nested server config is invalid", () => {
    const result = McpSettingsSchema.safeParse({
      servers: [
        { name: "valid", transport: "stdio", command: "npx" },
        { name: "INVALID", transport: "stdio", command: "npx" },
      ],
    });
    expect(result.success).toBe(false);
  });
});
