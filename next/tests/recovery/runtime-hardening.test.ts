import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Runtime, type RuntimeTool } from "../../packages/runtime/src/engine.ts";
import { ExecutionJournal } from "../../packages/tools/journal.ts";
import { digest, Workspace } from "../../packages/tools/workspace.ts";
import type { Model, ModelClient } from "../../packages/runtime/src/openrouter.ts";
import type { Scope, Mandate, Order, ToolAction } from "../../packages/contracts/src/index.ts";
const model: Model = {
  id: "fixture/recovery",
  name: "Recovery test fixture",
  context_length: 100000,
  supported_parameters: ["tools"],
  pricing: { prompt: "0.000001", completion: "0.000001" },
};
let repo: Repository, dir: string, scope: Scope, mandate: Mandate, order: Order;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "runtime-hardening-"));
  repo = await Repository.open(path.join(dir, "db.sqlite"));
  const setup = await repo.setup({
    companyName: "Fixture",
    ceoName: "Robert",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "1000000",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  order = await repo.createOrder(scope, { kind: "research", goal: "Test recovery", budgetLimitUsdMicros: "1000000" });
  order = await repo.updateOrder(scope, order.id, 1, { status: "ready", planVersion: 1 });
  mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["fixture.effect"],
    targetIds: [order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 2,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "1000000",
  };
  await repo.createMandate(mandate);
});
afterEach(async () => {
  await repo.close();
  await rm(dir, { recursive: true, force: true });
});
function runtime(client: ModelClient, tools: RuntimeTool[] = []) {
  return new Runtime({ repo, directory: dir, client, models: [model], tools });
}
const message = {
  role: "assistant" as const,
  content: null,
  tool_calls: [
    {
      id: "call-one",
      type: "function" as const,
      function: { name: "fixture__effect", arguments: '{"value":"approved"}' },
    },
  ],
};
it("never issues another paid request after interrupted response and process restart", async () => {
  let calls = 0;
  const client: ModelClient = {
    async complete() {
      calls++;
      throw new Error("fixture stream interrupted");
    },
  };
  await expect(runtime(client).start(scope, order.id, mandate, model.id)).rejects.toThrow("fixture stream interrupted");
  await repo.close();
  repo = await Repository.open(path.join(dir, "db.sqlite"));
  const recovered = await runtime(client).resume(scope, order.id);
  expect(calls).toBe(1);
  expect(recovered.blockedReason).toBe("model_response_unknown");
  expect(BigInt((await repo.budget(scope.companyId)).unreconciledUsdMicros)).toBeGreaterThan(0n);
  expect(await repo.listDocuments(scope, "action")).toHaveLength(0);
});
it("keeps missing usage visible and postpones tool effects until explicit reconciliation", async () => {
  let calls = 0,
    effects = 0;
  const tools: RuntimeTool[] = [
    {
      id: "fixture.effect",
      schema: z.object({ value: z.string() }),
      description: "Fixture",
      requiresApproval: false,
      execute: async () => {
        effects++;
        return { done: true };
      },
    },
  ];
  const client: ModelClient = {
    async complete() {
      calls++;
      return calls === 1
        ? { id: "unknown-cost", message }
        : { id: "known-cost", costUsdMicros: "0", message: { role: "assistant", content: "Ready for review" } };
    },
  };
  let run = await runtime(client, tools).start(scope, order.id, mandate, model.id);
  expect(run.state).toBe("blocked");
  expect(effects).toBe(0);
  await runtime(client, tools).resume(scope, order.id);
  expect(calls).toBe(1);
  const held = (await repo.budget(scope.companyId)).reservations[0]!;
  await repo.settle(scope, held.id, "20");
  run = await runtime(client, tools).resume(scope, order.id);
  expect(effects).toBe(1);
  expect(calls).toBe(2);
  expect(run.state).toBe("reviewing");
});
it("accounts malformed complete model responses without persisting partial tool actions", async () => {
  let calls = 0;
  const client: ModelClient = {
    async complete() {
      calls++;
      return {
        id: "invalid-tool",
        costUsdMicros: "11",
        message: {
          ...message,
          tool_calls: [
            message.tool_calls[0]!,
            { id: "bad", type: "function", function: { name: "fixture__effect", arguments: '{"value":' } },
          ],
        },
      };
    },
  };
  const tools: RuntimeTool[] = [
    {
      id: "fixture.effect",
      schema: z.object({ value: z.string() }),
      description: "Fixture",
      requiresApproval: false,
      execute: async () => ({ done: true }),
    },
  ];
  const run = await runtime(client, tools).start(scope, order.id, mandate, model.id);
  expect(run.blockedReason).toBe("model_response_invalid");
  expect((await repo.budget(scope.companyId)).spentUsdMicros).toBe("11");
  expect(await repo.listDocuments(scope, "action")).toHaveLength(0);
  await runtime(client, tools).resume(scope, order.id);
  expect(calls).toBe(1);
});
it("records an already completed effect after crash and mandate revocation without re-executing it", async () => {
  let effects = 0,
    calls = 0;
  const tools: RuntimeTool[] = [
    {
      id: "fixture.effect",
      schema: z.object({ value: z.string() }),
      description: "Fixture",
      requiresApproval: false,
      execute: async () => {
        effects++;
        return { externalId: "fixture-effect" };
      },
    },
  ];
  const client: ModelClient = {
    async complete() {
      calls++;
      return { id: "effect-request", costUsdMicros: "1", message };
    },
  };
  const original = repo.transact.bind(repo);
  repo.transact = async (...args) => {
    if (args[2].type === "tool.result") throw new Error("fixture crash after external effect");
    return original(...args);
  };
  await expect(runtime(client, tools).start(scope, order.id, mandate, model.id)).rejects.toThrow("fixture crash");
  expect(effects).toBe(1);
  await repo.close();
  repo = await Repository.open(path.join(dir, "db.sqlite"));
  await repo.revokeMandate(scope, mandate.id, 1);
  const run = await runtime(client, tools).resume(scope, order.id);
  expect(effects).toBe(1);
  expect(calls).toBe(1);
  expect(run.blockedReason).toBe("mandate_unavailable");
  expect((await repo.listDocuments<ToolAction>(scope, "action"))[0]?.data.status).toBe("succeeded");
  expect(run.messages.filter((m) => m.role === "tool")).toHaveLength(1);
});
it("rolls back the reservation if atomic model-intent persistence fails", async () => {
  const existing = randomUUID();
  await repo.putDocument(scope, "run", existing, { state: "existing" });
  await expect(
    repo.reserveAndTransact(
      scope,
      {
        id: randomUUID(),
        orderId: order.id,
        periodId: (await repo.budget(scope.companyId)).periodId,
        amountUsdMicros: "50",
      },
      [{ kind: "run", id: existing, data: {}, expectedRevision: 0 }],
      { type: "model.prepared", aggregateId: order.id },
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect((await repo.budget(scope.companyId)).reservations).toHaveLength(0);
});
it("stale local intent stays unknown and a durable staged result is recovered without another effect", async () => {
  const directory = path.join(dir, "receipts");
  await mkdir(directory);
  const id = randomUUID(),
    argsHash = digest("fixture");
  await writeFile(path.join(directory, id + ".json"), JSON.stringify({ actionId: id, argsHash, state: "started" }));
  let effects = 0;
  const journal = new ExecutionJournal(directory);
  const unknown = await journal.execute(id, argsHash, async () => {
    effects++;
    return null;
  });
  expect(unknown.status).toBe("effect_unknown");
  expect(unknown.resultSha256).toBe(digest(JSON.stringify(unknown.data)));
  expect(effects).toBe(0);
  const result = {
    status: "succeeded",
    data: { externalId: "fixture" },
    resultSha256: digest(JSON.stringify({ externalId: "fixture" })),
  };
  await writeFile(path.join(directory, id + ".json.result"), JSON.stringify({ actionId: id, argsHash, result }));
  expect(
    await journal.execute(id, argsHash, async () => {
      effects++;
      return null;
    }),
  ).toEqual(result);
  expect(effects).toBe(0);
  expect(JSON.parse(await readFile(path.join(directory, id + ".json"), "utf8")).result).toEqual(result);
});
it("shares one local execution under concurrency and rejects a corrupt receipt", async () => {
  const journal = new ExecutionJournal(path.join(dir, "receipts")),
    id = randomUUID(),
    argsHash = digest("fixture");
  let effects = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      journal.execute(id, argsHash, async () => {
        effects++;
        return { done: true };
      }),
    ),
  );
  expect(effects).toBe(1);
  await writeFile(
    path.join(dir, "receipts", id + ".json"),
    JSON.stringify({
      actionId: id,
      argsHash,
      result: { status: "succeeded", data: { done: false }, resultSha256: digest(JSON.stringify({ done: true })) },
    }),
  );
  await expect(journal.execute(id, argsHash, async () => null)).rejects.toMatchObject({ code: "journal_corrupt" });
});

