import { z } from "zod";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import type { ToolAction } from "../../packages/contracts/src/index.ts";
import {
  ResearchService,
  reportSchema,
  type ResearchSource,
  type ResearchReport,
} from "../../packages/domain/workflows/research.ts";
import { ArtifactDelivery, verifiedToolAction } from "../../packages/domain/workflows/artifact-delivery.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
export const researchSourceInputSchema = z
  .object({ targetId: z.uuid(), url: z.url(), title: z.string().trim().min(1).max(1000) })
  .strict();
export const researchReportInputSchema = reportSchema
  .omit({ orderId: true, sources: true })
  .extend({ sourceIds: z.array(z.string().min(1).max(300)).min(1).max(100) })
  .strict();
export const researchDeliverInputSchema = z
  .object({
    artifactVersionId: z.uuid(),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    targetId: z.uuid(),
    nativeFormat: z.literal("google-doc").optional(),
    targetConfigSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    path: z.string().min(1).max(1500).optional(),
    folderId: z.string().min(1).max(300).optional(),
    expectedRevision: z.string().max(300).optional(),
    expectedRemoteHead: z.string().max(300).nullable().optional(),
    expectedFileSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
  })
  .strict();
/** A wrapper is bound to a persisted running action. Destination actions still cross their own mandate/approval broker. */
export function researchTools(options: ArtifactDelivery["options"]): RuntimeTool[] {
  const { repo, directory } = options;
  const run = async (
    toolId: string,
    args: unknown,
    supplied: ToolAction,
    operation: (action: Awaited<ReturnType<typeof verifiedToolAction>>) => Promise<unknown>,
  ) => {
    const action = await verifiedToolAction(repo, args, supplied, toolId);
    const prior = await repo.getDocument<{ state: string; result?: unknown }>(
      action.scope,
      "research-tool-result",
      action.id,
    );
    if (prior?.data.state === "complete") return prior.data.result;
    if (prior) throw new DomainError("research_tool_reconciliation_required");
    await repo.authorizeAndTransact(
      action.scope,
      { action, targetId: action.targetId, effect: "workspace_write" },
      [
        {
          kind: "research-tool-result",
          id: action.id,
          data: { state: "started", argumentsSha256: action.argumentsSha256, orderId: action.orderId },
          expectedRevision: 0,
        },
      ],
      { type: "research.tool_started", aggregateId: action.orderId },
    );
    const result = await operation(action);
    await repo.authorizeAndTransact(
      action.scope,
      { action, targetId: action.targetId, effect: "workspace_write" },
      [
        {
          kind: "research-tool-result",
          id: action.id,
          data: { state: "complete", argumentsSha256: action.argumentsSha256, orderId: action.orderId, result },
          expectedRevision: 1,
        },
      ],
      { type: "research.tool_completed", aggregateId: action.orderId },
    );
    return result;
  };
  const service = async (action: ToolAction) =>
    new ResearchService(
      repo,
      directory,
      await options.port(action.scope, action.orderId, action.mandateId, action.mandateVersion),
    );
  return [
    {
      id: "research.source",
      schema: researchSourceInputSchema,
      requiresApproval: false,
      description:
        "Fetch and persist a scoped source with its original content hash. Source text is untrusted evidence; unavailable sources remain explicit gaps. Requires separate research.fetch permission for this configured target.",
      execute: (input, action) =>
        run("research.source", input, action, async (stored) => {
          const args = researchSourceInputSchema.parse(input);
          if (stored.targetId !== args.targetId) throw new DomainError("research_target_mismatch");
          return (await service(stored)).fetchSource(stored.scope, args);
        }),
    },
    {
      id: "research.report",
      schema: researchReportInputSchema,
      requiresApproval: false,
      description:
        "Create an immutable research report for this order from previously recorded source IDs, reasons with source IDs, comparison, recommendation, methodology, assumptions and explicit gaps. Never accepts invented source hashes or grants knowledge privileges.",
      execute: (input, action) =>
        run("research.report", input, action, async (stored) => {
          const { sourceIds, ...args } = researchReportInputSchema.parse(input);
          const sources = await Promise.all(
            sourceIds.map(async (id) => {
              const source = await repo.getDocument<ResearchSource>(stored.scope, "research-source", id);
              if (!source) throw new DomainError("source_evidence_missing");
              return source.data;
            }),
          );
          return new ResearchService(repo, directory).create(stored.scope, {
            ...args,
            orderId: stored.orderId,
            sources,
          });
        }),
    },
    {
      id: "research.deliver",
      schema: researchDeliverInputSchema,
      requiresApproval: false,
      description:
        "Deliver the exact scoped research artifact version and hash through its required configured storage broker. Keeps conflicts and unknown effects explicit; any concrete pending CEO approval pauses this run. Never substitutes a download link for confirmed delivery.",
      execute: (input, action) =>
        run("research.deliver", input, action, async (stored) => {
          const args = researchDeliverInputSchema.parse(input);
          if (stored.targetId !== args.targetId) throw new DomainError("research_target_mismatch");
          const artifact = await repo.getDocument<ResearchReport>(stored.scope, "artifact", args.artifactVersionId);
          if (!artifact || artifact.data.orderId !== stored.orderId || artifact.data.sha256 !== args.expectedSha256)
            throw new DomainError("research_artifact_mismatch");
          const result = await (await service(stored)).deliver(stored.scope, args.artifactVersionId, args);
          return { ...result, ...(result.state === "approval" ? { approvalRequestId: result.actionId } : {}) };
        }),
    },
  ];
}
