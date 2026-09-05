import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import type { UtilContext } from "../../../../types/runtime-context-domains.ts";
import { PKG_VERSION } from "../../../../config/runtime.ts";
import { isAuthenticated } from "../../../../security/auth.ts";
import { createReleaseStatusReader, detectInstallType } from "./release-status.ts";

interface UpdateAutoRouteBaseDeps {
  app: Express;
  db: DatabaseSync;
  dbPath: string;
  activeProcesses: Map<string, ChildProcess>;
}

/** Release discovery is read-only. Host update scripts own backup, validation and service restart. */
export function registerUpdateAutoRoutes(base: UpdateAutoRouteBaseDeps, _util: UtilContext): void {
  const { app, dbPath } = base;
  const readStatus = createReleaseStatusReader({
    currentVersion: PKG_VERSION,
    installType: detectInstallType(),
    enabled: process.env.UPDATE_CHECK_ENABLED !== "0",
    ttlMs: Math.max(60000, Number(process.env.UPDATE_CHECK_TTL_MS) || 1800000),
    timeoutMs: Math.max(1000, Number(process.env.UPDATE_CHECK_TIMEOUT_MS) || 4000),
  });
  const authenticated = (req: Request, res: Response, next: NextFunction): void => {
    if (!isAuthenticated(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    next();
  };
  const health = () => ({ ok: true, version: PKG_VERSION, app: "IronCrew", dbPath });
  app.get("/health", (_req, res) => res.json(health()));
  app.get("/healthz", (_req, res) => res.json(health()));
  app.get("/api/health", (_req, res) => res.json(health()));
  app.get("/api/update-status", authenticated, async (req, res) => {
    res.json({ ok: true, ...(await readStatus(req.query.refresh === "1")) });
  });
  app.get("/api/update-auto-status", authenticated, async (_req, res) => {
    res.json({
      ok: true,
      auto_update: {
        enabled: false,
        configured_enabled: false,
        settings_enabled: false,
        scheduler_ready: false,
        channel: "stable",
        reason: "manual_update_required",
      },
      runtime: { running: false, next_check_at: null },
      update_status: await readStatus(),
    });
  });
  for (const endpoint of ["/api/update-apply", "/api/update-auto-config"]) {
    app.post(endpoint, authenticated, async (_req, res) => {
      res.status(409).json({
        ok: false,
        error: "manual_update_required",
        message:
          "IronCrew aktualisiert sich nicht aus dem laufenden Webprozess. Bitte den Host-Update-Assistenten für ein stabiles Release verwenden.",
        update_status: await readStatus(),
      });
    });
  }
}
