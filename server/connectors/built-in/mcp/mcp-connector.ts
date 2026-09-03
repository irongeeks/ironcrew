import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Connector, ConnectorCapability, ConnectorExecuteResult } from "../../connector-interface.ts";
import type { McpServerConfig } from "./mcp-config.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "connectors" });

/**
 * A Connector implementation that wraps a single MCP server connection.
 * Each MCP server's tools are exposed as connector capabilities.
 */
export class McpConnector implements Connector {
  readonly name: string;
  capabilities: ConnectorCapability[] = [];

  private client: Client | null = null;
  private transport: StdioClientTransport | SSEClientTransport | null = null;
  private config: McpServerConfig;
  private _connected = false;
  private _error: string | undefined;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.name = `mcp:${config.name}`;
  }

  get connected(): boolean {
    return this._connected;
  }

  get error(): string | undefined {
    return this._error;
  }

  /**
   * Establish the MCP connection and discover tools.
   */
  async connect(): Promise<void> {
    this._error = undefined;

    try {
      this.client = new Client({ name: "octooffice", version: "2.7.0" });

      if (this.config.transport === "stdio") {
        if (!this.config.command) {
          throw new Error(`MCP server "${this.config.name}": stdio transport requires a command`);
        }
        // Security audit: always log stdio spawns for visibility
        log.warn(
          { server: this.config.name, command: this.config.command, args: this.config.args ?? [] },
          "spawning stdio MCP server",
        );
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env as Record<string, string> | undefined,
        });
      } else {
        if (!this.config.url) {
          throw new Error(`MCP server "${this.config.name}": SSE transport requires a url`);
        }
        const sseUrl = new URL(this.config.url);
        this.transport = new SSEClientTransport(sseUrl, {
          requestInit: this.config.headers ? { headers: this.config.headers as Record<string, string> } : undefined,
        });
      }

      await this.client.connect(this.transport);
      this._connected = true;

      // Discover tools from the MCP server
      await this.discoverTools();
    } catch (err) {
      this._connected = false;
      this._error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Query the MCP server for its available tools and map them to connector capabilities.
   */
  private async discoverTools(): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.listTools();
      this.capabilities = (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
        outputSchema: {},
      }));
    } catch (err) {
      log.warn({ err, server: this.config.name }, "MCP tool discovery failed — capabilities cleared");
      this.capabilities = [];
    }
  }

  /**
   * Execute a tool on the MCP server.
   */
  async execute(
    capability: string,
    input: Record<string, unknown>,
    _config: Record<string, unknown>,
  ): Promise<ConnectorExecuteResult> {
    if (!this.client || !this._connected) {
      return {
        status: "error",
        artifacts: [],
        error: `MCP server "${this.config.name}" is not connected`,
      };
    }

    const startTime = Date.now();

    try {
      const timeoutMs = this.config.timeout_ms ?? 30_000;
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        this.client.callTool({ name: capability, arguments: input }).finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP tool "${capability}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);

      // Extract text content from the MCP tool result
      const textParts: string[] = [];
      for (const content of result.content as Array<{ type: string; text?: string }>) {
        if (content.type === "text" && content.text) {
          textParts.push(content.text);
        }
      }

      const outputText = textParts.join("\n");
      const isError = result.isError === true;

      return {
        status: isError ? "error" : "success",
        artifacts: outputText
          ? [
              {
                path: `mcp://${this.config.name}/${capability}`,
                type: "text",
                metadata: { output: outputText },
              },
            ]
          : [],
        costInfo: { durationMs: Date.now() - startTime },
        error: isError ? outputText : undefined,
      };
    } catch (err) {
      return {
        status: "error",
        artifacts: [],
        costInfo: { durationMs: Date.now() - startTime },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Generate agent guidance text describing available MCP tools.
   */
  getAgentGuidance(capability: string, _config: Record<string, unknown>, _lang: string): string {
    const tool = this.capabilities.find((c) => c.name === capability);
    if (!tool) {
      return `MCP tool "${capability}" is available via server "${this.config.name}".`;
    }

    const parts = [`MCP tool "${tool.name}" is available via server "${this.config.name}".`];
    if (tool.description) {
      parts.push(`Description: ${tool.description}`);
    }
    if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
      parts.push(`Input schema: ${JSON.stringify(tool.inputSchema)}`);
    }
    return parts.join("\n");
  }

  /**
   * Test the connection to the MCP server.
   */
  async testConnection(_config: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (this._connected && this.client) {
      return {
        ok: true,
        message: `Connected to MCP server "${this.config.name}" with ${this.capabilities.length} tools`,
      };
    }

    try {
      await this.connect();
      const toolCount = this.capabilities.length;
      return {
        ok: true,
        message: `Successfully connected to MCP server "${this.config.name}" — discovered ${toolCount} tools`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Disconnect from the MCP server and clean up resources.
   */
  async disconnect(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
      }
    } catch {
      // best-effort cleanup
    }
    this.client = null;
    this.transport = null;
    this._connected = false;
    this.capabilities = [];
  }

  /**
   * Return current status for API responses.
   */
  getStatus(): {
    name: string;
    label?: string;
    transport: "stdio" | "sse";
    connected: boolean;
    tools: Array<{ name: string; description?: string }>;
    error?: string;
  } {
    return {
      name: this.config.name,
      label: this.config.label,
      transport: this.config.transport,
      connected: this._connected,
      tools: this.capabilities.map((c) => ({ name: c.name, description: c.description })),
      error: this._error,
    };
  }
}
