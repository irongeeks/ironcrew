import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Order } from "../../packages/contracts/src/index.ts";
import type { MutationHandler } from "./workflow-routes.ts";
import type { WebsiteCareService } from "./website-care-service.ts";
export function registerWebsiteCareRoutes(
  app: Express,
  options: {
    service: WebsiteCareService;
    order: (req: Request, res: Response) => Promise<Order>;
    ceo: (res: Response) => Promise<string> | string;
    mutate: MutationHandler;
  },
) {
  const base = "/api/v1/orders/:id/website-care";
  app.get(base, async (req, res) => {
    const o = await options.order(req, res);
    res.json(await options.service.status(o.scope, o.id));
  });
  app.post(
    base,
    options.mutate(async (req, res) => {
      const o = await options.order(req, res);
      return options.service.configure(o.scope, o.id, await options.ceo(res), req.body);
    }),
  );
  app.put(
    base + "/:policyId",
    options.mutate(async (req, res) => {
      const o = await options.order(req, res);
      return options.service.configure(o.scope, o.id, await options.ceo(res), req.body, {
        id: z.uuid().parse(req.params.policyId),
        revision: z.coerce.number().int().positive().parse(req.header("If-Match")),
      });
    }),
  );
  app.post(
    base + "/:policyId/run",
    options.mutate(async (req, res) => {
      const o = await options.order(req, res),
        body = z
          .object({ kind: z.enum(["check", "backup", "update"]) })
          .strict()
          .parse(req.body);
      return options.service.run(o.scope, o.id, await options.ceo(res), z.uuid().parse(req.params.policyId), body.kind);
    }),
  );
}
