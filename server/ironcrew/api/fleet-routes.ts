import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { CrewAuth } from "../auth/crew-auth.ts";
import type { FleetHub } from "../runner/fleet/hub.ts";
import { enrollmentSchema } from "../runner/fleet/types.ts";

/** Mounted behind the normal crew identity, CSRF and shared-auth middleware. */
export function registerFleetRoutes(
  app: Express,
  { hub, auth, base = "/api/crew" }: { hub: FleetHub; auth: CrewAuth; base?: string },
): void {
  const respond = (work: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const result = work(req);
      if (req.method !== "GET") hub.notifyChanged();
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: "fleet_request_invalid",
        message:
          error instanceof z.ZodError
            ? "Ungültige Runner-Konfiguration"
            : error instanceof Error
              ? error.message
              : "Fleet request failed",
      });
    }
  };
  app.get(
    `${base}/fleet/workers`,
    auth.requireUser,
    respond(() => ({ workers: hub.store.list() })),
  );
  app.get(
    `${base}/fleet/leases`,
    auth.requireUser,
    respond(() => ({ leases: hub.store.leases() })),
  );
  app.post(
    `${base}/fleet/enrollments`,
    auth.requireRole("owner"),
    respond((req) => hub.store.create(enrollmentSchema.parse(req.body), auth.actorOf(req).actorId)),
  );
  app.post(
    `${base}/fleet/workers/:id/enrollment`,
    auth.requireRole("owner"),
    respond((req) => hub.issue(String(req.params.id), auth.actorOf(req).actorId)),
  );
  app.post(
    `${base}/fleet/workers/:id/revoke`,
    auth.requireRole("owner"),
    respond((req) => ({ worker: hub.revoke(String(req.params.id), auth.actorOf(req).actorId) })),
  );
}
