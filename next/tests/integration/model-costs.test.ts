import { afterEach, expect, it } from "vitest";
import request from "supertest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Runtime, type Run } from "../../packages/runtime/src/engine.ts";
import { OpenRouterClient, type Model } from "../../packages/runtime/src/openrouter.ts";
import { ModelCostService } from "../../apps/control/model-cost-service.ts";
import { createApp } from "../../apps/control/app.ts";
import { hashPassword } from "../../apps/control/auth.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(interrupted = false, api = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "model-cost-"));
  let repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
      companyName: "Model costs",
      ceoName: "Owner",
      passwordHash: api ? await hashPassword("model-fixture-password-1234") : "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "100000",
    }),
    scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  let order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Actual local model cost request",
    budgetLimitUsdMicros: "100000",
  });
  order = await repo.updateOrder(scope, order.id, order.revision, { status: "ready", planVersion: 1 });
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: [],
    targetIds: [order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 10,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "100000",
  };
  await repo.createMandate(mandate);
  const model: Model = {
    id: "fixture/model",
    name: "Fixture",
    context_length: 100000,
    supported_parameters: ["tools"],
    pricing: { prompt: "0.000001", completion: "0.000001" },
  };
  let generationBody: unknown = {
      data: {
        id: "gen-fixture",
        model: model.id,
        total_cost: 0.00003,
        created_at: "2026-09-07T12:00:00.000Z",
        secretEcho: "fixture-api-token",
      },
    },
    generationStatus = 200,
    completions = 0,
    generations = 0;
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe("Bearer fixture-api-token");
    if (req.url?.startsWith("/generation")) {
      generations++;
      expect(new URL(req.url, "http://localhost").searchParams.get("id")).toBe("gen-fixture");
      res.writeHead(generationStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(generationBody));
      return;
    }
    completions++;
    if (interrupted) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "gen-fixture",
        choices: [{ message: { role: "assistant", content: "Actual fixture answer, no provider usage supplied" } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new OpenRouterClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    testServer: true,
    secret: async () => "fixture-api-token",
    timeoutMs: 500,
  });
  let runtime = new Runtime({ repo, directory, models: [model], client });
  if (interrupted) await expect(runtime.start(scope, order.id, mandate, model.id)).rejects.toThrow();
  else expect((await runtime.start(scope, order.id, mandate, model.id)).blockedReason).toBe("usage_unreconciled");
  const costs = () => new ModelCostService({ repo, directory, client, isRunActive: (id) => runtime.active.has(id) });
  cleanup.push(async () => {
    await repo.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get repo() {
      return repo;
    },
    get runtime() {
      return runtime;
    },
    directory,
    scope,
    order,
    ceoId: setup.ceo.id,
    client,
    costs,
    get completions() {
      return completions;
    },
    get generations() {
      return generations;
    },
    set generationBody(value: unknown) {
      generationBody = value;
    },
    set generationStatus(value: number) {
      generationStatus = value;
    },
    async turn() {
      return (await costs().list(scope.companyId, setup.ceo.id)).turns[0]!;
    },
    async restart() {
      await repo.close();
      repo = await Repository.open(path.join(directory, "company.sqlite"));
      runtime = new Runtime({ repo, directory, models: [model], client });
    },
  };
}
const manual = {
  actualUsdMicros: "0",
  evidence: {
    mediaType: "text/plain",
    contentBase64: Buffer.from("Provider statement fixture: this interrupted turn billed zero.").toString("base64"),
    description: "Explicit CEO statement attribution",
  },
};
it("reconciles actual HTTP completion usage through the saved generation after restart without another model call", async () => {
  const f = await fixture();
  await f.restart();
  const turn = await f.turn(),
    oldRun = await f.repo.getDocument<Run>(f.scope, "run", f.order.id);
  expect(turn).toMatchObject({ usageState: "unreconciled", responseAvailable: true, providerId: "gen-fixture" });
  const settled = await f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision);
  expect(settled).toMatchObject({ actualUsdMicros: "30", usageState: "reconciled", reservationState: "settled" });
  expect(f.completions).toBe(1);
  expect(f.generations).toBe(1);
  expect((await f.repo.getDocument(f.scope, "run", f.order.id))!.data).toEqual(oldRun!.data);
  const evidence = await f.repo.getDocument(f.scope, "model-cost-evidence", turn.id);
  expect(JSON.stringify(evidence)).not.toContain("fixture-api-token");
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({ spentUsdMicros: "30", unreconciledUsdMicros: "0" });
  await expect(f.costs().provider(f.scope.companyId, f.ceoId, turn.id, settled.revision)).rejects.toMatchObject({
    code: "model_cost_already_settled",
  });
  expect(f.generations).toBe(1);
});
it.each(["id", "model", "missing_cost", "negative_cost"])(
  "keeps reservations on %s provider mismatch",
  async (problem) => {
    const f = await fixture(),
      turn = await f.turn();
    f.generationBody = {
      data: {
        id: problem === "id" ? "gen-other" : "gen-fixture",
        model: problem === "model" ? "other/model" : "fixture/model",
        ...(problem === "missing_cost" ? {} : { total_cost: problem === "negative_cost" ? -0.1 : 0.00003 }),
      },
    };
    await expect(f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision)).rejects.toThrow();
    expect((await f.turn()).reservationState).toBe("unreconciled");
    expect(f.generations).toBe(1);
    expect(f.completions).toBe(1);
  },
);
it("stores manual original evidence for a lost response but never removes its pending turn or resumes it", async () => {
  const f = await fixture(true),
    turn = await f.turn();
  await expect(f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision)).rejects.toMatchObject({
    code: "model_cost_provider_id_unknown",
  });
  expect(f.generations).toBe(0);
  await f.costs().manual(f.scope.companyId, f.ceoId, turn.id, turn.revision, manual);
  const run = await f.runtime.resume(f.scope, f.order.id);
  expect(run).toMatchObject({ state: "blocked", blockedReason: "model_response_unknown", pendingTurnId: turn.id });
  expect(f.completions).toBe(1);
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({
    spentUsdMicros: "0",
    reservedUsdMicros: "0",
    unreconciledUsdMicros: "0",
  });
  const evidence = (await f.repo.getDocument<{ contentBase64: string }>(f.scope, "model-cost-evidence", turn.id))!;
  expect(evidence.data.contentBase64).toBe(manual.evidence.contentBase64);
});
it("rejects foreign CEO and active model runs before fetching generation metadata", async () => {
  const f = await fixture(),
    turn = await f.turn();
  await expect(f.costs().list(randomUUID(), f.ceoId)).rejects.toMatchObject({ code: "ceo_required" });
  await expect(f.costs().provider(f.scope.companyId, randomUUID(), turn.id, turn.revision)).rejects.toMatchObject({
    code: "ceo_required",
  });
  f.runtime.active.add(f.order.id);
  await expect(f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision)).rejects.toMatchObject({
    code: "model_cost_run_active",
  });
  expect(f.generations).toBe(0);
});
it("records actual overruns and clamps available budget without inventing permission for further spend", async () => {
  const f = await fixture(true),
    turn = await f.turn();
  await f.costs().manual(f.scope.companyId, f.ceoId, turn.id, turn.revision, { ...manual, actualUsdMicros: "200000" });
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({ spentUsdMicros: "200000", availableUsdMicros: "0" });
});
it("rounds a real sub-micro provider charge upward and rejects provider errors without leaking payloads", async () => {
  const f = await fixture();
  f.generationBody = { data: { id: "gen-fixture", model: "fixture/model", total_cost: 1e-7 } };
  expect(await f.client.generation("gen-fixture")).toMatchObject({ costUsdMicros: "1" });
  f.generationStatus = 401;
  f.generationBody = { error: "fixture-api-token" };
  await expect(f.client.generation("gen-fixture")).rejects.toMatchObject({ code: "usage_unavailable" });
});
it("uses the real CEO session, CSRF, immutable turn revision and idempotency for provider settlement", async () => {
  const f = await fixture(false, true),
    turn = await f.turn();
  const app = createApp({
      repo: f.repo,
      directory: f.directory,
      publicOrigin: "http://127.0.0.1:8790",
      modelCostService: f.costs(),
    }),
    agent = request.agent(app);
  await agent.get("/api/v1/model-costs").expect(401);
  const login = await agent.post("/api/v1/session").send({ password: "model-fixture-password-1234" }).expect(200);
  const url = `/api/v1/model-costs/${turn.id}/provider`;
  await agent.post(url).send({}).expect(403);
  await agent
    .post(url)
    .set({ "X-CSRF-Token": login.body.csrfToken, "Idempotency-Key": randomUUID() })
    .send({})
    .expect(400);
  const headers = {
    "X-CSRF-Token": login.body.csrfToken,
    "Idempotency-Key": randomUUID(),
    "If-Match": String(turn.revision),
  };
  await agent.post(url).set(headers).send({}).expect(200);
  await agent.post(url).set(headers).send({}).expect(200);
  expect(f.generations).toBe(1);
  expect(f.completions).toBe(1);
  const listing = await agent.get("/api/v1/model-costs").expect(200);
  expect(listing.body.turns[0]).toMatchObject({ actualUsdMicros: "30", usageState: "reconciled" });
  expect(JSON.stringify(listing.body)).not.toContain("fixture-api-token");
  expect(JSON.stringify(listing.body)).not.toContain("Actual fixture answer");
});
it("atomically settles concurrent provider reconciliations only once", async () => {
  const f = await fixture(),
    turn = await f.turn();
  const outcomes = await Promise.allSettled([
    f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision),
    f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  expect((await f.repo.budget(f.scope.companyId)).spentUsdMicros).toBe("30");
  expect(await f.repo.listDocuments(f.scope, "model-cost-evidence")).toHaveLength(1);
});
it("rechecks activity after secret resolution before the provider request", async () => {
  const f = await fixture(),
    turn = await f.turn();
  f.client.secret = async () => {
    f.runtime.active.add(f.order.id);
    return "fixture-api-token";
  };
  await expect(f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision)).rejects.toMatchObject({
    code: "model_cost_run_active",
  });
  expect(f.generations).toBe(0);
});
it("rejects a provider generation reused by another persisted model turn", async () => {
  const f = await fixture(),
    turn = await f.turn(),
    stored = (await f.repo.getDocument<Record<string, unknown>>(f.scope, "model-turn", turn.id))!;
  const duplicateId = randomUUID();
  await f.repo.putDocument(f.scope, "model-turn", duplicateId, { ...stored.data, id: duplicateId });
  await expect(f.costs().provider(f.scope.companyId, f.ceoId, turn.id, turn.revision)).rejects.toMatchObject({
    code: "model_cost_provider_id_reused",
  });
  expect(f.generations).toBe(0);
});
