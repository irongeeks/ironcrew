import { oauthBrokerOptions, recoveryGeneration } from "./oauth-broker.ts";
import { oauthConfigurationSchema } from "../../packages/integrations/src/oauth.ts";
import path from "node:path";
import { z } from "zod";
import { scopeSchema, type Scope, type ToolAction } from "../../packages/contracts/src/index.ts";
import { DomainError, sameScope, sha256 } from "../../packages/domain/src/index.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import { secretRefSchema, type SecretResolver } from "../../packages/integrations/src/secrets.ts";
import { MailConnector } from "../../packages/integrations/src/mail.ts";
import type { AuthorizedIntegrationAction, IntegrationResult } from "../../packages/integrations/src/service.ts";
export const mailConnectionSchema = z
  .object({
    id: z.uuid(),
    scope: scopeSchema,
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    secretRef: secretRefSchema.optional(),
    oauth: oauthConfigurationSchema.optional(),
    from: z.email(),
    mailbox: z.string().optional(),
    tlsMode: z.enum(["implicit", "starttls"]).optional(),
    tlsCaFile: z.string().refine(path.isAbsolute).optional(),
    enabledTools: z.array(z.enum(["mail.send", "mail.read"])).min(1),
  })
  .strict();
export type MailConfiguration = { mailConnections: z.infer<typeof mailConnectionSchema>[] };
export const mailCapabilities = [
  {
    id: "mail.read",
    effect: "read" as const,
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
  },
  {
    id: "mail.send",
    effect: "external_send" as const,
    inputSchema: z
      .object({
        to: z.array(z.email()).min(1).max(20),
        subject: z.string().min(1).max(200),
        text: z.string().min(1).max(100000),
      })
      .strict(),
  },
];
const targetFor = (config: MailConfiguration, scope: Scope, id: string, tool: string) => {
  const target = config.mailConnections.find(
    (t) => t.id === id && t.enabledTools.includes(tool as "mail.send" | "mail.read"),
  );
  if (!target || !sameScope(target.scope, scope)) throw new DomainError("mail_target_denied", undefined, 403);
  return target;
};
export function mailRuntimeTools(
  repo: Repository,
  config: MailConfiguration,
  secrets: SecretResolver,
  directory?: string,
): RuntimeTool[] {
  return mailCapabilities
    .map((cap) => {
      const create = (scope?: Scope): RuntimeTool | undefined => {
        const targets = config.mailConnections.filter(
          (t) => (!scope || sameScope(t.scope, scope)) && t.enabledTools.includes(cap.id as "mail.send" | "mail.read"),
        );
        if (!targets.length) return undefined;
        return {
          id: cap.id,
          schema: z
            .object({
              targetId: z.enum(targets.map((t) => t.id) as [string, ...string[]]),
              targetConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
              parameters: cap.inputSchema,
            })
            .strict(),
          description: `${cap.id}: TLS mailbox. SMTP acceptance does not establish delivery. Targets: ${JSON.stringify(targets.map((t) => ({ id: t.id, targetConfigSha256: sha256(t) })))}`,
          requiresApproval: cap.effect === "external_send",
          forScope: scope ? undefined : (next) => create(next),
          execute: async (input, action) => {
            const parsed = z
                .object({
                  targetId: z.uuid(),
                  targetConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
                  parameters: cap.inputSchema,
                })
                .strict()
                .parse(input),
              target = targetFor(config, action.scope, parsed.targetId, cap.id);
            if (sha256(target) !== parsed.targetConfigSha256)
              throw new DomainError("mail_target_changed", undefined, 403);
            const connector = new MailConnector(
              target,
              secrets,
              async () => {
                const stored = await repo.getDocument<ToolAction>(action.scope, "action", action.id);
                if (
                  !stored ||
                  stored.data.toolId !== cap.id ||
                  stored.data.status !== "running" ||
                  stored.data.argumentsSha256 !== sha256(input)
                )
                  throw new DomainError("action_missing");
                await repo.assertAuthorized(action.scope, {
                  action: stored.data,
                  targetId: target.id,
                  effect: cap.effect,
                  requireApproval: cap.effect === "external_send",
                });
              },
              directory
                ? {
                    oauth: oauthBrokerOptions(repo, directory, secrets).oauth,
                    oauthGeneration: () => recoveryGeneration(repo, action.scope),
                  }
                : {},
            );
            const call = {
              id: action.id,
              scope: action.scope,
              targetId: target.id,
              toolId: cap.id,
              args: parsed.parameters,
            };
            return cap.id === "mail.send" ? connector.send(call) : connector.read(call);
          },
        };
      };
      return create();
    })
    .filter((tool): tool is RuntimeTool => tool !== undefined);
}
export function managedMailPort(
  repo: Repository,
  directory: string,
  config: MailConfiguration,
  request: { orderId: string; mandateId: string; mandateVersion: number },
  secrets: SecretResolver,
) {
  const actions = new ManagedActions(repo, path.join(directory, "receipts"));
  return {
    execute: async (input: AuthorizedIntegrationAction): Promise<IntegrationResult> => {
      const cap = mailCapabilities.find((c) => c.id === input.toolId);
      if (!cap) throw new DomainError("tool_unknown");
      const target = targetFor(config, input.scope, input.targetId, cap.id),
        parameters = cap.inputSchema.parse(input.args);
      const result = await actions.perform(
        {
          ...request,
          id: input.id,
          scope: input.scope,
          targetId: target.id,
          toolId: cap.id,
          effect: cap.effect,
          requireApproval: cap.effect === "external_send",
          args: { targetConfigurationSha256: sha256(target), parameters },
        },
        async () => {
          const connector = new MailConnector(
              target,
              secrets,
              async () => {
                const stored = await repo.getDocument<ToolAction>(input.scope, "action", input.id);
                if (!stored || stored.data.status !== "running") throw new DomainError("action_missing");
                await repo.assertAuthorized(input.scope, {
                  action: stored.data,
                  targetId: target.id,
                  effect: cap.effect,
                  requireApproval: cap.effect === "external_send",
                });
              },
              {
                oauth: oauthBrokerOptions(repo, directory, secrets).oauth,
                oauthGeneration: () => recoveryGeneration(repo, input.scope),
              },
            ),
            call = { ...input, args: parameters };
          return cap.id === "mail.send" ? connector.send(call) : connector.read(call);
        },
      );
      if (result.state !== "succeeded")
        throw new DomainError(result.state === "approval" ? "approval_required" : "mail_" + result.state);
      return result.data as IntegrationResult;
    },
  };
}
