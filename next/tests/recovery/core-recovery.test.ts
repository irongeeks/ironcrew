import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";

it("RUN-02/03 persists prepared model context, tool intent, approval waits and unreconciled usage across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ironcrew-recovery-")),
    path = join(dir, "company.sqlite");
  let repo = await Repository.open(path);
  try {
    const setup = await repo.setup({
        companyName: "Recovery",
        ceoName: "Robert",
        passwordHash: "fixture",
        timezone: "Europe/Berlin",
        budgetLimitUsdMicros: "1000",
      }),
      scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
    const order = await repo.createOrder(scope, {
      kind: "website",
      goal: "Create a file",
      budgetLimitUsdMicros: "1000",
    });
    const runId = randomUUID(),
      turnId = randomUUID(),
      actionId = randomUUID();
    const messages = [
      { role: "user", content: "Create a file" },
      {
        role: "assistant",
        tool_calls: [
          { id: actionId, type: "function", function: { name: "workspace.write", arguments: '{"path":"index.html"}' } },
        ],
      },
    ];
    await repo.transact(
      scope,
      [
        { kind: "run", id: runId, data: { orderId: order.id, state: "waiting_approval" } },
        { kind: "model_turn", id: turnId, data: { runId, state: "complete", messages } },
        {
          kind: "action",
          id: actionId,
          data: { runId, orderId: order.id, status: "proposed", argumentsSha256: "test-intent" },
        },
      ],
      { type: "run.waiting_approval", aggregateId: runId },
    );
    const held = await repo.reserve(scope, {
      id: randomUUID(),
      orderId: order.id,
      periodId: setup.periodId,
      amountUsdMicros: "200",
      modelTurnId: turnId,
    });
    await repo.markUnreconciled(scope, held.id);
    const events = await repo.events(scope);
    await repo.close();
    repo = await Repository.open(path);
    expect((await repo.getDocument<{ state: string }>(scope, "run", runId))?.data.state).toBe("waiting_approval");
    expect((await repo.getDocument<{ messages: unknown }>(scope, "model_turn", turnId))?.data.messages).toEqual(
      messages,
    );
    expect((await repo.budget(scope.companyId)).unreconciledUsdMicros).toBe("200");
    expect(await repo.events(scope)).toEqual(events);
    expect(await repo.verifyAudit(scope.companyId)).toBe(true);
    expect((await repo.pendingOutbox(scope.companyId)).length).toBe(events.length);
    const backup = join(dir, "snapshot.sqlite");
    await repo.backup(backup);
    const restored = await Repository.open(backup);
    try {
      expect((await restored.getDocument(scope, "action", actionId))?.revision).toBe(1);
      expect(await restored.verifyAudit(scope.companyId)).toBe(true);
    } finally {
      await restored.close();
    }
  } finally {
    await repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
