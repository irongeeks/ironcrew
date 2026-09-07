import { beforeEach, afterEach, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import type { ApprovalBinding, Scope, ToolAction } from "../../packages/contracts/src/index.ts";
let directory: string,
  repo: Repository,
  app: ReturnType<typeof createApp>,
  agent: ReturnType<typeof request.agent>,
  setup: SetupResult,
  csrf: string,
  scope: Scope;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "control-hardening-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" });
  agent = request.agent(app);
  const token = await issueSetupToken(directory),
    response = await agent
      .post("/api/v1/setup")
      .send({
        token,
        companyName: "Control fixture",
        ceoName: "Fixture CEO",
        password: "fixture-password-1234",
        timezone: "Europe/Berlin",
      })
      .expect(200);
  setup = response.body as SetupResult;
  csrf = response.body.csrfToken as string;
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const headers = () => ({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() });
async function pendingApproval(targetScope: Scope) {
  const order = await repo.createOrder(targetScope, {
    kind: "research",
    goal: "Scoped approval",
    budgetLimitUsdMicros: "0",
  });
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope: targetScope,
    allowedToolIds: ["fixture.send"],
    targetIds: [order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 1,
    maxDurationSeconds: 30,
    maxCostUsdMicros: "0",
  };
  await repo.createMandate(mandate);
  const args = { text: "Exact proposed message" },
    action: ToolAction = {
      id: randomUUID(),
      runId: order.id,
      orderId: order.id,
      scope: targetScope,
      toolId: "fixture.send",
      toolVersion: 1,
      args,
      argumentsSha256: sha256(args),
      status: "proposed",
      mandateId: mandate.id,
      mandateVersion: 1,
      evidenceRefs: [],
    };
  await repo.putDocument(targetScope, "action", action.id, action);
  const binding: ApprovalBinding = {
    companyId: targetScope.companyId,
    orderId: order.id,
    mandateId: mandate.id,
    mandateVersion: 1,
    actionId: action.id,
    targetId: order.id,
    argumentsSha256: action.argumentsSha256,
    expiresAt: mandate.expiresAt,
  };
  await repo.putDocument(targetScope, "approval-request", action.id, { id: action.id, binding, status: "pending" });
  return action;
}
it("allows the authenticated CEO to decide a private-area approval by its exact persisted scope", async () => {
  const privateScope = { ...scope, areaId: setup.areas[1]!.id },
    action = await pendingApproval(privateScope);
  await agent
    .post(`/api/v1/approvals/${action.id}/decision`)
    .set(headers())
    .set("If-Match", "1")
    .send({ decision: "approved" })
    .expect(200);
  expect((await repo.getDocument<ToolAction>(privateScope, "action", action.id))?.data.status).toBe("authorized");
});
it("lists project-scoped pending approvals for the authenticated CEO", async () => {
  const projectId = randomUUID();
  await repo.putDocument(scope, "project", projectId, { id: projectId, name: "Project fixture" });
  const action = await pendingApproval({ ...scope, projectId });
  const response = await agent.get("/api/v1/approvals").expect(200);
  expect(response.body.items.map((item: { id: string }) => item.id)).toContain(action.id);
});
it("rejects a stale plan without persisting an orphan immutable plan version", async () => {
  const order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Planning fixture",
    budgetLimitUsdMicros: "0",
  });
  await agent
    .post(`/api/v1/orders/${order.id}/plan`)
    .set(headers())
    .set("If-Match", "999")
    .send({ steps: ["Read source"], acceptanceCriteria: ["Source checked"] })
    .expect(409);
  expect(await repo.listDocuments(scope, "plan")).toHaveLength(0);
  expect((await repo.getOrder(scope, order.id)).planVersion).toBe(0);
});
it("increments public employee revision on the first edit and rejects the original stale version", async () => {
  const id = setup.employees[0]!.id;
  const first = await agent
    .patch(`/api/v1/employees/${id}`)
    .set(headers())
    .set("If-Match", "1")
    .send({ persona: "First edited persona" })
    .expect(200);
  expect(first.body.revision).toBe(2);
  await agent
    .patch(`/api/v1/employees/${id}`)
    .set(headers())
    .set("If-Match", "1")
    .send({ persona: "Stale overwrite" })
    .expect(409);
});
it("replays a known validation failure under the same key rather than claiming an unknown effect", async () => {
  const key = randomUUID(),
    body = { limitUsdMicros: "invalid", startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-10-01T00:00:00Z" };
  const first = await agent
    .post("/api/v1/budget")
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", key)
    .send(body)
    .expect(400);
  const repeated = await agent
    .post("/api/v1/budget")
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", key)
    .send(body)
    .expect(400);
  expect(repeated.body.code).toBe(first.body.code);
});
it("does not consume the one-time setup token for an invalid timezone", async () => {
  const freshDirectory = path.join(directory, "fresh"),
    freshRepo = await Repository.open(path.join(freshDirectory, "company.sqlite"));
  try {
    const freshApp = createApp({ repo: freshRepo, directory: freshDirectory, publicOrigin: "http://127.0.0.1:8790" }),
      token = await issueSetupToken(freshDirectory);
    const body = {
      token,
      companyName: "Fresh fixture",
      ceoName: "CEO",
      password: "fixture-password-1234",
      timezone: "Invalid/Zone",
    };
    await request(freshApp).post("/api/v1/setup").send(body).expect(400);
    await request(freshApp)
      .post("/api/v1/setup")
      .send({ ...body, timezone: "Europe/Berlin" })
      .expect(200);
  } finally {
    await freshRepo.close();
  }
});

it("does not persist the plaintext enrollment credential in the API idempotency cache", async () => {
  const token = "fixture-worker-token-that-must-remain-hashed-centrally";
  let enrollments = 0;
  const workers = {
    enroll: async () => {
      enrollments++;
      return { workerId: randomUUID(), token, generation: 1 };
    },
  } as unknown as import("../../apps/control/worker-server.ts").WorkerServer;
  const workerApp = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790", workers: async () => workers });
  const workerAgent = request.agent(workerApp);
  const session = await workerAgent.post("/api/v1/session").send({ password: "fixture-password-1234" }).expect(200);
  const enrollmentKey = randomUUID();
  const enrolled = await workerAgent
    .post("/api/v1/workers/enroll")
    .set("X-CSRF-Token", session.body.csrfToken as string)
    .set("Idempotency-Key", enrollmentKey)
    .send({ name: "Fixture worker", capabilities: ["workspace.read"] })
    .expect(200);
  expect(enrolled.body.token).toBe(token);
  await workerAgent
    .post("/api/v1/workers/enroll")
    .set("X-CSRF-Token", session.body.csrfToken as string)
    .set("Idempotency-Key", enrollmentKey)
    .send({ name: "Fixture worker", capabilities: ["workspace.read"] })
    .expect(410);
  expect(enrollments).toBe(1);
  const requests = await repo.listDocuments(scope, "request");
  expect(JSON.stringify(requests)).not.toContain(token);
});

it("prepares and corrects a private voucher in its persisted scope", async () => {
  const privateScope = { ...scope, areaId: setup.areas[1]!.id };
  const order = await repo.createOrder(privateScope, {
    kind: "finance",
    goal: "Private voucher",
    budgetLimitUsdMicros: "0",
  });
  const original = Buffer.from("%PDF-1.7\nfixture original\n%%EOF");
  const { digest } = await import("../../packages/tools/workspace.ts");
  const uploaded = await agent
    .post(`/api/v1/orders/${order.id}/finance/vouchers`)
    .set(headers())
    .send({
      originalSha256: digest(original),
      originalBase64: original.toString("base64"),
      mediaType: "application/pdf",
      invoice: {
        id: "invoice-private",
        supplierId: "fixture-supplier",
        reference: "INV-PRIVATE",
        currency: "EUR",
        totalMinor: "100",
        paidMinor: "0",
        dueAt: "2026-01-01T00:00:00Z",
        observedAt: new Date().toISOString(),
        source: "fixture-original",
        disputed: false,
        paymentPause: false,
      },
    })
    .expect(200);
  const id = uploaded.body.voucherId as string;
  await agent
    .post(`/api/v1/finance/vouchers/${id}/correction`)
    .set(headers())
    .send({ field: "accountDatevId", value: 6100, reuse: false, source: "CEO verified original" })
    .expect(200);
  const payment = await agent
    .post(`/api/v1/finance/vouchers/${id}/payment`)
    .set(headers())
    .send({
      recipient: "Fixture supplier",
      bankAccount: "fixture-account",
      reference: "INV-PRIVATE",
      amountMinor: "100",
    })
    .expect(200);
  expect(payment.body.orderId).toBe(order.id);
  expect((await repo.listDocuments(privateScope, "payment-preparation")).length).toBe(1);
  const dashboard = await agent.get("/api/v1/finance").expect(200);
  expect(dashboard.body.vouchers[0]).toMatchObject({ id, scope: privateScope, originalMediaType: "application/pdf" });
  const download = await agent.get(`/api/v1/finance/vouchers/${id}/original`).expect(200);
  expect(Buffer.from(download.body as Uint8Array)).toEqual(original);
  expect(download.headers["content-security-policy"]).toContain("sandbox");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(directory, "blobs", digest(original)), Buffer.from("tampered"));
  await agent.get(`/api/v1/finance/vouchers/${id}/original`).expect(409);
});

