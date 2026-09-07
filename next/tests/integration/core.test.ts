import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import type { Mandate, Scope, ToolAction } from "../../packages/contracts/src/index.ts";
let repo: Repository, dir: string, setup: SetupResult, scope: Scope;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ironcrew-core-"));
  repo = await Repository.open(join(dir, "company.sqlite"));
  setup = await repo.setup({
    companyName: "IronGeeks",
    ceoName: "Robert",
    passwordHash: "hash-fixture",
    timezone: "Europe/Berlin",
    budgetLimitUsdMicros: "100",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
});
afterEach(async () => {
  await repo.close();
  await rm(dir, { recursive: true, force: true });
});
const order = () => repo.createOrder(scope, { kind: "research", goal: "Prüfauftrag", budgetLimitUsdMicros: "100" });
describe("CORE-01/02/03 durable scoped repository", () => {
  it("sets up exactly one company, CEO and nine independent personas", async () => {
    expect(setup.employees).toHaveLength(9);
    expect(setup.employees.every((e) => e.permissionsFromPersona === false)).toBe(true);
    expect((await repo.health()).foreignKeys).toBe(true);
    expect((await repo.health()).journalMode).toBe("wal");
    await expect(
      repo.setup({
        companyName: "Duplicate",
        ceoName: "Second",
        passwordHash: "x",
        timezone: "UTC",
        budgetLimitUsdMicros: "100",
      }),
    ).rejects.toMatchObject({ code: "setup_already_complete" });
    expect(await repo.verifyAudit(scope.companyId)).toBe(true);
  });
  it("defaults inbox lead to Cersei and serializes competing lead CAS changes", async () => {
    const created = await order();
    expect(created.leadEmployeeId).toBe(setup.employees.find((e) => e.seedKey === "chief_of_staff")!.id);
    await expect(
      repo.createOrder(scope, { kind: "research", goal: "x", budgetLimitUsdMicros: "1", leadEmployeeId: "" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    const results = await Promise.allSettled([
      repo.changeLead(scope, created.id, 1, setup.employees[1]!.id),
      repo.changeLead(scope, created.id, 1, setup.employees[2]!.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await repo.getOrder(scope, created.id)).revision).toBe(2);
    expect((await repo.events(scope)).filter((e) => e.type === "order.lead_changed")).toHaveLength(1);
  });
  it("denies a second area every order and document read and mutation", async () => {
    const created = await order();
    const id = randomUUID();
    await repo.putDocument(scope, "message", id, { text: "Confidential" });
    const foreign = { ...scope, areaId: setup.areas[1]!.id };
    await expect(repo.getOrder(foreign, created.id)).rejects.toMatchObject({ code: "scope_denied" });
    await expect(repo.getDocument(foreign, "message", id)).rejects.toMatchObject({ code: "scope_denied" });
    await expect(
      repo.putDocument(foreign, "message", id, { text: "overwrite" }, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(await repo.listOrders(foreign)).toEqual([]);
  });
  it("rolls back all documents and audit/outbox events if one CAS fails", async () => {
    const a = randomUUID(),
      b = randomUUID();
    await repo.putDocument(scope, "run", a, { status: "prepared" });
    const before = await repo.events(scope);
    await expect(
      repo.transact(
        scope,
        [
          { kind: "run", id: b, data: {} },
          { kind: "run", id: a, data: {}, expectedRevision: 0 },
        ],
        { type: "run.updated", aggregateId: a },
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await repo.getDocument(scope, "run", b)).toBeNull();
    expect(await repo.events(scope)).toEqual(before);
    expect(await repo.verifyAudit(scope.companyId)).toBe(true);
  });
  it("requires plan and passed review/delivery before completion", async () => {
    const created = await order();
    await expect(repo.updateOrder(scope, created.id, 1, { status: "ready" })).rejects.toMatchObject({
      code: "plan_required",
    });
    let current = await repo.updateOrder(scope, created.id, 1, { status: "ready", planVersion: 1 });
    current = await repo.updateOrder(scope, current.id, current.revision, { status: "running" });
    current = await repo.updateOrder(scope, current.id, current.revision, { status: "reviewing" });
    await expect(repo.updateOrder(scope, current.id, current.revision, { status: "completed" })).rejects.toMatchObject({
      code: "completion_checks_required",
    });
    current = await repo.updateOrder(scope, current.id, current.revision, {
      status: "completed",
      requiredReviewsPassed: true,
      deliveryComplete: true,
    });
    expect(current.status).toBe("completed");
  });
});
describe("BUD-01/02 exact transactional money", () => {
  it("allows only covered reservations across ten concurrent calls and idempotent settlement", async () => {
    const created = await order();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        repo.reserve(scope, { id: randomUUID(), periodId: setup.periodId, orderId: created.id, amountUsdMicros: "30" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const held = (await repo.budget(scope.companyId)).reservations[0]!;
    await repo.settle(scope, held.id, "45");
    await repo.settle(scope, held.id, "45");
    const budget = await repo.budget(scope.companyId);
    expect(budget.spentUsdMicros).toBe("45");
    expect(budget.reservedUsdMicros).toBe("60");
    expect(budget.availableUsdMicros).toBe("0");
    expect(BigInt(budget.spentUsdMicros) + BigInt(budget.reservedUsdMicros) - BigInt(budget.limitUsdMicros)).toBe(5n);
    await expect(
      repo.reserve(scope, { id: randomUUID(), periodId: setup.periodId, orderId: created.id, amountUsdMicros: "1" }),
    ).rejects.toMatchObject({ code: "company_budget_exceeded" });
  });
  it("keeps unreconciled costs reserved and refuses silent release", async () => {
    const created = await order();
    const reservation = await repo.reserve(scope, {
      id: randomUUID(),
      periodId: setup.periodId,
      orderId: created.id,
      amountUsdMicros: "90",
    });
    await repo.markUnreconciled(scope, reservation.id);
    expect((await repo.budget(scope.companyId)).unreconciledUsdMicros).toBe("90");
    await expect(repo.releaseReservation(scope, reservation.id)).rejects.toMatchObject({
      code: "reservation_not_held",
    });
    await expect(repo.setBudget(scope.companyId, { limitUsdMicros: "50" })).rejects.toMatchObject({
      code: "budget_below_committed",
    });
  });
  it("preserves integers above JavaScript safe range", async () => {
    await repo.setBudget(scope.companyId, { limitUsdMicros: "9007199254740993" });
    const created = await repo.createOrder(scope, {
      kind: "research",
      goal: "Exact",
      budgetLimitUsdMicros: "9007199254740993",
    });
    await repo.reserve(scope, {
      id: randomUUID(),
      periodId: setup.periodId,
      orderId: created.id,
      amountUsdMicros: "9007199254740993",
    });
    expect((await repo.budget(scope.companyId)).reservedUsdMicros).toBe("9007199254740993");
  });
});
describe("RUN-03 version and argument bound approvals", () => {
  it("invalidates changed args, targets, artifact versions and revoked mandates", async () => {
    const created = await order(),
      targetId = randomUUID(),
      artifactVersionId = randomUUID();
    const mandate: Mandate = {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["mail.send"],
      targetIds: [targetId],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxAttempts: 1,
      maxDurationSeconds: 30,
      maxCostUsdMicros: "10",
    };
    await repo.createMandate(mandate);
    const args = { body: "Approved text" };
    const action: ToolAction = {
      id: randomUUID(),
      runId: randomUUID(),
      orderId: created.id,
      scope,
      toolId: "mail.send",
      toolVersion: 1,
      args,
      argumentsSha256: sha256(args),
      status: "proposed",
      mandateId: mandate.id,
      mandateVersion: 1,
      evidenceRefs: [],
    };
    await repo.putDocument(scope, "action", action.id, action);
    const approval = await repo.approve(scope, {
      companyId: scope.companyId,
      orderId: created.id,
      mandateId: mandate.id,
      mandateVersion: 1,
      actionId: action.id,
      targetId,
      artifactVersionId,
      argumentsSha256: action.argumentsSha256,
      expiresAt: mandate.expiresAt,
    });
    action.approvalId = approval.id;
    await repo.assertAuthorized(scope, { action, targetId, artifactVersionId });
    const changed = {
      ...action,
      args: { body: "Different text" },
      argumentsSha256: sha256({ body: "Different text" }),
    };
    await expect(repo.assertAuthorized(scope, { action: changed, targetId, artifactVersionId })).rejects.toMatchObject({
      code: "approval_binding_mismatch",
    });
    await expect(
      repo.assertAuthorized(scope, { action, targetId, artifactVersionId: randomUUID() }),
    ).rejects.toMatchObject({ code: "approval_binding_mismatch" });
    await repo.revokeMandate(scope, mandate.id, 1);
    await expect(repo.assertAuthorized(scope, { action, targetId, artifactVersionId })).rejects.toMatchObject({
      code: "mandate_revoked",
    });
  });
});

it("permits only the exact CEO-approved sevdesk reminder routine and recipient", async () => {
  const created = await order(),
    targetId = randomUUID(),
    ruleId = randomUUID();
  const mandate: Mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["sevdesk.reminder.send", "customer.send"],
    targetIds: [targetId],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 1,
    maxDurationSeconds: 30,
    maxCostUsdMicros: "10",
  };
  await repo.createMandate(mandate);
  await repo.putDocument(scope, "reminder-rule", `${ruleId}:3`, {
    version: 3,
    approvedByCeo: true,
    enabled: true,
    feesMinor: "0",
    targetIds: [targetId],
    invoiceIds: ["invoice-1"],
    recipients: ["invoice@example.invalid"],
  });
  const args = { ruleId, ruleVersion: 3, invoiceId: "invoice-1", to: "invoice@example.invalid" };
  const action: ToolAction = {
    id: randomUUID(),
    runId: randomUUID(),
    orderId: created.id,
    scope,
    toolId: "sevdesk.reminder.send",
    toolVersion: 1,
    args,
    argumentsSha256: sha256(args),
    status: "proposed",
    mandateId: mandate.id,
    mandateVersion: 1,
    evidenceRefs: [],
  };
  const input = { action, targetId, effect: "external_send" as const, routineRuleId: ruleId, routineRuleVersion: 3 };
  await repo.assertAuthorized(scope, input);
  await expect(repo.assertAuthorized(scope, { ...input, routineRuleVersion: 2 })).rejects.toMatchObject({
    code: "reminder_rule_denied",
  });
  const wrongArgs = { ...args, to: "other@example.invalid" };
  await expect(
    repo.assertAuthorized(scope, {
      ...input,
      action: { ...action, args: wrongArgs, argumentsSha256: sha256(wrongArgs) },
    }),
  ).rejects.toMatchObject({ code: "reminder_rule_denied" });
  await expect(
    repo.assertAuthorized(scope, { ...input, action: { ...action, toolId: "customer.send" } }),
  ).rejects.toMatchObject({ code: "approval_required" });
});
it("enforces company-wide recovery pause on private-scope execution and reservations", async () => {
  const privateScope = { ...scope, areaId: setup.areas[1]!.id };
  const created = await repo.createOrder(privateScope, {
    kind: "research",
    goal: "Private task",
    budgetLimitUsdMicros: "100",
  });
  await repo.putDocument(scope, "recovery-state", scope.companyId, { dispatchPaused: true });
  await expect(
    repo.reserveAndTransact(
      privateScope,
      { id: randomUUID(), periodId: setup.periodId, orderId: created.id, amountUsdMicros: "10" },
      [{ kind: "model-turn", id: randomUUID(), data: {} }],
      { type: "model.prepared", aggregateId: created.id },
    ),
  ).rejects.toMatchObject({ code: "recovery_dispatch_paused" });
  expect((await repo.budget(scope.companyId)).reservations).toHaveLength(0);
});
it("preserves immutable artifact seals even if the caller omits the immutable option on update", async () => {
  const id = randomUUID();
  await repo.putDocument(scope, "artifact", id, { sha256: "fixture-version" }, { immutable: true });
  await expect(
    repo.putDocument(scope, "artifact", id, { sha256: "mutated" }, { expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "immutable_document" });
});
