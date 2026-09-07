import { test, expect } from "vitest";
import { readFile, writeFile, mkdir, stat, rm, symlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import { consumeUpdateResults, executeQueuedUpdate, updaterTick } from "../../packages/operations/src/index.ts";
import { fixture, run, portableNode, age } from "../fixtures/updater.ts";
const integrationTest = test.skipIf(!existsSync(portableNode) || !existsSync(age));

integrationTest(
  "external child updater stops own service, backs up offline, swaps exact signed release and imports proof",
  async () => {
    const f = await fixture();
    const queued = (await f.service.applyUpdate(f.scope, f.setup.ceo.id, f.plan.id)) as {
      state: string;
      jobId: string;
    };
    expect(queued.state).toBe("queued");
    await f.closeRepo();
    const result = await run(
      process.execPath,
      [
        "--eval",
        `import {executeQueuedUpdate} from ${JSON.stringify(new URL("../../packages/operations/src/updater.ts", import.meta.url).href)}; console.log(JSON.stringify(await executeQueuedUpdate(${JSON.stringify(f.configPath)},${JSON.stringify(queued.jobId)})));`,
      ],
      { timeout: 45000, maxBuffer: 100000 },
    );
    const outcome = JSON.parse(result.stdout);
    expect(outcome.state).toBe("applied");
    expect(outcome.health.version).toBe("0.4.1");
    const installed = await stat(f.config.installDirectory);
    expect(installed.isDirectory()).toBe(true);
    if (process.platform === "win32") {
      // Node chmod on Windows controls the writable attribute, not a POSIX mode or service-account DACL.
      // The full signed swap, executable startup and health identity remain asserted above and below.
      expect(installed.mode & 0o200).toBe(0o200);
    } else expect(installed.mode & 0o777).toBe(0o755);
    if (process.env.IRONCREW_TEST_SYSTEMD === "1") expect((await stat(outcome.backup.archivePath)).uid).toBe(501);
    if (process.env.IRONCREW_TEST_SYSTEMD === "1")
      expect((await stat(path.join(f.config.installDirectory, "runtime/node"))).uid).toBe(0);
    expect(outcome.health.instanceId).not.toBe(f.before.instanceId);
    expect((await readFile(outcome.backup.archivePath)).subarray(0, 22).toString()).toContain("age-encryption.org");
    const repo = await Repository.open(path.join(f.config.dataDirectory, "company.sqlite"));
    try {
      expect(await consumeUpdateResults(repo, f.configPath)).toBe(1);
      expect((await repo.getDocument<Record<string, unknown>>(f.scope, "update-plan", f.plan.id))?.data.state).toBe(
        "applied",
      );
      expect(
        (await repo.getDocument<Record<string, unknown>>(f.scope, "recovery-state", f.scope.companyId))?.data
          .dispatchPaused,
      ).toBe(false);
      expect(await executeQueuedUpdate(f.configPath, queued.jobId)).toEqual(outcome);
    } finally {
      await repo.close();
    }
  },
  60000,
);
integrationTest(
  "unhealthy real new process is stopped before verified old release restarts",
  async () => {
    const f = await fixture(true);
    const queued = (await f.service.applyUpdate(f.scope, f.setup.ceo.id, f.plan.id)) as { jobId: string };
    await f.closeRepo();
    const result = await run(
      process.execPath,
      [
        "--eval",
        `import {executeQueuedUpdate} from ${JSON.stringify(new URL("../../packages/operations/src/updater.ts", import.meta.url).href)}; console.log(JSON.stringify(await executeQueuedUpdate(${JSON.stringify(f.configPath)},${JSON.stringify(queued.jobId)})));`,
      ],
      { timeout: 45000, maxBuffer: 100000 },
    );
    const outcome = JSON.parse(result.stdout);
    expect(outcome.state).toBe("rolled_back");
    expect(outcome.health.version).toBe("0.4.0");
    expect(outcome.health.instanceId).not.toBe(f.before.instanceId);
    const repo = await Repository.open(path.join(f.config.dataDirectory, "company.sqlite"));
    try {
      expect(await consumeUpdateResults(repo, f.configPath)).toBe(1);
      expect(
        (await repo.getDocument<Record<string, unknown>>(f.scope, "maintenance-update-active", f.scope.companyId))?.data
          .state,
      ).toBe("idle");
    } finally {
      await repo.close();
    }
  },
  60000,
);
integrationTest(
  "candidate changed after queue cannot stop running service and cannot be retried blindly",
  async () => {
    const f = await fixture();
    const queued = (await f.service.applyUpdate(f.scope, f.setup.ceo.id, f.plan.id)) as { jobId: string };
    await writeFile(path.join(f.candidate, "dist/apps/control/main.js"), "tampered");
    await f.closeRepo();
    const result = await executeQueuedUpdate(f.configPath, queued.jobId);
    expect(result.state).toBe("effect_unknown");
    expect(result.errorCode).toBe("release_hash");
    expect((await (await fetch(f.config.healthUrl)).json()).instanceId).toBe(f.before.instanceId);
    expect(await executeQueuedUpdate(f.configPath, queued.jobId)).toEqual(result);
  },
  60000,
);
integrationTest(
  "result from before a recovery generation cannot release the restored system",
  async () => {
    const f = await fixture();
    const queued = (await f.service.applyUpdate(f.scope, f.setup.ceo.id, f.plan.id)) as { jobId: string };
    await f.closeRepo();
    const outcome = await executeQueuedUpdate(f.configPath, queued.jobId);
    expect(outcome.state).toBe("applied");
    const repo = await Repository.open(path.join(f.config.dataDirectory, "company.sqlite"));
    try {
      const recovery = await repo.getDocument<Record<string, unknown>>(f.scope, "recovery-state", f.scope.companyId);
      await repo.putDocument(
        f.scope,
        "recovery-state",
        f.scope.companyId,
        { generation: "restored-new-generation", dispatchPaused: true, schedulesPaused: true },
        { expectedRevision: recovery!.revision },
      );
      expect(await consumeUpdateResults(repo, f.configPath)).toBe(1);
      expect(await consumeUpdateResults(repo, f.configPath)).toBe(0);
      expect((await repo.getDocument<Record<string, unknown>>(f.scope, "update-plan", f.plan.id))?.data.state).toBe(
        "effect_unknown",
      );
      expect(
        (await repo.getDocument<Record<string, unknown>>(f.scope, "recovery-state", f.scope.companyId))?.data
          .dispatchPaused,
      ).toBe(true);
    } finally {
      await repo.close();
    }
  },
  60000,
);
integrationTest(
  "administrative backup target and executable hash constrain an otherwise freshly approved plan",
  async () => {
    const f = await fixture();
    for (const change of [
      { backupDirectory: path.join(f.root, "other-backups") },
      { ageExecutableSha256: "0".repeat(64) },
    ]) {
      if (change.backupDirectory) await mkdir(change.backupDirectory, { mode: 0o700 });
      Object.assign(f.config, change);
      await writeFile(f.configPath, JSON.stringify(f.config), { mode: 0o600 });
      const plan = await f.service.proposeUpdate(f.scope, f.setup.ceo.id, f.plan.policyId, f.candidate);
      await f.service.approveUpdate(f.scope, f.setup.ceo.id, plan.id);
      await updaterTick(f.configPath);
      await expect(f.service.applyUpdate(f.scope, f.setup.ceo.id, plan.id)).rejects.toMatchObject({
        code: "update_backup_configuration",
      });
      expect((await (await fetch(f.config.healthUrl)).json()).instanceId).toBe(f.before.instanceId);
      expect(await f.repo.listDocuments(f.scope, "update-executor-job")).toHaveLength(0);
      f.config.backupDirectory = path.join(f.root, "backups");
    }
  },
  60000,
);
integrationTest(
  "queue symlink cannot change ownership or write into a protected unrelated directory",
  async () => {
    const f = await fixture(),
      protectedDirectory = path.join(f.root, "protected-root-directory");
    await mkdir(protectedDirectory, { mode: 0o700 });
    const before = await stat(protectedDirectory);
    const queue = path.join(f.config.dataDirectory, "update-queue");
    await rm(queue, { recursive: true });
    await symlink(protectedDirectory, queue);
    await expect(updaterTick(f.configPath)).rejects.toThrow();
    const after = await stat(protectedDirectory);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(after.mode).toBe(before.mode);
    expect(await readdir(protectedDirectory)).toEqual([]);
  },
  60000,
);
integrationTest(
  "harmless policy path aliases resolve to the same administrative targets without changing the approval binding",
  async () => {
    const f = await fixture(false, true);
    const prior = await f.repo.getDocument<Record<string, unknown>>(f.scope, "update-policy", f.plan.policyId);
    const queued = (await f.service.applyUpdate(f.scope, f.setup.ceo.id, f.plan.id)) as { jobId: string };
    const current = await f.repo.getDocument<Record<string, unknown>>(f.scope, "update-policy", f.plan.policyId);
    expect(current?.data.fingerprint).toBe(prior?.data.fingerprint);
    await f.closeRepo();
    const outcome = await executeQueuedUpdate(f.configPath, queued.jobId);
    expect(outcome.state).toBe("applied");
    expect(outcome.health?.version).toBe("0.4.1");
  },
  60000,
);
