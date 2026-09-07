import { beforeEach, afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import type { Scope, ToolAction, Order } from "../../packages/contracts/src/index.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { coordinationTools, coordinationOrders, type Coordination } from "../../packages/runtime/src/coordination.ts";
import { OpenRouterClient, type Model } from "../../packages/runtime/src/openrouter.ts";
import { shaUuid, type Run } from "../../packages/runtime/src/engine.ts";
let repo: Repository,
  directory: string,
  setup: SetupResult,
  scope: Scope,
  order: Order,
  action: ToolAction,
  server: Server;
let input: { topic: string; context: string; employeeIds: string[] }, client: OpenRouterClient;
let responses: ServerResponse[], requests: Record<string, unknown>[], secretHook: (() => Promise<void>) | undefined;
const model: Model = {
  id: "fixture-model",
  name: "Fixture",
  supported_parameters: ["tools"],
  pricing: { prompt: "0.000001", completion: "0.000001" },
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ic-coordination-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  setup = await repo.setup({
    companyName: "Coordination lab",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "1000000",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  order = await repo.createOrder(scope, {
    kind: "website",
    goal: "Assess design feasibility",
    budgetLimitUsdMicros: "1000000",
  });
  order = await repo.commitPlan(scope, order.id, order.revision, {
    steps: ["Consult technical and design crew"],
    acceptanceCriteria: ["Attributed assessments"],
  });
  order = await repo.updateOrder(scope, order.id, order.revision, { status: "running" });
  input = {
    topic: "Implementation constraints",
    context: "Source: owner brief; no hosting access configured",
    employeeIds: [order.leadEmployeeId, setup.employees.find((e) => e.id !== order.leadEmployeeId)!.id],
  };
  const mandateId = randomUUID();
  await repo.createMandate({
    id: mandateId,
    version: 1,
    scope,
    allowedToolIds: ["coordination.consult"],
    targetIds: [order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 10,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "1000000",
  });
  action = {
    id: randomUUID(),
    runId: order.id,
    orderId: order.id,
    scope,
    toolId: "coordination.consult",
    toolVersion: 1,
    args: input,
    argumentsSha256: sha256(input),
    status: "running",
    mandateId,
    mandateVersion: 1,
    evidenceRefs: [],
  };
  await repo.putDocument(scope, "action", action.id, { ...action, targetId: order.id });
  const run: Run = {
    id: order.id,
    orderId: order.id,
    scope,
    messages: [],
    actionIds: [action.id],
    step: 1,
    state: "running",
    modelId: model.id,
    mandateId,
    mandateVersion: 1,
    targetId: order.id,
    testPassed: false,
    artifactIds: [],
  };
  await repo.putDocument(scope, "run", order.id, run);
  responses = [];
  requests = [];
  secretHook = undefined;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    responses.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  client = new OpenRouterClient({
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    testServer: true,
    maxConcurrent: 4,
    secret: async () => {
      await secretHook?.();
      return "fixture-token";
    },
  });
});
afterEach(async () => {
  for (const res of responses) if (!res.writableEnded) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const tool = () => coordinationTools({ repo, client, models: [model] })[0]!;
function finish(index: number, cost: number | undefined = 0.001) {
  responses[index]!.setHeader("Content-Type", "application/json");
  responses[index]!.end(
    JSON.stringify({
      id: `fixture-${index}`,
      choices: [{ message: { role: "assistant", content: `Assessment ${index}: request explicit hosting access.` } }],
      ...(cost === undefined ? {} : { usage: { cost } }),
    }),
  );
}
it("executes participants in parallel with actual profiles, budget accounting and visible live state, then replays without another HTTP call", async () => {
  const executing = tool().execute(input, action);
  await expect.poll(() => requests.length).toBe(2);
  expect((await coordinationOrders(repo, [order]))[0]!.activeCoordination?.employeeIds).toEqual(input.employeeIds);
  const prompts = requests.map((r) => JSON.stringify(r.messages));
  for (const id of input.employeeIds)
    expect(prompts.some((p) => p.includes(setup.employees.find((e) => e.id === id)!.displayName))).toBe(true);
  expect(requests.every((r) => Array.isArray(r.tools) && r.tools.length === 0)).toBe(true);
  expect((await repo.budget(scope.companyId)).reservations.every((r) => r.state === "held")).toBe(true);
  finish(0);
  finish(1);
  const result = (await executing) as Coordination;
  expect(result.status).toBe("complete");
  expect(result.contributions).toHaveLength(2);
  expect((await coordinationOrders(repo, [order]))[0]!.activeCoordination).toBeUndefined();
  expect((await repo.budget(scope.companyId)).spentUsdMicros).toBe("2000");
  await repo.close();
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  expect(await tool().execute(input, action)).toEqual(result);
  expect(requests).toHaveLength(2);
});
it("keeps unknown participant costs reserved and blocks replay", async () => {
  const executing = tool()
    .execute(input, action)
    .catch((e: Error) => e.message);
  await expect.poll(() => requests.length).toBe(2);
  responses[0]!.setHeader("Content-Type", "application/json");
  responses[0]!.end(
    JSON.stringify({
      id: "no-usage",
      choices: [{ message: { role: "assistant", content: "Assessment without bill" } }],
    }),
  );
  finish(1);
  expect(await executing).toBe("coordination_incomplete");
  expect(BigInt((await repo.budget(scope.companyId)).unreconciledUsdMicros)).toBeGreaterThan(0n);
  expect((await coordinationOrders(repo, [order]))[0]!.activeCoordination).toBeUndefined();
  await expect(tool().execute(input, action)).rejects.toThrow();
  expect(requests).toHaveLength(2);
});
it("rechecks mandate after secret resolution and never sends after revocation", async () => {
  secretHook = async () => {
    await repo.revokeMandate(scope, action.mandateId, 1);
  };
  await expect(tool().execute(input, action)).rejects.toThrow("coordination_incomplete");
  expect(requests).toHaveLength(0);
  const budget = await repo.budget(scope.companyId);
  expect(budget.spentUsdMicros).toBe("0");
  expect(budget.unreconciledUsdMicros).toBe("0");
});
it("rejects foreign participants before any reservation or HTTP request", async () => {
  input.employeeIds[1] = randomUUID();
  action = { ...action, args: input, argumentsSha256: sha256(input) };
  await repo.putDocument(scope, "action", action.id, { ...action, targetId: order.id }, { expectedRevision: 1 });
  await expect(tool().execute(input, action)).rejects.toThrow("employee_not_found");
  expect(requests).toHaveLength(0);
  expect((await repo.budget(scope.companyId)).reservations).toHaveLength(0);
});

async function pendingMeeting(completeAll: boolean) {
  await repo.putDocument(scope, "coordination", action.id, {
    id: action.id,
    orderId: order.id,
    actionId: action.id,
    topic: input.topic,
    contextSha256: sha256(input.context),
    employeeIds: input.employeeIds,
    status: "running",
    startedAt: new Date().toISOString(),
    contributions: [],
  });
  for (const [index, employeeId] of input.employeeIds.entries()) {
    const id = shaUuid(`coordination:${action.id}:${employeeId}`),
      reservationId = shaUuid(`coordination-reservation:${id}`);
    const turn = { id, employeeId, coordinationId: action.id, reservationId, state: "sent", usageState: "pending" };
    await repo.reserveAndTransact(
      scope,
      {
        id: reservationId,
        periodId: (await repo.budget(scope.companyId)).periodId,
        orderId: order.id,
        amountUsdMicros: "10",
        modelTurnId: id,
        mandateId: action.mandateId,
        mandateVersion: 1,
      },
      [{ kind: "model-turn", id, data: turn, expectedRevision: 0 }],
      { type: "fixture.prepared", aggregateId: order.id },
    );
    if (completeAll || index === 0)
      await repo.settleAndTransact(
        scope,
        { reservationId, actualMicros: "3" },
        [
          {
            kind: "model-turn",
            id,
            data: {
              ...turn,
              state: "complete",
              usageState: "reconciled",
              response: {
                id: "fixture-completed",
                message: { role: "assistant", content: `Durable contribution ${index}` },
                costUsdMicros: "3",
              },
            },
            expectedRevision: 1,
          },
        ],
        { type: "fixture.completed", aggregateId: order.id },
      );
  }
  await repo.close();
  repo = await Repository.open(path.join(directory, "company.sqlite"));
}
it("recovers persisted complete contributions after restart without another provider dispatch", async () => {
  await pendingMeeting(true);
  const result = (await tool().execute(input, action)) as Coordination;
  expect(result.status).toBe("complete");
  expect(result.contributions).toHaveLength(2);
  expect(requests).toHaveLength(0);
  expect((await repo.budget(scope.companyId)).spentUsdMicros).toBe("6");
});
it("marks interrupted pending participant usage unknown after restart and never reissues", async () => {
  await pendingMeeting(false);
  await expect(tool().execute(input, action)).rejects.toThrow("coordination_reconciliation_required");
  const meeting = await repo.getDocument<Coordination>(scope, "coordination", action.id);
  expect(meeting?.data.status).toBe("blocked");
  expect(meeting?.data.contributions).toHaveLength(1);
  expect((await repo.budget(scope.companyId)).unreconciledUsdMicros).toBe("10");
  await expect(tool().execute(input, action)).rejects.toThrow("coordination_reconciliation_required");
  expect(requests).toHaveLength(0);
});
it("never projects another repository instance's running meeting as locally active", async () => {
  const executing = tool().execute(input, action);
  await expect.poll(() => requests.length).toBe(2);
  const copy = path.join(directory, "snapshot.sqlite");
  await repo.backup(copy);
  const restored = await Repository.open(copy);
  try {
    expect((await coordinationOrders(restored, [order]))[0]!.activeCoordination).toBeUndefined();
  } finally {
    await restored.close();
    finish(0);
    finish(1);
    await executing;
  }
});
it("books known provider costs even if the configured redactor cannot produce a valid response", async () => {
  const executing = coordinationTools({ repo, client, models: [model], redact: () => "invalid-json" })[0]!
    .execute(input, action)
    .catch((e: Error) => e.message);
  await expect.poll(() => requests.length).toBe(2);
  finish(0);
  finish(1);
  expect(await executing).toBe("coordination_incomplete");
  const budget = await repo.budget(scope.companyId);
  expect(budget.spentUsdMicros).toBe("2000");
  expect(budget.unreconciledUsdMicros).toBe("0");
});
it("enforces the firm budget before any participant can contact the provider", async () => {
  await repo.setBudget(scope.companyId, { limitUsdMicros: "0" });
  await expect(tool().execute(input, action)).rejects.toThrow("coordination_incomplete");
  expect(requests).toHaveLength(0);
  expect((await repo.budget(scope.companyId)).reservations).toHaveLength(0);
});
it("uses the participant's explicit catalog-bound model override and immutable profile snapshot", async () => {
  const employeeId = input.employeeIds[1]!;
  await repo.putDocument(scope, "employee-profile", employeeId, {
    displayName: "Named specialist",
    persona: "Use explicit source comparisons",
    modelOverride: "expert-model",
  });
  const executing = coordinationTools({ repo, client, models: [model, { ...model, id: "expert-model" }] })[0]!.execute(
    input,
    action,
  );
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.filter((r) => r.model === "expert-model")).toHaveLength(1);
  expect(requests.some((r) => JSON.stringify(r.messages).includes("Named specialist"))).toBe(true);
  finish(0);
  finish(1);
  await executing;
  const turns = await repo.listDocuments<{
    employeeId: string;
    profileSnapshot: { displayName: string };
    modelId: string;
  }>(scope, "model-turn");
  expect(turns.find((t) => t.data.employeeId === employeeId)?.data).toMatchObject({
    modelId: "expert-model",
    profileSnapshot: { displayName: "Named specialist" },
  });
});

it("reconstructs a complete response whose missing provider cost was subsequently settled in the ledger", async () => {
  await pendingMeeting(true);
  for (const row of await repo.listDocuments<Record<string, unknown>>(scope, "model-turn")) {
    const response = { ...(row.data.response as Record<string, unknown>) };
    delete response.costUsdMicros;
    await repo.putDocument(scope, "model-turn", row.id, { ...row.data, response }, { expectedRevision: row.revision });
  }
  const result = (await tool().execute(input, action)) as Coordination;
  expect(result.status).toBe("complete");
  expect(result.contributions).toHaveLength(2);
  expect(requests).toHaveLength(0);
  expect((await repo.budget(scope.companyId)).spentUsdMicros).toBe("6");
});
