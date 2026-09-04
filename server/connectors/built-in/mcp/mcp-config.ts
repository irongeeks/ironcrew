import { z } from "zod/v4";
import { logger } from "../../../observability/logger.ts";
import { McpConfigValueSchema } from "./mcp-secrets.ts";

const log = logger.child({ module: "connectors" });

/**
 * Configuration schema for a single external MCP server connection.
 *
 * Transport-specific fields are validated via a Zod refinement:
 *   - stdio requires `command`
 *   - sse and http require `url`
 *
 * `env` and `headers` hold either a literal string or a SecretRef — see
 * mcp-secrets.ts for why a literal credential must not end up here.
 */
export const McpServerConfigSchema = z
  .object({
    /** Unique identifier for this MCP server */
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9_-]+$/, "Must be lowercase alphanumeric with hyphens/underscores"),

    /** Human-readable label */
    label: z.string().optional(),

    /**
     * Transport type.
     *
     * "http" is MCP's streamable HTTP transport, which supersedes "sse" in the
     * spec; "sse" stays because servers deployed against the older transport
     * are still out there and an operator should not have to redeploy one to
     * upgrade IronCrew.
     */
    transport: z.enum(["stdio", "sse", "http"]),

    // ── stdio transport fields ──
    /** Command to spawn (e.g., "npx", "node", "python") */
    command: z.string().optional(),
    /** Arguments for the command */
    args: z.array(z.string()).optional(),
    /** Environment variables passed to the spawned process — literal or SecretRef */
    env: z.record(z.string(), McpConfigValueSchema).optional(),

    // ── SSE / Streamable HTTP transport fields ──
    /** URL of the MCP server (e.g., "http://localhost:3001/mcp") */
    url: z.string().url().optional(),
    /** Extra headers for HTTP requests — literal or SecretRef */
    headers: z.record(z.string(), McpConfigValueSchema).optional(),

    // ── common fields ──
    /** Whether this server is enabled */
    enabled: z.boolean().default(true),
    /** Whether to auto-connect on startup */
    autoConnect: z.boolean().default(true),
    /** Tool call timeout in milliseconds */
    timeout_ms: z.number().int().positive().default(30_000),
  })
  .refine(
    (cfg) => {
      if (cfg.transport === "stdio") {
        if (typeof cfg.command !== "string" || cfg.command.length === 0) return false;
        // Block commands containing shell metacharacters to prevent injection
        if (/[;&|`$(){}!<>\\]/.test(cfg.command)) {
          log.warn(
            { server: cfg.name, command: cfg.command },
            "MCP server command rejected: contains shell metacharacters",
          );
          return false;
        }
        return true;
      }
      return typeof cfg.url === "string" && cfg.url.length > 0;
    },
    {
      message:
        "stdio transport requires a non-empty 'command' field without shell metacharacters (;&|`$(){}!<>\\); sse and http require a non-empty 'url' field",
    },
  )
  .refine(
    (cfg) => {
      if (cfg.transport === "stdio" || !cfg.url) return true;
      // MCP servers run locally, so allow localhost/loopback but block cloud metadata & link-local
      try {
        const u = new URL(cfg.url);
        const host = u.hostname.toLowerCase();
        if (host === "169.254.169.254" || host === "metadata.google.internal") return false;
        if (host.startsWith("169.254.")) return false;
        return true;
      } catch {
        return false;
      }
    },
    {
      message: "MCP server URL targets a blocked address (cloud metadata endpoint)",
    },
  );

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Top-level MCP settings stored in the `settings` table under key "mcp_servers".
 */
export const McpSettingsSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([]),
});

export type McpSettings = z.infer<typeof McpSettingsSchema>;

/**
 * Runtime status for a connected MCP server.
 */
export interface McpServerStatus {
  name: string;
  label?: string;
  transport: "stdio" | "sse" | "http";
  connected: boolean;
  tools: Array<{ name: string; description?: string }>;
  error?: string;
  /**
   * True when this server's credentials are SecretRefs, so it can only be
   * started by the runner. Reported rather than inferred by the UI: an
   * operator otherwise sees a server that refuses to connect with no hint
   * that the missing piece is a daemon, not a wrong command.
   */
  needsRunner?: boolean;
}
