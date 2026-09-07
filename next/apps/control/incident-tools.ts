import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import {
  IncidentService,
  repairParameters,
  checkParameters,
  messageParameters,
  type IncidentServiceOptions,
} from "./incident-service.ts";
export function incidentRuntimeTools(
  repo: Repository,
  directory: string,
  options: Omit<IncidentServiceOptions, "repo" | "directory"> = {},
): RuntimeTool[] {
  const service = new IncidentService({ repo, directory, ...options });
  return [
    {
      id: "incident.health_profiles",
      schema: z.object({}).strict(),
      description:
        "Read administratively configured independent HTTP health targets and exact profile fingerprints for this scope. Observation checks must fit the mandate duration and expiry.",
      requiresApproval: false,
      execute: async (_input, action) => service.profiles(action.scope),
    },
    ...(
      [
        {
          id: "incident.repair",
          schema: repairParameters,
          method: "repair",
          requiresApproval: true,
          description:
            "Restart exactly the incident's configured service target. Requires concrete CEO approval bound to targetConfigSha256; accepted restart still requires independent functional check.",
        },
        {
          id: "incident.check",
          schema: checkParameters,
          method: "check",
          requiresApproval: false,
          description:
            "Start an explicitly mandated continuous observation using an administrative health profile. Uses actual HTTP status/content; downtime or missed probes prevents resolution.",
        },
        {
          id: "incident.customer_message",
          schema: messageParameters,
          method: "customerMessage",
          requiresApproval: true,
          description:
            "Send the exact approved incident status message through a configured TLS mailbox. Approval binds sender configuration, recipient, subject, content and current incidentState. SMTP acceptance is not delivery.",
        },
      ] as const
    ).map((def) => ({
      id: def.id,
      schema: def.schema,
      description: def.description,
      requiresApproval: def.requiresApproval,
      execute: async (input: unknown, action: Parameters<RuntimeTool["execute"]>[1]) =>
        service[def.method](
          action.scope,
          action.orderId,
          {
            ...def.schema.parse(input),
            actionId: action.id,
            mandateId: action.mandateId,
            mandateVersion: action.mandateVersion,
          },
          action,
        ),
    })),
  ];
}
