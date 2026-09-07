import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Repository } from "../../packages/persistence/src/index.ts";
import { WorkerServer, type Enrollment } from "../../apps/control/worker-server.ts";
import { WorkerClient } from "../../apps/worker/client.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import type { ControlMessage, Mandate, Scope, ToolAction, WorkerMessage } from "../../packages/contracts/src/index.ts";
let repo: Repository,
  server: Server,
  workers: WorkerServer,
  scope: Scope,
  dir: string,
  url: string,
  ca: string,
  enrollment: Enrollment;
const sockets: WebSocket[] = [],
  clients: WorkerClient[] = [];
const waitFor = async (predicate: () => Promise<boolean>, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Condition timed out");
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ironcrew-wss-"));
  repo = await Repository.open(join(dir, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "WSS Test",
    ceoName: "Robert",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "1000",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  ca = await readFile(new URL("./worker-fixtures/cert.pem", import.meta.url), "utf8");
  server = createServer({ key: await readFile(new URL("./worker-fixtures/key.pem", import.meta.url)), cert: ca });
  workers = await WorkerServer.create({ server, repo, scope });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `wss://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/workers/connect`;
  enrollment = await workers.enroll("Local fixture", ["workspace.write"], 1);
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const ws of sockets.splice(0)) ws.terminate();
  await workers.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo.close();
  await rm(dir, { recursive: true, force: true });
});
async function prepare() {
  const order = await repo.createOrder(scope, { kind: "website", goal: "Create file", budgetLimitUsdMicros: "1000" }),
    targetId = randomUUID();
  const mandate: Mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["workspace.write"],
    targetIds: [targetId],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 1,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "100",
  };
  await repo.createMandate(mandate);
  const args = { path: "index.html", content: "<h1>Test</h1>" };
  const action: ToolAction = {
    id: randomUUID(),
    runId: randomUUID(),
    orderId: order.id,
    scope,
    toolId: "workspace.write",
    toolVersion: 1,
    args,
    argumentsSha256: sha256(args),
    status: "proposed",
    mandateId: mandate.id,
    mandateVersion: 1,
    evidenceRefs: [],
  };
  await repo.putDocument(scope, "action", action.id, action);
  return { action, targetId };
}
async function socket(auth = enrollment) {
  const ws = new WebSocket(url, {
    ca,
    headers: {
      authorization: `Bearer ${auth.token}`,
      "x-worker-id": auth.workerId,
      "x-worker-generation": String(auth.generation),
    },
  });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}
function envelope(payload: WorkerMessage["payload"], sequence: number): WorkerMessage {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    workerId: enrollment.workerId,
    generation: enrollment.generation,
    sequence,
    sentAt: new Date().toISOString(),
    payload,
  };
}
it("authenticates WSS with hashed enrollment, executes and persists an acknowledged journal result", async () => {
  let effects = 0;
  const client = new WorkerClient({
    url,
    ...enrollment,
    capabilities: ["workspace.write"],
    directory: join(dir, "worker"),
    ca,
    execute: async () => {
      effects++;
      return { written: true };
    },
  });
  clients.push(client);
  await client.start();
  const { action, targetId } = await prepare();
  await workers.dispatch(scope, action.id, enrollment.workerId, { targetId, effect: "workspace_write" });
  await waitFor(
    async () => (await repo.getDocument<ToolAction>(scope, "action", action.id))?.data.status === "succeeded",
  );
  expect(effects).toBe(1);
  const identity = await repo.getDocument<{ credentialHash: string }>(scope, "worker", enrollment.workerId);
  expect(identity?.data.credentialHash).not.toBe(enrollment.token);
  expect(identity?.data.credentialHash).toHaveLength(64);
  expect(await repo.verifyAudit(scope.companyId)).toBe(true);
});
it("commits duplicated result messages once and re-ACKs the identical receipt", async () => {
  const ws = await socket(),
    messages: ControlMessage[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as ControlMessage));
  const { action, targetId } = await prepare(),
    lease = await workers.dispatch(scope, action.id, enrollment.workerId, { targetId, effect: "workspace_write" });
  const data = { written: true };
  const result = envelope(
    {
      type: "result",
      actionId: action.id,
      leaseId: lease.id,
      status: "succeeded",
      data,
      resultSha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      evidenceRefs: [],
    },
    1,
  );
  ws.send(JSON.stringify(result));
  await waitFor(async () => messages.filter((m) => m.payload.type === "ack").length === 1);
  ws.send(JSON.stringify(result));
  await waitFor(async () => messages.filter((m) => m.payload.type === "ack").length === 2);
  expect((await repo.getDocument(scope, "action", action.id))?.revision).toBe(3);
  expect((await repo.events(scope)).filter((e) => e.type === "worker.result")).toHaveLength(1);
});
it("fences rotated generations and converts active uncertain effects into effect_unknown", async () => {
  const ws = await socket();
  const { action, targetId } = await prepare();
  await workers.dispatch(scope, action.id, enrollment.workerId, { targetId, effect: "workspace_write" });
  const next = await workers.rotate(enrollment.workerId);
  expect(next.generation).toBe(2);
  await waitFor(async () => ws.readyState !== WebSocket.OPEN);
  expect((await repo.getDocument<ToolAction>(scope, "action", action.id))?.data.status).toBe("effect_unknown");
  await expect(socket(enrollment)).rejects.toThrow("401");
  await socket(next);
});
it("rejects a plaintext WS URL before any connection and never bypasses TLS validation", () => {
  expect(
    () =>
      new WorkerClient({
        url: url.replace("wss:", "ws:"),
        ...enrollment,
        capabilities: ["workspace.write"],
        directory: dir,
        execute: async () => null,
      }),
  ).toThrow("tls_required");
});

it("restores durable leases after central restart and blocks unknown effects without redispatch", async () => {
  await socket();
  const { action, targetId } = await prepare();
  const lease = await workers.dispatch(scope, action.id, enrollment.workerId, { targetId, effect: "workspace_write" });
  const document = await repo.getDocument<import("../../apps/control/worker-server.ts").WorkerLease>(
    scope,
    "worker_lease",
    lease.id,
  );
  await repo.putDocument(
    scope,
    "worker_lease",
    lease.id,
    { ...document!.data, expiresAt: new Date(Date.now() - 1000).toISOString() },
    { expectedRevision: document!.revision },
  );
  await workers.close();
  workers = await WorkerServer.create({ server, repo, scope });
  await workers.reconcileExpired();
  expect((await repo.getDocument<ToolAction>(scope, "action", action.id))?.data.status).toBe("effect_unknown");
  await socket();
  await expect(
    workers.dispatch(scope, action.id, enrollment.workerId, { targetId, effect: "workspace_write" }),
  ).rejects.toMatchObject({ code: "action_not_dispatchable" });
});

it("serializes simultaneous dispatches against the enrolled worker capacity", async () => {
  await socket();
  const first = await prepare(),
    second = await prepare();
  const results = await Promise.allSettled([
    workers.dispatch(scope, first.action.id, enrollment.workerId, {
      targetId: first.targetId,
      effect: "workspace_write",
    }),
    workers.dispatch(scope, second.action.id, enrollment.workerId, {
      targetId: second.targetId,
      effect: "workspace_write",
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});
