import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Runtime } from "../../packages/runtime/src/engine.ts";
import type { Model } from "../../packages/runtime/src/openrouter.ts";
import { Scheduler } from "../../packages/domain/workflows/automation.ts";
import { BackgroundCoordinator } from "../../apps/control/background.ts";
const model: Model = {
  id: "fixture/no-network",
  name: "Fixture",
  supported_parameters: ["tools"],
  context_length: 100000,
  pricing: { prompt: "0", completion: "0" },
};
it("dispatches persisted routine once after configuration becomes available and never repeats after restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-background-"));
  let repo = await Repository.open(path.join(directory, "db.sqlite"));
  try {
    const setup = await repo.setup({
      companyName: "Fixture",
      ceoName: "Fixture",
      passwordHash: "fixture",
      timezone: "Europe/Berlin",
      budgetLimitUsdMicros: "10000",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const mandate = {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["workspace.read"],
      targetIds: [randomUUID()],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxAttempts: 3,
      maxDurationSeconds: 60,
      maxCostUsdMicros: "10000",
    };
    await repo.createMandate(mandate);
    await new Scheduler(repo).create(
      scope,
      {
        cron: "* * * * *",
        timezone: "Europe/Berlin",
        enabled: true,
        goal: "Authorized routine fixture",
        kind: "research",
        leadEmployeeId: setup.employees[0]!.id,
        budgetLimitUsdMicros: "1000",
        mandateId: mandate.id,
        maxActiveOrders: 1,
      },
      new Date(Date.now() - 120000),
    );
    let runtime: Runtime | undefined = undefined,
      calls = 0,
      catalogCalls = 0;
    const catalog = async () => {
      catalogCalls++;
      return { models: [model], observedAt: new Date().toISOString() };
    };
    const background = new BackgroundCoordinator(repo, () => runtime, catalog);
    await background.tick();
    expect(calls).toBe(0);
    const orders = await repo.listOrders(scope);
    expect(orders).toHaveLength(1);
    expect((await repo.getDocument<{ reason: string }>(scope, "schedule-status", orders[0]!.id))?.data.reason).toBe(
      "model_not_configured",
    );
    runtime = new Runtime({
      repo,
      directory,
      models: [model],
      client: {
        async complete() {
          calls++;
          return {
            id: "fixture-generation",
            costUsdMicros: "0",
            message: { role: "assistant", content: "Routine evidence requires review." },
          };
        },
      },
    });
    await background.tick();
    expect(calls).toBe(1);
    expect(catalogCalls).toBe(1);
    expect((await repo.getOrder(scope, orders[0]!.id)).planVersion).toBe(1);
    expect((await repo.getOrder(scope, orders[0]!.id)).status).toBe("reviewing");
    await repo.close();
    repo = await Repository.open(path.join(directory, "db.sqlite"));
    await new BackgroundCoordinator(repo, () => runtime, catalog).tick();
    expect(calls).toBe(1);
    expect(await repo.listOrders(scope)).toHaveLength(1);
    await repo.putDocument(scope, "recovery-state", scope.companyId, { dispatchPaused: true, schedulesPaused: true });
    await new BackgroundCoordinator(repo, () => runtime, catalog).tick();
    expect(catalogCalls).toBe(2);
    expect(calls).toBe(1);
  } finally {
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("schedules due source observations with stable check IDs, including private areas, and respects recovery pause", async () => {
  const repo = await Repository.open(":memory:");
  try {
    const setup = await repo.setup({
      companyName: "Fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "0",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[1]!.id };
    const id = randomUUID();
    const nextCheckAt = new Date(Date.now() - 1000).toISOString();
    await repo.putDocument(scope, "research-watch", id, { id, scope, enabled: true, nextCheckAt });
    const ids: string[] = [];
    const bg = new BackgroundCoordinator(
      repo,
      () => undefined,
      async () => ({ models: [], observedAt: new Date().toISOString() }),
      undefined,
      async (watch, checkId) => {
        expect(watch.scope.areaId).toBe(scope.areaId);
        ids.push(checkId);
      },
    );
    await bg.tick();
    await bg.tick();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    await repo.putDocument(
      { companyId: scope.companyId, areaId: setup.areas[0]!.id },
      "recovery-state",
      scope.companyId,
      { dispatchPaused: true, schedulesPaused: true },
    );
    await bg.tick();
    expect(ids).toHaveLength(2);
  } finally {
    await repo.close();
  }
});
