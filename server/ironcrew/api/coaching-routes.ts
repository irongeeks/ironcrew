import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { CoachingError, CoachingStore } from "../domain/coaching-store.ts";

export function registerCoachingRoutes(
  app: Express,
  options: {
    db: DatabaseSync;
    companyId: string;
    auth: CrewAuth;
    base?: string;
    onChanged?: () => void;
  },
): CoachingStore {
  const { db, companyId, auth } = options;
  const base = `${options.base ?? "/api/crew"}/coaching`;
  const store = new CoachingStore(db);
  const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof CoachingError) {
        res.status(error.status).json({ error: "coaching_rejected", message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "invalid_coaching_request",
          message: "Bitte alle Coaching-Felder und Prüfkriterien vollständig ausfüllen.",
        });
        return;
      }
      next(error);
    }
  };
  const id = (req: Request) => z.string().min(1).max(100).parse(req.params.id);
  app.get(
    base,
    auth.requireUser,
    handle((req, res) => {
      const agentId = z.string().min(1).max(100).parse(req.query.agentId);
      res.json(store.snapshot(companyId, agentId));
    }),
  );
  app.post(
    `${base}/proposals`,
    auth.requireRole("operator"),
    handle((req, res) => {
      const proposal = store.create(companyId, req.body, auth.actorOf(req));
      options.onChanged?.();
      res.status(201).json({ proposal });
    }),
  );
  app.post(
    `${base}/proposals/:id/evaluate`,
    auth.requireRole("operator"),
    handle((req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const proposal = store.evaluate(companyId, id(req), auth.actorOf(req));
      options.onChanged?.();
      res.json({ proposal });
    }),
  );
  app.post(
    `${base}/proposals/:id/review`,
    auth.requireRole("owner"),
    handle((req, res) => {
      const proposal = store.review(companyId, id(req), req.body, auth.actorOf(req));
      options.onChanged?.();
      res.json({ proposal });
    }),
  );
  app.post(
    `${base}/notes`,
    auth.requireRole("operator"),
    handle((req, res) => {
      const note = store.note(companyId, req.body, auth.actorOf(req));
      options.onChanged?.();
      res.status(201).json({ note });
    }),
  );
  return store;
}
