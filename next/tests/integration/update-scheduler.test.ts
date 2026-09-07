import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { UpdateScheduler } from "../../apps/control/update-scheduler.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
let directory: string, repo: Repository, scope: Scope, ceoId: string, now: Date;
const approvedAt = "2026-09-07T11:00:00.000Z";
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "update-scheduler-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Scheduler fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas.find((a) => a.visibility === "company")!.id };
  ceoId = setup.ceo.id;
  now = new Date("2026-09-07T12:05:00.000Z");
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
async function put(kind: string, id: string, data: unknown) {
  const prior = await repo.getDocument(scope, kind, id);
  return repo.putDocument(scope, kind, id, data, { expectedRevision: prior?.revision ?? 0 });
}
async function seed(plan = {}, policy = {}) {
  await put("update-policy", "policy", {
    fingerprint: "exact-policy",
    autoApplyApproved: true,
    window: { cron: "0 12 * * *", timezone: "UTC", durationMinutes: 15 },
    ...policy,
  });
  await put("update-plan", "plan", {
    id: "plan",
    state: "approved",
    policyId: "policy",
    policyFingerprint: "exact-policy",
    approvedBy: ceoId,
    approvedAt,
    expiresAt: "2026-09-08T11:00:00.000Z",
    ...plan,
  });
}
it("queues an explicit approval once inside its opted-in window, including concurrent ticks", async () => {
  await seed();
  let calls = 0;
  const scheduler = new UpdateScheduler({
    repo,
    now: () => now,
    apply: async (selected, ceo, id) => {
      calls++;
      expect(selected).toEqual(scope);
      expect(ceo).toBe(ceoId);
      expect(id).toBe("plan");
      return { state: "queued" };
    },
  });
  await Promise.all([scheduler.tick(scope), scheduler.tick(scope)]);
  await new UpdateScheduler({
    repo,
    now: () => now,
    apply: async () => {
      throw new Error("must not replay");
    },
  }).tick(scope);
  expect(calls).toBe(1);
  expect((await repo.listDocuments(scope, "update-schedule-attempt"))[0]?.data).toMatchObject({ state: "queued" });
});
it("never grants approval or ignores expiry, scope, policy binding, revocation or maintenance windows", async () => {
  let calls = 0;
  const scheduler = new UpdateScheduler({
    repo,
    now: () => now,
    apply: async () => {
      calls++;
      return { state: "queued" };
    },
  });
  for (const patch of [
    { state: "planned" },
    { approvedBy: "someone-else" },
    { expiresAt: now.toISOString() },
    { expiresAt: "invalid" },
    { policyFingerprint: "changed" },
  ]) {
    await seed(patch);
    await scheduler.tick(scope);
  }
  await seed({}, { autoApplyApproved: false });
  await scheduler.tick(scope);
  await seed();
  now = new Date("2026-09-07T12:15:00.000Z");
  await scheduler.tick(scope);
  now = new Date("2026-09-07T12:05:00.000Z");
  await scheduler.tick({ ...scope, projectId: "foreign" });
  await repo.putDocument(scope, "update-policy-revocation", "policy", { revokedAt: now.toISOString() });
  await scheduler.tick(scope);
  expect(calls).toBe(0);
  expect(await repo.listDocuments(scope, "update-schedule-attempt")).toHaveLength(0);
});
it("retries only a known pre-effect unavailability after the delay and within the same approval", async () => {
  await seed();
  let calls = 0;
  const scheduler = new UpdateScheduler({
    repo,
    now: () => now,
    apply: async () => {
      if (++calls === 1) throw new DomainError("updater_unavailable", "offline", 503);
      return { state: "queued" };
    },
  });
  await scheduler.tick(scope);
  await scheduler.tick(scope);
  expect(calls).toBe(1);
  now = new Date(now.getTime() + 30_000);
  await scheduler.tick(scope);
  expect(calls).toBe(2);
  expect((await repo.listDocuments(scope, "update-schedule-attempt"))[0]?.data).toMatchObject({ state: "queued" });
});
it("does not replay an unknown effect or an interrupted scheduler attempt", async () => {
  await seed();
  let calls = 0;
  const scheduler = new UpdateScheduler({
    repo,
    now: () => now,
    apply: async () => {
      calls++;
      throw new Error("connection lost after effect");
    },
  });
  await scheduler.tick(scope);
  await scheduler.tick(scope);
  expect(calls).toBe(1);
  const id = "plan:" + approvedAt;
  await put("update-schedule-attempt", id, {
    planId: "plan",
    state: "running",
    bootId: "old-process",
    attemptedAt: now.toISOString(),
  });
  await new UpdateScheduler({
    repo,
    now: () => now,
    apply: async () => {
      calls++;
      return { state: "queued" };
    },
  }).tick(scope);
  expect(calls).toBe(1);
  expect((await repo.getDocument(scope, "update-schedule-attempt", id))?.data).toMatchObject({
    state: "effect_unknown",
    code: "scheduler_restart_unknown",
  });
});
