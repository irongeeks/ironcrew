import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import {
  ArtifactDelivery,
  artifactDeliverInputSchema,
  approvalRequestInputSchema,
  requestActionApproval,
} from "../../packages/domain/workflows/artifact-delivery.ts";
export function artifactApprovalTools(options: ArtifactDelivery["options"]): RuntimeTool[] {
  const delivery = new ArtifactDelivery(options);
  return [
    {
      id: "artifact.deliver",
      schema: artifactDeliverInputSchema,
      requiresApproval: false,
      description:
        "Deliver an exact immutable UTF-8 text artifact version/hash to its configured Nextcloud or Drive target using separate authorized child actions. Binary/site-package publishing uses its dedicated workflow. Both wrapper and destination tool must be allowed by the mandate.",
      execute: (args, action) => delivery.deliver(args, action),
    },
    {
      id: "approval.request",
      schema: approvalRequestInputSchema,
      requiresApproval: false,
      description:
        "Request a concrete CEO decision for an existing undispatched action of this same order/scope and exact arguments hash. Creates or reuses pending decision; never grants approval. Run waits with context.",
      execute: (args, action) => requestActionApproval(options.repo, args, action),
    },
  ];
}
