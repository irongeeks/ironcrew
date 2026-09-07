import type { Express, Response } from "express";
import { z } from "zod";
import type { Scope } from "../../packages/contracts/src/index.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { FinanceCorrections } from "../../packages/domain/workflows/finance-corrections.ts";
import type { MutationHandler } from "./workflow-routes.ts";
export function registerFinanceCorrectionRoutes(
  app: Express,
  options: { repo: Repository; directory: string; context: (res: Response) => Scope; mutate: MutationHandler },
) {
  const service = new FinanceCorrections(options.repo, options.directory);
  for (const operation of ["activate", "disable", "revision"] as const) {
    app.post(
      `/api/v1/finance/correction-rules/:id/${operation}`,
      options.mutate(async (req, res) => {
        const id = z.uuid().parse(req.params.id),
          companyId = options.context(res).companyId;
        const doc = (await options.repo.listCompanyDocuments(companyId, "finance-rule")).find((item) => item.id === id);
        if (!doc) throw new DomainError("finance_rule_not_found");
        const ceo = (await options.repo.snapshot(companyId)).ceo.id;
        return operation === "revision"
          ? service.revise(doc.scope, id, req.body, ceo)
          : service[operation](doc.scope, id, ceo);
      }),
    );
  }
}
