import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { ObjectiveEvaluationError, ObjectiveEvaluationStore } from "../domain/objective-evaluation-store.ts";
export function registerObjectiveEvaluationRoutes(
  app: Express,
  options: {
    db: DatabaseSync;
    companyId: string;
    auth: CrewAuth;
    base?: string;
    onChanged?: () => void;
  },
): ObjectiveEvaluationStore {
  const { db, companyId, auth } = options;
  const base = `${options.base ?? "/api/crew"}/evaluations`;
  const store = new ObjectiveEvaluationStore(db);
  const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof ObjectiveEvaluationError) {
        res.status(error.status).json({ error: "evaluation_rejected", message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "invalid_evaluation",
          message: "Bitte Rubrik, Version und Prüfkriterien vollständig und gültig angeben.",
        });
        return;
      }
      next(error);
    }
  };
  app.get(
    base,
    auth.requireUser,
    handle((req, res) => {
      res.json(store.snapshot(companyId, auth.actorOf(req)));
    }),
  );
  app.post(
    `${base}/rubrics`,
    auth.requireRole("owner"),
    handle((req, res) => {
      const rubric = store.createRubric(companyId, req.body, auth.actorOf(req));
      options.onChanged?.();
      res.status(201).json({ rubric });
    }),
  );
  app.post(
    `${base}/measure`,
    auth.requireRole("operator"),
    handle((req, res) => {
      const measurement = store.measure(companyId, req.body, auth.actorOf(req));
      options.onChanged?.();
      res.json({ measurement });
    }),
  );
  app.get(
    `${base}/:id/replay`,
    auth.requireUser,
    handle((req, res) => {
      const id = z.string().min(1).max(100).parse(req.params.id);
      res.json({ checks: store.replay(companyId, id) });
    }),
  );
  return store;
}
