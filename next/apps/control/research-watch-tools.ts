import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import type { ToolAction } from "../../packages/contracts/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import {
  ResearchWatch,
  researchWatchCreateSchema,
  watchReviewSchema,
  type WatchDefinition,
} from "../../packages/domain/workflows/research-watch.ts";
import { configuredResearchWatch } from "./research-watch-routes.ts";
export function researchWatchTools(repo: Repository, directory: string): RuntimeTool[] {
  const createSchema = z
    .object({
      title: researchWatchCreateSchema.shape.title,
      relevantChanges: researchWatchCreateSchema.shape.relevantChanges,
      sources: researchWatchCreateSchema.shape.sources,
      cadenceSeconds: researchWatchCreateSchema.shape.cadenceSeconds,
      budgetLimitUsdMicros: researchWatchCreateSchema.shape.budgetLimitUsdMicros,
      predecessorArtifactId: researchWatchCreateSchema.shape.predecessorArtifactId,
    })
    .strict();
  const checkSchema = z.object({ watchId: z.uuid(), checkId: z.uuid() }).strict();
  const reviewSchema = z.object({ watchId: z.uuid(), checkId: z.uuid(), assessment: watchReviewSchema }).strict();
  async function ownedWatch(action: ToolAction, id: string) {
    const watch = await repo.getDocument<WatchDefinition>(action.scope, "research-watch", id);
    if (
      !watch ||
      watch.data.orderId !== action.orderId ||
      watch.data.mandateId !== action.mandateId ||
      watch.data.mandateVersion !== action.mandateVersion
    )
      throw new DomainError("watch_binding_mismatch");
    return watch;
  }
  return [
    {
      id: "research.watch.create",
      schema: createSchema,
      description:
        "Create an explicitly mandated source observation for this research order. Set cadence and cost ceiling equal to the order budget; preserve a source-backed predecessor. Never extend permissions or activate company rules.",
      requiresApproval: false,
      execute: async (input, action) =>
        new ResearchWatch(repo, directory).create(action.scope, {
          ...createSchema.parse(input),
          orderId: action.orderId,
          mandateId: action.mandateId,
          mandateVersion: action.mandateVersion,
        }),
    },
    {
      id: "research.watch.check",
      schema: checkSchema,
      description:
        "Perform a due source-hash observation. A failure is incomplete, a changed source produces an immutable change template requiring lead review. Reuse checkId for a retry; no model call is made by this tool.",
      requiresApproval: false,
      execute: async (input, action) => {
        const parsed = checkSchema.parse(input),
          watch = await ownedWatch(action, parsed.watchId);
        return configuredResearchWatch(repo, directory, watch.data).check(action.scope, watch.id, {
          checkId: parsed.checkId,
        });
      },
    },
    {
      id: "research.watch.review",
      schema: reviewSchema,
      description:
        "As the responsible lead, assess a complete source-change template against its exact artifact. State maintain, revise, or irrelevant with evidence. This does not change company knowledge or permissions.",
      requiresApproval: false,
      execute: async (input, action) => {
        const parsed = reviewSchema.parse(input),
          watch = await ownedWatch(action, parsed.watchId),
          order = await repo.getOrder(action.scope, action.orderId);
        return new ResearchWatch(repo, directory).review(
          action.scope,
          watch.id,
          parsed.checkId,
          order.leadEmployeeId,
          parsed.assessment,
        );
      },
    },
  ];
}
