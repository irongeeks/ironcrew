import path from "node:path";
import { readFile, lstat } from "node:fs/promises";
import { z } from "zod";
import type { Repository } from "../../persistence/src/index.ts";
import type { Scope, ToolAction, ApprovalBinding } from "../../contracts/src/index.ts";
import type { AuthorizedIntegrationAction, IntegrationResult } from "../../integrations/src/service.ts";
import { DomainError, sameScope, sha256 } from "../src/index.ts";
import { Workspace, digest } from "../../tools/workspace.ts";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactDeliverInputSchema = z
  .object({
    artifactVersionId: z.uuid(),
    expectedSha256: hash,
    targetId: z.uuid(),
    destination: z.enum(["nextcloud", "gdrive"]),
    path: z.string().min(1).max(1000).optional(),
    folderId: z.string().min(1).max(300).optional(),
    name: z.string().min(1).max(255).optional(),
    expectedRevision: z.string().min(1).max(300).optional(),
    predecessorId: z.string().min(1).max(300).optional(),
  })
  .strict();
export const approvalRequestInputSchema = z
  .object({ actionId: z.uuid(), argumentsSha256: hash, summary: z.string().trim().min(1).max(2000) })
  .strict();
export type DeliveryPort = { execute: (input: AuthorizedIntegrationAction) => Promise<IntegrationResult> };
const idFor = (value: unknown) => {
  const h = sha256(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
type StoredAction = ToolAction & { targetId: string; artifactVersionId?: string };
export async function verifiedToolAction(repo: Repository, input: unknown, supplied: ToolAction, toolId: string) {
  const record = await repo.getDocument<StoredAction>(supplied.scope, "action", supplied.id);
  if (
    !record ||
    record.data.toolId !== toolId ||
    record.data.status !== "running" ||
    record.data.orderId !== supplied.orderId ||
    !sameScope(record.data.scope, supplied.scope) ||
    record.data.argumentsSha256 !== sha256(input)
  )
    throw new DomainError("execution_action_mismatch");
  await repo.assertDispatchAllowed(supplied.scope.companyId);
  await repo.assertAuthorized(supplied.scope, {
    action: record.data,
    targetId: record.data.targetId,
    effect: "workspace_write",
  });
  return record.data;
}
export class ArtifactDelivery {
  readonly options: {
    repo: Repository;
    directory: string;
    port: (scope: Scope, orderId: string, mandateId: string, mandateVersion: number) => Promise<DeliveryPort>;
  };
  constructor(options: ArtifactDelivery["options"]) {
    this.options = options;
  }
  async deliver(input: unknown, supplied: ToolAction) {
    const args = artifactDeliverInputSchema.parse(input),
      { repo, directory } = this.options;
    const action = await verifiedToolAction(repo, input, supplied, "artifact.deliver");
    if (action.targetId !== args.targetId) throw new DomainError("delivery_target_mismatch");
    const artifact = await repo.getDocument<{
      id: string;
      orderId: string;
      sha256: string;
      bytes: number;
      mediaType: string;
    }>(action.scope, "artifact", args.artifactVersionId);
    if (
      !artifact ||
      artifact.data.orderId !== action.orderId ||
      artifact.data.id !== args.artifactVersionId ||
      artifact.data.sha256 !== args.expectedSha256
    )
      throw new DomainError("delivery_artifact_mismatch");
    if (
      !/^(text\/|application\/(json|xml|javascript)$)/.test(artifact.data.mediaType) ||
      artifact.data.bytes > 1_000_000
    )
      throw new DomainError("delivery_format_not_supported");
    const file = await new Workspace(path.join(directory, "blobs")).resolve(args.expectedSha256);
    if ((await lstat(file)).size !== artifact.data.bytes) throw new DomainError("blob_corrupt");
    const bytes = await readFile(file);
    if (digest(bytes) !== args.expectedSha256) throw new DomainError("blob_corrupt");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parameters =
      args.destination === "nextcloud"
        ? {
            path: z.string().min(1).parse(args.path),
            content,
            mediaType: artifact.data.mediaType,
            ...(args.expectedRevision ? { expectedEtag: args.expectedRevision } : { createOnly: true }),
          }
        : {
            folderId: z.string().min(1).parse(args.folderId),
            name: z.string().min(1).parse(args.name),
            content,
            mediaType: artifact.data.mediaType,
            ...(args.predecessorId
              ? { predecessorId: args.predecessorId, expectedVersion: z.string().min(1).parse(args.expectedRevision) }
              : {}),
          };
    const id = idFor([
      "artifact-delivery",
      action.scope,
      action.orderId,
      action.mandateId,
      action.mandateVersion,
      args,
    ]);
    const prior = await repo.getDocument<Record<string, unknown>>(action.scope, "artifact-delivery", id);
    if (prior?.data.state === "delivered") return prior.data;
    if (prior?.data.state === "effect_unknown") throw new DomainError("delivery_reconciliation_required");
    const base = {
      id,
      orderId: action.orderId,
      artifactVersionId: args.artifactVersionId,
      artifactSha256: args.expectedSha256,
      targetId: args.targetId,
      destination: args.destination,
      argumentsSha256: sha256(parameters),
      childActionId: idFor([id, "write"]),
    };
    await repo.authorizeAndTransact(
      action.scope,
      { action, targetId: args.targetId, effect: "workspace_write" },
      [
        {
          kind: "artifact-delivery",
          id,
          data: { ...base, state: "effect_unknown" },
          expectedRevision: prior?.revision ?? 0,
        },
      ],
      { type: "artifact.delivery_prepared", aggregateId: action.orderId },
    );
    let next: Record<string, unknown>;
    try {
      const port = await this.options.port(action.scope, action.orderId, action.mandateId, action.mandateVersion);
      const result = await port.execute({
        id: base.childActionId,
        scope: action.scope,
        targetId: args.targetId,
        toolId: args.destination === "nextcloud" ? "nextcloud.write" : "gdrive.create",
        args: parameters,
      });
      if (result.effectStatus !== "succeeded" || !result.externalId) throw new DomainError("delivery_unconfirmed");
      const data = result.data as Record<string, unknown>;
      next = {
        ...base,
        state: "delivered",
        externalId: result.externalId,
        externalRevision:
          typeof data.etag === "string" ? data.etag : typeof data.version === "string" ? data.version : undefined,
        observedAt: result.observedAt,
        evidenceRefs: result.evidenceRefs,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const knownFailure =
        (error as { effectStatus?: string }).effectStatus === "failed" ||
        (typeof code === "string" &&
          /^(integration_not_configured|tool_unknown|configuration|authorization|mandate_|scope_|approval_expired)/.test(
            code,
          ));
      next = {
        ...base,
        state: code === "approval_required" ? "approval" : knownFailure ? "failed" : "effect_unknown",
        ...(code === "approval_required"
          ? { actionId: base.childActionId, approvalRequestId: base.childActionId }
          : {}),
        errorCode: typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code) ? code : "delivery_unknown",
      };
    }
    await repo.putDocument(action.scope, "artifact-delivery", id, next, {
      expectedRevision: (prior?.revision ?? 0) + 1,
    });
    return next;
  }
}
export async function requestActionApproval(repo: Repository, input: unknown, supplied: ToolAction) {
  const args = approvalRequestInputSchema.parse(input),
    caller = await verifiedToolAction(repo, input, supplied, "approval.request");
  if (args.actionId === caller.id) throw new DomainError("approval_target_invalid");
  const target = await repo.getDocument<StoredAction>(caller.scope, "action", args.actionId);
  if (
    !target ||
    target.data.orderId !== caller.orderId ||
    !sameScope(target.data.scope, caller.scope) ||
    !["proposed", "authorized"].includes(target.data.status) ||
    target.data.argumentsSha256 !== args.argumentsSha256 ||
    sha256(target.data.args) !== args.argumentsSha256
  )
    throw new DomainError("approval_target_invalid");
  const action = target.data;
  const existing = await repo.getDocument<{ binding: ApprovalBinding; status: string }>(
    caller.scope,
    "approval-request",
    action.id,
  );
  const stable = {
    companyId: caller.scope.companyId,
    orderId: caller.orderId,
    mandateId: action.mandateId,
    mandateVersion: action.mandateVersion,
    actionId: action.id,
    targetId: action.targetId,
    argumentsSha256: action.argumentsSha256,
    ...(action.artifactVersionId ? { artifactVersionId: action.artifactVersionId } : {}),
  };
  if (existing) {
    if (
      sha256({ ...existing.data.binding, expiresAt: undefined }) !== sha256(stable) ||
      existing.data.status !== "pending" ||
      Date.parse(existing.data.binding.expiresAt) <= Date.now()
    )
      throw new DomainError("approval_request_stale");
  } else {
    const binding = { ...stable, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    await repo.authorizeAndTransact(
      caller.scope,
      { action: caller, targetId: caller.targetId, effect: "workspace_write" },
      [
        { kind: "action", id: action.id, data: action, expectedRevision: target.revision },
        {
          kind: "approval-request",
          id: action.id,
          data: { id: action.id, binding, summary: args.summary, args: action.args, status: "pending" },
          expectedRevision: 0,
        },
      ],
      { type: "approval.requested", aggregateId: caller.orderId },
    );
  }
  return { state: "approval", actionId: action.id, approvalRequestId: action.id };
}