it("consumes CEO messages once at the next model boundary while an active response is in flight", async () => {
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const requests: import("../../packages/runtime/src/openrouter.ts").ModelRequest[] = [];
  const client: ModelClient = {
    async complete(request) {
      requests.push(structuredClone(request));
      calls++;
      if (calls === 1) {
        entered();
        await pending;
        return { id: "first-turn", costUsdMicros: "1", message };
      }
      return { id: "second-turn", costUsdMicros: "1", message: { role: "assistant", content: "Review ready" } };
    },
  };
  const rt = runtime(client, [
    {
      id: "fixture.effect",
      schema: z.object({ value: z.string() }),
      description: "Fixture",
      requiresApproval: false,
      execute: async () => ({ done: true }),
    },
  ]);
  const running = rt.start(scope, order.id, mandate, model.id);
  await entry;
  const sent = await Runtime.appendMessage(repo, scope, order.id, "CEO correction during model response");
  release();
  const finished = await running;
  expect(requests[0]!.messages.some((m) => m.content === sent.content)).toBe(false);
  expect(requests[1]!.messages.filter((m) => m.content === sent.content)).toHaveLength(1);
  expect(finished.consumedMessageIds).toContain(sent.id);
  expect((await rt.findRun(order.id, scope)).messages.filter((m) => m.content === sent.content)).toHaveLength(1);
  expect((await repo.getDocument(scope, "message", sent.id))?.data).toMatchObject({
    role: "user",
    content: sent.content,
  });
});

