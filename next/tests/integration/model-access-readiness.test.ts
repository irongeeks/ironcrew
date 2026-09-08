import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import { configSchema } from "../../apps/control/configuration.ts";
import { ProtonPassResolver } from "../../packages/integrations/src/secrets.ts";
import { IntegrationError } from "../../packages/integrations/src/transport.ts";

let directory: string, repo: Repository, agent: ReturnType<typeof request.agent>, csrf: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-readiness-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  agent = request.agent(createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" }));
  const setup = await agent
    .post("/api/v1/setup")
    .send({
      token: await issueSetupToken(directory),
      companyName: "Readiness fixture",
      ceoName: "CEO",
      password: "fixture-password-1234",
      timezone: "UTC",
    })
    .expect(200);
  csrf = setup.body.csrfToken;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const configuration = () =>
  configSchema.parse({
    liveExecutionEnabled: true,
    proton: { executable: path.resolve("fixture-pass-cli") },
    openrouter: { secretRef: { provider: "proton-pass", shareId: "share", itemId: "item", field: "password" } },
  });
const save = (body: object) =>
  agent.put("/api/v1/configuration").set({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }).send(body);

it("checks the secret before claiming readiness and never persists its value", async () => {
  const resolve = vi.spyOn(ProtonPassResolver.prototype, "resolve").mockResolvedValue("fixture-never-persist-secret");
  const response = await save(configuration()).expect(200);
  expect(response.body).toMatchObject({ saved: true, runtimeReady: true });
  expect(resolve).toHaveBeenCalledWith(configuration().openrouter!.secretRef, "IronCrew model access readiness check");
  expect(await readFile(path.join(directory, "configuration.json"), "utf8")).not.toContain(
    "fixture-never-persist-secret",
  );
});

it.each(["configuration", "auth"] as const)(
  "rejects an unusable resolver (%s) without replacing a working configuration",
  async (code) => {
    const resolve = vi.spyOn(ProtonPassResolver.prototype, "resolve").mockResolvedValue("fixture-secret");
    await save(configuration()).expect(200);
    const prior = await readFile(path.join(directory, "configuration.json"), "utf8");
    resolve.mockRejectedValue(new IntegrationError(code, "DO-NOT-EXPOSE-SECRET"));
    const changed = configuration();
    changed.openrouter!.secretRef.itemId = "broken-item";
    const response = await save(changed).expect(422);
    expect(response.body.code).toBe(
      code === "configuration" ? "model_secret_configuration" : "model_secret_unavailable",
    );
    expect(JSON.stringify(response.body)).not.toContain("DO-NOT-EXPOSE");
    expect(await readFile(path.join(directory, "configuration.json"), "utf8")).toBe(prior);
    // Failure must release the runtime-update lock and restore the previous runtime.
    resolve.mockResolvedValue("fixture-secret");
    await save(configuration()).expect(200);
  },
);

it("rejects relative CLI paths with a configuration error and allows disabling a broken access", async () => {
  const resolve = vi.spyOn(ProtonPassResolver.prototype, "resolve").mockRejectedValue(new Error("unavailable"));
  const config = configuration();
  config.proton!.executable = "pass-cli";
  expect((await save(config).expect(422)).body.code).toBe("model_secret_configuration");
  config.liveExecutionEnabled = false;
  expect((await save(config).expect(200)).body.runtimeReady).toBe(false);
  expect(resolve).not.toHaveBeenCalled();
});

it("uses the newly saved executable and model access for a real runtime dispatch without restart", async () => {
  const { createFixtureLauncher } = await import("../fixtures/launcher.ts");
  const executable = await createFixtureLauncher(
    directory,
    "pass-cli-live",
    `
if (process.argv[2] === '--version') console.log('Proton Pass CLI 2.3.2');
else process.stdout.write('fixture-live-key\\n');
`,
  );
  const setup = await repo.setupState();
  const snapshot = await repo.snapshot(setup!.company.id);
  const scope = { companyId: snapshot.company.id, areaId: snapshot.areas[0]!.id };
  const model = {
    id: "fixture/live:free",
    name: "Live fixture",
    context_length: 100000,
    supported_parameters: ["tools"],
    pricing: { prompt: "0", completion: "0" },
  };
  await repo.putDocument(scope, "model", randomUUID(), model);
  const config = configuration();
  config.proton!.executable = executable;
  config.openrouter!.modelOverride = model.id;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "gen-fixture",
        choices: [{ message: { role: "assistant", content: "Bitte den nächsten Schritt bestätigen." } }],
        usage: { cost: 0 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const oldExecutable = await createFixtureLauncher(
    directory,
    "pass-cli-old",
    `
if (process.argv[2] === '--version') console.log('Proton Pass CLI 2.3.2');
else process.stdout.write('old-key\\n');
`,
  );
  await save({ ...config, proton: { executable: oldExecutable } }).expect(200);
  await save(config).expect(200);
  let order = await repo.createOrder(scope, { kind: "research", goal: "Live dispatch", budgetLimitUsdMicros: "0" });
  order = await repo.updateOrder(scope, order.id, order.revision, { status: "ready", planVersion: 1 });
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: [],
    targetIds: [order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 2,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  };
  await repo.createMandate(mandate);
  const response = await agent
    .post(`/api/v1/orders/${order.id}/run`)
    .set({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() })
    .send({ mandateId: mandate.id, modelId: model.id })
    .expect(200);
  expect(response.body.blockedReason).not.toBe("model_response_unknown");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: "Bearer fixture-live-key" });
  expect((await repo.listDocuments(scope, "model-turn"))[0]!.data).toMatchObject({
    state: "complete",
    usageState: "reconciled",
  });
  expect((await repo.budget(scope.companyId)).reservations.every((r) => r.state === "settled")).toBe(true);
});
