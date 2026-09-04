import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Connector, ConnectorCapability, ConnectorExecuteResult } from "../../connector-interface.ts";
import type { McpServerConfig } from "./mcp-config.ts";
import { configHasSecretRefs, materializeMcpConfig, type ResolvedValueMap } from "./mcp-secrets.ts";
import type { SecretRef } from "../../../ironcrew/secrets/secret-ref.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "connectors" });

export interface McpConnectorOptions {
  /**
   * Fetches one secret from a vault. Absent in the control plane on purpose:
   * a config whose credentials are SecretRefs can then only be started where
   * a resolver exists, which is the runner (see mcp-secrets.ts).
   */
  resolveSecret?: (ref: SecretRef) => Promise<string>;
}

/**
 * A Connector implementation that wraps a single MCP server connection.
 * Each MCP server's tools are exposed as connector capabilities.
 */
export class McpConnector implements Connector {
  readonly name: string;
  capabilities: ConnectorCapability[] = [];

  private client: Client | null = null;
  private transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null = null;
  private config: McpServerConfig;
  private readonly resolveSecret?: (ref: SecretRef) => Promise<string>;
  private _connected = false;
  private _error: string | undefined;
  /** The values fetched for the current connection, for redaction by the caller. */
  private secretValues: string[] = [];

  constructor(config: McpServerConfig, options: McpConnectorOptions = {}) {
    this.config = config;
    this.resolveSecret = options.resolveSecret;
    this.name = `mcp:${config.name}`;
  }

  get resolvedSecretValues(): readonly string[] {
    return this.secretValues;
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
      const { env, headers } = await this.materialize();
      this.client = new Client({ name: "ironcrew", version: "2.7.0" });

      if (this.config.transport === "stdio") {
        if (!this.config.command) {
          throw new Error(`MCP server "${this.config.name}": stdio transport requires a command`);
        }
        // Security audit: always log stdio spawns for visibility. The env is
        // deliberately absent from this line — it is where the credentials are.
        log.warn(
          { server: this.config.name, command: this.config.command, args: this.config.args ?? [] },
          "spawning stdio MCP server",
        );
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env,
        });
      } else {
        if (!this.config.url) {
          throw new Error(`MCP server "${this.config.name}": ${this.config.transport} transport requires a url`);
        }
        const url = new URL(this.config.url);
        const requestInit = headers ? { headers } : undefined;
        this.transport =
          this.config.transport === "http"
            ? new StreamableHTTPClientTransport(url, { requestInit })
            : new SSEClientTransport(url, { requestInit });
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
   * Turns the stored config's SecretRefs into the values a transport needs.
   *
   * Without a resolver this refuses rather than starting the server with a
   * reference object stringified into an environment variable — which would
   * fail later as an authentication error nobody could trace back to here.
   */
  private async materialize(): Promise<{ env?: ResolvedValueMap; headers?: ResolvedValueMap }> {
    this.secretValues = [];
    if (!this.resolveSecret) {
      if (configHasSecretRefs(this.config)) {
        throw new Error(
          `MCP server "${this.config.name}" stores its credentials as SecretRefs, and this process has no vault ` +
            "access. Start it through the IronCrew runner (IRONCREW_RUNNER_SOCKET), which resolves them as its own user.",
        );
      }
      return {
        env: this.config.env as ResolvedValueMap | undefined,
        headers: this.config.headers as ResolvedValueMap | undefined,
      };
    }

    const { config, secretValues } = await materializeMcpConfig(this.config, this.resolveSecret);
    this.secretValues = secretValues;
    return { env: config.env, headers: config.headers };
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
    // Resolved credentials live exactly as long as the connection that needed
    // them; a disconnected connector holding one is a leak waiting for a heap
    // dump.
    this.secretValues = [];
  }

  /**
   * Return current status for API responses.
   */
  getStatus(): {
    name: string;
    label?: string;
    transport: "stdio" | "sse" | "http";
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