it("snapshots the edited lead profile and uses its public version for every model turn", async () => {
  const leadId = order.leadEmployeeId;
  await repo.putDocument(scope, "employee-profile", leadId, {
    displayName: "Edited Lead",
    persona: "Use the edited fixture persona.",
  });
  const rt = runtime({
    async complete(request) {
      expect(request.messages[0]!.content).toContain("Use the edited fixture persona.");
      return { id: "profile-turn", costUsdMicros: "1", message: { role: "assistant", content: "Review ready" } };
    },
  });
  const run = await rt.start(scope, order.id, mandate, model.id);
  expect(run.profileSnapshot).toMatchObject({ employeeId: leadId, displayName: "Edited Lead" });
  expect(run.profileVersion).toBe(2);
  expect((await repo.listDocuments<{ profileVersion: number }>(scope, "model-turn"))[0]!.data.profileVersion).toBe(2);
});
it("resumes reviewed work for a new CEO correction exactly once without claiming prior checks still pass", async () => {
  let calls = 0;
  const requests: import("../../packages/runtime/src/openrouter.ts").ModelRequest[] = [];
  const rt = runtime({
    async complete(request) {
      calls++;
      requests.push(structuredClone(request));
      return {
        id: "review-" + calls,
        costUsdMicros: "1",
        message: { role: "assistant", content: "Ready for review " + calls },
      };
    },
  });
  await rt.start(scope, order.id, mandate, model.id);
  expect(calls).toBe(1);
  await rt.resume(scope, order.id);
  expect(calls).toBe(1);
  const sent = await Runtime.appendMessage(repo, scope, order.id, "Please revise the conclusion.");
  const result = await rt.resume(scope, order.id);
  expect(calls).toBe(2);
  expect(requests[1]!.messages.filter((m) => m.content === sent.content)).toHaveLength(1);
  expect(result.testPassed).toBe(false);
  await rt.resume(scope, order.id);
  expect(calls).toBe(2);
});

it("does not turn a model-declared zero-exit command into trusted verification", async () => {
  const permission = { ...mandate, id: randomUUID(), allowedToolIds: ["workspace.execute", "artifact.stage"] };
  await repo.createMandate(permission);
  const content = "An untested output",
    sha = digest(content);
  await mkdir(path.join(dir, "exports"));
  await writeFile(path.join(dir, "exports", "result.txt"), content);
  const receipt = vi.spyOn(Workspace.prototype, "execute").mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    termination: "exited",
    attestationId: randomUUID(),
    profileSha256: "a".repeat(64),
    toolchainSha256: "b".repeat(64),
    outputDirectory: path.join(dir, "exports"),
    outputHashes: { "result.txt": sha },
    resources: { memoryEvents: {}, pidsEvents: {}, cpuStat: {} },
  });
  try {
    let calls = 0;
    const client: ModelClient = {
      complete: async () => {
        const call = [
          { name: "workspace__execute", args: { argv: ["node", "-e", "process.exit(0)"], purpose: "test" } },
          { name: "artifact__stage", args: { path: "result.txt", mediaType: "text/plain" } },
        ][calls++];
        return {
          id: "fixture-generation-" + calls,
          costUsdMicros: "0",
          message: call
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-" + calls,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  },
                ],
              }
            : { role: "assistant", content: "Declared ready" },
        };
      },
    };
    const instance = runtime(client),
      workspace = instance.workspace(order.id);
    await workspace.init();
    await workspace.applyPatch({ files: [{ path: "result.txt", content, expectedSha256: null }] });
    const run = await instance.start(scope, order.id, permission, model.id);
    expect(receipt).toHaveBeenCalledOnce();
    expect(run.artifactIds).toHaveLength(1);
    expect(run.testPassed).toBe(false);
    expect(run.testedHashes?.["result.txt"]).toBeUndefined();
  } finally {
    receipt.mockRestore();
  }
});
