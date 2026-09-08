import request from "supertest";
import * as tar from "tar";
import { createApp } from "../../apps/control/app.ts";
import { hashPassword } from "../../apps/control/auth.ts";
import { afterEach, expect, it } from "vitest";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Repository } from "../../packages/persistence/src/index.ts";
import { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";
import { HostingService } from "../../apps/control/hosting-service.ts";
import { WebsiteCareService } from "../../apps/control/website-care-service.ts";
import { HostingCareHttpClient } from "../../packages/integrations/src/hosting-care.ts";
const exec = promisify(execFile),
  age = process.env.IRONCREW_TEST_AGE ?? "/tmp/ironcrew-age-1.3.2/age/age";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(api = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "website-care-"));
  let repo = await Repository.open(path.join(directory, "company.sqlite"));
  const identity = path.join(directory, "age-identity");
  await exec(path.join(path.dirname(age), process.platform === "win32" ? "age-keygen.exe" : "age-keygen"), [
    "-o",
    identity,
  ]);
  const recipient = (
    await exec(path.join(path.dirname(age), process.platform === "win32" ? "age-keygen.exe" : "age-keygen"), [
      "-y",
      identity,
    ])
  ).stdout.trim();
  const setup = await repo.setup({
      companyName: "Website care fixture",
      ceoName: "CEO",
      passwordHash: api ? await hashPassword("care-fixture-password-1234") : "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "100000",
    }),
    scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  const order = await repo.createOrder(scope, {
      kind: "website",
      goal: "Hosted customer fixture",
      budgetLimitUsdMicros: "100000",
    }),
    website = new WebsiteWorkflow(repo, directory),
    html = "<!doctype html><html><h1>Actual hosted care fixture</h1></html>";
  await website.create(scope, order.id, "Fixture");
  await website.concepts(scope, order.id, [
    { name: "A", rationale: "First", html },
    { name: "B", rationale: "Other", html: "<h1>Other</h1>" },
  ]);
  const site = (await repo.getDocument<{ concepts: { id: string }[] }>(scope, "website", order.id))!;
  await website.select(scope, order.id, site.data.concepts[0]!.id);
  const artifact = await website.build(scope, order.id);
  // The broker serves the built artifact, whose CSP and sanitization can change concept bytes.
  const hostedHtml = await readFile(path.join(directory, "blobs", artifact.sha256), "utf8");
  const backupSource = path.join(directory, "site-backup.json"),
    runtimeFile = path.join(directory, "runtime.json");
  await writeFile(backupSource, (await website.packageArchive(scope, artifact.id)).content);
  await writeFile(runtimeFile, JSON.stringify({ version: "1.0.0", manifestSha256: "a".repeat(64) }));
  const calls: string[] = [],
    backups = new Map<string, { archive: string; hash: string }>();
  let unhealthy = false,
    badUpdate = false,
    loseUpdate = false,
    wrongProbe = false;
  const resourceId = "resource-fixture",
    deploymentId = randomUUID(),
    archiveSha256 = "b".repeat(64);
  const server = createServer(
    {
      key: await readFile(new URL("../integration/worker-fixtures/key.pem", import.meta.url)),
      cert: await readFile(new URL("../integration/worker-fixtures/cert.pem", import.meta.url)),
    },
    async (req, res) => {
      try {
        const runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
        if (req.method === "GET") {
          if (req.url === "/") {
            res.setHeader("content-type", "text/html");
            res.end(unhealthy || (badUpdate && runtime.version === "1.0.1") ? "<h1>Failed service</h1>" : hostedHtml);
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              req.url?.includes("maintenance")
                ? { resourceId, ...runtime }
                : { artifactVersionId: artifact.id, packageSha256: artifact.packageSha256, archiveSha256 },
            ),
          );
          return;
        }
        calls.push(req.url!);
        expect(req.headers.authorization).toBe("Bearer care-fixture-token");
        let body = "";
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        let result: unknown;
        if (req.url?.endsWith("/backups")) {
          expect(input.destinationId).toBe("fixture-backups");
          expect(input.recipient).toBe(recipient);
          const archive = path.join(directory, input.actionId + ".age");
          await exec(age, ["-r", recipient, "-o", archive, backupSource]);
          const bytes = await readFile(archive);
          expect(bytes.includes(Buffer.from(hostedHtml))).toBe(false);
          backups.set(input.actionId, { archive, hash: sha(bytes) });
          result = {
            id: input.actionId,
            resourceId,
            artifactVersionId: artifact.id,
            packageSha256: artifact.packageSha256,
            destinationId: input.destinationId,
            recipient,
            encrypted: true,
            archiveSha256: sha(bytes),
            bytes: bytes.length,
            costUsdMicros: input.costUsdMicros,
          };
        } else if (req.url?.endsWith("/restore-probe")) {
          const backupId = req.url.split("/").at(-2)!,
            backup = backups.get(backupId)!,
            restored = path.join(directory, backupId + ".restored.json");
          await exec(age, ["-d", "-i", identity, "-o", restored, backup.archive]);
          const restoredBytes = await readFile(restored);
          const restoreRoot = path.join(directory, backupId + ".restored");
          await mkdir(restoreRoot);
          await tar.x({ file: restored, cwd: restoreRoot, strict: true });
          const restoredFiles = await Promise.all(
            artifact.files.map(async (file) => {
              const bytes = await readFile(path.join(restoreRoot, file.path));
              return { path: file.path, sha256: sha(bytes), bytes: bytes.length };
            }),
          );
          expect(restoredFiles).toEqual(artifact.files);
          expect(await readFile(path.join(restoreRoot, "index.html"), "utf8")).toBe(hostedHtml);
          result = {
            backupId,
            archiveSha256: backup.hash,
            restoredPackageSha256: wrongProbe ? "f".repeat(64) : sha(JSON.stringify(restoredFiles)),
            isolated: true,
            functionalCheckPassed: true,
            completedAt: new Date().toISOString(),
            evidenceSha256: sha(restoredBytes),
          };
        } else if (req.url?.endsWith("/maintenance/rollback")) {
          expect(input.rollbackRef).toBe("rollback-fixture");
          await writeFile(
            runtimeFile,
            JSON.stringify({ version: input.restoreVersion, manifestSha256: input.restoreManifestSha256 }),
          );
          result = { state: "restored", version: input.restoreVersion, manifestSha256: input.restoreManifestSha256 };
        } else if (req.url?.endsWith("/maintenance")) {
          expect(backups.has(input.backupId)).toBe(true);
          expect(input.version).toBe("1.0.1");
          expect(input.manifestSha256).toBe("c".repeat(64));
          await writeFile(
            runtimeFile,
            JSON.stringify({ version: input.version, manifestSha256: input.manifestSha256 }),
          );
          if (loseUpdate) {
            req.socket.destroy();
            return;
          }
          result = {
            resourceId,
            version: input.version,
            manifestSha256: input.manifestSha256,
            previousVersion: runtime.version,
            previousManifestSha256: runtime.manifestSha256,
            rollbackRef: "rollback-fixture",
            state: "applied",
            costUsdMicros: input.costUsdMicros,
          };
        } else throw Error("unexpected route");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    secrets = { resolve: async () => "care-fixture-token" };
  const profile = await new HostingService({ repo, directory, secrets }).configureProfile(scope, setup.ceo.id, {
    name: "Own TLS broker fixture",
    scope,
    provider: "ironcrew-hosting-v1",
    endpoint: url,
    publicUrl: url,
    expectedDnsAddresses: ["127.0.0.1"],
    stack: "static",
    plan: "fixture",
    monthlyCostLimitUsdMicros: "0",
    healthContains: ["Actual hosted care fixture"],
    trustedCaPem: await readFile(new URL("../integration/worker-fixtures/cert.pem", import.meta.url), "utf8"),
    secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "password" },
    timeoutMs: 1000,
  });
  const deployment = {
    id: "deployment-fixture",
    resourceId,
    publicUrl: url,
    artifactVersionId: artifact.id,
    packageSha256: artifact.packageSha256,
    archiveSha256,
    rollbackRef: "previous-deployment",
  };
  await repo.putDocument(scope, "hosting-deployment", deploymentId, {
    id: deploymentId,
    profileId: profile.id,
    profileFingerprint: profile.fingerprint,
    orderId: order.id,
    state: "verified",
    deployment,
  });
  let clock = Date.now();
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["website.care.check", "website.care.backup", "website.care.update"],
    targetIds: [profile.id],
    parameterConstraints: {},
    expiresAt: new Date(clock + 86400000).toISOString(),
    maxAttempts: 10,
    maxDurationSeconds: 3600,
    maxCostUsdMicros: "100000",
  };
  await repo.createMandate(mandate);
  const input = {
    profileId: profile.id,
    deploymentId,
    mandateId: mandate.id,
    mandateVersion: 1,
    enabled: true,
    expiresAt: new Date(clock + 7200000).toISOString(),
    budgetLimitUsdMicros: "10000",
    healthIntervalSeconds: 60,
    incidentBudgetLimitUsdMicros: "1000",
    backup: {
      destinationId: "fixture-backups",
      recipient,
      retentionDays: 7,
      costUsdMicros: "10",
      schedule: { cron: "0 2 * * *", timezone: "Europe/Berlin" },
    },
    update: {
      candidate: {
        class: "patch",
        currentVersion: "1.0.0",
        currentManifestSha256: "a".repeat(64),
        version: "1.0.1",
        manifestSha256: "c".repeat(64),
        costUsdMicros: "20",
      },
      schedule: { cron: "* * * * *", timezone: "Europe/Berlin" },
    },
  };
  const service = () => new WebsiteCareService({ repo, directory, secrets, now: () => new Date(clock) });
  cleanup.push(async () => {
    await repo.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get repo() {
      return repo;
    },
    directory,
    scope,
    order,
    ceoId: setup.ceo.id,
    profile,
    mandate,
    input,
    service,
    calls,
    backups,
    runtimeFile,
    port: new HostingCareHttpClient(secrets),
    set unhealthy(value: boolean) {
      unhealthy = value;
    },
    set badUpdate(value: boolean) {
      badUpdate = value;
    },
    set loseUpdate(value: boolean) {
      loseUpdate = value;
    },
    set wrongProbe(value: boolean) {
      wrongProbe = value;
    },
    setClock(value: string) {
      clock = Date.parse(value);
    },
    advance(ms: number) {
      clock += ms;
    },
    async restart() {
      await repo.close();
      repo = await Repository.open(path.join(directory, "company.sqlite"));
    },
  };
}
it("performs actual TLS health, age encryption/restore and a bound runtime patch under a separate care order", async () => {
  const f = await fixture(),
    policy = await f.service().configure(f.scope, f.order.id, f.ceoId, f.input);
  expect(policy.careOrderId).not.toBe(f.order.id);
  const checked = await f.service().run(f.scope, f.order.id, f.ceoId, policy.id, "check");
  expect(checked.state, JSON.stringify(await f.repo.listDocuments(f.scope, "action"))).toBe("succeeded");
  const result = await f.service().run(f.scope, f.order.id, f.ceoId, policy.id, "update");
  expect(result.state).toBe("succeeded");
  expect(f.calls.map((c) => c.split("/").at(-1))).toEqual(["backups", "restore-probe", "maintenance"]);
  expect(JSON.parse(await readFile(f.runtimeFile, "utf8"))).toMatchObject({
    version: "1.0.1",
    manifestSha256: "c".repeat(64),
  });
  expect(await f.repo.budget(f.scope.companyId)).toMatchObject({ spentUsdMicros: "30" });
  const serialized = JSON.stringify(await f.service().status(f.scope, f.order.id));
  expect(serialized).not.toContain("care-fixture-token");
  expect(serialized).not.toContain("AGE-SECRET-KEY");
});
it("actually rolls back a failed post-update health check and does not label the candidate installed", async () => {
  const f = await fixture();
  f.badUpdate = true;
  const policy = await f.service().configure(f.scope, f.order.id, f.ceoId, f.input);
  const result = await f.service().run(f.scope, f.order.id, f.ceoId, policy.id, "update");
  expect(result.state, JSON.stringify({ calls: f.calls, actions: await f.repo.listDocuments(f.scope, "action") })).toBe(
    "rolled_back",
  );
  expect(JSON.parse(await readFile(f.runtimeFile, "utf8"))).toMatchObject({ version: "1.0.0" });
  expect(f.calls.at(-1)).toContain("rollback");
});
it("does not apply a patch after an invalid isolated restore proof", async () => {
  const f = await fixture();
  f.wrongProbe = true;
  const policy = await f.service().configure(f.scope, f.order.id, f.ceoId, f.input);
  const result = await f.service().run(f.scope, f.order.id, f.ceoId, policy.id, "update");
  expect(result.state).toBe("effect_unknown");
  expect(f.calls.some((c) => c.endsWith("/maintenance"))).toBe(false);
});
it("preserves unknown update effects across restart and never retries the request or blind rollback", async () => {
  const f = await fixture();
  f.loseUpdate = true;
  const policy = await f.service().configure(f.scope, f.order.id, f.ceoId, f.input);
  expect((await f.service().run(f.scope, f.order.id, f.ceoId, policy.id, "update")).state).toBe("effect_unknown");
  const count = f.calls.length;
  await f.restart();
  f.advance(3600000);
  await f.service().tickCompany(f.scope.companyId);
  expect(f.calls).toHaveLength(count);
  expect(f.calls.some((c) => c.endsWith("/rollback"))).toBe(false);
});
it("deduplicates recurring health alarms into one linked incident while keeping cause unknown", async () => {
  const f = await fixture();
  f.unhealthy = true;
  const policy = await f.service().configure(f.scope, f.order.id, f.ceoId, f.input);
  expect((await f.service().run(f.scope, f.order.id, f.ceoId, policy.id, "check")).state).toBe("failed");
  f.advance(61000);
  await f.service().tickCompany(f.scope.companyId);
  const incidents = await f.repo.listDocuments<{ cause: { status: string } }>(f.scope, "incident");
  expect(incidents).toHaveLength(1);
  expect(incidents[0]!.data.cause.status).toBe("unknown");
});
it("requires a mandate, prevents overlapping active policies atomically and blocks restore-generation reuse", async () => {
  const f = await fixture();
  await expect(
    f.service().configure(f.scope, f.order.id, f.ceoId, { ...f.input, mandateId: randomUUID() }),
  ).rejects.toMatchObject({ code: "care_mandate_invalid" });
  const outcomes = await Promise.allSettled([
    f.service().configure(f.scope, f.order.id, f.ceoId, f.input),
    f.service().configure(f.scope, f.order.id, f.ceoId, f.input),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  const policy = (await f.service().status(f.scope, f.order.id)).policies[0]!;
  await f.repo.putDocument(f.scope, "recovery-state", f.scope.companyId, {
    generation: randomUUID(),
    dispatchPaused: false,
  });
  await expect(f.service().run(f.scope, f.order.id, f.ceoId, policy.id, "backup")).rejects.toMatchObject({
    code: "care_authorization_changed",
  });
  expect(f.calls).toHaveLength(0);
});
it("blocks a revoked mandate after secret resolution and an expired schedule without provider writes", async () => {
  const f = await fixture(),
    policy = await f.service().configure(f.scope, f.order.id, f.ceoId, f.input);
  const port = new HostingCareHttpClient({
      resolve: async () => {
        await f.repo.revokeMandate(f.scope, f.mandate.id, 1);
        return "care-fixture-token";
      },
    }),
    service = new WebsiteCareService({ repo: f.repo, directory: f.directory, port });
  await service.run(f.scope, f.order.id, f.ceoId, policy.id, "backup");
  expect(f.calls).toHaveLength(0);
  f.advance(86400000);
  await f.service().tickCompany(f.scope.companyId);
  expect(f.calls).toHaveLength(0);
});
it("exposes care through real CEO session, CSRF and revision guarded HTTP without unauthorised dispatch", async () => {
  const f = await fixture(true),
    app = createApp({
      repo: f.repo,
      directory: f.directory,
      publicOrigin: "http://127.0.0.1:8790",
      websiteCareService: f.service(),
    }),
    agent = request.agent(app),
    base = `/api/v1/orders/${f.order.id}/website-care`;
  await agent.get(base).expect(401);
  const login = await agent.post("/api/v1/session").send({ password: "care-fixture-password-1234" }).expect(200);
  await agent.post(base).send(f.input).expect(403);
  const headers = { "X-CSRF-Token": login.body.csrfToken, "Idempotency-Key": randomUUID() };
  const configured = await agent.post(base).set(headers).send(f.input).expect(200);
  const replay = await agent.post(base).set(headers).send(f.input).expect(200);
  expect(replay.body.id).toBe(configured.body.id);
  expect(f.calls).toEqual([]);
  await agent
    .put(`${base}/${configured.body.id}`)
    .set({ "X-CSRF-Token": login.body.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": "0" })
    .send(f.input)
    .expect(400);
  const checked = await agent
    .post(`${base}/${configured.body.id}/run`)
    .set({ "X-CSRF-Token": login.body.csrfToken, "Idempotency-Key": randomUUID() })
    .send({ kind: "check" })
    .expect(200);
  expect(checked.body.state).toBe("succeeded");
  const listed = await agent.get(base).expect(200);
  expect(listed.body.policies[0]).toMatchObject({ careOrderId: configured.body.id, revision: 1 });
  expect(JSON.stringify(listed.body)).not.toContain("care-fixture-token");
});
it("persists bounded cron slots across restart and never catches up an update outside its approved window", async () => {
  const f = await fixture();
  const policy = await f.service().configure(f.scope, f.order.id, f.ceoId, {
    ...f.input,
    healthIntervalSeconds: 3600,
    backup: { ...f.input.backup, schedule: { cron: "* * * * *", timezone: "Europe/Berlin" } },
    update: undefined,
  });
  await f.service().tickCompany(f.scope.companyId);
  f.advance(61000);
  await f.service().tickCompany(f.scope.companyId);
  expect(f.calls).toHaveLength(2);
  await f.restart();
  await f.service().tickCompany(f.scope.companyId);
  expect(f.calls).toHaveLength(2);
  const state = await f.repo.getDocument<Record<string, string>>(f.scope, "website-care-state", policy.id);
  expect(Date.parse(String(state!.data.nextBackupAt))).toBeGreaterThan(Date.parse(String(state!.data.lastBackupAt)));
  const second = await fixture();
  second.setClock("2026-09-07T12:00:00.000Z");
  const p = await second.service().configure(second.scope, second.order.id, second.ceoId, {
    ...second.input,
    expiresAt: "2026-09-07T14:00:00.000Z",
    update: { ...second.input.update, schedule: { cron: "0 3 * * 1", timezone: "Europe/Berlin" }, windowMinutes: 5 },
  });
  await expect(second.service().run(second.scope, second.order.id, second.ceoId, p.id, "update")).rejects.toMatchObject(
    { code: "care_update_outside_window" },
  );
  const before = await second.repo.getDocument<Record<string, string>>(second.scope, "website-care-state", p.id);
  await second.repo.putDocument(
    second.scope,
    "website-care-state",
    p.id,
    { ...before!.data, nextUpdateAt: "2026-09-07T01:00:00.000Z" },
    { expectedRevision: before!.revision },
  );
  await second.service().tickCompany(second.scope.companyId);
  expect(second.calls).toEqual([]);
  expect(
    (await second.repo.getDocument<Record<string, string>>(second.scope, "website-care-state", p.id))!.data,
  ).toMatchObject({
    nextUpdateAt: "2026-09-14T01:00:00.000Z",
    lastError: "care_update_window_missed",
  });
});
