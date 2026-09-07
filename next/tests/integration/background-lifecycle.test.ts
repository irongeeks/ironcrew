import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { BackgroundCoordinator } from "../../apps/control/background.ts";
import { Runtime } from "../../packages/runtime/src/engine.ts";
import { Scheduler } from "../../packages/domain/workflows/automation.ts";
const model = {
  id: "fixture/free",
  name: "Fixture",
  supported_parameters: ["tools"],
  context_length: 100000,
  pricing: { prompt: "0", completion: "0" },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-background-lifecycle-"));
  const repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "1000",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas[0].id };
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: [],
    targetIds: [randomUUID()],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxAttempts: 3,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "1000",
  };
  await repo.createMandate(mandate);
  await new Scheduler(repo).create(
    scope,
    {
      cron: "* * * * *",
      timezone: "UTC",
      enabled: true,
      goal: "Fixture",
      kind: "research",
      leadEmployeeId: setup.employees[0].id,
      budgetLimitUsdMicros: "100",
      mandateId: mandate.id,
      maxActiveOrders: 1,
    },
    new Date(Date.now() - 120000),
  );
  return {
    directory,
    repo,
    scope,
    cleanup: async () => {
      await repo.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it("pauses synchronously, drains an in-flight catalog before snapshot, and stops future ticks", async () => {
  const f = await fixture();
  try {
    const started = deferred(),
      pending = deferred();
    let calls = 0;
    const background = new BackgroundCoordinator(
      f.repo,
      () => undefined,
      async () => {
        calls++;
        started.resolve();
        await pending.promise;
        await f.repo.putDocument(f.scope, "catalog-fixture", "latest", { completed: true });
        return { models: [model], observedAt: new Date().toISOString() };
      },
    );
    const tick = background.tick();
    await started.promise;
    let drained = false;
    const pausing = background.pause().then((release) => {
      drained = true;
      return release;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await background.tick();
    expect(calls).toBe(1);
    pending.resolve();
    await tick;
    const release = await pausing;
    expect((await f.repo.getDocument(f.scope, "catalog-fixture", "latest"))!.data).toEqual({ completed: true });
    expect(await f.repo.listOrders(f.scope)).toHaveLength(0);
    await background.tick();
    expect(await f.repo.listOrders(f.scope)).toHaveLength(0);
    release();
    release();
    await background.tick();
    expect(await f.repo.listOrders(f.scope)).toHaveLength(1);
    await background.stop();
    await background.tick(new Date(Date.now() + 3600000));
    expect(calls).toBe(1);
  } finally {
    await f.cleanup();
  }
});
it("retries a routine after runtime configuration rejected start without conflicting with selection evidence", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const runtime = new Runtime({
      repo: f.repo,
      directory: f.directory,
      models: [model],
      client: {
        async complete() {
          calls++;
          return {
            id: "fixture-result",
            costUsdMicros: "0",
            message: { role: "assistant", content: "Review needed." },
          };
        },
      },
    });
    runtime.acceptingRuns = false;
    const background = new BackgroundCoordinator(
      f.repo,
      () => runtime,
      async () => ({ models: [model], observedAt: new Date().toISOString() }),
    );
    await background.tick();
    expect(calls).toBe(0);
    const [order] = await f.repo.listOrders(f.scope);
    expect(await f.repo.listDocuments(f.scope, "model-selection")).toHaveLength(1);
    runtime.acceptingRuns = true;
    await background.tick();
    expect(calls).toBe(1);
    expect((await f.repo.getOrder(f.scope, order.id)).status).toBe("reviewing");
    expect(await f.repo.listDocuments(f.scope, "model-selection")).toHaveLength(1);
    await background.stop();
  } finally {
    await f.cleanup();
  }
});
