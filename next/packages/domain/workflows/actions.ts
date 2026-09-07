import { randomUUID } from "node:crypto";
import path from "node:path";
import { Repository } from "../../persistence/src/index.ts";
import type { Scope, ToolAction, EffectClass, ApprovalBinding, Json } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../src/index.ts";
import { ExecutionJournal, type ToolResult } from "../../tools/journal.ts";
export type ActionRequest = {
  id?: string;
  orderId: string;
  scope: Scope;
  toolId: string;
  targetId: string;
  args: Json;
  effect: EffectClass;
  mandateId: string;
  mandateVersion: number;
  artifactVersionId?: string;
  requireApproval?: boolean;
  routineRuleId?: string;
  routineRuleVersion?: number;
};
type ManagedAction = ToolAction & {
  requestHash: string;
  targetId: string;
  effect: EffectClass;
  artifactVersionId?: string;
  result?: unknown;
};
type ActionOutcome = { state: ToolAction["status"] | "approval"; id: string; data?: unknown };
export class ManagedActions {
  repo: Repository;
  journal: ExecutionJournal;
  private static active = new Map<string, { hash: string; promise: Promise<ActionOutcome> }>();
  constructor(repo: Repository, receiptsDirectory: string) {
    this.repo = repo;
    this.journal = new ExecutionJournal(receiptsDirectory);
  }
  async perform(request: ActionRequest, execute: (action: ToolAction) => Promise<unknown>): Promise<ActionOutcome> {
    const id = request.id ?? randomUUID(),
      hash = sha256({ ...request, id });
    const key = path.resolve(this.journal.directory) + ":" + request.scope.companyId + ":" + id;
    const prior = ManagedActions.active.get(key);
    if (prior) {
      if (prior.hash !== hash) throw new DomainError("action_binding_conflict");
      return prior.promise;
    }
    const promise = this.run({ ...request, id }, hash, execute);
    ManagedActions.active.set(key, { hash, promise });
    try {
      return await promise;
    } finally {
      if (ManagedActions.active.get(key)?.promise === promise) ManagedActions.active.delete(key);
    }
  }
  private async run(
    request: ActionRequest & { id: string },
    requestHash: string,
    execute: (action: ToolAction) => Promise<unknown>,
  ): Promise<ActionOutcome> {
    const { id, scope } = request;
    await this.repo.getOrder(scope, request.orderId);
    let old = await this.repo.getDocument<ManagedAction>(scope, "action", id);
    let action: ManagedAction = old?.data ?? {
      id,
      runId: request.orderId,
      orderId: request.orderId,
      scope,
      toolId: request.toolId,
      toolVersion: 1,
      args: request.args,
      argumentsSha256: sha256(request.args),
      status: "proposed",
      mandateId: request.mandateId,
      mandateVersion: request.mandateVersion,
      evidenceRefs: [],
      requestHash,
      targetId: request.targetId,
      effect: request.effect,
      ...(request.artifactVersionId ? { artifactVersionId: request.artifactVersionId } : {}),
    };
    if (action.requestHash !== requestHash || action.argumentsSha256 !== sha256(request.args))
      throw new DomainError("action_binding_conflict");
    if (["succeeded", "failed", "effect_unknown", "denied", "expired"].includes(action.status))
      return { state: action.status, id, data: action.result };
    if (!old) old = await this.repo.putDocument(scope, "action", id, action);
    let result: ToolResult;
    if (action.status === "running" || action.status === "dispatched")
      result = (await this.journal.recover(id, action.argumentsSha256)) ?? {
        status: "effect_unknown",
        data: { code: "missing_local_receipt" },
        resultSha256: sha256({ code: "missing_local_receipt" }),
      };
    else {
      await this.repo.assertDispatchAllowed(scope.companyId);
      const external = !["read", "workspace_write", "external_draft", "external_change"].includes(request.effect);
      const routine = request.toolId === "sevdesk.reminder.send" && request.routineRuleId && request.routineRuleVersion;
      if ((request.requireApproval || (external && !routine)) && !action.approvalId) {
        const binding: ApprovalBinding = {
          companyId: scope.companyId,
          orderId: request.orderId,
          mandateId: request.mandateId,
          mandateVersion: request.mandateVersion,
          actionId: id,
          targetId: request.targetId,
          argumentsSha256: action.argumentsSha256,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          ...(request.artifactVersionId ? { artifactVersionId: request.artifactVersionId } : {}),
        };
        const pending = await this.repo.getDocument(scope, "approval-request", id);
        if (!pending)
          await this.repo.putDocument(scope, "approval-request", id, {
            id,
            binding,
            args: request.args,
            summary: request.toolId,
            status: "pending",
          });
        return { state: "approval", id };
      }
      const authorized = action;
      action = { ...action, status: "running" };
      await this.repo.authorizeAndTransact(
        scope,
        {
          action: authorized,
          requireApproval: request.requireApproval,
          targetId: request.targetId,
          effect: request.effect,
          artifactVersionId: request.artifactVersionId,
          routineRuleId: request.routineRuleId,
          routineRuleVersion: request.routineRuleVersion,
        },
        [{ kind: "action", id, data: action, expectedRevision: old.revision }],
        { type: "action.dispatched", aggregateId: request.orderId },
      );
      result = await this.journal.execute(id, action.argumentsSha256, () => execute(action));
    }
    const current = await this.repo.getDocument(scope, "action", id);
    await this.repo.transact(
      scope,
      [
        {
          kind: "action",
          id,
          data: { ...action, status: result.status, result: result.data, resultSha256: sha256(result.data) },
          expectedRevision: current!.revision,
        },
      ],
      { type: "action.result", aggregateId: request.orderId, data: { actionId: id, status: result.status } },
    );
    return { state: result.status, id, data: result.data };
  }
}
