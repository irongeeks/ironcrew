import { it, expect } from "vitest";
import { Repository } from "../../packages/persistence/src/index.ts";
import { randomUUID } from "node:crypto";
it("renews only an explicitly recurring period, archives spending and carries unknown reservations", async () => {
  const repo = await Repository.open(":memory:");
  try {
    const setup = await repo.setup({
      companyName: "Fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "Europe/Berlin",
      budgetLimitUsdMicros: "1000",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const order = await repo.createOrder(scope, {
      kind: "research",
      goal: "Period fixture",
      budgetLimitUsdMicros: "10000",
    });
    await repo
      .reserve(scope, { id: randomUUID(), periodId: setup.periodId, orderId: order.id, amountUsdMicros: "400" })
      .then((r) => repo.settle(scope, r.id, "300"));
    const held = await repo.reserve(scope, {
      id: randomUUID(),
      periodId: setup.periodId,
      orderId: order.id,
      amountUsdMicros: "200",
    });
    await repo.markUnreconciled(scope, held.id);
    const t = Date.now();
    const budget = await repo.setBudget(scope.companyId, {
      limitUsdMicros: "1000",
      startsAt: new Date(t - 200000).toISOString(),
      endsAt: new Date(t - 100000).toISOString(),
      renewal: "fixed_duration",
    });
    expect(budget.periodId).not.toBe(setup.periodId);
    expect(budget.spentUsdMicros).toBe("0");
    expect(budget.reservedUsdMicros).toBe("200");
    expect(budget.unreconciledUsdMicros).toBe("200");
    expect(budget.availableUsdMicros).toBe("800");
    expect(budget.periodActive).toBe(true);
    const archive = await repo.getDocument<{ spentUsdMicros: string }>(scope, "budget-period", setup.periodId);
    expect(archive?.data.spentUsdMicros).toBe("300");
    await expect(
      repo.reserve(scope, { id: randomUUID(), periodId: budget.periodId, orderId: order.id, amountUsdMicros: "801" }),
    ).rejects.toThrow("company_budget_exceeded");
    await repo.settle(scope, held.id, "250");
    expect((await repo.budget(scope.companyId)).unreconciledUsdMicros).toBe("0");
    const second = await repo.setBudget(scope.companyId, {
      limitUsdMicros: "1000",
      startsAt: new Date(t - 200000).toISOString(),
      endsAt: new Date(t - 100000).toISOString(),
      renewal: "fixed_duration",
    });
    expect(second.periodId).not.toBe(budget.periodId);
    expect(await repo.listDocuments(scope, "budget-period")).toHaveLength(2);
    expect(await repo.verifyAudit(scope.companyId)).toBe(true);
  } finally {
    await repo.close();
  }
});
it("expired or future one-off periods forbid dispatch and never silently grant fresh spending", async () => {
  const repo = await Repository.open(":memory:");
  try {
    const setup = await repo.setup({
      companyName: "Fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "Europe/Berlin",
      budgetLimitUsdMicros: "1000",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const order = await repo.createOrder(scope, {
      kind: "research",
      goal: "Expired period",
      budgetLimitUsdMicros: "1000",
    });
    const t = Date.now();
    for (const offset of [-200000, 100000]) {
      const b = await repo.setBudget(scope.companyId, {
        limitUsdMicros: "1000",
        startsAt: new Date(t + offset).toISOString(),
        endsAt: new Date(t + offset + 100000).toISOString(),
        renewal: "none",
      });
      expect(b.periodId).toBe(setup.periodId);
      expect(b.periodActive).toBe(false);
      expect(b.availableUsdMicros).toBe("0");
      await expect(
        repo.reserve(scope, { id: randomUUID(), periodId: b.periodId, orderId: order.id, amountUsdMicros: "1" }),
      ).rejects.toThrow("budget_period_inactive");
    }
  } finally {
    await repo.close();
  }
});
it("enforces a shared mandate ceiling atomically across parallel runs and settlements", async () => {
  const repo = await Repository.open(":memory:");
  try {
    const setup = await repo.setup({
      companyName: "Fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "10000",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const orders = await Promise.all(
      [1, 2].map((i) =>
        repo.createOrder(scope, { kind: "research", goal: "Parallel " + i, budgetLimitUsdMicros: "10000" }),
      ),
    );
    const mandate = {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["workspace.read"],
      targetIds: orders.map((o) => o.id),
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxAttempts: 3,
      maxDurationSeconds: 60,
      maxCostUsdMicros: "1000",
    };
    await repo.createMandate(mandate);
    const results = await Promise.allSettled(
      orders.map((o) =>
        repo.reserve(scope, {
          id: randomUUID(),
          periodId: setup.periodId,
          orderId: o.id,
          amountUsdMicros: "600",
          mandateId: mandate.id,
          mandateVersion: 1,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const held = (await repo.budget(scope.companyId)).reservations[0]!;
    await repo.settle(scope, held.id, "500");
    await expect(
      repo.reserve(scope, {
        id: randomUUID(),
        periodId: setup.periodId,
        orderId: orders[1]!.id,
        amountUsdMicros: "501",
        mandateId: mandate.id,
        mandateVersion: 1,
      }),
    ).rejects.toThrow("mandate_budget_exceeded");
    await repo.revokeMandate(scope, mandate.id, 1);
    await expect(
      repo.reserve(scope, {
        id: randomUUID(),
        periodId: setup.periodId,
        orderId: orders[1]!.id,
        amountUsdMicros: "1",
        mandateId: mandate.id,
        mandateVersion: 1,
      }),
    ).rejects.toThrow("mandate_unavailable");
  } finally {
    await repo.close();
  }
});
it("keeps actual settlement overruns truthful while available remains nonnegative and further reservations fail", async () => {
  const repo = await Repository.open(":memory:");
  try {
    const setup = await repo.setup({
      companyName: "Fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "1000",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const order = await repo.createOrder(scope, {
      kind: "research",
      goal: "Actual cost exceeds estimate",
      budgetLimitUsdMicros: "10000",
    });
    const held = await repo.reserve(scope, {
      id: randomUUID(),
      periodId: setup.periodId,
      orderId: order.id,
      amountUsdMicros: "900",
    });
    await repo.settle(scope, held.id, "1200");
    const budget = await repo.budget(scope.companyId);
    expect(budget.spentUsdMicros).toBe("1200");
    expect(budget.availableUsdMicros).toBe("0");
    await expect(
      repo.reserve(scope, { id: randomUUID(), periodId: setup.periodId, orderId: order.id, amountUsdMicros: "1" }),
    ).rejects.toThrow("company_budget_exceeded");
    await repo.setBudget(scope.companyId, { limitUsdMicros: "1500" });
    expect((await repo.budget(scope.companyId)).availableUsdMicros).toBe("300");
    expect(await repo.verifyAudit(scope.companyId)).toBe(true);
  } finally {
    await repo.close();
  }
});
