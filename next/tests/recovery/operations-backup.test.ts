import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as tar from "tar";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createBackup, restoreBackup, type BackupResult } from "../../packages/operations/src/index.ts";
const exec = promisify(execFile);
const age = process.env.IRONCREW_TEST_AGE ?? "/tmp/ironcrew-age-1.3.2/age/age";
const keygen =
  process.env.IRONCREW_TEST_AGE_KEYGEN ??
  path.join(path.dirname(age), process.platform === "win32" ? "age-keygen.exe" : "age-keygen");
const available = existsSync(age) && existsSync(keygen);

describe.skipIf(!available)("real age encrypted SQLite backup/restore (local fixture)", () => {
  let directory: string;
  let identity: string;
  let recipient: string;
  let source: string;
  let backup: BackupResult;
  let companyId: string;
  let areaId: string;
  const sessionId = randomUUID();
  const workerId = randomUUID();
  const scheduleId = randomUUID();
  const actionId = randomUUID();
  const remoteJobId = randomUUID();
  const approvedUpdateId = randomUUID();
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "ironcrew-recovery-fixture-"));
    identity = path.join(directory, "identity.txt");
    await exec(keygen, ["--output", identity]);
    recipient = (await readFile(identity, "utf8")).match(/# public key: (age1\S+)/)![1];
    source = path.join(directory, "source");
    await mkdir(path.join(source, "blobs"), { recursive: true });
    await writeFile(path.join(source, "blobs", "artifact-1"), "immutable report fixture");
    await mkdir(path.join(source, "workspaces", "fixture-order"), { recursive: true });
    await writeFile(path.join(source, "workspaces", "fixture-order", "working.txt"), "unfinished company work");
    await writeFile(
      path.join(source, "channel-config.json"),
      JSON.stringify({ version: 1, channels: [], proton: { executable: "/fixture/pass-cli" } }),
    );
    const repo = await Repository.open(path.join(source, "company.sqlite"));
    const setup = await repo.setup({
      companyName: "Recovery test company",
      ceoName: "Fixture CEO",
      passwordHash: "fixture-password-hash",
      timezone: "Europe/Berlin",
      budgetLimitUsdMicros: "10000",
    });
    companyId = setup.company.id;
    areaId = setup.areas[0].id;
    const scope = { companyId, areaId };
    await repo.putDocument(scope, "session", sessionId, {
      hash: "fixture-hash",
      csrf: "fixture-csrf",
      expiresAt: Date.now() + 100000,
      revoked: false,
    });
    await repo.putDocument(scope, "worker", workerId, {
      credentialHash: "fixture-worker-hash",
      generation: 4,
      revoked: false,
      sequence: 10,
    });
    await repo.putDocument(scope, "schedule", scheduleId, { enabled: true, paused: false });
    await repo.putDocument(scope, "action", actionId, { status: "running" });
    await repo.putDocument(scope, "remote-execution", remoteJobId, {
      id: remoteJobId,
      workerId,
      generation: 4,
      state: "uploading",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
    await repo.putDocument(scope, "update-plan", approvedUpdateId, {
      id: approvedUpdateId,
      state: "approved",
      approvedBy: setup.ceo.id,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    await repo.close();
    let frozen = false;
    backup = await createBackup({
      databasePath: path.join(source, "company.sqlite"),
      blobDirectory: path.join(source, "blobs"),
      outputDirectory: path.join(directory, "backups"),
      recipient,
      ageExecutable: age,
      appVersion: "0.4.0-dev.0",
      configuration: { version: 1, connections: [] },
      quiesce: async () => {
        expect(frozen).toBe(false);
        frozen = true;
        return async () => {
          frozen = false;
        };
      },
    });
    expect(frozen).toBe(false);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("encrypts artifacts and restores complete state with paused automation and revoked sessions", async () => {
    const archive = await readFile(backup.archivePath);
    expect(archive.subarray(0, 22).toString()).toContain("age-encryption.org/v1");
    expect(archive.includes(Buffer.from("immutable report fixture"))).toBe(false);
    const target = path.join(directory, "restored");
    let beforeActivate = 0;
    const result = await restoreBackup({
      archivePath: backup.archivePath,
      identityPath: identity,
      ageExecutable: age,
      targetDirectory: target,
      beforeActivate: async () => {
        beforeActivate++;
      },
    });
    expect(beforeActivate).toBe(1);
    expect(JSON.parse(await readFile(path.join(target, "channel-config.json"), "utf8"))).toMatchObject({
      version: 1,
      channels: [],
    });
    expect(await readFile(path.join(target, "workspaces", "fixture-order", "working.txt"), "utf8")).toBe(
      "unfinished company work",
    );
    expect(await readFile(path.join(target, "blobs", "artifact-1"), "utf8")).toBe("immutable report fixture");
    expect(result.recovery).toMatchObject({
      dispatchPaused: true,
      schedulesPaused: true,
      revokedSessions: 1,
      fencedWorkers: 1,
      pausedSchedules: 1,
      unknownActions: 1,
      unknownRemoteExecutions: 1,
      invalidatedUpdateApprovals: 1,
    });
    const repo = await Repository.open(path.join(target, "company.sqlite"));
    const scope = { companyId, areaId };
    try {
      expect((await repo.getDocument<Record<string, unknown>>(scope, "session", sessionId))?.data.revoked).toBe(true);
      expect((await repo.getDocument<Record<string, unknown>>(scope, "worker", workerId))?.data).toMatchObject({
        generation: 5,
        revoked: true,
      });
      expect((await repo.getDocument<Record<string, unknown>>(scope, "schedule", scheduleId))?.data.enabled).toBe(
        false,
      );
      expect((await repo.getDocument<Record<string, unknown>>(scope, "action", actionId))?.data.status).toBe(
        "effect_unknown",
      );
      expect(
        (await repo.getDocument<Record<string, unknown>>(scope, "remote-execution", remoteJobId))?.data,
      ).toMatchObject({
        state: "effect_unknown",
        code: "recovery_generation_changed",
        recoveryGeneration: result.recovery.generation,
      });
      const restoredUpdate = (await repo.getDocument<Record<string, unknown>>(scope, "update-plan", approvedUpdateId))!
        .data;
      expect(restoredUpdate).toMatchObject({ state: "planned", errorCode: "recovery_approval_invalidated" });
      expect(restoredUpdate.approvedBy).toBeUndefined();
      expect(restoredUpdate.expiresAt).toBeUndefined();
      expect(await repo.verifyAudit(companyId)).toBe(true);
    } finally {
      await repo.close();
    }
  });
  it("keeps previous data as rollback directory", async () => {
    const target = path.join(directory, "existing");
    await mkdir(target);
    await writeFile(path.join(target, "previous-marker"), "previous state");
    const result = await restoreBackup({
      archivePath: backup.archivePath,
      identityPath: identity,
      ageExecutable: age,
      targetDirectory: target,
      beforeActivate: async () => {},
    });
    expect(await readFile(path.join(result.previousDirectory!, "previous-marker"), "utf8")).toBe("previous state");
    await expect(access(path.join(target, "company.sqlite"))).resolves.toBeUndefined();
  });
  it("rejects wrong decryption key and modified ciphertext before activation or target mutation", async () => {
    const wrong = path.join(directory, "wrong-identity.txt");
    await exec(keygen, ["--output", wrong]);
    const target = path.join(directory, "untouched");
    await mkdir(target);
    await writeFile(path.join(target, "marker"), "untouched");
    let activations = 0;
    await expect(
      restoreBackup({
        archivePath: backup.archivePath,
        identityPath: wrong,
        ageExecutable: age,
        targetDirectory: target,
        beforeActivate: async () => {
          activations++;
        },
      }),
    ).rejects.toMatchObject({ code: "age_failed" });
    const modified = Buffer.from(await readFile(backup.archivePath));
    modified[modified.length - 1] ^= 1;
    const corrupt = path.join(directory, "corrupt.age");
    await writeFile(corrupt, modified);
    await expect(
      restoreBackup({
        archivePath: corrupt,
        identityPath: identity,
        ageExecutable: age,
        targetDirectory: target,
        beforeActivate: async () => {
          activations++;
        },
      }),
    ).rejects.toMatchObject({ code: "age_failed" });
    expect(activations).toBe(0);
    expect(await readFile(path.join(target, "marker"), "utf8")).toBe("untouched");
  });
  it("rejects links, manifest hash mismatch and oversized archives before target mutation", async () => {
    const fixture = path.join(directory, "malicious");
    await mkdir(fixture);
    const target = path.join(directory, "safe-target");
    await mkdir(target);
    await writeFile(path.join(target, "marker"), "safe");
    let activations = 0;
    await symlink("../../outside", path.join(fixture, "escape"));
    const tarPath = path.join(directory, "link.tar");
    await tar.c({ cwd: fixture, file: tarPath }, ["escape"]);
    const encrypted = path.join(directory, "link.tar.age");
    await exec(age, ["--recipient", recipient, "--output", encrypted, tarPath]);
    await expect(
      restoreBackup({
        archivePath: encrypted,
        identityPath: identity,
        ageExecutable: age,
        targetDirectory: target,
        beforeActivate: async () => {
          activations++;
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe_archive" });
    const clear = path.join(directory, "clear.tar");
    await exec(age, ["--decrypt", "--identity", identity, "--output", clear, backup.archivePath]);
    const unpacked = path.join(directory, "unpacked");
    await mkdir(unpacked);
    await tar.x({ cwd: unpacked, file: clear });
    await writeFile(path.join(unpacked, "blobs", "artifact-1"), "changed after snapshot");
    const tamperedTar = path.join(directory, "tampered.tar");
    const tamperManifest = JSON.parse(await readFile(path.join(unpacked, "manifest.json"), "utf8")) as {
      files: { path: string }[];
    };
    await tar.c({ cwd: unpacked, file: tamperedTar }, ["manifest.json", ...tamperManifest.files.map((f) => f.path)]);
    const tampered = path.join(directory, "tampered.age");
    await exec(age, ["--recipient", recipient, "--output", tampered, tamperedTar]);
    await expect(
      restoreBackup({
        archivePath: tampered,
        identityPath: identity,
        ageExecutable: age,
        targetDirectory: target,
        beforeActivate: async () => {
          activations++;
        },
      }),
    ).rejects.toMatchObject({ code: "hash" });
    await expect(
      restoreBackup({
        archivePath: backup.archivePath,
        identityPath: identity,
        ageExecutable: age,
        targetDirectory: target,
        maxPlaintextBytes: 100,
        beforeActivate: async () => {
          activations++;
        },
      }),
    ).rejects.toThrow();
    expect(activations).toBe(0);
    expect(await readFile(path.join(target, "marker"), "utf8")).toBe("safe");
  });
  it("blocks raw secrets in configuration before backup publication", async () => {
    await expect(
      createBackup({
        databasePath: path.join(source, "company.sqlite"),
        blobDirectory: path.join(source, "blobs"),
        outputDirectory: path.join(directory, "bad-backup"),
        recipient,
        ageExecutable: age,
        appVersion: "0.4.0-dev.0",
        configuration: { smtp: { password: "do-not-copy" } },
        quiesce: async () => async () => {},
      }),
    ).rejects.toMatchObject({ code: "raw_secret" });
  });
});
