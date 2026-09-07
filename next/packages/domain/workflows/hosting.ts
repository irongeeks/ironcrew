import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Repository } from "../../persistence/src/index.ts";
import type { Scope, ToolAction } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../src/index.ts";
import { ManagedActions, type ActionRequest } from "./actions.ts";
import { WebsiteWorkflow } from "./website.ts";
import {
  hostingProfileSchema,
  type HostingProfile,
  type HostingPort,
  type HostingResource,
  type HostingDeployment,
  type HostingPackage,
} from "../../integrations/src/hosting.ts";
import { IntegrationError } from "../../integrations/src/transport.ts";
export const hostingActionSchema = z
  .object({
    actionId: z.uuid(),
    profileId: z.uuid(),
    mandateId: z.uuid(),
    mandateVersion: z.number().int().positive().default(1),
  })
  .strict();
export const hostingPublishSchema = hostingActionSchema.extend({
  artifactVersionId: z.uuid(),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
interface ResourceRecord {
  profileId: string;
  profileFingerprint: string;
  orderId: string;
  actionId: string;
  resource: HostingResource;
}
interface DeploymentRecord {
  id: string;
  profileId: string;
  profileFingerprint: string;
  orderId: string;
  actionId: string;
  artifactVersionId: string;
  packageSha256: string;
  state: "verifying" | "verified" | "effect_unknown" | "rollback_accepted";
  deployment: HostingDeployment;
  health?: unknown;
}
/** Adds hosting target identity to the existing WebsiteWorkflow's durable, artifact-bound publish action. */
class HostingActions extends ManagedActions {
  private readonly binding: Record<string, string>;
  constructor(repo: Repository, directory: string, binding: Record<string, string>) {
    super(repo, directory);
    this.binding = binding;
  }
  override perform(request: ActionRequest, execute: (action: ToolAction) => Promise<unknown>) {
    return super.perform(
      { ...request, requireApproval: true, args: { ...(request.args as object), ...this.binding } },
      execute,
    );
  }
}
export class HostingWorkflow {
  protected readonly repo: Repository;
  protected readonly directory: string;
  protected readonly port: HostingPort;
  constructor(options: { repo: Repository; directory: string; port: HostingPort }) {
    this.repo = options.repo;
    this.directory = options.directory;
    this.port = options.port;
  }
  private async ceo(scope: Scope, ceoId: string) {
    const setup = await this.repo.snapshot(scope.companyId);
    if (setup.ceo.id !== ceoId)
      throw new DomainError("hosting_ceo_required", "Hosting configuration requires CEO", 403);
  }
  async profiles(scope: Scope, ceoId: string) {
    await this.ceo(scope, ceoId);
    return (await this.repo.listCompanyDocuments<HostingProfile>(scope.companyId, "hosting-profile")).map((record) => ({
      ...record.data,
      revision: record.revision,
    }));
  }
  async configureProfile(
    scope: Scope,
    ceoId: string,
    input: unknown,
    update?: { id: string; expectedRevision: number },
  ) {
    await this.ceo(scope, ceoId);
    const parsed = hostingProfileSchema.parse(input);
    if (parsed.scope.companyId !== scope.companyId) throw new DomainError("hosting_scope_denied");
    const id = update?.id ?? randomUUID();
    if (update) {
      const old = await this.repo.getDocument<HostingProfile>(parsed.scope, "hosting-profile", id);
      if (!old) throw new DomainError("hosting_profile_missing");
    }
    const profile: HostingProfile = {
      ...parsed,
      id,
      fingerprint: sha256(parsed),
      configuredBy: ceoId,
      configuredAt: new Date().toISOString(),
    };
    return (
      await this.repo.putDocument(parsed.scope, "hosting-profile", id, profile, {
        expectedRevision: update?.expectedRevision ?? 0,
      })
    ).data;
  }
  private async profile(scope: Scope, id: string) {
    const record = await this.repo.getDocument<HostingProfile>(scope, "hosting-profile", id);
    if (!record) throw new DomainError("hosting_profile_missing");
    return record.data;
  }
  private async current(scope: Scope, profile: HostingProfile) {
    const current = await this.profile(scope, profile.id);
    if (current.fingerprint !== profile.fingerprint)
      throw new IntegrationError("authorization", "Hostingprofil wurde seit der Freigabe geändert.");
  }
  async status(scope: Scope, orderId: string) {
    await this.repo.getOrder(scope, orderId);
    return {
      pendingActions: (
        await this.repo.listDocuments<ToolAction & { targetId?: string; artifactVersionId?: string }>(scope, "action")
      )
        .filter(
          (item) =>
            item.data.orderId === orderId &&
            ["hosting.provision", "website.publish", "hosting.rollback"].includes(item.data.toolId),
        )
        .map((item) => ({
          id: item.id,
          toolId: item.data.toolId,
          status: item.data.status,
          mandateId: item.data.mandateId,
          mandateVersion: item.data.mandateVersion,
          targetId: item.data.targetId,
          args: item.data.args,
          artifactVersionId: item.data.artifactVersionId,
          revision: item.revision,
        })),
      resources: (await this.repo.listDocuments<ResourceRecord>(scope, "hosting-resource"))
        .filter((item) => item.data.orderId === orderId)
        .map((item) => item.data),
      deployments: (await this.repo.listDocuments<DeploymentRecord>(scope, "hosting-deployment"))
        .filter((item) => item.data.orderId === orderId)
        .map((item) => item.data),
    };
  }
  async provision(scope: Scope, orderId: string, input: unknown) {
    const request = hostingActionSchema.parse(input),
      profile = await this.profile(scope, request.profileId),
      order = await this.repo.getOrder(scope, orderId);
    if (order.kind !== "website") throw new DomainError("website_order_required");
    const old = await this.repo.getDocument<ResourceRecord>(scope, "hosting-resource", profile.id);
    if (old) {
      if (old.data.orderId !== orderId || old.data.profileFingerprint !== profile.fingerprint)
        throw new DomainError("hosting_resource_conflict");
      if (old.data.actionId !== request.actionId) throw new DomainError("hosting_already_provisioned");
    }
    const actions = new ManagedActions(this.repo, path.join(this.directory, "receipts"));
    return actions.perform(
      {
        id: request.actionId,
        scope,
        orderId,
        toolId: "hosting.provision",
        targetId: profile.id,
        effect: "external_change",
        mandateId: request.mandateId,
        mandateVersion: request.mandateVersion,
        requireApproval: true,
        args: {
          profileId: profile.id,
          profileFingerprint: profile.fingerprint,
          publicUrl: profile.publicUrl,
          stack: profile.stack,
          plan: profile.plan,
          monthlyCostLimitUsdMicros: profile.monthlyCostLimitUsdMicros,
        },
      },
      async (action) => {
        await this.current(scope, profile);
        try {
          await this.repo.assertAuthorized(scope, {
            action,
            targetId: profile.id,
            effect: "external_change",
            requireApproval: true,
            costUsdMicros: profile.monthlyCostLimitUsdMicros,
          });
        } catch {
          // No broker request has started: a denied commitment is a known failure.
          throw new IntegrationError("authorization", "Hostingmandat deckt Ziel, Freigabe oder Kostenrahmen nicht ab.");
        }
        // A target has one provisioning intent, even across distinct concurrent approved actions.
        const claim = await this.repo.getDocument<{ actionId: string }>(scope, "hosting-provision-intent", profile.id);
        if (claim && claim.data.actionId !== action.id)
          throw new IntegrationError(
            "authorization",
            "Für dieses Ziel besteht bereits eine Provisionierungswirkung; zuerst abgleichen.",
          );
        if (!claim) {
          try {
            await this.repo.putDocument(
              scope,
              "hosting-provision-intent",
              profile.id,
              { actionId: action.id, profileFingerprint: profile.fingerprint },
              { expectedRevision: 0 },
            );
          } catch {
            throw new IntegrationError(
              "authorization",
              "Eine andere Provisionierung hat dieses Ziel bereits beansprucht.",
            );
          }
        }
        const resource = await this.port.provision(profile, action.id);
        await this.repo.putDocument(
          scope,
          "hosting-resource",
          profile.id,
          {
            profileId: profile.id,
            profileFingerprint: profile.fingerprint,
            orderId,
            actionId: action.id,
            resource,
          } satisfies ResourceRecord,
          { expectedRevision: 0 },
        );
        return { effectStatus: "succeeded", resource, observedAt: new Date().toISOString() };
      },
    );
  }
  async publish(scope: Scope, orderId: string, input: unknown) {
    const request = hostingPublishSchema.parse(input),
      profile = await this.profile(scope, request.profileId);
    const artifact = await this.repo.getDocument<{
      orderId: string;
      stack: string;
      packageSha256: string;
      sha256: string;
    }>(scope, "artifact", request.artifactVersionId);
    if (
      !artifact ||
      artifact.data.orderId !== orderId ||
      artifact.data.packageSha256 !== request.packageSha256 ||
      artifact.data.stack !== profile.stack
    )
      throw new DomainError("hosting_artifact_mismatch");
    const resource = await this.repo.getDocument<ResourceRecord>(scope, "hosting-resource", profile.id);
    if (!resource || resource.data.orderId !== orderId || resource.data.profileFingerprint !== profile.fingerprint)
      throw new DomainError("hosting_provision_required");
    const binding = {
      profileId: profile.id,
      profileFingerprint: profile.fingerprint,
      publicUrl: profile.publicUrl,
      artifactVersionId: request.artifactVersionId,
      packageSha256: request.packageSha256,
      resourceId: resource.data.resource.id,
    };
    const bindingHash = sha256(binding),
      prior = await this.repo.getDocument<ToolAction & { result?: unknown }>(scope, "action", request.actionId);
    if (prior) {
      if (
        prior.data.orderId !== orderId ||
        prior.data.toolId !== "website.publish" ||
        (prior.data.args as { hostingBindingSha256?: string }).hostingBindingSha256 !== bindingHash ||
        prior.data.mandateId !== request.mandateId ||
        prior.data.mandateVersion !== request.mandateVersion
      )
        throw new DomainError("hosting_approval_binding_changed");
      if (["succeeded", "failed", "effect_unknown", "denied", "expired"].includes(prior.data.status))
        return { state: prior.data.status, id: request.actionId, data: prior.data.result };
    }
    const website = new WebsiteWorkflow(this.repo, this.directory),
      archive = await website.packageArchive(scope, request.artifactVersionId);
    if (archive.packageSha256 !== request.packageSha256) throw new DomainError("hosting_package_changed");
    const packet: HostingPackage = {
      artifactVersionId: request.artifactVersionId,
      packageSha256: request.packageSha256,
      archiveSha256: archive.sha256,
      archive: archive.content,
      entrySha256: artifact.data.sha256,
    };
    const actions = new HostingActions(this.repo, path.join(this.directory, "receipts"), {
      ...binding,
      archiveSha256: archive.sha256,
      hostingBindingSha256: bindingHash,
    });
    return website.publish(
      scope,
      orderId,
      actions,
      {
        id: request.actionId,
        targetId: profile.id,
        mandateId: request.mandateId,
        mandateVersion: request.mandateVersion,
        requireApproval: true,
      },
      async (versionId, hash) => {
        if (versionId !== request.artifactVersionId || hash !== request.packageSha256)
          throw new IntegrationError("authorization", "Websiteversion wurde nach Freigabe geändert.");
        await this.current(scope, profile);
        const deployment = await this.port.deploy(profile, resource.data.resource.id, request.actionId, packet),
          id = randomUUID();
        const recorded = await this.repo.putDocument(scope, "hosting-deployment", id, {
          id,
          profileId: profile.id,
          profileFingerprint: profile.fingerprint,
          orderId,
          actionId: request.actionId,
          artifactVersionId: request.artifactVersionId,
          packageSha256: request.packageSha256,
          state: "verifying",
          deployment,
        } satisfies DeploymentRecord);
        try {
          const health = await this.port.verify(profile, deployment, packet);
          await this.repo.putDocument(
            scope,
            "hosting-deployment",
            id,
            { ...recorded.data, state: "verified", health },
            { expectedRevision: recorded.revision },
          );
          return {
            url: deployment.publicUrl,
            httpsVerified: health.httpsVerified,
            functionalCheckPassed: health.functionalCheckPassed,
            rollbackRef: deployment.rollbackRef,
            healthEvidenceId: id,
          };
        } catch (error) {
          await this.repo.putDocument(
            scope,
            "hosting-deployment",
            id,
            { ...recorded.data, state: "effect_unknown" },
            { expectedRevision: recorded.revision },
          );
          throw error;
        }
      },
    );
  }
  async rollback(scope: Scope, orderId: string, input: unknown) {
    const parsed = hostingActionSchema.extend({ deploymentId: z.uuid() }).parse(input),
      profile = await this.profile(scope, parsed.profileId),
      record = await this.repo.getDocument<DeploymentRecord>(scope, "hosting-deployment", parsed.deploymentId);
    if (
      !record ||
      record.data.orderId !== orderId ||
      record.data.profileId !== profile.id ||
      record.data.profileFingerprint !== profile.fingerprint
    )
      throw new DomainError("hosting_deployment_missing");
    return new ManagedActions(this.repo, path.join(this.directory, "receipts")).perform(
      {
        id: parsed.actionId,
        scope,
        orderId,
        toolId: "hosting.rollback",
        effect: "publish",
        targetId: profile.id,
        mandateId: parsed.mandateId,
        mandateVersion: parsed.mandateVersion,
        artifactVersionId: record.data.artifactVersionId,
        requireApproval: true,
        args: {
          deploymentId: record.id,
          profileFingerprint: profile.fingerprint,
          rollbackRef: record.data.deployment.rollbackRef,
          publicUrl: profile.publicUrl,
        },
      },
      async () => {
        await this.current(scope, profile);
        const result = await this.port.rollback(
          profile,
          record.data.deployment.resourceId,
          parsed.actionId,
          record.data.deployment.rollbackRef,
        );
        await this.repo.putDocument(
          scope,
          "hosting-deployment",
          record.id,
          { ...record.data, state: "rollback_accepted" },
          { expectedRevision: record.revision },
        );
        const site = await this.repo.getDocument<{ state: string; artifactVersionId?: string; publication?: unknown }>(
          scope,
          "website",
          orderId,
        );
        if (site?.data.state === "published" && site.data.artifactVersionId === record.data.artifactVersionId) {
          const { publication: _publication, ...priorSite } = site.data;
          await this.repo.putDocument(
            scope,
            "website",
            orderId,
            {
              ...priorSite,
              state: "accepted",
              hostingRollback: {
                deploymentId: record.id,
                actionId: parsed.actionId,
                state: "accepted",
                requiresFreshHealthCheck: true,
              },
            },
            { expectedRevision: site.revision },
          );
        }
        return { ...result, effectStatus: "accepted", requiresFreshHealthCheck: true };
      },
    );
  }
}
