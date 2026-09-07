import path from "node:path";
import { z } from "zod";
import { scopeSchema, type Scope, type ToolAction } from "../../packages/contracts/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import {
  GitConnector,
  ServiceBroker,
  IntegrationError,
  gitCapabilities,
  serviceBrokerCapabilities,
  secretRefSchema,
  type GitActionPort,
  type SecretResolver,
  type BrokerRunner,
  type AuthorizedIntegrationAction,
  type IntegrationResult,
} from "../../packages/integrations/src/index.ts";
const absolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"), "Absolute administrative path required");
export const gitConnectionSchema = z
  .object({
    id: z.uuid(),
    scope: scopeSchema,
    repositoryPath: absolutePath,
    workspaceRoot: absolutePath,
    gitExecutable: absolutePath,
    sourceBranch: z.string().min(1),
    remoteName: z.string().min(1),
    remoteUrl: z.string().min(1),
    remoteBranch: z.string().min(1),
    authorName: z.string().min(1),
    authorEmail: z.email(),
    allowLocalRemote: z.boolean().default(false),
    credential: z
      .object({ username: z.string().min(1), secretRef: secretRefSchema })
      .strict()
      .optional(),
  })
  .strict();
export const serviceTargetSchema = z
  .object({
    id: z.uuid(),
    scope: scopeSchema,
    kind: z.enum(["systemd", "docker", "windows"]),
    resourceName: z.string().min(1),
    executable: absolutePath,
  })
  .strict();
export type LocalConfiguration = {
  gitConnections: z.infer<typeof gitConnectionSchema>[];
  serviceTargets: z.infer<typeof serviceTargetSchema>[];
};
const sameScope = (a: Scope, b: Scope) =>
  ["companyId", "areaId", "customerId", "projectId"].every((key) => a[key as keyof Scope] === b[key as keyof Scope]);
const servicePrefix = (kind: string) =>
  kind === "systemd" ? "linux.service" : kind === "docker" ? "docker.container" : "windows.service";
