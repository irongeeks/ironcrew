import { evaluateModel } from "../policy/vendor-policy.ts";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { CompanyPolicyError, type CompanyPolicyStore } from "../policy/company-policy-store.ts";
export function registerCompanyPolicyRoutes(
  app: Express,
  options: { store: CompanyPolicyStore; companyId: string; auth: CrewAuth; base?: string; onChanged?: () => void },
): void {
  const { store, companyId, auth } = options;
  const base = `${options.base ?? "/api/crew"}/policies/vendor`;
  const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof CompanyPolicyError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: "invalid_vendor_policy", message: "Policy-Auswahl oder Begründung ist ungültig." });
        return;
      }
      next(error);
    }
  };
  app.get(
    base,
    auth.requireUser,
    handle((_req, res) => res.json(store.snapshot(companyId))),
  );
  app.post(
    `${base}/check`,
    auth.requireUser,
    handle((req, res) => {
      const { model, provider } = z
        .object({ model: z.string().trim().min(1).max(250), provider: z.string().trim().min(1).max(200).optional() })
        .strict()
        .parse(req.body);
      const snapshot = store.snapshot(companyId);
      let decision: { allowed: boolean; code: string; reason: string; matchedRule?: string } = evaluateModel(
        snapshot.effectivePolicy,
        model,
        provider,
      );
      if (decision.allowed && provider && !snapshot.effectivePolicy.openrouter.allowed_providers.includes(provider))
        decision = {
          allowed: false,
          code: "provider_not_allowed",
          reason: "Dieser OpenRouter-Provider ist in der wirksamen Policy nicht freigegeben.",
        };
      res.json({
        model,
        provider: provider ?? null,
        decision,
        revision: snapshot.revision,
        baselineFingerprint: snapshot.baselineFingerprint,
      });
    }),
  );
  app.put(
    base,
    auth.requireRole("owner"),
    handle((req, res) => {
      const snapshot = store.save(companyId, req.body, auth.actorOf(req).actorId);
      options.onChanged?.();
      res.json(snapshot);
    }),
  );
}
