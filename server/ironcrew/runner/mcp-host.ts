/**
 * IronCrew — MCP servers, running on the runner.
 *
 * An MCP server is usually a process with an API key in its environment. That
 * key must not live in the control plane's database or memory
 * (docs/THREAT_MODEL.md T-05, T-17), so the server is started here instead:
 * the runner resolves the SecretRefs as its own OS user, against its own
 * vault session, and the control plane only ever sends tool calls and
 * receives tool results.
 *
 * DAEMON-SCOPED, NOT CONNECTION-SCOPED
 *
 * The control plane opens one socket connection per request, so a server tied
 * to a connection would be spawned and killed for every single tool call —
 * seconds of latency, and an npx download for some of them. The connectors
 * therefore live as long as the daemon, and are closed on `mcp-disconnect` or
 * at shutdown.
 *
 * That means a control-plane restart leaves them running. Deliberate: they
 * are cheap to keep and expensive to restart, and the next `mcp-connect` for
 * the same name replaces the connector rather than adding a second one.
 */

import { McpConnector } from "../../connectors/built-in/mcp/mcp-connector.ts";
import type { McpServerConfig } from "../../connectors/built-in/mcp/mcp-config.ts";
import type { ConnectorCapability, ConnectorExecuteResult } from "../../connectors/connector-interface.ts";
import type { SecretRef } from "../secrets/secret-ref.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-runner" });

/** What the runner server needs from an MCP host. A fake satisfies it in tests. */
export interface McpHost {
  connect(config: McpServerConfig): Promise<ConnectorCapability[]>;
  call(server: string, tool: string, input: Record<string, unknown>): Promise<ConnectorExecuteResult>;
  disconnect(server: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface LocalMcpHostOptions {
  /** Resolves one SecretRef against the runner's own vault. */
  resolveSecret?: (ref: SecretRef) => Promise<string>;
  /** Injectable so tests exercise the host without spawning anything. */
  createConnector?: (config: McpServerConfig) => McpConnector;
}

export class LocalMcpHost implements McpHost {
  private readonly connectors = new Map<string, McpConnector>();
  private readonly createConnector: (config: McpServerConfig) => McpConnector;

  constructor(opts: LocalMcpHostOptions = {}) {
    this.createConnector =
      opts.createConnector ?? ((config) => new McpConnector(config, { resolveSecret: opts.resolveSecret }));
  }

  get serverNames(): string[] {
    return [...this.connectors.keys()];
  }

  /**
   * Starts a server, or replaces the one already running under that name.
   *
   * Replacing rather than reusing: the config may have changed — a new
   * command, a new vault item — and a silently reused connection would keep
   * answering with the old credentials long after an operator "fixed" them.
   */
  async connect(config: McpServerConfig): Promise<ConnectorCapability[]> {
    await this.disconnect(config.name);

    const connector = this.createConnector(config);
    await connector.connect();
    this.connectors.set(config.name, connector);
    log.info({ server: config.name, tools: connector.capabilities.length }, "MCP server started on the runner");
    return connector.capabilities;
  }

  async call(server: string, tool: string, input: Record<string, unknown>): Promise<ConnectorExecuteResult> {
    const connector = this.connectors.get(server);
    if (!connector) {
      // An error, not a thrown exception two layers up: the control plane's
      // connector can then reconnect and retry, which is the normal recovery
      // after a runner restart.
      return {
        status: "error",
        artifacts: [],
        error: `MCP-Server "${server}" läuft auf diesem Runner nicht.`,
      };
    }
    return connector.execute(tool, input, {});
  }

  async disconnect(server: string): Promise<void> {
    const connector = this.connectors.get(server);
    if (!connector) return;
    this.connectors.delete(server);
    await connector.disconnect();
  }

  async closeAll(): Promise<void> {
    const all = [...this.connectors.values()];
    this.connectors.clear();
    await Promise.allSettled(all.map((connector) => connector.disconnect()));
  }
}
