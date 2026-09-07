import type { Express, Response } from "express";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { ModelRatings, ratingInputSchema } from "../../packages/runtime/src/ratings.ts";
import type { MutationHandler } from "./workflow-routes.ts";
/** Register behind CEO authentication; mutations additionally use the Control CSRF/idempotency wrapper. */
export function registerRatingRoutes(
  app: Express,
  options: { repo: Repository; context: (res: Response) => Scope; mutate: MutationHandler },
) {
  const ratings = new ModelRatings(options.repo);
  const scopeFor = async (res: Response, id: string) => {
    const order = (await options.repo.listAllOrders(options.context(res).companyId)).find((order) => order.id === id);
    if (!order) throw new DomainError("order_not_found", "Order missing", 404);
    return order.scope;
  };
  app.get("/api/v1/models/ratings", async (_req, res) =>
    res.json({ items: await ratings.summaries(options.context(res).companyId), nextCursor: null }),
  );
  app.get("/api/v1/orders/:id/model-ratings", async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      scope = await scopeFor(res, id);
    res.json({
      items: (await ratings.latest(scope.companyId, id)).map((row) => row.data),
      targets: await ratings.targets(scope, id),
      nextCursor: null,
    });
  });
  app.post(
    "/api/v1/orders/:id/model-ratings",
    options.mutate(async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        body = ratingInputSchema.omit({ orderId: true }).parse(req.body),
        scope = await scopeFor(res, id);
      const identity = await options.repo.getIdentity();
      if (!identity || identity.companyId !== scope.companyId)
        throw new DomainError("ceo_required", "CEO required", 403);
      return ratings.rate(scope, { ...body, orderId: id }, { kind: "human", id: identity.id });
    }),
  );
}
