import type { NextFunction, Request, Response } from "express";
import { requireAuth, isLoopbackRequest, shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { McpServerConfigSchema } from "../../../connectors/built-in/mcp/mcp-config.ts";

export function registerMcpServerRoutes(ctx: RuntimeContext): void {
  const { app, db } = ctx;
  const mcpManager = ctx.mcpManager;

  /**
   * MCP mutation routes (add/update/delete/connect/disconnect/test) allow
   * arbitrary command execution and outbound connections. Restrict them to
   * loopback-only to prevent authenticated RCE/SSRF from remote clients.
   */
  const requireLoopback = (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackRequest(req)) {
      return res
        .status(403)
        .json({ ok: false, error: "mcp_loopback_only", message: "MCP management is restricted to local access" });
    }
    return next();
  };

  function requireCsrfGuard(req: Parameters<typeof shouldRequireCsrf>[0], res: Response): boolean {
    if (!shouldRequireCsrf(req)) return true;
    if (hasValidCsrfToken(req)) return true;
    res.status(403).json({ ok: false, error: "csrf_token_invalid" });
    return false;
  }

  app.use("/api/ops/mcp-servers", requireAuth);

  // ---- LIST MCP SERVERS (with status) ----
  app.get("/api/ops/mcp-servers", requireLoopback, (_req, res) => {
    if (!mcpManager) {
      return res.json({ servers: [] });
    }
    res.json({ servers: mcpManager.getStatuses() });
  });

  // ---- ADD MCP SERVER ----
  app.post("/api/ops/mcp-servers", requireLoopback, async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!mcpManager) {
      return res
        .status(503)
        .json({ ok: false, error: "mcp_manager_unavailable", message: "MCP manager not available" });
    }

    try {
      const parseResult = McpServerConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          ok: false,
          error: "validation_failed",
          message: "Invalid MCP server config",
          details: parseResult.error.issues,
        });
      }

      const config = parseResult.data;

      // Check for duplicate name
      if (mcpManager.getConfig(config.name)) {
        return res
          .status(409)
          .json({ ok: false, error: "mcp_server_exists", message: `MCP server "${config.name}" already exists` });
      }

      mcpManager.addServer(config);
      mcpManager.saveToSettings(db);

      // Auto-connect if enabled
      if (config.enabled && config.autoConnect) {
        try {
          await mcpManager.connectServer(config.name, ctx.connectorRegistry);
          // Re-register capabilities
          if (ctx.connectorRegistry) {
            mcpManager.registerAll(ctx.connectorRegistry);
          }
        } catch {
          // Saved but not connected. The reason is not dropped: the manager
          // keeps it, so it is in the status below and survives a page reload.
        }
      }

      res.status(201).json({ ok: true, server: mcpManager.getServerStatus(config.name) });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- UPDATE MCP SERVER ----
  app.put("/api/ops/mcp-servers/:name", requireLoopback, async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!mcpManager) {
      return res
        .status(503)
        .json({ ok: false, error: "mcp_manager_unavailable", message: "MCP manager not available" });
    }

    try {
      const name = String(req.params.name);
      const existing = mcpManager.getConfig(name);
      if (!existing) {
        return res
          .status(404)
          .json({ ok: false, error: "mcp_server_not_found", message: `MCP server "${name}" not found` });
      }

      const parseResult = McpServerConfigSchema.safeParse({ ...req.body, name });
      if (!parseResult.success) {
        return res.status(400).json({
          ok: false,
          error: "validation_failed",
          message: "Invalid MCP server config",
          details: parseResult.error.issues,
        });
      }

      const config = parseResult.data;

      // Disconnect existing (clean up stale bindings), update config, reconnect if needed
      await mcpManager.disconnectServer(name, ctx.connectorRegistry);
      mcpManager.addServer(config);
      mcpManager.saveToSettings(db);

      if (config.enabled && config.autoConnect) {
        try {
          await mcpManager.connectServer(name, ctx.connectorRegistry);
          if (ctx.connectorRegistry) {
            mcpManager.registerAll(ctx.connectorRegistry);
          }
        } catch {
          // Saved but not connected — the manager keeps the reason.
        }
      }

      res.json({ ok: true, server: mcpManager.getServerStatus(name) });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- DELETE MCP SERVER ----
  app.delete("/api/ops/mcp-servers/:name", requireLoopback, async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!mcpManager) {
      return res
        .status(503)
        .json({ ok: false, error: "mcp_manager_unavailable", message: "MCP manager not available" });
    }

    try {
      const name = String(req.params.name);
      if (!mcpManager.getConfig(name)) {
        return res
          .status(404)
          .json({ ok: false, error: "mcp_server_not_found", message: `MCP server "${name}" not found` });
      }

      await mcpManager.removeServer(name, ctx.connectorRegistry);
      mcpManager.saveToSettings(db);

      res.json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- TEST CONNECTION ----
  app.post("/api/ops/mcp-servers/:name/test", requireLoopback, async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!mcpManager) {
      return res
        .status(503)
        .json({ ok: false, error: "mcp_manager_unavailable", message: "MCP manager not available" });
    }

    const name = String(req.params.name);
    const connector = mcpManager.getConnector(name);

    if (connector) {
      const result = await connector.testConnection({});
      return res.json(result);
    }

    // Not connected yet — try to connect
    const config = mcpManager.getConfig(name);
    if (!config) {
      return res
        .status(404)
        .json({ ok: false, error: "mcp_server_not_found", message: `MCP server "${name}" not found` });
    }

    try {
      await mcpManager.connectServer(name, ctx.connectorRegistry);
      const newConnector = mcpManager.getConnector(name);
      const toolCount = newConnector?.capabilities.length ?? 0;
      // Disconnect after test unless autoConnect is on
      if (!config.autoConnect) {
        await mcpManager.disconnectServer(name, ctx.connectorRegistry);
      } else if (ctx.connectorRegistry) {
        mcpManager.registerAll(ctx.connectorRegistry);
      }
      return res.json({ ok: true, message: `Connected successfully — discovered ${toolCount} tools` });
    } catch (err) {
      return res.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- CONNECT ----
  app.post("/api/ops/mcp-servers/:name/connect", requireLoopback, async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!mcpManager) {
      return res
        .status(503)
        .json({ ok: false, error: "mcp_manager_unavailable", message: "MCP manager not available" });
    }

    const name = String(req.params.name);
    if (!mcpManager.getConfig(name)) {
      return res
        .status(404)
        .json({ ok: false, error: "mcp_server_not_found", message: `MCP server "${name}" not found` });
    }

    try {
      await mcpManager.connectServer(name, ctx.connectorRegistry);
      if (ctx.connectorRegistry) {
        mcpManager.registerAll(ctx.connectorRegistry);
      }
      res.json({ ok: true, server: mcpManager.getServerStatus(name) });
    } catch (err) {
      res.json({ ok: false, error: "connect_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- DISCONNECT ----
  app.post("/api/ops/mcp-servers/:name/disconnect", requireLoopback, async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!mcpManager) {
      return res
        .status(503)
        .json({ ok: false, error: "mcp_manager_unavailable", message: "MCP manager not available" });
    }

    try {
      const name = String(req.params.name);
      await mcpManager.disconnectServer(name, ctx.connectorRegistry);
      res.json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- GET TOOLS FOR A SERVER ----
  app.get("/api/ops/mcp-servers/:name/tools", requireLoopback, (_req, res) => {
    if (!mcpManager) {
      return res.json({ tools: [] });
    }

    const name = String(_req.params.name);
    const tools = mcpManager.getServerTools(name);
    res.json({ tools });
  });
}
