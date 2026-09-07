import type { Express, Response } from "express";
import { z } from "zod";
import type { MutationHandler } from "./workflow-routes.ts";
import type { ModelCostService } from "./model-cost-service.ts";
export function registerModelCostRoutes(
  app: Express,
  options: {
    service: ModelCostService;
    context: (res: Response) => Promise<{ companyId: string; ceoId: string }> | { companyId: string; ceoId: string };
    mutate: MutationHandler;
  },
) {
  app.get("/api/v1/model-costs", async (_req, res) => {
    const a = await options.context(res);
    res.json(await options.service.list(a.companyId, a.ceoId));
  });
  app.post(
    "/api/v1/model-costs/:id/provider",
    options.mutate(async (req, res) => {
      z.object({}).strict().parse(req.body);
      const a = await options.context(res);
      return options.service.provider(
        a.companyId,
        a.ceoId,
        z.uuid().parse(req.params.id),
        z.coerce.number().int().positive().parse(req.header("If-Match")),
      );
    }),
  );
  app.post(
    "/api/v1/model-costs/:id/manual",
    options.mutate(async (req, res) => {
      const a = await options.context(res);
      return options.service.manual(
        a.companyId,
        a.ceoId,
        z.uuid().parse(req.params.id),
        z.coerce.number().int().positive().parse(req.header("If-Match")),
        req.body,
      );
    }),
  );
}
