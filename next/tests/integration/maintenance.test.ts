import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { MaintenanceService } from "../../apps/control/maintenance-service.ts";
import { createBackup, hashFile, type ReleaseManifest } from "../../packages/operations/src/index.ts";
const age = process.env.IRONCREW_TEST_AGE ?? "/tmp/ironcrew-age-1.3.2/age/age";
const keygen = process.env.IRONCREW_TEST_AGE_KEYGEN ?? path.join(path.dirname(age), "age-keygen");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "ironcrew-maintenance-"))),
    directory = path.join(parent, "data");
  await mkdir(path.join(directory, "blobs"), { recursive: true });
  await writeFile(path.join(directory, "blobs", "fixture"), "real immutable artifact");
  const repo = await Repository.open(path.join(directory, "company.sqlite"));
  cleanup.push(async () => {
    await repo.close();
    await rm(parent, { recursive: true, force: true });
  });
  const setup = await repo.setup({
    companyName: "Maintenance fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas.find((area) => area.visibility === "company")!.id };
  const identity = path.join(parent, "identity.txt");
  await promisify(execFile)(keygen, ["--output", identity]);
  const recipient = (await readFile(identity, "utf8")).match(/# public key: (age1\S+)/)![1];
  let now = new Date("2026-09-07T00:00:00Z"),
    calls = 0,
    health = true,
    stopped = 0,
    restarted = 0;
  const options = {
    repo,
    directory,
    currentVersion: "0.4.0",
    now: () => now,
    onlineBackup: async (input: { ageExecutable: string; recipient: string; outputDirectory: string }) => {
      calls++;
      return createBackup({
        databasePath: path.join(directory, "company.sqlite"),
        blobDirectory: path.join(directory, "blobs"),
        ...input,
        appVersion: "0.4.0",
        configuration: {},
        quiesce: async () => async () => {},
        snapshotDatabase: (destination) => repo.backup(destination),
      });
    },
    platform: "darwin",
    arch: "arm64",
    releaseLifecycle: {
      beforeActivate: async () => {
        stopped++;
      },
      healthCheck: async (directory: string) => {
        expect(await readFile(path.join(directory, "dist/apps/control/main.js"), "utf8")).toContain("fixture release");
        return health;
      },
      restartPrevious: async () => {
        restarted++;
      },
    },
  };
  const service = new MaintenanceService(options);
  const input = {
    name: "Daily encrypted backup",
    cron: "0 2 * * *",
    timezone: "UTC",
    ageExecutable: age,
    recipient,
    destination: path.join(parent, "backups"),
  };
  return {
    parent,
    directory,
    repo,
    setup,
    scope,
    identity,
    service,
    options,
    input,
    setNow: (value: string) => {
      now = new Date(value);
    },
    getCalls: () => calls,
    setHealth: (value: boolean) => {
      health = value;
    },
    lifecycle: () => ({ stopped, restarted }),
  };
}
async function active(
  f: Awaited<ReturnType<typeof fixture>>,
  retention?: { enabled: boolean; daily: number; weekly: number },
) {
  const policy = await f.service.proposeBackupPolicy(f.scope, f.setup.ceo.id, {
    ...f.input,
    ...(retention ? { retention } : {}),
  });
  await f.service.probeBackupPolicy(f.scope, f.setup.ceo.id, policy.id, { identityPath: f.identity });
  await f.service.activateBackupPolicy(f.scope, f.setup.ceo.id, policy.id);
  return policy;
}
async function release(f: Awaited<ReturnType<typeof fixture>>, version = "0.4.1") {
  const directory = path.join(f.parent, "release-" + randomUUID());
  await mkdir(path.join(directory, "runtime"), { recursive: true });
  await mkdir(path.join(directory, "dist/apps/control"), { recursive: true });
  await writeFile(path.join(directory, "runtime/node"), "pinned runtime fixture");
  await writeFile(path.join(directory, "dist/apps/control/main.js"), "fixture release " + version);
  const manifest: ReleaseManifest = {
    format: "ironcrew-release",
    version,
    schemaVersion: 1,
    protocolVersion: 1,
    nodeVersion: "26.4.0",
    platform: "darwin",
    arch: "arm64",
    files: [],
  };
  for (const file of ["runtime/node", "dist/apps/control/main.js"]) {
    const bytes = await readFile(path.join(directory, file));
    manifest.files.push({
      path: file,
      bytes: bytes.length,
      sha256: await hashFile(path.join(directory, file)),
      executable: file === "runtime/node",
    });
  }
  const keys = generateKeyPairSync("ed25519"),
    pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(directory, "release-manifest.json"), bytes);
  await writeFile(path.join(directory, "release-manifest.sig"), sign(null, bytes, keys.privateKey));
  return { directory, pem, manifest };
}
describe.skipIf(!existsSync(age) || !existsSync(keygen))("durable maintenance with real age and restore probes", () => {
  it("proposes disabled defaults, enforces CEO and requires an actual matching restore before activation", async () => {
    const f = await fixture();
    await expect(f.service.proposeBackupPolicy(f.scope, randomUUID(), f.input)).rejects.toMatchObject({
      code: "maintenance_ceo_required",
    });
    await expect(
      f.service.proposeBackupPolicy(f.scope, f.setup.ceo.id, { ...f.input, timezone: "Invalid/Zone" }),
    ).rejects.toThrow();
    const policy = await f.service.proposeBackupPolicy(f.scope, f.setup.ceo.id, f.input);
    expect(policy.enabled).toBe(false);
    expect(policy.retention).toEqual({ enabled: false, daily: 7, weekly: 4 });
    await f.service.tick(f.scope);
    expect(f.getCalls()).toBe(0);
    await expect(f.service.activateBackupPolicy(f.scope, f.setup.ceo.id, policy.id)).rejects.toMatchObject({
      code: "restore_probe_required",
    });
    const proof = await f.service.probeBackupPolicy(f.scope, f.setup.ceo.id, policy.id, { identityPath: f.identity });
    expect(proof.state).toBe("passed");
    expect(proof.companyId).toBe(f.scope.companyId);
    expect(JSON.stringify(await f.service.list(f.scope, f.setup.ceo.id))).not.toContain(f.identity);
    expect((await f.service.activateBackupPolicy(f.scope, f.setup.ceo.id, policy.id)).enabled).toBe(true);
    expect(f.getCalls()).toBe(1);
  });
  it("catches up once across concurrent coordinators, persists runs and protects pinned proof, tampered and foreign files from retention", async () => {
    const f = await fixture(),
      policy = await active(f, { enabled: true, daily: 1, weekly: 0 });
    f.setNow("2026-09-08T03:00:00Z");
    await Promise.all([f.service.tick(f.scope), new MaintenanceService(f.options).tick(f.scope)]);
    expect(f.getCalls()).toBe(2);
    const before = await f.service.list(f.scope, f.setup.ceo.id),
      older = before.backups.find((item) => item.id !== before.probes[0].archiveId)!;
    await writeFile(older.archivePath, "tampered own name");
    const foreign = path.join(f.input.destination, "ironcrew-foreign.tar.age");
    await writeFile(foreign, "foreign bytes");
    f.setNow("2026-09-20T03:00:00Z");
    await f.service.tick(f.scope);
    expect(f.getCalls()).toBe(3);
    await f.service.tick(f.scope);
    expect(f.getCalls()).toBe(3);
    expect(await readFile(older.archivePath, "utf8")).toBe("tampered own name");
    expect(await readFile(foreign, "utf8")).toBe("foreign bytes");
    expect(await f.repo.listDocuments(f.scope, "retention-issue")).toHaveLength(1);
    const own = (await f.service.list(f.scope, f.setup.ceo.id)).backups.find(
      (item) => item.id !== older.id && item.id !== before.probes[0].archiveId,
    )!;
    f.setNow("2026-09-21T03:00:00Z");
    await f.service.tick(f.scope);
    await expect(access(own.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.service.pauseBackupPolicy(f.scope, f.setup.ceo.id, policy.id);
    f.setNow("2026-09-22T03:00:00Z");
    await f.service.tick(f.scope);
    expect(f.getCalls()).toBe(4);
  });
  it("rejects the wrong restore identity, stale probe and repaired-archive mismatch without silently activating", async () => {
    const f = await fixture(),
      policy = await f.service.proposeBackupPolicy(f.scope, f.setup.ceo.id, f.input),
      wrong = path.join(f.parent, "wrong.txt");
    await promisify(execFile)(keygen, ["--output", wrong]);
    await expect(
      f.service.probeBackupPolicy(f.scope, f.setup.ceo.id, policy.id, { identityPath: wrong }),
    ).rejects.toThrow();
    expect((await f.service.list(f.scope, f.setup.ceo.id)).probes).toHaveLength(0);
    await f.service.probeBackupPolicy(f.scope, f.setup.ceo.id, policy.id, { identityPath: f.identity });
    f.setNow("2026-11-01T00:00:00Z");
    await expect(f.service.activateBackupPolicy(f.scope, f.setup.ceo.id, policy.id)).rejects.toMatchObject({
      code: "restore_probe_required",
    });
    f.setNow("2026-09-07T00:00:00Z");
    const view = await f.service.list(f.scope, f.setup.ceo.id);
    await writeFile(view.backups.find((b) => b.id === view.probes[0].archiveId)!.archivePath, "changed");
    await expect(f.service.activateBackupPolicy(f.scope, f.setup.ceo.id, policy.id)).rejects.toMatchObject({
      code: "archive_hash",
    });
  });
  it("marks interrupted maintenance unknown on restart and never blindly repeats the prior operation", async () => {
    const f = await fixture();
    await f.repo.putDocument(f.scope, "maintenance-job", "old-job", { state: "running", bootId: "prior-process" });
    await f.repo.putDocument(f.scope, "update-plan", "old-update", { state: "running", bootId: "prior-process" });
    await f.service.tick(f.scope);
    expect((await f.repo.getDocument(f.scope, "maintenance-job", "old-job"))!.data).toMatchObject({
      state: "effect_unknown",
    });
    expect((await f.repo.getDocument(f.scope, "update-plan", "old-update"))!.data).toMatchObject({
      state: "effect_unknown",
    });
    expect(f.getCalls()).toBe(0);
  });
  it("binds signed update plans to classes and windows, snapshots before activation and blocks outdated plans", async () => {
    const f = await fixture(),
      backup = await active(f),
      r = await release(f),
      install = path.join(f.parent, "install");
    await mkdir(install);
    await writeFile(path.join(install, "old.txt"), "old release");
    const policy = (await f.service.proposeUpdatePolicy(f.scope, f.setup.ceo.id, {
      name: "Patch window",
      trustedPublicKeyPem: r.pem,
      installDirectory: install,
      backupPolicyId: backup.id,
      allowedClasses: ["patch"],
      window: { cron: "0 2 * * *", timezone: "UTC", durationMinutes: 30 },
    })) as { id: string };
    const plan = await f.service.proposeUpdate(f.scope, f.setup.ceo.id, policy.id, r.directory),
      oldPlan = await f.service.proposeUpdate(f.scope, f.setup.ceo.id, policy.id, r.directory);
    await f.service.approveUpdate(f.scope, f.setup.ceo.id, plan.id);
    await f.service.approveUpdate(f.scope, f.setup.ceo.id, oldPlan.id);
    await expect(f.service.applyUpdate(f.scope, f.setup.ceo.id, plan.id)).rejects.toMatchObject({
      code: "maintenance_window_closed",
    });
    expect(f.getCalls()).toBe(1);
    f.setNow("2026-09-07T02:00:00Z");
    expect((await f.service.applyUpdate(f.scope, f.setup.ceo.id, plan.id)).state).toBe("applied");
    expect(f.getCalls()).toBe(2);
    expect(f.lifecycle()).toEqual({ stopped: 1, restarted: 0 });
    await expect(f.service.applyUpdate(f.scope, f.setup.ceo.id, oldPlan.id)).rejects.toMatchObject({
      code: "update_base_changed",
    });
  });
  it("performs real release rollback on failed health and leaves the plan effect unknown", async () => {
    const f = await fixture(),
      backup = await active(f),
      r = await release(f),
      install = path.join(f.parent, "install");
    await mkdir(install);
    await writeFile(path.join(install, "old.txt"), "old release");
    const policy = (await f.service.proposeUpdatePolicy(f.scope, f.setup.ceo.id, {
      name: "Patch",
      trustedPublicKeyPem: r.pem,
      installDirectory: install,
      backupPolicyId: backup.id,
      window: { cron: "0 2 * * *", timezone: "UTC", durationMinutes: 30 },
    })) as { id: string };
    const plan = await f.service.proposeUpdate(f.scope, f.setup.ceo.id, policy.id, r.directory);
    await f.service.approveUpdate(f.scope, f.setup.ceo.id, plan.id);
    f.setNow("2026-09-07T02:00:00Z");
    f.setHealth(false);
    await expect(f.service.applyUpdate(f.scope, f.setup.ceo.id, plan.id)).rejects.toMatchObject({
      code: "release_health",
    });
    expect(await readFile(path.join(install, "old.txt"), "utf8")).toBe("old release");
    expect(f.lifecycle()).toEqual({ stopped: 1, restarted: 1 });
    expect((await f.repo.getDocument(f.scope, "update-plan", plan.id))!.data).toMatchObject({
      state: "effect_unknown",
    });
  });
  it("refuses disallowed release classes, independent trust mismatch, missing executor and revoked policy", async () => {
    const f = await fixture(),
      backup = await active(f),
      minor = await release(f, "0.5.0"),
      patch = await release(f);
    const policy = (await f.service.proposeUpdatePolicy(f.scope, f.setup.ceo.id, {
      name: "Patch only",
      trustedPublicKeyPem: minor.pem,
      installDirectory: path.join(f.parent, "install"),
      backupPolicyId: backup.id,
      allowedClasses: ["patch"],
      window: { cron: "0 2 * * *", timezone: "UTC", durationMinutes: 30 },
    })) as { id: string };
    await expect(f.service.proposeUpdate(f.scope, f.setup.ceo.id, policy.id, minor.directory)).rejects.toMatchObject({
      code: "update_class_denied",
    });
    await expect(f.service.proposeUpdate(f.scope, f.setup.ceo.id, policy.id, patch.directory)).rejects.toMatchObject({
      code: "release_signature",
    });
    const correct = (await f.service.proposeUpdatePolicy(f.scope, f.setup.ceo.id, {
      name: "Trusted patch",
      trustedPublicKeyPem: patch.pem,
      installDirectory: path.join(f.parent, "install"),
      backupPolicyId: backup.id,
      window: { cron: "0 2 * * *", timezone: "UTC", durationMinutes: 30 },
    })) as { id: string };
    const plan = await f.service.proposeUpdate(f.scope, f.setup.ceo.id, correct.id, patch.directory);
    await f.service.approveUpdate(f.scope, f.setup.ceo.id, plan.id);
    await expect(
      new MaintenanceService({ ...f.options, releaseLifecycle: undefined }).applyUpdate(
        f.scope,
        f.setup.ceo.id,
        plan.id,
      ),
    ).rejects.toMatchObject({ code: "maintenance_executor_not_configured" });
    await f.service.revokeUpdatePolicy(f.scope, f.setup.ceo.id, correct.id);
    f.setNow("2026-09-07T02:00:00Z");
    await expect(f.service.applyUpdate(f.scope, f.setup.ceo.id, plan.id)).rejects.toMatchObject({
      code: "update_policy_revoked",
    });
    expect(f.lifecycle().stopped).toBe(0);
  });
  it("serializes different approved update plans against one installation", async () => {
    const f = await fixture(),
      backup = await active(f),
      r = await release(f),
      install = path.join(f.parent, "install");
    await mkdir(install);
    await writeFile(path.join(install, "old.txt"), "old");
    const policy = (await f.service.proposeUpdatePolicy(f.scope, f.setup.ceo.id, {
      name: "Concurrent",
      trustedPublicKeyPem: r.pem,
      installDirectory: install,
      backupPolicyId: backup.id,
      window: { cron: "0 2 * * *", timezone: "UTC", durationMinutes: 30 },
    })) as { id: string };
    const plans = await Promise.all(
      [1, 2].map(() => f.service.proposeUpdate(f.scope, f.setup.ceo.id, policy.id, r.directory)),
    );
    for (const plan of plans) await f.service.approveUpdate(f.scope, f.setup.ceo.id, plan.id);
    f.setNow("2026-09-07T02:00:00Z");
    const results = await Promise.allSettled(
      plans.map((plan) => f.service.applyUpdate(f.scope, f.setup.ceo.id, plan.id)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(f.lifecycle().stopped).toBe(1);
    expect(f.getCalls()).toBe(2);
  });
});

it.skipIf(!existsSync(age) || !existsSync(keygen))(
  "defers only a pre-snapshot busy result and retries the original daily slot after restart",
  async () => {
    const f = await fixture(),
      policy = await active(f),
      backup = f.options.onlineBackup;
    let attempts = 0;
    const onlineBackup: typeof backup = async (input) => {
      attempts++;
      if (attempts === 1) throw new DomainError("backup_busy");
      return backup(input);
    };
    const service = new MaintenanceService({ ...f.options, onlineBackup });
    f.setNow("2026-09-07T02:00:00Z");
    await service.tick(f.scope);
    expect(attempts).toBe(1);
    expect(f.getCalls()).toBe(1);
    expect(
      (await f.repo.listDocuments<{ state: string; dueAt: string }>(f.scope, "maintenance-job"))[0]?.data,
    ).toMatchObject({ state: "deferred", dueAt: "2026-09-07T02:00:00.000Z" });
    expect(
      (await f.repo.getDocument<{ nextDueAt: string; retryNotBefore: string }>(f.scope, "backup-policy", policy.id))
        ?.data,
    ).toMatchObject({ nextDueAt: "2026-09-07T02:00:00.000Z", retryNotBefore: "2026-09-07T02:00:30.000Z" });
    const restarted = new MaintenanceService({ ...f.options, onlineBackup });
    f.setNow("2026-09-07T02:00:29Z");
    await restarted.tick(f.scope);
    expect(attempts).toBe(1);
    f.setNow("2026-09-07T02:00:30Z");
    await restarted.tick(f.scope);
    expect(attempts).toBe(2);
    expect(f.getCalls()).toBe(2);
    expect(
      (await f.repo.listDocuments<{ state: string; dueAt: string }>(f.scope, "maintenance-job")).map((job) => ({
        state: job.data.state,
        dueAt: job.data.dueAt,
      })),
    ).toEqual([
      { state: "deferred", dueAt: "2026-09-07T02:00:00.000Z" },
      { state: "succeeded", dueAt: "2026-09-07T02:00:00.000Z" },
    ]);
    await restarted.tick(f.scope);
    expect(attempts).toBe(2);
  },
);
it.skipIf(!existsSync(age) || !existsSync(keygen))(
  "never retries an unknown backup effect within the same scheduled slot",
  async () => {
    const f = await fixture();
    await active(f);
    let attempts = 0;
    const service = new MaintenanceService({
      ...f.options,
      onlineBackup: async () => {
        attempts++;
        throw new DomainError("backup_timeout");
      },
    });
    f.setNow("2026-09-07T02:00:00Z");
    await service.tick(f.scope);
    f.setNow("2026-09-07T02:00:31Z");
    await service.tick(f.scope);
    expect(attempts).toBe(1);
    expect((await f.repo.listDocuments<{ state: string }>(f.scope, "maintenance-job"))[0]?.data.state).toBe(
      "effect_unknown",
    );
  },
);
