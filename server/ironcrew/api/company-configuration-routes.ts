import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { CompanyConfigurationError, type CompanyConfigurationStore } from "../policy/company-configuration-store.ts";
export function registerCompanyConfigurationRoutes(
  app: Express,
  options: {
    store: CompanyConfigurationStore;
    companyId: string;
    auth: CrewAuth;
    base?: string;
    onChanged?: () => void;
  },
): void {
  const { store, companyId, auth } = options;
  const base = `${options.base ?? "/api/crew"}/configuration`;
  const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof CompanyConfigurationError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: "invalid_configuration", message: "Konfiguration oder Begründung ist ungültig." });
        return;
      }
      next(error);
    }
  };
  app.get(
    base,
    auth.requireUser,
    handle((req, res) => res.json(store.snapshot(companyId, auth.actorOf(req).actorId))),
  );
  app.put(
    base,
    auth.requireRole("owner"),
    handle((req, res) => {
      const snapshot = store.save(companyId, req.body, auth.actorOf(req).actorId);
      options.onChanged?.();
      res.json(snapshot);
    }),
  );
}
