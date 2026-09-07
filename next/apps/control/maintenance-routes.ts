import type { Express, Response } from "express";
import { z } from "zod";
import type { Scope } from "../../packages/contracts/src/index.ts";
import type { MutationHandler } from "./workflow-routes.ts";
import type { MaintenanceService } from "./maintenance-service.ts";
export function registerMaintenanceRoutes(
  app: Express,
  options: {
    service: MaintenanceService;
    context: (res: Response) => Promise<{ scope: Scope; ceoId: string }> | { scope: Scope; ceoId: string };
    mutate: MutationHandler;
  },
) {
  const { service, context, mutate } = options;
  app.get("/api/v1/maintenance", async (_req, res) => {
    const actor = await context(res);
    res.json(await service.list(actor.scope, actor.ceoId));
  });
  app.post(
    "/api/v1/maintenance/backup-policies",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.proposeBackupPolicy(actor.scope, actor.ceoId, req.body);
    }),
  );
  app.post(
    "/api/v1/maintenance/backup-policies/:id/probe",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.probeBackupPolicy(
        actor.scope,
        actor.ceoId,
        z.uuid().parse(req.params.id),
        z
          .object({ identityPath: z.string().min(1) })
          .strict()
          .parse(req.body),
      );
    }),
  );
  app.post(
    "/api/v1/maintenance/backup-policies/:id/activate",
    mutate(async (req, res) => {
      const actor = await context(res);
      z.object({})
        .strict()
        .parse(req.body ?? {});
      return service.activateBackupPolicy(actor.scope, actor.ceoId, z.uuid().parse(req.params.id));
    }),
  );
  app.post(
    "/api/v1/maintenance/backup-policies/:id/pause",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.pauseBackupPolicy(actor.scope, actor.ceoId, z.uuid().parse(req.params.id));
    }),
  );
  app.post(
    "/api/v1/maintenance/update-policies",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.proposeUpdatePolicy(actor.scope, actor.ceoId, req.body);
    }),
  );
  app.post(
    "/api/v1/maintenance/update-policies/:id/revoke",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.revokeUpdatePolicy(actor.scope, actor.ceoId, z.uuid().parse(req.params.id));
    }),
  );
  app.post(
    "/api/v1/maintenance/updates",
    mutate(async (req, res) => {
      const actor = await context(res),
        input = z
          .object({ policyId: z.uuid(), releaseDirectory: z.string().min(1) })
          .strict()
          .parse(req.body);
      return service.proposeUpdate(actor.scope, actor.ceoId, input.policyId, input.releaseDirectory);
    }),
  );
  app.post(
    "/api/v1/maintenance/updates/:id/approve",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.approveUpdate(actor.scope, actor.ceoId, z.uuid().parse(req.params.id));
    }),
  );
  app.post(
    "/api/v1/maintenance/updates/:id/apply",
    mutate(async (req, res) => {
      const actor = await context(res);
      return service.applyUpdate(actor.scope, actor.ceoId, z.uuid().parse(req.params.id));
    }),
  );
}
