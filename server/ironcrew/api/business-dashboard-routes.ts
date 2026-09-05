import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { businessRefreshSchema, BUSINESS_SOURCE_IDS } from "../../../src/shared/business-dashboard.ts";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { BusinessDashboardError, type BusinessDashboardService } from "../packs/business-dashboard.ts";

export function registerBusinessDashboardRoutes(
  app: Express,
  options: { service: BusinessDashboardService; auth: CrewAuth; base?: string },
): void {
  const base = `${options.base ?? "/api/crew"}/business-dashboard`;
  // Financial and infrastructure inventory are restricted to the Owner.
  app.get(base, options.auth.requireRole("owner"), (_req, res) => res.json(options.service.snapshot()));
  app.post(
    `${base}/:source/refresh`,
    options.auth.requireRole("owner"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const source = z.enum(BUSINESS_SOURCE_IDS).parse(req.params.source);
        const input = businessRefreshSchema.parse(req.body);
        res.json(await options.service.refresh(source, input.agentId, options.auth.actorOf(req).actorId));
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({ error: "invalid_refresh", message: "Gültige Datenquelle und Mitarbeiter auswählen." });
          return;
        }
        if (error instanceof BusinessDashboardError) {
          res.status(error.status).json({ error: error.code, message: error.message });
          return;
        }
        next(error);
      }
    },
  );
}
