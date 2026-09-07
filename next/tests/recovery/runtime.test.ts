import { it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Runtime, shaUuid, type Run } from "../../packages/runtime/src/engine.ts";
import { digest } from "../../packages/tools/workspace.ts";
import type { Model, ModelClient, ModelRequest } from "../../packages/runtime/src/openrouter.ts";
import type { ApprovalBinding, ToolAction } from "../../packages/contracts/src/index.ts";
const model: Model = {
  id: "fixture/local-test",
  name: "Local fixture (no paid model)",
  context_length: 100000,
  supported_parameters: ["tools"],
  pricing: { prompt: "0", completion: "0" },
};
it("persists actual file, fixture test, approval pause, restart and immutable artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-runtime-"));
  let repo = await Repository.open(path.join(directory, "db.sqlite"));
  try {
    const setup = await repo.setup({
      companyName: "Fixture",
      ceoName: "Fixture CEO",
      passwordHash: "test-only-hash",
      timezone: "Europe/Berlin",
      budgetLimitUsdMicros: "10000",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    let order = await repo.createOrder(scope, {
      kind: "website",
      goal: "Create a verified file",
      budgetLimitUsdMicros: "10000",
    });
    order = await repo.updateOrder(scope, order.id, order.revision, { status: "ready", planVersion: 1 });
    const mandate = {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["workspace.apply_patch", "workspace.test_fixture", "artifact.stage", "fixture.confirm"],
      targetIds: [order.id],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      maxAttempts: 10,
      maxDurationSeconds: 3600,
      maxCostUsdMicros: "10000",
    };
    await repo.createMandate(mandate);
    const fixture =
      "import { test } from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('produced artifact',()=>assert.equal(readFileSync(new URL('./result.txt',import.meta.url),'utf8'),'Created by own tool loop'));";
    const calls = [
      {
        name: "workspace__apply_patch",
        args: { files: [{ path: "result.txt", content: "Created by own tool loop", expectedSha256: null }] },
      },
      { name: "workspace__test_fixture", args: { path: "check.test.mjs" } },
      { name: "fixture__confirm", args: { message: "Approve this exact action" } },
      { name: "artifact__stage", args: { path: "result.txt", mediaType: "text/plain" } },
    ];
    let modelCalls = 0,
      effects = 0;
    const client: ModelClient = {
      async complete(request: ModelRequest) {
        modelCalls++;
        const index = request.messages.filter((m) => m.role === "assistant").length;
        const call = calls[index];
        return {
          id: "generation-" + index,
          costUsdMicros: "0",
          message: call
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-" + index,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  },
                ],
              }
            : { role: "assistant", content: "Result ready for independent review." },
        };
      },
    };
    const makeRuntime = () =>
      new Runtime({
        repo,
        directory,
        client,
        models: [model],
        tools: [
          {
            id: "fixture.confirm",
            schema: z.object({ message: z.string() }),
            description: "Explicit fixture approval",
            requiresApproval: true,
            execute: async () => {
              effects++;
              return { confirmed: true };
            },
          },
        ],
      });
    let runtime = makeRuntime();
    const workspace = runtime.workspace(order.id);
    await workspace.init();
    await workspace.applyPatch({ files: [{ path: "check.test.mjs", content: fixture, expectedSha256: null }] });
    await repo.putDocument(
      scope,
      "trusted-fixture",
      shaUuid("check.test.mjs"),
      { sha256: digest(fixture) },
      { immutable: true },
    );
    const paused = await runtime.start(scope, order.id, mandate, model.id);
    expect(paused.state).toBe("approval");
    expect(paused.testPassed).toBe(true);
    expect(effects).toBe(0);
    expect(modelCalls).toBe(3);
    const pending = (await repo.listDocuments<{ binding: ApprovalBinding }>(scope, "approval-request"))[0]!;
    await repo.close();
    repo = await Repository.open(path.join(directory, "db.sqlite"));
    runtime = makeRuntime();
    expect((await repo.getDocument<Run>(scope, "run", order.id))?.data.messages.length).toBeGreaterThan(4);
    const approval = await repo.approve(scope, pending.data.binding);
    const action = await repo.getDocument<ToolAction>(scope, "action", pending.id);
    await repo.putDocument(
      scope,
      "action",
      pending.id,
      { ...action!.data, approvalId: approval.id, status: "authorized" },
      { expectedRevision: action!.revision },
    );
    const result = await runtime.resume(scope, order.id);
    expect(result.state).toBe("reviewing");
    expect(effects).toBe(1);
    expect(result.artifactIds).toHaveLength(1);
    expect(await readFile(path.join(directory, "workspaces", order.id, "result.txt"), "utf8")).toBe(
      "Created by own tool loop",
    );
    expect(await repo.listDocuments(scope, "artifact")).toHaveLength(1);
    expect(await repo.verifyAudit(scope.companyId)).toBe(true);
    await runtime.resume(scope, order.id);
    expect(effects).toBe(1);
  } finally {
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
