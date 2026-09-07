import type { Express, Response } from "express";
import { z } from "zod";
import type { MutationHandler } from "./workflow-routes.ts";
import type { IntegrationCostService } from "./integration-costs.ts";
export function registerIntegrationCostRoutes(
  app: Express,
  options: {
    service: IntegrationCostService;
    context: (res: Response) => Promise<{ companyId: string; ceoId: string }> | { companyId: string; ceoId: string };
    mutate: MutationHandler;
  },
) {
  app.get("/api/v1/integration-costs", async (_req, res) => {
    const actor = await options.context(res);
    res.json(await options.service.list(actor.companyId, actor.ceoId));
  });
  app.post(
    "/api/v1/integration-costs/:id/reconcile",
    options.mutate(async (req, res) => {
      const actor = await options.context(res);
      return options.service.reconcile(
        actor.companyId,
        actor.ceoId,
        z.uuid().parse(req.params.id),
        z.coerce.number().int().positive().parse(req.header("If-Match")),
        req.body,
      );
    }),
  );
}
