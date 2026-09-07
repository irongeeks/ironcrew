import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import { ResearchService } from "../../packages/domain/workflows/research.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { IntegrationService, type IntegrationResult } from "../../packages/integrations/src/service.ts";
import { googleConfigurationSha256 } from "../../packages/integrations/src/google-workspace.ts";
import type { ApprovalBinding, Json, ToolAction } from "../../packages/contracts/src/index.ts";
import { googleWorkspaceFixture } from "../fixtures/google-workspace.ts";
it("delivers the actual stored research artifact as a native Doc only after exact CEO approval and never duplicates a replay", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "research-native-")),
    repo = await Repository.open(path.join(directory, "company.sqlite")),
    f = await googleWorkspaceFixture();
  try {
    const setup = await repo.setup({
        companyName: "Native fixture",
        ceoName: "Owner",
        passwordHash: "fixture",
        timezone: "UTC",
        budgetLimitUsdMicros: "0",
      }),
      scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const connection = { ...f.connection, scope },
      order = await repo.createOrder(scope, {
        kind: "research",
        goal: "Native report fixture",
        budgetLimitUsdMicros: "0",
      });
    const mandate = {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["gdocs.create"],
      targetIds: [connection.id],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxAttempts: 1,
      maxDurationSeconds: 60,
      maxCostUsdMicros: "0",
    };
    await repo.createMandate(mandate);
    const managed = new ManagedActions(repo, path.join(directory, "receipts")),
      service = new IntegrationService({
        connections: [connection],
        secrets: { resolve: async () => "fixture-access-token" },
        transport: f.transport,
        authorize: async (a) => {
          const stored = await repo.getDocument<ToolAction>(scope, "action", a.id);
          if (!stored) throw new DomainError("action_missing");
          await repo.assertAuthorized(scope, {
            action: stored.data,
            targetId: a.targetId,
            effect: "external_draft",
            requireApproval: true,
          });
        },
      });
    const research = new ResearchService(repo, directory, {
      execute: async (a) => {
        const r = await managed.perform(
          {
            id: a.id,
            scope,
            orderId: order.id,
            toolId: a.toolId,
            targetId: a.targetId,
            args: a.args as Json,
            effect: "external_draft",
            requireApproval: true,
            mandateId: mandate.id,
            mandateVersion: 1,
          },
          () => service.execute(a),
        );
        if (r.state !== "succeeded")
          throw new DomainError(r.state === "approval" ? "approval_required" : "integration_" + r.state);
        return r.data as IntegrationResult;
      },
    });
    const source = {
      id: "source-fixture",
      title: "Fixture source",
      url: "https://example.invalid/research",
      observedAt: new Date().toISOString(),
      status: "available" as const,
      contentSha256: "a".repeat(64),
    };
    await repo.putDocument(scope, "research-source", source.id, source, { immutable: true });
    const report = await research.create(scope, {
      orderId: order.id,
      title: "Native research fixture",
      recommendation: "Review the documented result",
      reasons: [{ text: "The fixture source supports the claim", sourceIds: [source.id] }],
      comparison: "One documented fixture",
      methodology: "Source fixture",
      sources: [source],
      assumptions: [],
      gaps: [],
      requiredDelivery: "gdrive",
    });
    const input = {
      targetId: connection.id,
      folderId: "folder-a",
      nativeFormat: "google-doc" as const,
      targetConfigSha256: googleConfigurationSha256(connection),
    };
    const pending = await research.deliver(scope, report.id, input);
    expect(pending.state).toBe("approval");
    expect(f.seen).toHaveLength(0);
    await expect(
      research.deliver(scope, report.id, { ...input, targetConfigSha256: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "delivery_approval_binding_changed" });
    const approval = await repo.getDocument<{ binding: ApprovalBinding }>(scope, "approval-request", pending.actionId!),
      approved = await repo.approve(scope, approval!.data.binding),
      action = await repo.getDocument<ToolAction>(scope, "action", pending.actionId!);
    await repo.putDocument(
      scope,
      "action",
      action!.id,
      { ...action!.data, status: "authorized", approvalId: approved.id },
      { expectedRevision: action!.revision },
    );
    expect((await research.deliver(scope, report.id, input)).state).toBe("delivered");
    const original = await readFile(path.join(directory, "blobs", report.sha256), "utf8");
    expect(f.seen[0]!.body).toContain(original);
    expect(f.seen[0]!.body).toContain("application/vnd.google-apps.document");
    await research.deliver(scope, report.id, input);
    expect(f.seen).toHaveLength(1);
  } finally {
    await f.close();
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