it("locks writes before awaiting the backup quiesce check and releases the lock on failure", async () => {
  const actionId = randomUUID();
  await repo.putDocument(scope, "action", actionId, { status: "running" });
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const original = repo.getDocument.bind(repo);
  let intercepted = false;
  repo.getDocument = async (...args) => {
    if (args[1] === "recovery-state" && !intercepted) {
      intercepted = true;
      entered();
      await blocked;
    }
    return original(...args);
  };
  const backup = agent
    .post("/api/v1/backups")
    .set(headers())
    .send({ ageExecutable: "/not/executed", recipient: "age1fixture", outputDirectory: directory })
    .then((result) => result);
  await entry;
  try {
    await agent
      .post("/api/v1/areas")
      .set(headers())
      .send({ name: "Must not start during backup", visibility: "company" })
      .expect(423);
  } finally {
    release();
  }
  expect((await backup).body.code).toBe("backup_busy");
  repo.getDocument = original;
  await agent
    .post("/api/v1/areas")
    .set(headers())
    .send({ name: "After failed backup", visibility: "company" })
    .expect(200);
  expect(
    (await repo.getDocument<{ dispatchPaused: boolean }>(scope, "recovery-state", scope.companyId))?.data
      .dispatchPaused,
  ).toBe(false);
});

