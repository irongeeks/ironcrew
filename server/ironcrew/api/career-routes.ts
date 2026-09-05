import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { difficultySchema } from "../../../src/shared/career.ts";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { CareerReviewStore, CareerError } from "../domain/career-review-store.ts";
export interface CareerRoutesOptions {
  db: DatabaseSync;
  companyId: string;
  auth: CrewAuth;
  store?: CareerReviewStore;
  base?: string;
  onChange?: () => void;
}
export function registerCareerRoutes(app: Express, options: CareerRoutesOptions): CareerReviewStore {
  const { companyId, auth } = options;
  const store = options.store ?? new CareerReviewStore(options.db);
  const base = `${options.base ?? "/api/crew"}/people`;
  const handle =
    (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
      try {
        fn(req, res);
      } catch (error) {
        if (error instanceof CareerError) {
          res.status(error.status).json({ error: error.code, message: error.message });
          return;
        }
        if (error instanceof z.ZodError) {
          res
            .status(400)
            .json({ error: "invalid_career_input", message: "Personal- oder Bewertungsdaten sind ungültig." });
          return;
        }
        next(error);
      }
    };
  app.get(
    base,
    auth.requireUser,
    handle((req, res) => {
      const filters = z
        .object({
          from: z.coerce.number().int().nonnegative().optional(),
          to: z.coerce.number().int().nonnegative().optional(),
          difficulty: difficultySchema.optional(),
          model: z.string().max(256).optional(),
        })
        .strict()
        .parse(req.query);
      res.json(store.snapshot(companyId, filters));
    }),
  );
  app.put(
    `${base}/config`,
    auth.requireRole("owner"),
    handle((req, res) => {
      const config = store.updateConfig(companyId, req.body, auth.actorOf(req).actorId);
      options.onChange?.();
      res.json({ config });
    }),
  );
  app.post(
    `${base}/agents/:id/level`,
    auth.requireRole("owner"),
    handle((req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const result = store.requestLevel(companyId, id, req.body, auth.actorOf(req).actorId);
      options.onChange?.();
      res.status(201).json(result);
    }),
  );
  return store;
}
