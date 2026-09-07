import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope, Order } from "../../packages/contracts/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import {
  ResearchWatch,
  researchWatchCreateSchema,
  type WatchDefinition,
  type WatchCheck,
} from "../../packages/domain/workflows/research-watch.ts";
import { ResearchService } from "../../packages/domain/workflows/research.ts";
import type { MutationHandler } from "./workflow-routes.ts";
/** Resolve configured integrations inside a check, so an unavailable connector is persisted as incomplete. */
export function configuredResearchWatch(
  repo: Repository,
  directory: string,
  watch: Pick<WatchDefinition, "scope" | "orderId" | "mandateId" | "mandateVersion">,
) {
  let service: Promise<ResearchService> | undefined;
  return new ResearchWatch(repo, directory, {
    fetchSource: async (scope, input) => {
      service ??= import("./configuration.ts").then(
        async ({ workflowIntegrationPort }) =>
          new ResearchService(
            repo,
            directory,
            await workflowIntegrationPort(
              repo,
              directory,
              watch.scope,
              watch.orderId,
              watch.mandateId,
              watch.mandateVersion,
            ),
          ),
      );
      return (await service).fetchSource(scope, input);
    },
  });
}
export function registerResearchWatchRoutes(
  app: Express,
  options: {
    repo: Repository;
    directory: string;
    context: (res: Response) => Scope;
    order: (req: Request, res: Response) => Promise<Order>;
    mutate: MutationHandler;
  },
) {
  const { repo, directory, order, mutate } = options;
  async function watchForOrder(req: Request, res: Response) {
    const o = await order(req, res),
      id = z.uuid().parse(req.params.watchId),
      watch = await repo.getDocument<WatchDefinition>(o.scope, "research-watch", id);
    if (!watch || watch.data.orderId !== o.id) throw new DomainError("watch_not_found", "watch_not_found", 404);
    return watch;
  }
  app.get("/api/v1/orders/:id/research/watches", async (req, res) => {
    const o = await order(req, res);
    res.json({
      items: (await repo.listDocuments<WatchDefinition>(o.scope, "research-watch"))
        .filter((watch) => watch.data.orderId === o.id)
        .map((watch) => ({ ...watch.data, revision: watch.revision })),
      nextCursor: null,
    });
  });
  app.post(
    "/api/v1/orders/:id/research/watches",
    mutate(async (req, res) => {
      const o = await order(req, res);
      return new ResearchWatch(repo, directory).create(
        o.scope,
        researchWatchCreateSchema.parse({ ...req.body, orderId: o.id }),
      );
    }),
  );
  app.get("/api/v1/orders/:id/research/watches/:watchId/checks", async (req, res) => {
    const watch = await watchForOrder(req, res);
    res.json({
      items: (await repo.listDocuments<WatchCheck>(watch.scope, "research-watch-check"))
        .filter((check) => check.data.watchId === watch.id)
        .map((check) => check.data),
      reviews: (await repo.listDocuments<{ watchId: string }>(watch.scope, "research-watch-review"))
        .filter((review) => review.data.watchId === watch.id)
        .map((review) => review.data),
      nextCursor: null,
    });
  });
  app.post(
    "/api/v1/orders/:id/research/watches/:watchId/check",
    mutate(async (req, res) => {
      const watch = await watchForOrder(req, res),
        input = z
          .object({ checkId: z.uuid().optional() })
          .strict()
          .parse(req.body ?? {});
      return configuredResearchWatch(repo, directory, watch.data).check(watch.scope, watch.id, {
        checkId: input.checkId ?? randomUUID(),
      });
    }),
  );
}
