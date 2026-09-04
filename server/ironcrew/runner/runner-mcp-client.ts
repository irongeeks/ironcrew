/**
 * IronCrew — an MCP server that runs on the runner, seen from the control plane.
 *
 * Same trick as RunnerRuntime: this implements the ordinary `Connector`
 * interface, so the connector registry, the tool gate and the agent prompt
 * cannot tell an MCP server running in another process under another OS user
 * from one running inline. The security property — the control plane never
 * holds the MCP server's API key — costs the rest of the system nothing.
 *
 * The name is `mcp:<server>`, byte-for-byte what McpConnector uses, because
 * tool grants (crew_tool_grants) reference it. A different prefix here would
 * silently revoke every grant an operator had already given.
 */

import { newId } from "../domain/ids.ts";
import { encodeMessage, RunnerProtocolError, RUNNER_PROTOCOL_VERSION, type McpConnectResult } from "./protocol.ts";
import { nextMessage, openSession, RunnerUnavailableError, type RunnerConnection } from "./runner-session.ts";
import type { McpServerConfig } from "../../connectors/built-in/mcp/mcp-config.ts";
import type { Connector, ConnectorCapability, ConnectorExecuteResult } from "../../connectors/connector-interface.ts";

export interface RunnerMcpConnectorOptions {
  config: McpServerConfig;
  connect: () => Promise<RunnerConnection>;
  token: string;
  /** How long to wait for a reply. A tool call may legitimately take a while. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class RunnerMcpConnector implements Connector {
  readonly name: string;
  capabilities: ConnectorCapability[] = [];

  private readonly config: McpServerConfig;
  private readonly connectFn: () => Promise<RunnerConnection>;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private _connected = false;
  private _error: string | undefined;

  constructor(opts: RunnerMcpConnectorOptions) {
    this.config = opts.config;
    this.name = `mcp:${opts.config.name}`;
    this.connectFn = opts.connect;
    this.token = opts.token;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this._connected;
  }

  get error(): string | undefined {
    return this._error;
  }

  /**
   * One request, one reply, one connection.
   *
   * Mirrors RunnerRuntime deliberately: a runner restart then costs the next
   * call a reconnect instead of breaking every future one. The MCP server
   * itself stays up across these connections — it lives in the runner daemon,
   * not in the socket (mcp-host.ts).
   */
  private async request(
    build: (id: string) => Parameters<typeof encodeMessage>[0],
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const session = await openSession({
      connect: this.connectFn,
      token: this.token,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    try {
      const id = newId("evt");
      session.connection.write(encodeMessage(build(id)));
      const reply = await nextMessage(session, timeoutMs);

      if (!reply) throw new RunnerUnavailableError("Der Runner schloss die Verbindung ohne Antwort.");
      if (reply.kind === "error") throw new RunnerUnavailableError(reply.message);
      if (reply.kind !== "result") throw new RunnerProtocolError(`Unerwartete Antwort "${reply.kind}".`);
      return reply.value;
    } finally {
      session.close();
    }
  }

  /**
   * Starts the server on the runner and learns its tools.
   *
   * The config crosses the wire with its SecretRefs intact — a reference
   * names a vault item, it is not itself a credential (mcp-secrets.ts). The
   * runner resolves it there.
   */
  async connect(): Promise<void> {
    this._error = undefined;
    try {
      const value = (await this.request((id) => ({
        v: RUNNER_PROTOCOL_VERSION,
        kind: "mcp-connect",
        id,
        config: this.config,
      }))) as McpConnectResult | null;

      this.capabilities = value?.tools ?? [];
      this._connected = true;
    } catch (err) {
      this._connected = false;
      this.capabilities = [];
      this._error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async execute(
    capability: string,
    input: Record<string, unknown>,
    _config: Record<string, unknown>,
  ): Promise<ConnectorExecuteResult> {
    const startTime = Date.now();
    try {
      const value = (await this.request(
        (id) => ({
          v: RUNNER_PROTOCOL_VERSION,
          kind: "mcp-call",
          id,
          server: this.config.name,
          tool: capability,
          input,
        }),
        // The runner enforces the per-server timeout on the tool call itself;
        // this one only has to outlast it, or a slow-but-working tool would
        // look like a broken runner.
        (this.config.timeout_ms ?? 30_000) + this.requestTimeoutMs,
      )) as ConnectorExecuteResult | null;

      if (!value) {
        return { status: "error", artifacts: [], error: `Der Runner lieferte kein Ergebnis für "${capability}".` };
      }
      return value;
    } catch (err) {
      // An unreachable runner is an error for this call, not an exception the
      // workflow layer has to know about. Same contract as McpConnector.
      return {
        status: "error",
        artifacts: [],
        costInfo: { durationMs: Date.now() - startTime },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getAgentGuidance(capability: string, _config: Record<string, unknown>, _lang: string): string {
    const tool = this.capabilities.find((c) => c.name === capability);
    if (!tool) {
      return `MCP tool "${capability}" is available via server "${this.config.name}" (running on the IronCrew runner).`;
    }
    const parts = [
      `MCP tool "${tool.name}" is available via server "${this.config.name}" (running on the IronCrew runner).`,
    ];
    if (tool.description) parts.push(`Description: ${tool.description}`);
    if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
      parts.push(`Input schema: ${JSON.stringify(tool.inputSchema)}`);
    }
    return parts.join("\n");
  }

  async testConnection(_config: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (this._connected) {
      return {
        ok: true,
        message: `MCP-Server "${this.config.name}" läuft auf dem Runner mit ${this.capabilities.length} Werkzeugen.`,
      };
    }
    try {
      await this.connect();
      return {
        ok: true,
        message: `MCP-Server "${this.config.name}" auf dem Runner gestartet — ${this.capabilities.length} Werkzeuge.`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Stops the server on the runner.
   *
   * Best-effort on purpose: an unreachable runner has already stopped it, and
   * a throw here would block the control plane's own shutdown or a config
   * change that is otherwise fine.
   */
  async disconnect(): Promise<void> {
    const wasConnected = this._connected;
    this._connected = false;
    this.capabilities = [];
    if (!wasConnected) return;
    try {
      await this.request((id) => ({
        v: RUNNER_PROTOCOL_VERSION,
        kind: "mcp-disconnect",
        id,
        server: this.config.name,
      }));
    } catch {
      // best-effort cleanup
    }
  }

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
