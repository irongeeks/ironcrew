import { z } from "zod";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import type { WebsiteCareService } from "./website-care-service.ts";
/** Mutations are scheduled under the CEO policy; model discovery cannot grant or expand care authority. */
export function websiteCareTools(service: WebsiteCareService): RuntimeTool[] {
  return [
    {
      id: "website.care.status",
      schema: z.object({ websiteOrderId: z.uuid() }).strict(),
      description:
        "Read explicitly configured technical care, backup/update evidence and incident links for the current scoped website. Content/SEO changes and policy approval are separate. Scheduler performs only already authorized care.",
      requiresApproval: false,
      execute: async (input, action) => {
        const parsed = z.object({ websiteOrderId: z.uuid() }).strict().parse(input);
        return service.status(action.scope, parsed.websiteOrderId);
      },
    },
  ];
}
