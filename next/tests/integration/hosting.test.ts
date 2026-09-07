import { afterEach, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../apps/control/app.ts";
import { hashPassword } from "../../apps/control/auth.ts";
import { createServer, type Server } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { x } from "tar";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import type { ApprovalBinding, Scope, ToolAction } from "../../packages/contracts/src/index.ts";
import { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";
import { HostingService } from "../../apps/control/hosting-service.ts";
import {
  HostingHttpClient,
  type HostingProfile,
  type HostingPackage,
} from "../../packages/integrations/src/hosting.ts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let directory: string,
  repo: Repository,
  setup: SetupResult,
  scope: Scope,
  server: Server,
  service: HostingService,
  profile: HostingProfile;
let calls: string[],
  html: Buffer,
  proof: Record<string, string>,
  wrongContent: boolean,
  wrongProof: boolean,
  malformed: boolean,
  hang: boolean;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-hosting-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(directory, "key.pem"),
      "-out",
      path.join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  calls = [];
  html = Buffer.from("previous deployment");
  proof = {};
  wrongContent = false;
  wrongProof = false;
  malformed = false;
  hang = false;
  server = createServer(
    { key: await readFile(path.join(directory, "key.pem")), cert: await readFile(path.join(directory, "cert.pem")) },
    async (req, res) => {
      try {
        if (req.method === "GET") {
          if (req.url === "/") {
            res.setHeader("content-type", "text/html");
            res.end(wrongContent ? "<h1>Wrong content</h1>" : html);
            return;
          }
          if (req.url === "/.well-known/ironcrew-deployment.json") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(wrongProof ? { ...proof, packageSha256: "0".repeat(64) } : proof));
            return;
          }
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.headers.authorization !== "Bearer fixture-hosting-token") {
          res.writeHead(401);
          res.end();
          return;
        }
        calls.push(req.url!);
        let body = "";
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        expect(input.protocolVersion).toBe(1);
        expect(input.actionId).toMatch(/^[a-f0-9-]+$/);
        res.setHeader("content-type", "application/json");
        if (malformed) {
          res.end(JSON.stringify({ success: true }));
          return;
        }
        if (req.url === "/broker/v1/resources") {
          await writeFile(path.join(directory, "resource.json"), JSON.stringify(input));
          if (hang) return;
          res.end(
            JSON.stringify({
              id: "resource-1",
              publicUrl: profile.publicUrl,
              stack: profile.stack,
              monthlyCostUsdMicros: "0",
              state: "ready",
            }),
          );
          return;
        }
        if (req.url === "/broker/v1/resources/resource-1/deployments") {
          const archive = Buffer.from(input.archiveBase64, "base64");
          expect(hash(archive)).toBe(input.archiveSha256);
          const dest = path.join(directory, `deployment-${input.actionId}`);
          await mkdir(dest);
          const file = path.join(directory, `${input.actionId}.tgz`);
          await writeFile(file, archive);
          await x({ file, cwd: dest, strict: true });
          await writeFile(path.join(directory, "previous.html"), html);
          html = await readFile(path.join(dest, "index.html"));
          proof = {
            artifactVersionId: input.artifactVersionId,
            packageSha256: input.packageSha256,
            archiveSha256: input.archiveSha256,
          };
          res.end(
            JSON.stringify({
              id: input.actionId,
              resourceId: "resource-1",
              publicUrl: profile.publicUrl,
              ...proof,
              rollbackRef: "previous-html",
            }),
          );
          return;
        }
        if (req.url === "/broker/v1/resources/resource-1/rollback") {
          html = await readFile(path.join(directory, "previous.html"));
          res.end(JSON.stringify({ rollbackRef: input.rollbackRef, state: "accepted" }));
          return;
        }
        res.writeHead(404);
        res.end();
      } catch {
        res.writeHead(500);
        res.end();
      }
    },
  );
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  setup = await repo.setup({
    companyName: "Hosting fixture",
    ceoName: "CEO",
    passwordHash: await hashPassword("fixture-password-1234"),
    timezone: "UTC",
    budgetLimitUsdMicros: "1000000",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  service = new HostingService({ repo, directory, secrets: { resolve: async () => "fixture-hosting-token" } });
  profile = await service.configureProfile(scope, setup.ceo.id, {
    name: "Local TLS broker",
    scope,
    provider: "ironcrew-hosting-v1",
    endpoint: `https://localhost:${address.port}/broker`,
    publicUrl: `https://localhost:${address.port}/`,
    secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "token" },
    trustedCaPem: await readFile(path.join(directory, "cert.pem"), "utf8"),
    expectedDnsAddresses: ["127.0.0.1", "::1"],
    stack: "static",
    plan: "fixture",
    monthlyCostLimitUsdMicros: "0",
    healthContains: ["Hosting fixture"],
    timeoutMs: 2000,
  });
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo?.close();
  await rm(directory, { recursive: true, force: true });
});
async function approve(id: string) {
  const pending = await repo.getDocument<{ binding: ApprovalBinding }>(scope, "approval-request", id);
  const approved = await repo.approve(scope, pending!.data.binding);
  const action = await repo.getDocument<ToolAction>(scope, "action", id);
  await repo.putDocument(
    scope,
    "action",
    id,
    { ...action!.data, approvalId: approved.id, status: "authorized" },
    { expectedRevision: action!.revision },
  );
}
async function prepared() {
  const order = await repo.createOrder(scope, { kind: "website", goal: "Hosting fixture", budgetLimitUsdMicros: "0" }),
    web = new WebsiteWorkflow(repo, directory);
  await web.create(scope, order.id, "Hosting fixture briefing");
  const concepts = await web.concepts(scope, order.id, [
    {
      name: "One",
      rationale: "One",
      html: '<!doctype html><html lang="de"><meta name="viewport" content="width=device-width"><title>Hosting fixture</title><h1>Hosting fixture</h1></html>',
    },
    { name: "Two", rationale: "Two", html: "<h1>Other</h1>" },
  ]);
  await web.select(scope, order.id, concepts.data.concepts[0]!.id);
  const artifact = await web.build(scope, order.id);
  await web.review(scope, order.id, {
    artifactVersionId: artifact.id,
    reviewerId: setup.ceo.id,
    reviewerKind: "ceo",
    checks: ["mobile", "functional", "quality"].map((name) => ({
      name,
      passed: true,
      evidence: "Local fixture checked",
    })),
  });
  await web.accept(scope, order.id, artifact.id);
  const mandate = await repo.createMandate({
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["hosting.provision", "website.publish", "hosting.rollback"],
    targetIds: [profile.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxAttempts: 3,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  });
  const request = { actionId: randomUUID(), profileId: profile.id, mandateId: mandate.id, mandateVersion: 1 };
  return { order, artifact, request };
}
async function provision(f: Awaited<ReturnType<typeof prepared>>) {
  expect((await service.provision(scope, f.order.id, f.request)).state).toBe("approval");
  expect(calls).toHaveLength(0);
  await approve(f.request.actionId);
  expect((await service.provision(scope, f.order.id, f.request)).state).toBe("succeeded");
}
it("transfers a real immutable archive only after distinct approvals, verifies DNS/TLS/version/content, persists receipts and replays once", async () => {
  const f = await prepared();
  await provision(f);
  const input = {
    ...f.request,
    actionId: randomUUID(),
    artifactVersionId: f.artifact.id,
    packageSha256: f.artifact.packageSha256,
  };
  expect((await service.publish(scope, f.order.id, input)).state).toBe("approval");
  expect(calls).toHaveLength(1);
  const action = await repo.getDocument<ToolAction>(scope, "action", input.actionId);
  expect(action?.data.args).toMatchObject({
    profileFingerprint: profile.fingerprint,
    publicUrl: profile.publicUrl,
    artifactVersionId: f.artifact.id,
    packageSha256: f.artifact.packageSha256,
  });
  await approve(input.actionId);
  expect((await service.publish(scope, f.order.id, input)).state).toBe("succeeded");
  expect(html.toString()).toContain("Hosting fixture");
  const status = await service.status(scope, f.order.id);
  expect(status.deployments[0]).toMatchObject({
    state: "verified",
    health: { httpsVerified: true, functionalCheckPassed: true, bodySha256: f.artifact.sha256 },
  });
  expect((status.deployments[0]!.health as { tlsFingerprint256: string }).tlsFingerprint256).toMatch(
    /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/,
  );
  expect((await service.publish(scope, f.order.id, input)).state).toBe("succeeded");
  expect(calls).toHaveLength(2);
  const rollback = { ...f.request, actionId: randomUUID(), deploymentId: status.deployments[0]!.id };
  expect((await service.rollback(scope, f.order.id, rollback)).state).toBe("approval");
  await approve(rollback.actionId);
  expect((await service.rollback(scope, f.order.id, rollback)).data).toMatchObject({
    state: "accepted",
    requiresFreshHealthCheck: true,
  });
  expect(html.toString()).toBe("previous deployment");
});
it.each(["content", "proof"])(
  "keeps a %s health mismatch effect_unknown and never deploys again automatically",
  async (fault) => {
    const f = await prepared();
    await provision(f);
    const input = {
      ...f.request,
      actionId: randomUUID(),
      artifactVersionId: f.artifact.id,
      packageSha256: f.artifact.packageSha256,
    };
    await service.publish(scope, f.order.id, input);
    await approve(input.actionId);
    wrongContent = fault === "content";
    wrongProof = fault === "proof";
    expect((await service.publish(scope, f.order.id, input)).state).toBe("effect_unknown");
    expect((await service.status(scope, f.order.id)).deployments[0]?.state).toBe("effect_unknown");
    expect((await service.publish(scope, f.order.id, input)).state).toBe("effect_unknown");
    expect(calls).toHaveLength(2);
    expect((await repo.getDocument<{ state: string }>(scope, "website", f.order.id))?.data.state).toBe("accepted");
  },
);
it("rejects changed profiles, wrong scope and tampered artifact bindings before HTTP", async () => {
  const f = await prepared();
  await provision(f);
  const input = {
    ...f.request,
    actionId: randomUUID(),
    artifactVersionId: f.artifact.id,
    packageSha256: f.artifact.packageSha256,
  };
  await service.publish(scope, f.order.id, input);
  await approve(input.actionId);
  await expect(service.publish(scope, f.order.id, { ...input, packageSha256: "0".repeat(64) })).rejects.toThrow(
    "hosting_artifact_mismatch",
  );
  const { id: _id, fingerprint: _fp, configuredAt: _at, configuredBy: _by, ...config } = profile;
  await service.configureProfile(
    scope,
    setup.ceo.id,
    { ...config, plan: "changed" },
    { id: profile.id, expectedRevision: 1 },
  );
  await expect(service.publish(scope, f.order.id, input)).rejects.toThrow("hosting_provision_required");
  await expect(service.status({ ...scope, areaId: setup.areas[1]!.id }, f.order.id)).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
it("rejects a provider success envelope without a typed resource and does not create fake provisioning records", async () => {
  const f = await prepared();
  await service.provision(scope, f.order.id, f.request);
  await approve(f.request.actionId);
  malformed = true;
  expect((await service.provision(scope, f.order.id, f.request)).state).toBe("effect_unknown");
  expect((await service.status(scope, f.order.id)).resources).toHaveLength(0);
});
it("performs actual DNS and trusted certificate checks; wrong addresses and untrusted CA fail closed", async () => {
  const client = new HostingHttpClient(),
    artifact: HostingPackage = {
      artifactVersionId: randomUUID(),
      archive: Buffer.from("fixture"),
      archiveSha256: hash(Buffer.from("fixture")),
      packageSha256: "a".repeat(64),
      entrySha256: hash(html),
    };
  proof = {
    artifactVersionId: artifact.artifactVersionId,
    packageSha256: artifact.packageSha256,
    archiveSha256: artifact.archiveSha256,
  };
  const deployment = {
    id: "fixture",
    resourceId: "fixture",
    publicUrl: profile.publicUrl,
    ...proof,
    rollbackRef: "previous",
  } as Parameters<HostingHttpClient["verify"]>[1];
  await expect(
    client.verify({ ...profile, expectedDnsAddresses: ["192.0.2.1"] }, deployment, artifact),
  ).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  await expect(client.verify({ ...profile, trustedCaPem: undefined }, deployment, artifact)).rejects.toMatchObject({
    effectStatus: "effect_unknown",
  });
});

it("requires session, CSRF and idempotency for API profile and deployment actions", async () => {
  const app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790", hostingService: service }),
    agent = request.agent(app);
  await agent.get("/api/v1/hosting/profiles").expect(401);
  const login = await agent.post("/api/v1/session").send({ password: "fixture-password-1234" }).expect(200),
    csrf = login.body.csrfToken;
  const headers = () => ({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() });
  expect((await agent.get("/api/v1/hosting/profiles").expect(200)).body.items[0].fingerprint).toBe(profile.fingerprint);
  const { id: _id, fingerprint: _fp, configuredAt: _at, configuredBy: _by, ...config } = profile;
  await agent.post("/api/v1/hosting/profiles").send(config).expect(403);
  const created = await agent
    .post("/api/v1/hosting/profiles")
    .set(headers())
    .send({ ...config, name: "Another target" })
    .expect(200);
  expect(created.body.id).toMatch(/^[a-f0-9-]+$/);
  await agent
    .put(`/api/v1/hosting/profiles/${created.body.id}`)
    .set(headers())
    .set("If-Match", "99")
    .send(config)
    .expect(409);
  const f = await prepared();
  const pending = await agent
    .post(`/api/v1/orders/${f.order.id}/hosting/provision`)
    .set(headers())
    .send(f.request)
    .expect(200);
  expect(pending.body.state).toBe("approval");
  expect(calls).toHaveLength(0);
  await approve(f.request.actionId);
  await agent.post(`/api/v1/orders/${f.order.id}/hosting/provision`).set(headers()).send(f.request).expect(200);
  const input = {
    ...f.request,
    actionId: randomUUID(),
    artifactVersionId: f.artifact.id,
    packageSha256: f.artifact.packageSha256,
  };
  expect(
    (await agent.post(`/api/v1/orders/${f.order.id}/hosting/publish`).set(headers()).send(input).expect(200)).body
      .state,
  ).toBe("approval");
  await approve(input.actionId);
  expect(
    (await agent.post(`/api/v1/orders/${f.order.id}/hosting/publish`).set(headers()).send(input).expect(200)).body
      .state,
  ).toBe("succeeded");
  expect((await agent.get(`/api/v1/orders/${f.order.id}/hosting`).expect(200)).body.deployments[0].state).toBe(
    "verified",
  );
});
it("admits only one approved provisioning intent for a target under concurrency", async () => {
  const f = await prepared(),
    second = { ...f.request, actionId: randomUUID() };
  await service.provision(scope, f.order.id, f.request);
  await service.provision(scope, f.order.id, second);
  await approve(f.request.actionId);
  await approve(second.actionId);
  const outcomes = await Promise.allSettled([
    service.provision(scope, f.order.id, f.request),
    service.provision(scope, f.order.id, second),
  ]);
  expect(outcomes.filter((x) => x.status === "fulfilled" && x.value.state === "succeeded")).toHaveLength(1);
  expect(calls).toHaveLength(1);
});

it("retains unknown after the broker creates a resource but loses its response", async () => {
  const { id: _id, fingerprint: _fp, configuredAt: _at, configuredBy: _by, ...config } = profile;
  profile = await service.configureProfile(
    scope,
    setup.ceo.id,
    { ...config, timeoutMs: 100 },
    { id: profile.id, expectedRevision: 1 },
  );
  const f = await prepared();
  await service.provision(scope, f.order.id, f.request);
  await approve(f.request.actionId);
  hang = true;
  expect((await service.provision(scope, f.order.id, f.request)).state).toBe("effect_unknown");
  expect(JSON.parse(await readFile(path.join(directory, "resource.json"), "utf8")).actionId).toBe(f.request.actionId);
  expect((await service.provision(scope, f.order.id, f.request)).state).toBe("effect_unknown");
  expect(calls).toHaveLength(1);
});
it("does not incur a monthly commitment beyond the explicit mandate ceiling", async () => {
  const { id: _id, fingerprint: _fp, configuredAt: _at, configuredBy: _by, ...config } = profile;
  profile = await service.configureProfile(
    scope,
    setup.ceo.id,
    { ...config, monthlyCostLimitUsdMicros: "1000000" },
    { id: profile.id, expectedRevision: 1 },
  );
  const f = await prepared();
  await service.provision(scope, f.order.id, f.request);
  await approve(f.request.actionId);
  expect((await service.provision(scope, f.order.id, f.request)).state).toBe("failed");
  expect(calls).toHaveLength(0);
  expect((await service.status(scope, f.order.id)).resources).toHaveLength(0);
});
