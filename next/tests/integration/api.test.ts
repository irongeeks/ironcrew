import { beforeEach, afterEach, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
let directory: string, repo: Repository, app: ReturnType<typeof createApp>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-api-"));
  repo = await Repository.open(path.join(directory, "db.sqlite"));
  app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" });
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
it("protects setup/session and enforces CSRF, idempotency, scope and revisions", async () => {
  await request(app).get("/api/v1/orders").expect(401);
  await request(app).get("/api/v1/setup").expect(401);
  const token = await issueSetupToken(directory);
  const agent = request.agent(app);
  const setup = await agent
    .post("/api/v1/setup")
    .send({
      token,
      companyName: "Fixture Firma",
      ceoName: "Fixture CEO",
      password: "fixture-password-123",
      locale: "de",
      timezone: "Europe/Berlin",
    })
    .expect(200);
  const csrf = setup.body.csrfToken as string;
  expect(setup.body.employees).toHaveLength(9);
  await agent.post("/api/v1/setup").send({}).expect(409);
  const scope = { companyId: setup.body.company.id, areaId: setup.body.areas[0].id };
  const body = { kind: "research", goal: "Prüfauftrag", budgetLimitUsdMicros: "0", scope };
  await agent.post("/api/v1/orders").send(body).expect(403);
  const key = randomUUID();
  const created = await agent
    .post("/api/v1/orders")
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", key)
    .send(body)
    .expect(200);
  const repeated = await agent
    .post("/api/v1/orders")
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", key)
    .send(body)
    .expect(200);
  expect(repeated.body.id).toBe(created.body.id);
  await agent
    .post("/api/v1/orders")
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", key)
    .send({ ...body, goal: "Anders" })
    .expect(409);
  expect((await agent.get("/api/v1/orders")).body.items).toHaveLength(1);
  await agent
    .post("/api/v1/orders")
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", randomUUID())
    .send({ ...body, scope: { ...scope, companyId: randomUUID() } })
    .expect(403);
  await agent
    .post(`/api/v1/orders/${created.body.id}/transition`)
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", randomUUID())
    .set("If-Match", "99")
    .send({ status: "ready" })
    .expect(409);
});

it("reports a stable process identity and the administratively verified release identity", async () => {
  const verified = { version: "0.4.1", releaseManifestSha256: "a".repeat(64) };
  const releaseApp = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790", releaseIdentity: verified });
  const first = await request(releaseApp).get("/api/v1/health").expect(200);
  const second = await request(releaseApp).get("/api/v1/health").expect(200);
  const another = await request(app).get("/api/v1/health").expect(200);
  expect(first.body).toMatchObject(verified);
  expect(first.body.instanceId).toBe(second.body.instanceId);
  expect(first.body.instanceId).not.toBe(another.body.instanceId);
  expect(another.body.releaseManifestSha256).toBeUndefined();
});

it("drains administrative update-result writes and refuses a concurrent backup snapshot", async () => {
  const agent = request.agent(app);
  const token = await issueSetupToken(directory);
  const setup = await agent
    .post("/api/v1/setup")
    .send({
      token,
      companyName: "Update coordination fixture",
      ceoName: "CEO",
      password: "fixture-password-1234",
      timezone: "UTC",
    })
    .expect(200);
  let continueOperation!: () => void;
  const wait = new Promise<void>((resolve) => {
    continueOperation = resolve;
  });
  let finished = false;
  const operation = app.locals.runAdministrativeTask(async () => {
    await wait;
    finished = true;
  });
  try {
    const backup = await agent
      .post("/api/v1/backups")
      .set({ "X-CSRF-Token": setup.body.csrfToken, "Idempotency-Key": randomUUID() })
      .send({ ageExecutable: "/unused/age", recipient: "age1fixture", outputDirectory: directory + "-backups" })
      .expect(409);
    expect(backup.body.code).toBe("backup_busy");
    let drained = false;
    const drain = app.locals.drainWrites().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    expect(drained).toBe(false);
    continueOperation();
    await operation;
    await drain;
    expect(finished).toBe(true);
    expect(
      await app.locals.runAdministrativeTask(async () => {
        throw new Error("must not run after shutdown");
      }),
    ).toBe(false);
  } finally {
    continueOperation();
    await operation;
  }
});

it("serves only unchanged artifact bytes and returns their verified digest", async () => {
  const agent = request.agent(app),
    token = await issueSetupToken(directory);
  const setup = await agent
    .post("/api/v1/setup")
    .send({
      token,
      companyName: "Artifact wire fixture",
      ceoName: "CEO",
      password: "fixture-password-1234",
      timezone: "UTC",
    })
    .expect(200);
  const scope = { companyId: setup.body.company.id, areaId: setup.body.areas[0].id };
  const content = Buffer.from("immutable fixture artifact"),
    hash = createHash("sha256").update(content).digest("hex"),
    id = randomUUID();
  await mkdir(path.join(directory, "blobs"));
  await writeFile(path.join(directory, "blobs", hash), content);
  await repo.putDocument(
    scope,
    "artifact",
    id,
    { id, scope, sha256: hash, mediaType: "text/plain", bytes: content.length },
    { immutable: true },
  );
  const original = await agent.get(`/api/v1/artifacts/${id}/download`).expect(200);
  expect(original.body).toEqual(content);
  expect(original.headers["x-content-sha256"]).toBe(hash);
  await writeFile(path.join(directory, "blobs", hash), "changed after staging");
  const changed = await agent.get(`/api/v1/artifacts/${id}/download`).expect(409);
  expect(changed.body.code).toBe("artifact_content_changed");
});
