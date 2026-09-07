import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Scope, Order } from "../../packages/contracts/src/index.ts";
import type { MutationHandler } from "./workflow-routes.ts";
import type { HostingService } from "./hosting-service.ts";
export function registerHostingRoutes(
  app: Express,
  options: {
    service: HostingService;
    context: (res: Response) => Promise<{ scope: Scope; ceoId: string }> | { scope: Scope; ceoId: string };
    order: (req: Request, res: Response) => Promise<Order>;
    mutate: MutationHandler;
  },
) {
  const { service, context, order, mutate } = options;
  app.get("/api/v1/hosting/profiles", async (_req, res) => {
    const actor = await context(res);
    res.json({ items: await service.profiles(actor.scope, actor.ceoId) });
  });
  app.post(
    "/api/v1/hosting/profiles",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.configureProfile(actor.scope, actor.ceoId, req.body);
    }),
  );
  app.put(
    "/api/v1/hosting/profiles/:id",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.configureProfile(actor.scope, actor.ceoId, req.body, {
        id: z.uuid().parse(req.params.id),
        expectedRevision: z.coerce.number().int().positive().parse(req.header("If-Match")),
      });
    }),
  );
  app.get("/api/v1/orders/:id/hosting", async (req, res) => {
    const target = await order(req, res);
    res.json(await service.status(target.scope, target.id));
  });
  app.post(
    "/api/v1/orders/:id/hosting/provision",
    mutate(async (req, res) => {
      const target = await order(req, res);
      return service.provision(target.scope, target.id, req.body);
    }),
  );
  app.post(
    "/api/v1/orders/:id/hosting/publish",
    mutate(async (req, res) => {
      const target = await order(req, res);
      return service.publish(target.scope, target.id, req.body);
    }),
  );
  app.post(
    "/api/v1/orders/:id/hosting/rollback",
    mutate(async (req, res) => {
      const target = await order(req, res);
      return service.rollback(target.scope, target.id, req.body);
    }),
  );
}
