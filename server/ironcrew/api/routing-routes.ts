import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { RoutingError, type RoutingStore } from "../domain/routing-store.ts";
export function registerRoutingRoutes(
  app: Express,
  options: { store: RoutingStore; companyId: string; auth: CrewAuth; base?: string; onChanged?: () => void },
): void {
  const { store, companyId, auth } = options;
  const base = `${options.base ?? "/api/crew"}/routing`;
  const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof RoutingError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: "invalid_routing", message: "Routing-Konfiguration oder Zuweisung ist ungültig." });
        return;
      }
      next(error);
    }
  };
  app.get(
    base,
    auth.requireUser,
    handle((_req, res) => res.json(store.snapshot(companyId))),
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
  app.put(
    `${base}/agents/:id`,
    auth.requireRole("owner"),
    handle((req, res) => {
      const id = z.string().min(1).max(150).parse(req.params.id);
      const snapshot = store.bind(companyId, id, req.body, auth.actorOf(req).actorId);
      options.onChanged?.();
      res.json(snapshot);
    }),
  );
}