export const localCapabilities = [
  ...gitCapabilities,
  ...serviceBrokerCapabilities.map((cap) => ({ ...cap, inputSchema: z.object({}).strict() })),
];
export function validateLocalConfiguration(config: LocalConfiguration) {
  const noActions: GitActionPort = {
    perform: async () => {
      throw new DomainError("configuration_only");
    },
  };
  for (const connection of config.gitConnections) new GitConnector(connection, noActions);
  for (const target of config.serviceTargets) new ServiceBroker(target, noActions);
}
function result(outcome: { state: string; id: string; data?: unknown }): IntegrationResult {
  if (outcome.state !== "succeeded") {
    const data = outcome.data as { code?: string } | undefined;
    throw Object.assign(
      new DomainError(
        outcome.state === "approval" ? "approval_required" : (data?.code ?? `integration_${outcome.state}`),
      ),
      {
        effectStatus: outcome.state === "effect_unknown" ? "effect_unknown" : "failed",
      },
    );
  }
  const data = z
    .object({
      observedAt: z.string(),
      effectStatus: z.enum(["succeeded", "accepted"]),
      externalId: z.string().optional(),
      evidenceRefs: z.array(z.string()),
    })
    .passthrough()
    .parse(outcome.data);
  return {
    observedAt: data.observedAt,
    effectStatus: data.effectStatus,
    externalId: data.externalId,
    evidenceRefs: data.evidenceRefs,
    data,
  };
}
export function localIntegrationPort(
  config: LocalConfiguration,
  actions: GitActionPort,
  request: { orderId: string; mandateId: string; mandateVersion: number },
  secrets?: SecretResolver,
  runner?: BrokerRunner,
) {
  return {
    execute: async (input: AuthorizedIntegrationAction): Promise<IntegrationResult> => {
      const capability = localCapabilities.find((cap) => cap.id === input.toolId);
      if (!capability) throw new IntegrationError("validation", "Unbekanntes lokales Werkzeug.");
      const args = capability.inputSchema.parse(input.args);
      const actionRequest = { ...request, id: input.id };
      if (input.toolId.startsWith("git.")) {
        const connection = config.gitConnections.find((item) => item.id === input.targetId);
        if (!connection || !sameScope(connection.scope, input.scope))
          throw new IntegrationError("authorization", "Git-Ziel liegt außerhalb des freigegebenen Bereichs.");
        const connector = new GitConnector(connection, actions, secrets);
        return result(
          await (input.toolId === "git.stage"
            ? connector.stage(actionRequest, args)
            : connector.push(actionRequest, args)),
        );
      }
      const target = config.serviceTargets.find((item) => item.id === input.targetId);
      if (
        !target ||
        !sameScope(target.scope, input.scope) ||
        !input.toolId.startsWith(servicePrefix(target.kind) + ".")
      )
        throw new IntegrationError(
          "authorization",
          "Dienstbroker-Ziel liegt außerhalb des freigegebenen Bereichs oder Werkzeugtyps.",
        );
      const restart = input.toolId.endsWith(".restart");
      return result(
        await new ServiceBroker(target, actions, runner).execute(
          { ...actionRequest, requireApproval: restart },
          restart ? "restart" : "status",
        ),
      );
    },
  };
}
/** Runtime already owns the durable journal. Reauthorize the persisted action instead of nesting another journal. */
export function localRuntimeTools(
  repo: Repository,
  config: LocalConfiguration,
  secrets?: SecretResolver,
  runner?: BrokerRunner,
): RuntimeTool[] {
  return localCapabilities.map((capability) => {
    const targets = [...config.gitConnections, ...config.serviceTargets].filter((target) =>
      capability.id.startsWith("git.")
        ? "repositoryPath" in target
        : "kind" in target && capability.id.startsWith(servicePrefix(target.kind) + "."),
    );
    const schema = z
      .object({
        targetId: z.uuid(),
        targetConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
        parameters: capability.inputSchema,
      })
      .strict();
    const requiresApproval = capability.id === "git.push" || capability.id.endsWith(".restart");
    return {
      id: capability.id,
      schema,
      requiresApproval,
      forScope: (scope: Scope) => {
        if (!targets.some((target) => sameScope(target.scope, scope))) return undefined;
        return localRuntimeTools(
          repo,
          {
            gitConnections: config.gitConnections.filter((target) => sameScope(target.scope, scope)),
            serviceTargets: config.serviceTargets.filter((target) => sameScope(target.scope, scope)),
          },
          secrets,
          runner,
        ).find((tool) => tool.id === capability.id);
      },
      description: `${capability.id}: exact configured target; ${requiresApproval ? "requires approval of concrete parameters" : "scoped local operation"}. Administrative targets: ${JSON.stringify(targets.map((target) => ({ targetId: target.id, targetConfigSha256: sha256(target), destination: "remoteUrl" in target ? { remote: target.remoteUrl, branch: target.remoteBranch } : target.resourceName })))}`,
      execute: async (input, action) => {
        const parsed = schema.parse(input);
        const target = targets.find((target) => target.id === parsed.targetId);
        if (!target || sha256(target) !== parsed.targetConfigSha256)
          throw new IntegrationError(
            "authorization",
            "Zielkonfiguration hat sich geändert oder ist nicht freigegeben.",
          );
        const actions: GitActionPort = {
          perform: async (request, execute) => {
            const stored = await repo.getDocument<ToolAction & { targetId: string }>(action.scope, "action", action.id);
            if (
              !stored ||
              stored.data.status !== "running" ||
              stored.data.argumentsSha256 !== sha256(input) ||
              stored.data.toolId !== capability.id ||
              stored.data.targetId !== parsed.targetId ||
              request.targetId !== parsed.targetId ||
              !sameScope(request.scope, action.scope)
            )
              throw new IntegrationError(
                "authorization",
                "Runtime-Aktion stimmt nicht mit dem gespeicherten Werkzeugauftrag überein.",
              );
            await repo.assertAuthorized(action.scope, {
              action: stored.data,
              targetId: parsed.targetId,
              effect: capability.effect,
              requireApproval: requiresApproval,
            });
            return { id: action.id, state: "succeeded", data: await execute(stored.data) };
          },
        };
        return localIntegrationPort(
          config,
          actions,
          { orderId: action.orderId, mandateId: action.mandateId, mandateVersion: action.mandateVersion },
          secrets,
          runner,
        ).execute({
          id: action.id,
          scope: action.scope,
          toolId: capability.id,
          targetId: parsed.targetId,
          args: parsed.parameters,
        });
      },
    };
  });
}
export function managedLocalPort(
  repo: Repository,
  directory: string,
  config: LocalConfiguration,
  request: { orderId: string; mandateId: string; mandateVersion: number },
  secrets?: SecretResolver,
  runner?: BrokerRunner,
) {
  const managed = new ManagedActions(repo, path.join(directory, "receipts"));
  const actions: GitActionPort = {
    perform: async (action, execute) => {
      const target = [...config.gitConnections, ...config.serviceTargets].find(
        (target) => target.id === action.targetId,
      );
      if (!target) throw new IntegrationError("authorization", "Ziel ist nicht konfiguriert.");
      return managed.perform(
        { ...action, args: { parameters: action.args, targetConfigSha256: sha256(target) } },
        execute,
      );
    },
  };
  return localIntegrationPort(config, actions, request, secrets, runner);
}
