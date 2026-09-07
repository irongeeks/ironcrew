import { IntegrationCostService } from "./integration-costs.ts";
import { integrationPriceSchema } from "../../packages/integrations/src/pricing.ts";
import { oauthBrokerOptions } from "./oauth-broker.ts";
import { browserInspectTools } from "./browser-inspect-tools.ts";
import { artifactApprovalTools } from "./artifact-approval-tools.ts";
import { researchTools } from "./research-tools.ts";
import { coordinationTools } from "../../packages/runtime/src/coordination.ts";
import { googleConfigurationSha256 } from "../../packages/integrations/src/google-workspace.ts";
import { oauthConfigurationSchema } from "../../packages/integrations/src/oauth.ts";
import type { WorkerServer } from "./worker-server.ts";
import { incidentRuntimeTools } from "./incident-tools.ts";
import { mailConnectionSchema, mailRuntimeTools, managedMailPort, mailCapabilities } from "./mail-broker.ts";
import { loadExecutionPort } from "../../packages/tools/isolation/index.ts";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  secretRefSchema,
  ProtonPassResolver,
  IntegrationService,
  toolCapabilities,
  redact,
  type IntegrationConnection,
} from "../../packages/integrations/src/index.ts";
import { OpenRouterClient, type Model } from "../../packages/runtime/src/openrouter.ts";
import { Runtime, type RuntimeTool } from "../../packages/runtime/src/engine.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { ToolAction } from "../../packages/contracts/src/index.ts";
import { scopeSchema } from "../../packages/contracts/src/index.ts";
import { DomainError, sha256 } from "../../packages/domain/src/index.ts";
import { workflowTools } from "./workflow-tools.ts";
import {
  gitConnectionSchema,
  serviceTargetSchema,
  validateLocalConfiguration,
  localRuntimeTools,
  managedLocalPort,
  localCapabilities,
} from "./git-broker.ts";
export const connectionSchema = z
  .object({
    id: z.uuid(),
    provider: z.enum([
      "brave",
      "research",
      "nextcloud",
      "gdrive",
      "sevdesk",
      "tactical",
      "proxmox",
      "graph",
      "telegram",
      "discord",
    ]),
    scope: scopeSchema,
    baseUrl: z.url().optional(),
    secretRef: secretRefSchema.optional(),
    oauth: oauthConfigurationSchema.optional(),
    pricing: integrationPriceSchema.optional(),
    username: z.string().optional(),
    tokenId: z.string().optional(),
    resourceIds: z.array(z.string()).optional(),
    rootPath: z.string().optional(),
    enabledTools: z.array(z.string()),
    schemaTag: z.string(),
    liveValidatedAt: z.string().optional(),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    liveExecutionEnabled: z.boolean().default(false),
    isolationProfilePath: z.string().min(1).optional(),
    remoteWorkerId: z.uuid().optional(),
    proton: z.object({ executable: z.string(), sessionDirectory: z.string().optional() }).optional(),
    openrouter: z.object({ secretRef: secretRefSchema, modelOverride: z.string().optional() }).optional(),
    connections: z.array(connectionSchema).default([]),
    gitConnections: z.array(gitConnectionSchema).default([]),
    serviceTargets: z.array(serviceTargetSchema).default([]),
    mailConnections: z.array(mailConnectionSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.isolationProfilePath && config.remoteWorkerId)
      context.addIssue({ code: "custom", message: "Choose either a local isolation profile or a remote worker" });
    const ids = [
      ...config.connections,
      ...config.gitConnections,
      ...config.serviceTargets,
      ...config.mailConnections,
    ].map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Duplicate integration target ID" });
    try {
      validateLocalConfiguration(config);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid administrative Git or service target configuration" });
    }
  });
