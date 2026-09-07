import { Runtime } from "../../packages/runtime/src/engine.ts";
import type { ToolAction } from "../../packages/contracts/src/index.ts";
import { it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import { restoreBackup } from "../../packages/operations/src/index.ts";
const age = process.env.IRONCREW_TEST_AGE ?? "/tmp/ironcrew-age-1.3.2/age/age";
const keygen =
  process.env.IRONCREW_TEST_AGE_KEYGEN ??
  path.join(path.dirname(age), process.platform === "win32" ? "age-keygen.exe" : "age-keygen");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it.skipIf(!existsSync(age) || !existsSync(keygen))(
  "online API drains background, blocks concurrent writes and produces a real restorable encrypted snapshot",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-online-backup-"));
    const source = path.join(directory, "source");
    await mkdir(source);
    const repo = await Repository.open(path.join(source, "company.sqlite"));
    try {
      const identity = path.join(directory, "identity.txt");
      await promisify(execFile)(keygen, ["--output", identity]);
      const recipient = (await readFile(identity, "utf8")).match(/# public key: (age1\S+)/)![1];
      const app = createApp({
        repo,
        directory: source,
        publicOrigin: "http://127.0.0.1:8790",
        releaseIdentity: { version: "0.4.2", releaseManifestSha256: "b".repeat(64) },
      });
      const agent = request.agent(app),
        token = await issueSetupToken(source);
      const setup = await agent
        .post("/api/v1/setup")
        .send({
          token,
          companyName: "Backup fixture",
          ceoName: "CEO",
          password: "fixture-password-1234",
          timezone: "UTC",
        })
        .expect(200);
      const csrf = setup.body.csrfToken,
        scope = { companyId: setup.body.company.id, areaId: setup.body.areas[0].id };
      const content = "A durable report",
        hash = createHash("sha256").update(content).digest("hex");
      await mkdir(path.join(source, "blobs"));
      await writeFile(path.join(source, "blobs", hash), content);
      const order = await repo.createOrder(scope, {
        kind: "research",
        goal: "Recovered execution output",
        budgetLimitUsdMicros: "0",
      });
      const execution: ToolAction = {
        id: randomUUID(),
        runId: order.id,
        orderId: order.id,
        scope,
        toolId: "workspace.execute",
        toolVersion: 1,
        args: {},
        argumentsSha256: "a".repeat(64),
        status: "succeeded",
        mandateId: randomUUID(),
        mandateVersion: 1,
        evidenceRefs: [],
      };
      // Explicit receipt fixture; the encryption/restore below must preserve its verified company-owned bytes.
      await repo.putDocument(scope, "action", execution.id, {
        ...execution,
        result: {
          exitCode: 0,
          termination: "exited",
          outputStorage: "content-addressed",
          outputDirectory: path.join(source, "removed-worker-export"),
          outputHashes: { "result.txt": hash },
        },
      });
      const started = deferred(),
        continueDrain = deferred();
      let released = false;
      app.locals.pauseBackground = async () => {
        started.resolve();
        await continueDrain.promise;
        return () => {
          released = true;
        };
      };
      const key = randomUUID();
      const input = { ageExecutable: age, recipient, outputDirectory: path.join(directory, "backups") };
      const backup = agent
        .post("/api/v1/backups")
        .set({ "X-CSRF-Token": csrf, "Idempotency-Key": key })
        .send(input)
        .then((response) => response);
      await started.promise;
      await agent
        .post("/api/v1/orders")
        .set({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() })
        .send({ scope, kind: "research", goal: "Must wait", budgetLimitUsdMicros: "0" })
        .expect(423);
      expect(released).toBe(false);
      continueDrain.resolve();
      const response = await backup;
      expect(response.status).toBe(200);
      expect(released).toBe(true);
      expect(response.body.state).toBe("verified_archive");
      expect(response.body.restoreTested).toBe(false);
      const bytes = await readFile(response.body.archivePath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(response.body.sha256);
      expect(bytes.subarray(0, 40).toString().startsWith("age-encryption.org/v1\n")).toBe(true);
      expect(
        (await repo.getDocument<{ dispatchPaused: boolean }>(scope, "recovery-state", scope.companyId))!.data
          .dispatchPaused,
      ).toBe(false);
      const repeated = await agent
        .post("/api/v1/backups")
        .set({ "X-CSRF-Token": csrf, "Idempotency-Key": key })
        .send(input)
        .expect(200);
      expect(repeated.body.id).toBe(response.body.id);
      const restored = path.join(directory, "restored");
      const restore = await restoreBackup({
        archivePath: response.body.archivePath,
        identityPath: identity,
        ageExecutable: age,
        targetDirectory: restored,
        beforeActivate: async () => {},
      });
      expect(restore.manifest.appVersion).toBe("0.4.2");
      expect(await readFile(path.join(restored, "blobs", hash), "utf8")).toBe(content);
      const recovered = await Repository.open(path.join(restored, "company.sqlite"));
      try {
        expect((await recovered.snapshot(scope.companyId)).company.name).toBe("Backup fixture");
        expect(await recovered.verifyAudit(scope.companyId)).toBe(true);
        const runtime = new Runtime({
          repo: recovered,
          directory: restored,
          models: [],
          client: {
            complete: async () => {
              throw new Error("No model request in restore test");
            },
          },
        });
        const tools = await runtime.localTools(order.id, scope);
        const staged = await tools
          .find((tool) => tool.id === "artifact.stage")!
          .execute(
            { path: "result.txt", mediaType: "text/plain", executionActionId: execution.id },
            { ...execution, id: randomUUID(), toolId: "artifact.stage" },
          );
        expect(staged).toMatchObject({ sha256: hash, bytes: Buffer.byteLength(content) });
      } finally {
        await recovered.close();
      }
    } finally {
      await repo.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
