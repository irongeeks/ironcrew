import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { FinanceCorrections } from "../../packages/domain/workflows/finance-corrections.ts";
export function financeCorrectionTools(repo: Repository, directory: string): RuntimeTool[] {
  return [
    {
      id: "finance.correction_rule.review",
      schema: z.object({ ruleId: z.uuid(), evidence: z.string().trim().min(1).max(4000) }).strict(),
      description:
        "Finance lead reviews an explicitly requested typed classification correction rule against its immutable source and conflicting scoped rules. CEO activation remains separate.",
      requiresApproval: false,
      execute: async (input, action) => {
        const args = z
          .object({ ruleId: z.uuid(), evidence: z.string().trim().min(1).max(4000) })
          .strict()
          .parse(input);
        const order = await repo.getOrder(action.scope, action.orderId),
          stored = await repo.getDocument<typeof action>(action.scope, "action", action.id);
        if (
          !stored ||
          stored.data.status !== "running" ||
          stored.data.orderId !== order.id ||
          stored.data.toolId !== "finance.correction_rule.review" ||
          order.kind !== "finance"
        )
          throw new DomainError("finance_lead_required");
        return new FinanceCorrections(repo, directory).review(
          action.scope,
          args.ruleId,
          order.leadEmployeeId,
          args.evidence,
        );
      },
    },
  ];
}
