import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { prepareRecovery } from "../../packages/operations/src/recovery.ts";
import { UpdateScheduler } from "../../apps/control/update-scheduler.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
let directory: string, source: Repository, restored: Repository | undefined, scope: Scope, ceoId: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-restore-authority-"));
  source = await Repository.open(path.join(directory, "source.sqlite"));
  const setup = await source.setup({
    companyName: "Recovery authority fixture",
    ceoName: "Fixture CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  ceoId = setup.ceo.id;
});
afterEach(async () => {
  await source.close();
  await restored?.close();
  restored = undefined;
  await rm(directory, { recursive: true, force: true });
});
async function restore() {
  const target = path.join(directory, "different-data-directory");
  await mkdir(target);
  const database = path.join(target, "company.sqlite");
  await source.backup(database);
  const report = await prepareRecovery(database);
  restored = await Repository.open(database);
  return report;
}
it("fences restored in-flight remote jobs and preserves completed receipts across actual SQLite backup", async () => {
  const workerId = randomUUID(),
    orderId = randomUUID();
  await source.putDocument(scope, "worker", workerId, {
    id: workerId,
    generation: 7,
    credentialHash: "old-secret-hash",
    revoked: false,
    sequence: 3,
  });
  const cases = ["dispatched", "uploading", "completed", "failed", "effect_unknown"];
  const ids = new Map<string, string>();
  for (const state of cases) {
    const id = randomUUID();
    ids.set(state, id);
    await source.putDocument(scope, "remote-execution", id, {
      id,
      scope,
      orderId,
      workerId,
      generation: 7,
      state,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
    await source.putDocument(scope, "action", id, {
      id,
      scope,
      orderId,
      status: state === "uploading" ? "running" : state === "completed" ? "succeeded" : state,
    });
  }
  const report = await restore();
  expect(report.unknownRemoteExecutions).toBe(2);
  expect(report.unknownActions).toBe(2);
  for (const [state, id] of ids) {
    const row = await restored!.getDocument<Record<string, unknown>>(scope, "remote-execution", id);
    if (state === "dispatched" || state === "uploading") {
      expect(row?.data).toMatchObject({
        state: "effect_unknown",
        code: "recovery_generation_changed",
        recoveryGeneration: report.generation,
      });
      expect(row?.revision).toBe(2);
      expect((await restored!.getDocument<Record<string, unknown>>(scope, "action", id))?.data.status).toBe(
        "effect_unknown",
      );
    } else {
      expect(row?.data.state).toBe(state);
      expect(row?.revision).toBe(1);
    }
  }
  expect((await restored!.getDocument<Record<string, unknown>>(scope, "worker", workerId))?.data).toMatchObject({
    generation: 8,
    revoked: true,
  });
  await expect(restored!.assertDispatchAllowed(scope.companyId)).rejects.toMatchObject({
    code: "recovery_dispatch_paused",
  });
  expect(await restored!.verifyAudit(scope.companyId)).toBe(true);
  // The source installation is unaffected; only the staging copy is fenced.
  expect(
    (await source.getDocument<Record<string, unknown>>(scope, "remote-execution", ids.get("dispatched")!))?.data.state,
  ).toBe("dispatched");
});
it("requires fresh update approval after restore and never auto-replays queued jobs or deferred attempts", async () => {
  const now = new Date(),
    policyId = randomUUID(),
    approvedAt = new Date(now.getTime() - 1000).toISOString(),
    approvedId = randomUUID();
  await source.putDocument(scope, "update-policy", policyId, {
    id: policyId,
    fingerprint: "fixture-policy-binding",
    autoApplyApproved: true,
    window: { cron: "* * * * *", timezone: "UTC", durationMinutes: 1 },
  });
  await source.putDocument(scope, "update-plan", approvedId, {
    id: approvedId,
    state: "approved",
    policyId,
    policyFingerprint: "fixture-policy-binding",
    approvedBy: ceoId,
    approvedAt,
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const queuedId = randomUUID(),
    runningId = randomUUID();
  for (const [id, state] of [
    [queuedId, "queued"],
    [runningId, "running"],
  ]) {
    await source.putDocument(scope, "update-plan", id!, { id, state, policyId, approvedBy: ceoId, approvedAt });
    await source.putDocument(scope, "update-executor-job", id!, { id, state, planId: id, generation: null });
  }
  await source.putDocument(scope, "maintenance-update-active", scope.companyId, {
    state: "queued",
    jobId: queuedId,
    planId: queuedId,
  });
  for (const state of ["running", "deferred", "queued", "applied"])
    await source.putDocument(scope, "update-schedule-attempt", state, {
      planId: approvedId,
      state,
      bootId: randomUUID(),
      attemptedAt: approvedAt,
      retryNotBefore: now.toISOString(),
    });
  const report = await restore();
  expect(report.invalidatedUpdateApprovals).toBe(1);
  const proposed = await restored!.getDocument<Record<string, unknown>>(scope, "update-plan", approvedId);
  expect(proposed?.data).toMatchObject({
    state: "planned",
    errorCode: "recovery_approval_invalidated",
    recoveryGeneration: report.generation,
  });
  for (const field of ["approvedBy", "approvedAt", "expiresAt"])
    expect(Object.hasOwn(proposed!.data, field)).toBe(false);
  for (const id of [queuedId, runningId]) {
    expect((await restored!.getDocument<Record<string, unknown>>(scope, "update-plan", id))?.data).toMatchObject({
      state: "effect_unknown",
      errorCode: "recovery_generation_changed",
    });
    expect(
      (await restored!.getDocument<Record<string, unknown>>(scope, "update-executor-job", id))?.data,
    ).toMatchObject({ state: "effect_unknown", code: "recovery_generation_changed" });
  }
  expect(
    (await restored!.getDocument<Record<string, unknown>>(scope, "maintenance-update-active", scope.companyId))?.data
      .state,
  ).toBe("effect_unknown");
  for (const state of ["running", "deferred"])
    expect(
      (await restored!.getDocument<Record<string, unknown>>(scope, "update-schedule-attempt", state))?.data,
    ).toMatchObject({ state: "effect_unknown", code: "recovery_generation_changed" });
  for (const state of ["queued", "applied"])
    expect(
      (await restored!.getDocument<Record<string, unknown>>(scope, "update-schedule-attempt", state))?.data.state,
    ).toBe(state);
  // Even an explicit operational resume must not restore the old CEO update consent.
  const recovery = await restored!.getDocument<Record<string, unknown>>(scope, "recovery-state", scope.companyId);
  await restored!.putDocument(
    scope,
    "recovery-state",
    scope.companyId,
    { ...recovery!.data, dispatchPaused: false, schedulesPaused: false },
    { expectedRevision: recovery!.revision },
  );
  let executions = 0;
  const scheduler = new UpdateScheduler({
    repo: restored!,
    now: () => now,
    apply: async () => {
      executions++;
      return { state: "queued" };
    },
  });
  await scheduler.tick(scope);
  expect(executions).toBe(0);
  expect(await restored!.verifyAudit(scope.companyId)).toBe(true);
});
