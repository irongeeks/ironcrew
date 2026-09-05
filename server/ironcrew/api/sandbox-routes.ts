import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { SandboxAccessService, SandboxAccessError } from "../domain/sandbox-access-service.ts";
import type { SandboxGrantRow } from "../domain/sandbox-grant-store.ts";

export interface SandboxRoutesOptions {
  db: DatabaseSync;
  companyId: string;
  auth: CrewAuth;
  base?: string;
  service?: SandboxAccessService;
  onRevoke?(grant: SandboxGrantRow): void | Promise<void>;
}
/** Mounted behind crew identity + global CSRF middleware. Decisions use the existing approval inbox. */
export function registerSandboxRoutes(app: Express, options: SandboxRoutesOptions): SandboxAccessService {
  const { companyId, auth } = options;
  const base = `${options.base ?? "/api/crew"}/sandbox-access`;
  const service = options.service ?? new SandboxAccessService(options.db);
  const handle =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SandboxAccessError) {
          res.status(400).json({
            error: "invalid_sandbox_request",
            message: error instanceof SandboxAccessError ? error.message : "Sandbox-Anfrage ist ungültig.",
          });
          return;
        }
        next(error);
      }
    };
  app.get(
    base,
    auth.requireUser,
    handle((_req, res) => res.json(service.list(companyId))),
  );
  app.post(
    `${base}/request`,
    auth.requireRole("owner"),
    handle((req, res) => {
      const approval = service.request(companyId, req.body, auth.actorOf(req).actorId);
      res.status(201).json({ approval });
    }),
  );
  app.post(
    `${base}/:id/revoke`,
    auth.requireRole("owner"),
    handle(async (req, res) => {
      const { reason } = z
        .object({ reason: z.string().trim().min(1).max(2000) })
        .strict()
        .parse(req.body);
      const id = typeof req.params.id === "string" ? req.params.id : "";
      const grant = service.revoke(companyId, id, auth.actorOf(req).actorId, reason);
      if (!grant) {
        res.status(404).json({ error: "sandbox_grant_not_found" });
        return;
      }
      await options.onRevoke?.(grant);
      res.json({ grant });
    }),
  );
  return service;
}
