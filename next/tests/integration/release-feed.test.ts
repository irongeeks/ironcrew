import { beforeEach, afterEach, it, expect } from "vitest";
import { createServer, type Server } from "node:https";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import express from "express";
import supertest from "supertest";
import { Repository } from "../../packages/persistence/src/index.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { hashFile } from "../../packages/operations/src/common.ts";
import {
  ReleaseFeedService,
  releaseFeedSigningBytes,
  type ReleaseFeedConfiguration,
} from "../../packages/operations/src/release-feed.ts";
import { registerReleaseFeedRoutes, discoverDueReleases } from "../../apps/control/release-feed-routes.ts";
import { MaintenanceService } from "../../apps/control/maintenance-service.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
let directory: string,
  repo: Repository,
  server: Server,
  scope: Scope,
  ceoId: string,
  policyId: string,
  configuration: ReleaseFeedConfiguration,
  service: ReleaseFeedService;
let archive: Buffer,
  envelope: unknown,
  downloads = 0;
const keys = generateKeyPairSync("ed25519");
let payload: Parameters<typeof releaseFeedSigningBytes>[0];
const publish = (value: unknown) => {
  payload = value;
  envelope = {
    signed: value,
    signature: sign(null, releaseFeedSigningBytes(value), keys.privateKey).toString("base64"),
  };
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-feed-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Feed fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  ceoId = setup.ceo.id;
  const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const ca = await readFile(new URL("./worker-fixtures/cert.pem", import.meta.url));
  downloads = 0;
  server = createServer(
    { cert: ca, key: await readFile(new URL("./worker-fixtures/key.pem", import.meta.url)) },
    (req, res) => {
      if (req.url === "/index.json") {
        res.end(JSON.stringify(envelope));
        return;
      }
      downloads++;
      res.writeHead(200, { "content-length": archive.length });
      res.end(archive);
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  configuration = {
    id: randomUUID(),
    indexUrl: base + "/index.json",
    archiveBaseUrl: base + "/releases/",
    trustedPublicKeyPem: pem,
    channel: "stable",
    caCertificatePem: ca.toString(),
  };
  await writeFile(path.join(directory, "release-feed.json"), JSON.stringify(configuration), { mode: 0o600 });
  policyId = randomUUID();
  const policy = {
    name: "Reviewed fixture policy",
    trustedPublicKeyPem: pem,
    installDirectory: path.join(directory, "outside-install"),
    backupPolicyId: randomUUID(),
    allowedClasses: ["patch"],
    window: { cron: "0 2 * * *", timezone: "UTC", durationMinutes: 30 },
  };
  await repo.putDocument(scope, "update-policy", policyId, { ...policy, id: policyId, fingerprint: sha256(policy) });
  const release = path.join(directory, "release");
  await mkdir(path.join(release, "runtime"), { recursive: true });
  await mkdir(path.join(release, "dist/apps/control"), { recursive: true });
  await writeFile(path.join(release, "runtime/node"), "fixture-runtime");
  await writeFile(path.join(release, "dist/apps/control/main.js"), "fixture-control");
  const files = [];
  for (const name of ["runtime/node", "dist/apps/control/main.js"])
    files.push({
      path: name,
      sha256: await hashFile(path.join(release, name)),
      bytes: (await readFile(path.join(release, name))).length,
      executable: name === "runtime/node",
    });
  const manifest = {
    format: "ironcrew-release",
    version: "0.4.1",
    schemaVersion: 1,
    protocolVersion: 1,
    nodeVersion: "26.4.0",
    platform: process.platform,
    arch: process.arch,
    files,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(release, "release-manifest.json"), bytes);
  await writeFile(path.join(release, "release-manifest.sig"), sign(null, bytes, keys.privateKey));
  await tar.c({ cwd: release, file: path.join(directory, "package.tgz"), gzip: true }, [
    ...files.map((f) => f.path),
    "release-manifest.json",
    "release-manifest.sig",
  ]);
  archive = await readFile(path.join(directory, "package.tgz"));
  publish({
    format: "ironcrew-release-feed",
    formatVersion: 1,
    sequence: 1,
    publishedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    channel: "stable",
    releases: [
      {
        version: "0.4.1",
        schemaVersion: 1,
        protocolVersion: 1,
        nodeVersion: "26.4.0",
        platform: process.platform,
        arch: process.arch,
        archiveUrl: base + "/releases/package.tgz",
        archiveSha256: await hashFile(path.join(directory, "package.tgz")),
        archiveBytes: archive.length,
        manifestSha256: await hashFile(path.join(release, "release-manifest.json")),
      },
    ],
  });
  service = new ReleaseFeedService({ repo, directory, configuration, currentVersion: "0.4.0" });
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
it("discovers and stages signed bytes without creating or approving an update", async () => {
  const candidates = await service.discover(scope, ceoId, policyId);
  expect(candidates).toHaveLength(1);
  expect(downloads).toBe(0);
  expect(await repo.listDocuments(scope, "update-plan")).toHaveLength(0);
  const staged = await service.stage(scope, ceoId, candidates[0]!.id);
  expect(await readFile(path.join(staged.releaseDirectory, "runtime/node"), "utf8")).toBe("fixture-runtime");
  expect(downloads).toBe(1);
  await service.stage(scope, ceoId, candidates[0]!.id);
  expect(downloads).toBe(1);
  expect(await repo.listDocuments(scope, "update-plan")).toHaveLength(0);
});
it("rejects wrong signatures and expired indices", async () => {
  const wrong = generateKeyPairSync("ed25519");
  envelope = {
    signed: payload,
    signature: sign(null, releaseFeedSigningBytes(payload), wrong.privateKey).toString("base64"),
  };
  await expect(service.discover(scope, ceoId, policyId)).rejects.toMatchObject({ code: "feed_signature" });
  publish({ ...(payload as object), expiresAt: new Date(Date.now() - 1).toISOString() });
  await expect(service.discover(scope, ceoId, policyId)).rejects.toMatchObject({ code: "feed_expired" });
});
it("keeps sequence replay fences after database restart and invalidates removed candidates", async () => {
  publish({ ...(payload as object), sequence: 2 });
  const candidates = await service.discover(scope, ceoId, policyId);
  await repo.close();
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  service = new ReleaseFeedService({ repo, directory, configuration, currentVersion: "0.4.0" });
  publish({ ...(payload as object), sequence: 1 });
  await expect(service.discover(scope, ceoId, policyId)).rejects.toMatchObject({ code: "feed_replay" });
  publish({ ...(payload as object), sequence: 3, releases: [] });
  await service.discover(scope, ceoId, policyId);
  expect(await service.list(scope, ceoId)).toEqual([]);
  await expect(service.stage(scope, ceoId, candidates[0]!.id)).rejects.toMatchObject({
    code: "release_candidate_stale",
  });
});
it("blocks wrong CEO/scope, policy revocation and archive hash tampering", async () => {
  await expect(service.discover(scope, randomUUID(), policyId)).rejects.toMatchObject({
    code: "maintenance_ceo_required",
  });
  await expect(service.discover({ ...scope, customerId: randomUUID() }, ceoId, policyId)).rejects.toMatchObject({
    code: "maintenance_ceo_required",
  });
  const [candidate] = await service.discover(scope, ceoId, policyId);
  archive = Buffer.from(archive);
  archive[4] = archive[4]! ^ 1;
  await expect(service.stage(scope, ceoId, candidate!.id)).rejects.toMatchObject({ code: "feed_archive_hash" });
  await repo.putDocument(scope, "update-policy-revocation", policyId, { revoked: true });
  expect(await service.list(scope, ceoId)).toEqual([]);
  await expect(service.stage(scope, ceoId, candidate!.id)).rejects.toMatchObject({ code: "update_policy_revoked" });
});
it("HTTP staging creates one planned update under concurrent calls and never approves it", async () => {
  const app = express();
  app.use(express.json());
  const maintenance = new MaintenanceService({
    repo,
    directory,
    currentVersion: "0.4.0",
    onlineBackup: async () => {
      throw Error("not used");
    },
  });
  registerReleaseFeedRoutes(app, {
    repo,
    directory,
    currentVersion: "0.4.0",
    maintenance,
    context: () => ({ scope, ceoId }),
    mutate: (handler) => async (req, res, next) => {
      try {
        res.json(await handler(req, res));
      } catch (e) {
        next(e);
      }
    },
  });
  app.use((e: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(400).json({ error: e.message }),
  );
  const found = await supertest(app).post("/api/v1/maintenance/releases/discover").send({ policyId }).expect(200);
  const id = found.body.candidates[0].id as string;
  const responses = await Promise.all(
    [1, 2].map(() =>
      supertest(app).post(`/api/v1/maintenance/releases/candidates/${id}/stage-plan`).send({}).expect(200),
    ),
  );
  expect(responses[0]!.body.planId).toBe(responses[1]!.body.planId);
  expect(responses[0]!.body.state).toBe("planned");
  expect(await repo.listDocuments(scope, "update-plan")).toHaveLength(1);
});

it("automatic discovery persists its cadence across restart and never stages or approves", async () => {
  const now = new Date();
  const options = { repo, directory, currentVersion: "0.4.0" };
  await expect(discoverDueReleases(options, scope, randomUUID(), now)).rejects.toMatchObject({
    code: "maintenance_ceo_required",
  });
  expect(await repo.listDocuments(scope, "release-discovery-status")).toHaveLength(0);
  const results = await Promise.all([
    discoverDueReleases(options, scope, ceoId, now),
    discoverDueReleases(options, scope, ceoId, now),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(["checked", "not_due"]);
  expect(downloads).toBe(0);
  expect(await repo.listDocuments(scope, "update-plan")).toHaveLength(0);
  await repo.close();
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  expect((await discoverDueReleases({ ...options, repo }, scope, ceoId, new Date(now.getTime() + 1000))).status).toBe(
    "not_due",
  );
  await repo.putDocument(scope, "update-policy-revocation", policyId, { revoked: true });
  const result = await discoverDueReleases({ ...options, repo }, scope, ceoId, new Date(now.getTime() + 16 * 60000));
  expect(result.status === "checked" && result.result.checkedPolicies).toBe(0);
});
it("automatic discovery records bounded error codes without secret-bearing errors", async () => {
  envelope = { invalid: "private-server-debug-token" };
  const result = await discoverDueReleases({ repo, directory, currentVersion: "0.4.0" }, scope, ceoId);
  expect(result.status === "checked" && result.result.state).toBe("failed");
  const status = await repo.getDocument(scope, "release-discovery-status", configuration.id);
  expect(JSON.stringify(status)).not.toContain("private-server-debug-token");
  expect(JSON.stringify(status)).toContain("release_discovery_failed");
  expect(downloads).toBe(0);
});