export type Configuration = z.infer<typeof configSchema>;
export async function readConfiguration(directory: string): Promise<Configuration> {
  try {
    return configSchema.parse(JSON.parse(await readFile(path.join(directory, "configuration.json"), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
    throw e;
  }
}
export async function saveConfiguration(directory: string, config: z.input<typeof configSchema>) {
  config = configSchema.parse(config);
  await writeFile(path.join(directory, "configuration.json.staging"), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(path.join(directory, "configuration.json.staging"), path.join(directory, "configuration.json"));
}
export async function configuredRuntime(
  repo: Repository,
  directory: string,
  config: Configuration,
  models: Model[],
  workers?: () => Promise<WorkerServer | undefined>,
): Promise<Runtime | undefined> {
  if (!config.liveExecutionEnabled || !config.openrouter || !config.proton) return undefined;
  const values = new Set<string>();
  const proton = new ProtonPassResolver({
    executable: config.proton.executable,
    environment: {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      PATH: path.dirname(config.proton.executable),
      ...(config.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: config.proton.sessionDirectory } : {}),
    },
  });
  const secrets = {
    async resolve(ref: z.infer<typeof secretRefSchema>, reason: string) {
      const value = await proton.resolve(ref, reason);
      values.add(value);
      return value;
    },
  };
  const client = new OpenRouterClient({
    secret: () => secrets.resolve(config.openrouter!.secretRef, "IronCrew authorized model request"),
  });
  const service = new IntegrationService({
    connections: config.connections as IntegrationConnection[],
    meteredRequest: new IntegrationCostService(repo).request,
    secrets,
    ...oauthBrokerOptions(repo, directory, secrets),
    authorize: async (input) => {
      const action = await repo.getDocument<ToolAction>(input.scope, "action", input.id);
      if (!action) throw new DomainError("action_missing");
      const capability = toolCapabilities.find((t) => t.id === input.toolId)!;
      await repo.assertAuthorized(input.scope, {
        action: action.data,
        targetId: input.targetId,
        effect: capability.effect,
        requireApproval: capability.requiresApproval === true,
      });
    },
  });
  const tools: RuntimeTool[] = toolCapabilities.map((c) => ({
    id: c.id,
    schema: z.object({ targetId: z.uuid(), parameters: c.inputSchema }),
    description: `${c.id}: configured target only. ${c.reconciliation}`,
    requiresApproval: c.requiresApproval === true || c.effect === "external_send",
    forScope: (scope) => {
      const connections = config.connections.filter(
        (connection) =>
          connection.provider === c.provider &&
          sha256(connection.scope) === sha256(scope) &&
          connection.enabledTools.includes(c.id),
      );
      if (!connections.length) return undefined;
      const tool = tools.find((item) => item.id === c.id)!;
      return {
        ...tool,
        forScope: undefined,
        description: `${tool.description} Available scoped targets: ${JSON.stringify(connections.map((connection) => ({ targetId: connection.id, resourceIds: connection.resourceIds ?? [], ...(connection.provider === "gdrive" ? { targetConfigSha256: googleConfigurationSha256(connection) } : {}) })))}`,
      };
    },
    execute: async (input, action) => {
      const parsed = z.object({ targetId: z.uuid(), parameters: c.inputSchema }).parse(input);
      return service.execute({
        id: action.id,
        scope: action.scope,
        toolId: c.id,
        targetId: parsed.targetId,
        args: parsed.parameters,
      });
    },
  }));
  const executionPort = await executionPortForConfiguration(directory, config, workers);
  return new Runtime({
    repo,
    directory,
    executionPort,
    models: models.filter((m) => (m as Model & { available?: boolean }).available !== false),
    client,
    tools: [
      ...tools,
      ...browserInspectTools({ repo, directory }),
      ...researchTools({
        repo,
        directory,
        port: (scope, orderId, mandateId, mandateVersion) =>
          workflowIntegrationPort(repo, directory, scope, orderId, mandateId, mandateVersion),
      }),
      ...artifactApprovalTools({
        repo,
        directory,
        port: (scope, orderId, mandateId, mandateVersion) =>
          workflowIntegrationPort(repo, directory, scope, orderId, mandateId, mandateVersion),
      }),
      ...coordinationTools({
        repo,
        client,
        models,
        redact: (text) => JSON.stringify(redact(JSON.parse(text), [...values])),
      }),
      ...localRuntimeTools(repo, config, secrets),
      ...mailRuntimeTools(repo, config, secrets, directory),
      ...incidentRuntimeTools(repo, directory, { configuration: async () => config, secrets }),
      ...workflowTools(repo, directory, async () => executionPort),
    ],
    redact: (text) => JSON.stringify(redact(JSON.parse(text), [...values])),
  });
}

/** Fachabläufe rufen denselben persistierenden Autorisierungsbroker wie Modellwerkzeuge auf. */
export async function workflowIntegrationPort(
  repo: Repository,
  directory: string,
  scope: import("../../packages/contracts/src/index.ts").Scope,
  orderId: string,
  mandateId: string,
  mandateVersion = 1,
) {
  const config = await readConfiguration(directory);
  if (!config.liveExecutionEnabled) throw new DomainError("integration_not_configured");
  const proton = config.proton
    ? new ProtonPassResolver({
        executable: config.proton.executable,
        environment: {
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          SYSTEMROOT: process.env.SYSTEMROOT,
          PATH: path.dirname(config.proton.executable),
          ...(config.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: config.proton.sessionDirectory } : {}),
        },
      })
    : {
        resolve: async () => {
          throw new DomainError("secret_provider_not_configured");
        },
      };
  const { ManagedActions } = await import("../../packages/domain/workflows/actions.ts");
  const actions = new ManagedActions(repo, path.join(directory, "receipts"));
  const local = managedLocalPort(repo, directory, config, { orderId, mandateId, mandateVersion }, proton);
  const mail = managedMailPort(repo, directory, config, { orderId, mandateId, mandateVersion }, proton);
  const service = new IntegrationService({
    connections: config.connections as IntegrationConnection[],
    meteredRequest: new IntegrationCostService(repo).request,
    secrets: proton,
    ...oauthBrokerOptions(repo, directory, proton),
    authorize: async (input) => {
      const record = await repo.getDocument<ToolAction>(scope, "action", input.id);
      if (!record) throw new DomainError("action_missing");
      await repo.assertAuthorized(scope, {
        action: record.data,
        targetId: input.targetId,
        effect: toolCapabilities.find((c) => c.id === input.toolId)!.effect,
        requireApproval: toolCapabilities.find((c) => c.id === input.toolId)!.requiresApproval === true,
      });
    },
  });
  return {
    execute: async (input: import("../../packages/integrations/src/index.ts").AuthorizedIntegrationAction) => {
      if (
        ["companyId", "areaId", "customerId", "projectId"].some(
          (key) => input.scope[key as keyof typeof scope] !== scope[key as keyof typeof scope],
        )
      )
        throw new DomainError("integration_scope_mismatch");
      if (mailCapabilities.some((cap) => cap.id === input.toolId)) return mail.execute(input);
      if (localCapabilities.some((cap) => cap.id === input.toolId)) return local.execute(input);
      const cap = toolCapabilities.find((c) => c.id === input.toolId);
      if (!cap) throw new DomainError("tool_unknown");
      const result = await actions.perform(
        {
          id: input.id,
          scope,
          orderId,
          toolId: input.toolId,
          targetId: input.targetId,
          args: input.args as import("../../packages/contracts/src/index.ts").Json,
          effect: cap.effect,
          requireApproval: cap.requiresApproval === true,
          mandateId,
          mandateVersion,
        },
        () => service.execute(input),
      );
      if (result.state !== "succeeded")
        throw new DomainError(
          result.state === "approval"
            ? "approval_required"
            : result.state === "failed" && typeof (result.data as { code?: unknown })?.code === "string"
              ? (result.data as { code: string }).code
              : "integration_" + result.state,
        );
      return result.data as import("../../packages/integrations/src/index.ts").IntegrationResult;
    },
  };
}

async function executionPortForConfiguration(
  directory: string,
  config: Configuration,
  workers?: () => Promise<WorkerServer | undefined>,
) {
  if (config.remoteWorkerId) {
    const server = await workers?.();
    if (!server) throw new DomainError("remote_worker_tls_required");
    return server.remoteExecutionPort(config.remoteWorkerId, directory);
  }
  return config.isolationProfilePath ? loadExecutionPort(config.isolationProfilePath) : undefined;
}

export async function configuredExecutionPort(directory: string, workers?: () => Promise<WorkerServer | undefined>) {
  return executionPortForConfiguration(directory, await readConfiguration(directory), workers);
}
