import type { DatabaseSync } from "node:sqlite";
import type { ConnectorRegistry } from "../../registry.ts";
import { McpConnector } from "./mcp-connector.ts";
import { McpSettingsSchema, type McpServerConfig, type McpServerStatus } from "./mcp-config.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "connectors" });

const MCP_SETTINGS_KEY = "mcp_servers";

/**
 * Manages multiple MCP server connections, their lifecycle, and registration
 * with the ConnectorRegistry.
 */
export class McpManager {
  private connectors = new Map<string, McpConnector>();
  private configs = new Map<string, McpServerConfig>();

  /**
   * Load MCP server configurations from the settings table.
   */
  loadFromSettings(db: DatabaseSync): void {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MCP_SETTINGS_KEY) as
      | { value: string }
      | undefined;

    if (!row?.value) return;

    try {
      const parsed = JSON.parse(row.value);
      const settings = McpSettingsSchema.parse(parsed);
      for (const config of settings.servers) {
        this.configs.set(config.name, config);
      }
    } catch (err) {
      log.warn({ err }, "failed to parse MCP settings from database");
    }
  }

  /**
   * Save current configs back to the settings table.
   */
  saveToSettings(db: DatabaseSync): void {
    const servers = Array.from(this.configs.values());
    const serialized = JSON.stringify({ servers });

    const existing = db.prepare("SELECT key FROM settings WHERE key = ?").get(MCP_SETTINGS_KEY);
    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(serialized, MCP_SETTINGS_KEY);
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(MCP_SETTINGS_KEY, serialized);
    }
  }

  /**
   * Connect to all enabled MCP servers that have autoConnect=true.
   */
  async connectAll(): Promise<void> {
    const connectPromises: Promise<void>[] = [];

    for (const config of this.configs.values()) {
      if (!config.enabled || !config.autoConnect) continue;
      connectPromises.push(this.connectServer(config.name));
    }

    // Connect in parallel, don't fail if individual servers fail
    await Promise.allSettled(connectPromises);
  }

  /**
   * Connect to a specific MCP server by name.
   * Pass connectorRegistry to clean up stale bindings from a prior connection.
   */
  async connectServer(name: string, connectorRegistry?: ConnectorRegistry): Promise<void> {
    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`MCP server "${name}" not configured`);
    }

    // Clean up existing connection and its registry entries before reconnecting
    const existing = this.connectors.get(name);
    if (existing) {
      if (connectorRegistry) {
        connectorRegistry.removeBindingsByConnector(existing.name);
        connectorRegistry.unregisterConnector(existing.name);
      }
      await existing.disconnect();
    }

    const connector = new McpConnector(config);

    // Only store the connector after a successful connect — a failed connector
    // in the map would confuse callers that treat getConnector() !== undefined
    // as a proxy for "is connected".
    await connector.connect();
    this.connectors.set(name, connector);
  }

  /**
   * Disconnect a specific MCP server and clean up its registry bindings.
   */
  async disconnectServer(name: string, connectorRegistry?: ConnectorRegistry): Promise<void> {
    const connector = this.connectors.get(name);
    if (connector) {
      if (connectorRegistry) {
        connectorRegistry.removeBindingsByConnector(connector.name);
        connectorRegistry.unregisterConnector(connector.name);
      }
      await connector.disconnect();
      this.connectors.delete(name);
    }
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connectors.values()).map((c) => c.disconnect());
    await Promise.allSettled(promises);
    this.connectors.clear();
  }

  /**
   * Register all connected MCP connectors and their tool capabilities
   * with the ConnectorRegistry.
   *
   * Only binds MCP tools when no existing binding exists, or when the
   * existing binding already belongs to this MCP connector. This prevents
   * MCP tools from hijacking built-in or user-configured bindings (e.g.
   * ComfyUI's text2img).
   */
  registerAll(connectorRegistry: ConnectorRegistry): void {
    for (const connector of this.connectors.values()) {
      connectorRegistry.registerConnector(connector);

      const timeoutMs = this.configs.get(connector.name.replace("mcp:", ""))?.timeout_ms ?? 30_000;

      for (const cap of connector.capabilities) {
        const existing = connectorRegistry.getBinding(cap.name);
        // Skip if another (non-MCP) connector already owns this capability
        if (existing && existing.connector !== connector.name) {
          continue;
        }
        connectorRegistry.setBinding(cap.name, {
          connector: connector.name,
          timeout_ms: timeoutMs,
          connector_config: {},
        });
      }
    }
  }

  /**
   * Add or update an MCP server configuration.
   */
  addServer(config: McpServerConfig): void {
    this.configs.set(config.name, config);
  }

  /**
   * Remove an MCP server configuration and disconnect if connected.
   */
  async removeServer(name: string, connectorRegistry?: ConnectorRegistry): Promise<void> {
    await this.disconnectServer(name, connectorRegistry); // also deletes from this.connectors
    this.configs.delete(name);
  }

  /**
   * Get the connector instance for a server (if it exists).
   */
  getConnector(name: string): McpConnector | undefined {
    return this.connectors.get(name);
  }

  /**
   * Get status of all configured MCP servers.
   */
  getStatuses(): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];

    for (const config of this.configs.values()) {
      const connector = this.connectors.get(config.name);
      if (connector) {
        statuses.push(connector.getStatus());
      } else {
        statuses.push({
          name: config.name,
          label: config.label,
          transport: config.transport,
          connected: false,
          tools: [],
        });
      }
    }

    return statuses;
  }

  /**
   * Get status of a single MCP server.
   */
  getServerStatus(name: string): McpServerStatus | undefined {
    const config = this.configs.get(name);
    if (!config) return undefined;

    const connector = this.connectors.get(name);
    if (connector) return connector.getStatus();

    return {
      name: config.name,
      label: config.label,
      transport: config.transport,
      connected: false,
      tools: [],
    };
  }

  /**
   * Get the raw config for a server.
   */
  getConfig(name: string): McpServerConfig | undefined {
    return this.configs.get(name);
  }

  /**
   * Get all configs.
   */
  getAllConfigs(): McpServerConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Get discovered tools for a connected server.
   */
  getServerTools(name: string): Array<{ name: string; description?: string }> {
    const connector = this.connectors.get(name);
    if (!connector) return [];
    return connector.capabilities.map((c) => ({ name: c.name, description: c.description }));
  }
}