it("streams every event in sequence across backlogged areas and project scopes", async () => {
  const cookieResponse = await agent.post("/api/v1/session").send({ password: "fixture-password-1234" }).expect(200);
  const cookie = (cookieResponse.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  const baseline = (await repo.eventsForCompany(scope.companyId, 0, 1000)).at(-1)!.sequence;
  for (let index = 0; index < 105; index++) await repo.putDocument(scope, "fixture-event", randomUUID(), { index });
  const privateScope = { ...scope, areaId: setup.areas[1]!.id };
  await repo.putDocument(privateScope, "fixture-event", randomUUID(), { private: true });
  const projectId = randomUUID();
  await repo.putDocument(scope, "project", projectId, { id: projectId });
  await repo.putDocument({ ...scope, projectId }, "fixture-event", randomUUID(), { project: true });
  const expected = (await repo.eventsForCompany(scope.companyId, baseline, 1000)).map((event) => event.sequence);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as import("node:net").AddressInfo,
    controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events?after=${baseline}`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes(`id: ${expected.at(-1)}\n`)) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual(expected);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

it("retains write ownership after a client disconnects until its actual handler completes", async () => {
  const session = await agent.post("/api/v1/session").send({ password: "fixture-password-1234" }).expect(200),
    cookie = (session.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  csrf = session.body.csrfToken as string;
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  const original = repo.createArea.bind(repo);
  repo.createArea = async (...args) => {
    entered();
    await blocked;
    return original(...args);
  };
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as import("node:net").AddressInfo,
    controller = new AbortController();
  try {
    const writing = fetch(`http://127.0.0.1:${address.port}/api/v1/areas`, {
      method: "POST",
      headers: {
        cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.body.csrfToken as string,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ name: "Disconnected write", visibility: "company" }),
      signal: controller.signal,
    }).catch((error) => error as Error);
    await entry;
    controller.abort();
    await writing;
    await agent
      .post("/api/v1/backups")
      .set(headers())
      .send({ ageExecutable: "/not/executed", recipient: "age1fixture", outputDirectory: directory })
      .expect(409);
    let drained = false;
    const draining = (app.locals.drainWrites as () => Promise<void>)().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    release();
    await draining;
    expect((await repo.snapshot(scope.companyId)).areas.some((area) => area.name === "Disconnected write")).toBe(true);
  } finally {
    release();
    repo.createArea = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("commits one plan and one approval decision under concurrent revision checks", async () => {
  const order = await repo.createOrder(scope, { kind: "research", goal: "Concurrent plan", budgetLimitUsdMicros: "0" });
  const plans = await Promise.all(
    [1, 2].map((index) =>
      agent
        .post(`/api/v1/orders/${order.id}/plan`)
        .set(headers())
        .set("If-Match", "1")
        .send({ steps: [`Step ${index}`], acceptanceCriteria: ["Checked"] }),
    ),
  );
  expect(plans.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(await repo.listDocuments(scope, "plan")).toHaveLength(1);
  const action = await pendingApproval(scope);
  const decisions = await Promise.all(
    ["approved", "denied"].map((decision) =>
      agent.post(`/api/v1/approvals/${action.id}/decision`).set(headers()).set("If-Match", "1").send({ decision }),
    ),
  );
  expect(decisions.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(await repo.listDocuments(scope, "approval")).toHaveLength(1);
});

it("queues an API CEO message for the next model turn even before a run exists", async () => {
  const order = await repo.createOrder(scope, { kind: "research", goal: "Message queue", budgetLimitUsdMicros: "0" });
  const response = await agent
    .post(`/api/v1/orders/${order.id}/messages`)
    .set(headers())
    .send({ content: "A concrete CEO correction" })
    .expect(200);
  expect((await repo.getDocument(scope, "run-inbox", response.body.id as string))?.data).toMatchObject({
    orderId: order.id,
    content: "A concrete CEO correction",
  });
});
