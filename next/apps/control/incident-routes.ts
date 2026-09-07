import { z } from "zod";
import { DomainError } from "../../packages/domain/src/index.ts";
import type { Express, Request, Response } from "express";
import type { Scope, Order } from "../../packages/contracts/src/index.ts";
import type { MutationHandler } from "./workflow-routes.ts";
import type { IncidentService } from "./incident-service.ts";
export function registerIncidentRoutes(
  app: Express,
  options: {
    service: IncidentService;
    context: (res: Response) => Promise<{ scope: Scope; ceoId: string }> | { scope: Scope; ceoId: string };
    order: (req: Request, res: Response) => Promise<Order>;
    mutate: MutationHandler;
  },
) {
  const { service, context, order, mutate } = options;
  app.get("/api/v1/incident/health-profiles", async (_req, res) => {
    const actor = await context(res);
    res.json({ items: await service.profiles(actor.scope, true) });
  });
  app.post(
    "/api/v1/incident/health-profiles",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.configureHealth(actor.scope, actor.ceoId, req.body);
    }),
  );
  app.put(
    "/api/v1/incident/health-profiles/:id",
    mutate(async (req, res) => {
      const actor = await context(res),
        targetId = z.uuid().parse(req.params.id);
      if (req.body.targetId !== targetId) throw new DomainError("health_profile_target_mismatch");
      return service.configureHealth(
        actor.scope,
        actor.ceoId,
        req.body,
        z.coerce.number().int().positive().parse(req.header("If-Match")),
      );
    }),
  );
  app.get("/api/v1/orders/:id/incident/status", async (req, res) => {
    const target = await order(req, res);
    res.json(await service.status(target.scope, target.id));
  });
  for (const [route, method] of [
    ["repair", "repair"],
    ["check", "check"],
    ["customer-message", "customerMessage"],
  ] as const)
    app.post(
      `/api/v1/orders/:id/incident/${route}`,
      mutate(async (req, res) => {
        const target = await order(req, res);
        return service[method](target.scope, target.id, req.body);
      }),
    );
}
