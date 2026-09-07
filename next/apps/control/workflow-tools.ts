import { FinanceAutomation } from "../../packages/domain/workflows/finance-automation.ts";
import { financeCorrectionTools } from "./finance-correction-tools.ts";
import { websiteCareTools } from "./website-care-tools.ts";
import { WebsiteCareService } from "./website-care-service.ts";
import type { ExecutionPort } from "../../packages/tools/isolation/index.ts";
import { z } from "zod";
import { researchWatchTools } from "./research-watch-tools.ts";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { WebsiteWorkflow, siteRevisionInputSchema } from "../../packages/domain/workflows/website.ts";
import { IncidentWorkflow } from "../../packages/domain/workflows/incident.ts";
import { KnowledgeService } from "../../packages/domain/workflows/knowledge.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
export function workflowTools(
  repo: Repository,
  directory: string,
  getExecutionPort?: () => Promise<ExecutionPort | undefined>,
): RuntimeTool[] {
  const web = new WebsiteWorkflow(repo, directory, getExecutionPort),
    incident = new IncidentWorkflow(repo),
    knowledge = new KnowledgeService(repo);
  return [
    ...websiteCareTools(new WebsiteCareService({ repo, directory })),
    ...financeCorrectionTools(repo, directory),
    ...researchWatchTools(repo, directory),
    {
      id: "website.revise",
      schema: siteRevisionInputSchema,
      requiresApproval: false,
      description:
        "Prepare a sourced revision of the selected website direction. Supply actual revised HTML, exact current artifact version, change explanation and relevant submitted feedback IDs. Then website.build produces a new package; previous artifacts and feedback remain unchanged and new review/acceptance is required.",
      execute: async (input, action) => web.revise(action.scope, action.orderId, input),
    },
    {
      id: "finance.processing_rule.review",
      schema: z.object({ ruleId: z.uuid(), evidence: z.string().trim().min(1).max(4000) }).strict(),
      description:
        "Finance lead reviews an explicitly proposed processing rule against source voucher and conflicts. CEO activation remains required.",
      requiresApproval: false,
      execute: async (input, action) => {
        const args = z
          .object({ ruleId: z.uuid(), evidence: z.string().trim().min(1).max(4000) })
          .strict()
          .parse(input);
        const order = await repo.getOrder(action.scope, action.orderId);
        const stored = await repo.getDocument(action.scope, "action", action.id);
        if (!stored || order.kind !== "finance") throw new DomainError("finance_lead_required");
        return new FinanceAutomation(repo).review(action.scope, args.ruleId, order.leadEmployeeId, args.evidence);
      },
    },
    {
      id: "website.brief",
      schema: z.object({
        briefing: z.string().min(1),
        stack: z.enum(["static", "react", "wordpress"]).default("static"),
      }),
      description: "Initialize the website workflow with an explicit brief and stack",
      requiresApproval: false,
      execute: async (input, a) => {
        const i = z.object({ briefing: z.string(), stack: z.enum(["static", "react", "wordpress"]) }).parse(input);
        if ((await repo.getOrder(a.scope, a.orderId)).kind !== "website")
          throw new DomainError("workflow_kind_mismatch");
        return web.create(a.scope, a.orderId, i.briefing, i.stack);
      },
    },
    {
      id: "website.concepts",
      schema: z.object({
        concepts: z
          .array(z.object({ name: z.string(), rationale: z.string(), html: z.string() }))
          .min(2)
          .max(10),
      }),
      description: "Provide five distinct actual HTML design concepts, each with a rationale. CEO selects next.",
      requiresApproval: false,
      execute: async (input, a) => web.concepts(a.scope, a.orderId, (input as { concepts: unknown }).concepts),
    },
    {
      id: "website.build",
      schema: z.object({}),
      description:
        "Build the previously CEO-selected concept and prepare a reproducible self-hosting package. React/WordPress require verified isolated build worker.",
      requiresApproval: false,
      execute: async (_input, a) => {
        const stored = await repo.getDocument<typeof a & { targetId: string }>(a.scope, "action", a.id);
        if (
          !stored ||
          stored.data.orderId !== a.orderId ||
          stored.data.toolId !== "website.build" ||
          stored.data.status !== "running"
        )
          throw new DomainError("execution_action_mismatch");
        return web.build(a.scope, a.orderId, {
          scope: a.scope,
          orderId: a.orderId,
          authority: { kind: "tool", actionId: a.id, targetId: stored.data.targetId },
        });
      },
    },
    {
      id: "incident.diagnose",
      schema: z.object({
        evidence: z.string(),
        causeStatus: z.enum(["unknown", "suspected", "confirmed"]),
        explanation: z.string(),
      }),
      description: "Record evidence and distinguish suspected from confirmed incident cause",
      requiresApproval: false,
      execute: async (input, a) =>
        incident.diagnose(
          a.scope,
          a.orderId,
          input as { evidence: string; causeStatus: "unknown" | "suspected" | "confirmed"; explanation: string },
        ),
    },
    {
      id: "knowledge.propose",
      schema: z.object({
        title: z.string(),
        content: z.string(),
        type: z.enum(["specialist", "company_rule"]),
        sourceArtifactVersionIds: z.array(z.uuid()).min(1),
      }),
      description: "Propose scoped sourced knowledge, never activate a company rule automatically",
      requiresApproval: false,
      execute: async (input, a) => {
        const order = await repo.getOrder(a.scope, a.orderId);
        return knowledge.propose(a.scope, {
          ...(input as {
            title: string;
            content: string;
            type: "specialist" | "company_rule";
            sourceArtifactVersionIds: string[];
          }),
          leadEmployeeId: order.leadEmployeeId,
        });
      },
    },
    {
      id: "knowledge.review",
      schema: z.object({
        id: z.uuid(),
        revision: z.number().int().positive(),
        decision: z.enum(["approve", "reject"]),
      }),
      description: "The responsible lead reviews proposed knowledge; company rules still await CEO",
      requiresApproval: false,
      execute: async (input, a) => {
        const i = z
          .object({ id: z.uuid(), revision: z.number().int().positive(), decision: z.enum(["approve", "reject"]) })
          .parse(input);
        const order = await repo.getOrder(a.scope, a.orderId);
        return knowledge.decide(a.scope, i.id, i.revision, { kind: "employee", id: order.leadEmployeeId }, i.decision);
      },
    },
  ];
}
