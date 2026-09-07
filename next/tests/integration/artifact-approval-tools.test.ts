import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Runtime, type RuntimeTool } from "../../packages/runtime/src/engine.ts";
import { artifactApprovalTools } from "../../apps/control/artifact-approval-tools.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import { IntegrationService, type IntegrationResult } from "../../packages/integrations/src/service.ts";
import { sha256, DomainError } from "../../packages/domain/src/index.ts";
import { digest } from "../../packages/tools/workspace.ts";
import type { Scope, Mandate, Order, ToolAction } from "../../packages/contracts/src/index.ts";
let repo: Repository,
  directory: string,
  scope: Scope,
  order: Order,
  mandate: Mandate,
  server: Server,
  targetId: string,
  artifactId: string,
  artifactHash: string,
  tools: RuntimeTool[];
let writes: string[];
const model = {
  id: "fixture",
  name: "Fixture",
  supported_parameters: ["tools"],
  pricing: { prompt: "0", completion: "0" },
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ic-artifact-tools-"));
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  const setup = await repo.setup({
    companyName: "Artifact tools",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "100",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  order = await repo.createOrder(scope, { kind: "research", goal: "Deliver document", budgetLimitUsdMicros: "100" });
  order = await repo.commitPlan(scope, order.id, order.revision, {
    steps: ["Deliver exact version"],
    acceptanceCriteria: ["External receipt"],
  });
  targetId = randomUUID();
  artifactId = randomUUID();
  const content = "# Exact generated artifact\nBelegbarer Inhalt.";
  artifactHash = digest(content);
  await mkdir(path.join(directory, "blobs"));
  await writeFile(path.join(directory, "blobs", artifactHash), content);
  await repo.putDocument(
    scope,
    "artifact",
    artifactId,
    {
      id: artifactId,
      orderId: order.id,
      scope,
      sha256: artifactHash,
      bytes: Buffer.byteLength(content),
      mediaType: "text/markdown",
    },
    { immutable: true },
  );
  mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["artifact.deliver", "nextcloud.write", "approval.request", "graph.mail.send"],
    targetIds: [order.id, targetId],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 10,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "100",
  };
  await repo.createMandate(mandate);
  writes = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    writes.push(Buffer.concat(chunks).toString());
    res.writeHead(201, { etag: '"v1"' }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const service = new IntegrationService({
    connections: [
      {
        id: targetId,
        scope,
        provider: "nextcloud",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        allowHttp: true,
        username: "fixture",
        rootPath: "reports",
        secretRef: { provider: "proton-pass", shareId: "s", itemId: "i", field: "password" },
        enabledTools: ["nextcloud.write"],
        schemaTag: "fixture",
      },
    ],
    secrets: { resolve: async () => "fixture" },
    authorize: async (a) => {
      const stored = await repo.getDocument<ToolAction>(scope, "action", a.id);
      if (!stored) throw Error("missing child");
      await repo.assertAuthorized(scope, { action: stored.data, targetId: a.targetId, effect: "external_draft" });
    },
  });
  const actions = new ManagedActions(repo, path.join(directory, "receipts"));
  tools = artifactApprovalTools({
    repo,
    directory,
    port: async (s, orderId, mandateId, mandateVersion) => ({
      execute: async (a) => {
        const result = await actions.perform(
          {
            id: a.id,
            scope: s,
            orderId,
            mandateId,
            mandateVersion,
            toolId: a.toolId,
            targetId: a.targetId,
            args: a.args as never,
            effect: "external_draft",
          },
          () => service.execute(a),
        );
        if (result.state !== "succeeded")
          throw new DomainError(result.state === "approval" ? "approval_required" : "integration_" + result.state);
        return result.data as IntegrationResult;
      },
    }),
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
function runtime(name: string, args: unknown) {
  let calls = 0;
  return new Runtime({
    repo,
    directory,
    models: [model],
    tools,
    client: {
      complete: async () => ({
        id: "fixture-" + calls,
        costUsdMicros: "0",
        message:
          calls++ === 0
            ? {
                role: "assistant",
                tool_calls: [{ id: "tool-1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
              }
            : { role: "assistant", content: "Delivered for review" },
      }),
    },
  });
}
async function stored(toolId: string, args: unknown) {
  const action: ToolAction = {
    id: randomUUID(),
    runId: order.id,
    orderId: order.id,
    scope,
    toolId,
    toolVersion: 1,
    args: args as never,
    argumentsSha256: sha256(args),
    status: "running",
    mandateId: mandate.id,
    mandateVersion: 1,
    evidenceRefs: [],
  };
  await repo.putDocument(scope, "action", action.id, {
    ...action,
    targetId: toolId === "artifact.deliver" ? targetId : order.id,
  });
  return action;
}
it("the real toolloop delivers exact immutable bytes over HTTP and replays the receipt without duplicate writes", async () => {
  const args = {
    artifactVersionId: artifactId,
    expectedSha256: artifactHash,
    targetId,
    destination: "nextcloud",
    path: "result.md",
  };
  const run = await runtime("artifact__deliver", args).start(scope, order.id, mandate, model.id);
  expect(run.messages.some((m) => m.role === "tool" && m.content?.includes('"state":"delivered"'))).toBe(true);
  const turns = await repo.listDocuments<{ request: unknown; requestSha256: string }>(scope, "model-turn");
  expect(turns.length).toBeGreaterThan(0);
  for (const turn of turns) expect(sha256(turn.data.request)).toBe(turn.data.requestSha256);
  expect(writes).toEqual(["# Exact generated artifact\nBelegbarer Inhalt."]);
  const action = await stored("artifact.deliver", args);
  const result = (await tools.find((t) => t.id === "artifact.deliver")!.execute(args, action)) as {
    state: string;
    externalId: string;
  };
  expect(result.state).toBe("delivered");
  expect(result.externalId).toBeTruthy();
  expect(writes).toHaveLength(1);
});
it("rejects stale hash and a same-scope artifact belonging to another order before external IO", async () => {
  const args = {
    artifactVersionId: artifactId,
    expectedSha256: "0".repeat(64),
    targetId,
    destination: "nextcloud",
    path: "result.md",
  };
  await expect(tools[0]!.execute(args, await stored("artifact.deliver", args))).rejects.toThrow(
    "delivery_artifact_mismatch",
  );
  const other = await repo.createOrder(scope, { kind: "research", goal: "Other order", budgetLimitUsdMicros: "0" });
  const foreign = randomUUID();
  await repo.putDocument(
    scope,
    "artifact",
    foreign,
    { id: foreign, orderId: other.id, sha256: artifactHash, bytes: 0, mediaType: "text/plain" },
    { immutable: true },
  );
  const second = { ...args, artifactVersionId: foreign, expectedSha256: artifactHash };
  await expect(tools[0]!.execute(second, await stored("artifact.deliver", second))).rejects.toThrow(
    "delivery_artifact_mismatch",
  );
  expect(writes).toHaveLength(0);
});
it("explicit approval tool binds the target action hash and pauses its real model loop without granting consent", async () => {
  const params = { to: "customer@example.invalid", subject: "Review", text: "Proposed message" };
  const target = await stored("graph.mail.send", params);
  await repo.putDocument(
    scope,
    "action",
    target.id,
    { ...target, status: "proposed", targetId },
    { expectedRevision: 1 },
  );
  const args = {
    actionId: target.id,
    argumentsSha256: target.argumentsSha256,
    summary: "Please approve the exact customer message",
  };
  const run = await runtime("approval__request", args).start(scope, order.id, mandate, model.id);
  expect(run.state).toBe("approval");
  expect(await repo.listDocuments(scope, "approval")).toHaveLength(0);
  const pending = await repo.getDocument<{ binding: { argumentsSha256: string; targetId: string } }>(
    scope,
    "approval-request",
    target.id,
  );
  expect(pending?.data.binding).toMatchObject({ argumentsSha256: target.argumentsSha256, targetId });
  const invalid = { ...args, argumentsSha256: "0".repeat(64) };
  await expect(tools[1]!.execute(invalid, await stored("approval.request", invalid))).rejects.toThrow(
    "approval_target_invalid",
  );
  expect(writes).toHaveLength(0);
});
