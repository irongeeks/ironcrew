import type { Express, Response } from "express";
import { z } from "zod";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { FinanceService } from "./finance-service.ts";
import {
  processingRuleInputSchema,
  reminderPolicyInputSchema,
  invoiceHoldSchema,
  type ProcessingRule,
  type ReminderPolicy,
} from "../../packages/domain/workflows/finance-automation.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
import type { MutationHandler } from "./workflow-routes.ts";
export function registerFinanceRoutes(
  app: Express,
  options: { service: FinanceService; context: (res: Response) => Scope; mutate: MutationHandler },
) {
  const { service, context, mutate } = options,
    repo = service.options.repo;
  const ceo = async () => {
    const identity = await repo.getIdentity();
    if (!identity) throw new DomainError("ceo_required");
    return identity.id;
  };
  const find = async (companyId: string, kind: "finance-processing-rule" | "finance-reminder-policy", id: string) => {
    const doc = (await repo.listCompanyDocuments<ProcessingRule | ReminderPolicy>(companyId, kind)).find(
      (d) => d.id === id,
    );
    if (!doc) throw new DomainError("finance_rule_not_found");
    return doc;
  };
  app.get("/api/v1/finance/automation", async (_req, res) => res.json(await service.list(context(res).companyId)));
  app.post(
    "/api/v1/finance/processing-rules",
    mutate(async (req, res) => {
      const input = processingRuleInputSchema.parse(req.body);
      if (input.scope.companyId !== context(res).companyId) throw new DomainError("scope_denied");
      return service.automation.propose(input.scope, await ceo(), input);
    }),
  );
  app.post(
    "/api/v1/finance/processing-rules/:id/activate",
    mutate(async (req, res) => {
      const doc = await find(context(res).companyId, "finance-processing-rule", z.uuid().parse(req.params.id));
      return service.automation.activate(doc.scope, doc.id, await ceo());
    }),
  );
  app.post(
    "/api/v1/finance/processing-rules/:id/disable",
    mutate(async (req, res) => {
      const doc = await find(context(res).companyId, "finance-processing-rule", z.uuid().parse(req.params.id));
      return service.automation.disable(doc.scope, "finance-processing-rule", doc.id, await ceo());
    }),
  );
  app.post(
    "/api/v1/finance/reminder-policies",
    mutate(async (req, res) => {
      const input = reminderPolicyInputSchema.parse(req.body);
      if (input.scope.companyId !== context(res).companyId) throw new DomainError("scope_denied");
      return service.automation.proposeReminder(input.scope, await ceo(), input);
    }),
  );
  app.post(
    "/api/v1/finance/reminder-policies/:id/activate",
    mutate(async (req, res) => {
      const doc = await find(context(res).companyId, "finance-reminder-policy", z.uuid().parse(req.params.id));
      return service.automation.activateReminder(doc.scope, doc.id, await ceo());
    }),
  );
  app.post(
    "/api/v1/finance/reminder-policies/:id/disable",
    mutate(async (req, res) => {
      const doc = await find(context(res).companyId, "finance-reminder-policy", z.uuid().parse(req.params.id));
      return service.automation.disable(doc.scope, "finance-reminder-policy", doc.id, await ceo());
    }),
  );
  app.post(
    "/api/v1/finance/invoice-holds",
    mutate(async (req, res) => {
      const input = invoiceHoldSchema.parse(req.body);
      if (input.scope.companyId !== context(res).companyId) throw new DomainError("scope_denied");
      const id = shaUuid(`${input.targetId}:${input.invoiceId}`),
        old = await repo.getDocument(input.scope, "invoice-hold", id);
      return repo.putDocument(
        input.scope,
        "invoice-hold",
        id,
        { ...input, id, changedBy: await ceo(), changedAt: new Date().toISOString() },
        { expectedRevision: old?.revision ?? 0 },
      );
    }),
  );
}
