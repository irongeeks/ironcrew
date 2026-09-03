import { z } from "zod/v4";
import { requireAuth } from "../../../security/auth.ts";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";

const BINDINGS_SETTING_KEY = "connector_capability_bindings";

const UpdateBindingsSchema = z.object({
  bindings: z.record(z.string(), z.unknown()),
});

const TestConnectorSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional().default({}),
});

export function registerConnectorRoutes(ctx: RuntimeContext): void {
  const { app, db } = ctx;
  const connectorRegistry = ctx.connectorRegistry;

  app.use("/api/ops/connectors", requireAuth);
  app.use("/api/ops/connector-bindings", requireAuth);

  // ---- LIST CONNECTORS ----
  app.get("/api/ops/connectors", (_req, res) => {
    if (!connectorRegistry) {
      return res.json({ connectors: [] });
    }

    const allConnectors = connectorRegistry.listAll();

    const connectors = allConnectors.map((c) => ({
      name: c.name,
      capabilities: (c.capabilities ?? []).map((cap) => ({
        name: cap.name,
        description: cap.description,
      })),
    }));

    res.json({ connectors });
  });

  // ---- GET BINDINGS ----
  app.get("/api/ops/connector-bindings", (_req, res) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(BINDINGS_SETTING_KEY) as
      | { value: string }
      | undefined;

    let bindings: Record<string, unknown> = {};
    if (row?.value) {
      try {
        bindings = JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        bindings = {};
      }
    }

    res.json({ bindings });
  });

  // ---- UPDATE BINDINGS ----
  app.put("/api/ops/connector-bindings", (req, res) => {
    const parseResult = UpdateBindingsSchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      return res
        .status(400)
        .json({ ok: false, error: "validation_failed", message: "bindings must be a plain object" });
    }
    const bindings = parseResult.data.bindings;

    const serialized = JSON.stringify(bindings);
    const existing = db.prepare("SELECT key FROM settings WHERE key = ?").get(BINDINGS_SETTING_KEY);

    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(serialized, BINDINGS_SETTING_KEY);
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(BINDINGS_SETTING_KEY, serialized);
    }

    // Apply bindings to the live registry if available
    if (connectorRegistry) {
      const bindingsMap = bindings as Record<
        string,
        { connector: string; timeout_ms?: number; max_retries?: number; connector_config?: Record<string, unknown> }
      >;
      for (const [capability, config] of Object.entries(bindingsMap)) {
        if (config && typeof config.connector === "string") {
          connectorRegistry.setBinding(capability, {
            connector: config.connector,
            timeout_ms: config.timeout_ms,
            max_retries: config.max_retries,
            connector_config: config.connector_config ?? {},
          });
        }
      }
    }

    res.json({ ok: true });
  });

  // ---- TEST CONNECTOR ----
  app.post("/api/ops/connectors/:name/test", async (req, res) => {
    const { name } = req.params;
    const parsed = TestConnectorSchema.safeParse(req.body ?? {});
    const config = parsed.success ? parsed.data.config : ({} as Record<string, unknown>);

    if (!connectorRegistry) {
      return res
        .status(503)
        .json({ ok: false, error: "connector_registry_unavailable", message: "Connector registry not available" });
    }

    const connector = connectorRegistry.getConnector(name);
    if (!connector) {
      return res
        .status(404)
        .json({ ok: false, error: "connector_not_found", message: `Connector "${name}" not found` });
    }

    try {
      const serverUrl = typeof config.serverUrl === "string" ? config.serverUrl : "";
      if (serverUrl && isBlockedSsrfTarget(serverUrl, { allowLocal: true })) {
        return res.status(400).json({
          ok: false,
          error: "blocked_ssrf_target",
          message: "URL targets a blocked address range (SSRF protection)",
        });
      }
      const result = await connector.testConnection(config);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ ok: false, message });
    }
  });
}
