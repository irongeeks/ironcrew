import { beforeEach, afterEach, it, expect } from "vitest";
import { createServer, request as httpsRequest, type Server } from "node:https";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Repository } from "../../packages/persistence/src/index.ts";
import { WorkerServer, type Enrollment } from "../../apps/control/worker-server.ts";
import {
  manifestHash,
  manifestSchema,
  remoteControlSchema,
  type RemoteControlMessage,
} from "../../packages/tools/remote-execution/protocol.ts";
import { Workspace } from "../../packages/tools/workspace.ts";
import { captureFiles, receiveFile } from "../../packages/tools/remote-execution/files.ts";
import { Readable } from "node:stream";
import type { Scope, Json } from "../../packages/contracts/src/index.ts";
import type { Attestation, ExecutionContext } from "../../packages/tools/isolation/types.ts";
let directory: string,
  repo: Repository,
  server: Server,
  workers: WorkerServer,
  scope: Scope,
  ceoId: string,
  base: string,
  ca: Buffer,
  enrollment: Enrollment,
  ws: WebSocket;
let sequence = 0;
const messages: RemoteControlMessage[] = [];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const waitFor = async <T>(query: () => T | undefined): Promise<T> => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = query();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Condition timed out");
};
// A protocol fixture, not a claim that this synthetic peer has actual OS isolation.
const attestation = (): Attestation => ({
  id: randomUUID(),
  profileSha256: "a".repeat(64),
  toolchainSha256: "b".repeat(64),
  bwrapSha256: "c".repeat(64),
  seccompSha256: "d".repeat(64),
  kernel: "protocol-fixture",
  bootId: randomUUID(),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  probes: Object.fromEntries(
    [
      "trusted_program_runs",
      "node_version",
      "seccomp_syscall",
      "kernel_namespaces",
      "capabilities_seccomp",
      "environment",
      "filesystem",
      "network",
      "host_process",
      "process_limit",
      "memory_limit",
      "cpu_timeout",
      "output_limit",
      "workspace_quota",
      "symlink_export",
      "nested_namespace",
    ].map((k) => [k, { passed: true, detail: "synthetic protocol fixture" }]),
  ),
});
let evidence: Attestation;
function send(payload: unknown, messageId = randomUUID()) {
  const message = {
    protocolVersion: 1,
    messageId,
    workerId: enrollment.workerId,
    generation: enrollment.generation,
    sequence: ++sequence,
    sentAt: new Date().toISOString(),
    payload,
  };
  ws.send(JSON.stringify(message));
  return message;
}
async function connect() {
  ws = new WebSocket(base.replace("https:", "wss:") + "/api/v1/workers/connect", {
    ca,
    headers: {
      authorization: `Bearer ${enrollment.token}`,
      "x-worker-id": enrollment.workerId,
      "x-worker-generation": String(enrollment.generation),
    },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (data) => {
    const parsed = remoteControlSchema.safeParse(JSON.parse(data.toString()));
    if (parsed.success) messages.push(parsed.data);
  });
}
function http(method: string, url: string, token: string, data?: Buffer) {
  return new Promise<{ status: number; body: Buffer; headers: import("node:http").IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = httpsRequest(
        base + url,
        {
          method,
          ca,
          headers: {
            authorization: `Bearer ${token}`,
            ...(data ? { "content-type": "application/octet-stream", "content-length": data.length } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.once("end", () =>
            resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }),
          );
        },
      );
      req.once("error", reject);
      req.end(data);
    },
  );
}
beforeEach(async () => {
  sequence = 0;
  messages.length = 0;
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-remote-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Protocol fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  ceoId = setup.ceo.id;
  ca = await readFile(new URL("./worker-fixtures/cert.pem", import.meta.url));
  server = createServer(
    { ca, cert: ca, key: await readFile(new URL("./worker-fixtures/key.pem", import.meta.url)) },
    (req, res) => {
      void workers.handleTransfer(req, res);
    },
  );
  workers = await WorkerServer.create({ server, repo, scope, directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  enrollment = await workers.enroll("Synthetic transport peer", ["workspace.execute"], 1);
  evidence = attestation();
  await connect();
  send({ type: "remote.hello", attestation: evidence });
  await expect
    .poll(async () => Boolean(await repo.getDocument(scope, "worker-attestation", enrollment.workerId)), {
      timeout: 15000,
    })
    .toBe(true);
});
afterEach(async () => {
  ws?.terminate();
  await workers.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
async function start() {
  const order = await repo.createOrder(scope, { kind: "website", goal: "Remote bytes", budgetLimitUsdMicros: "0" });
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const input = Buffer.alloc(2 * 1024 * 1024, 42);
  await writeFile(path.join(workspace, "input.bin"), input);
  const context: ExecutionContext = {
    scope,
    orderId: order.id,
    authority: { kind: "ceo", ceoId, requestId: randomUUID() },
  };
  const request = {
    workspaceRoot: workspace,
    argv: ["node", "build.mjs"],
    timeoutMs: 3000,
    outputPaths: ["dist"],
    context,
  };
  const controller = new AbortController();
  const wrapper = new Workspace(workspace, {
    executionPort: workers.remoteExecutionPort(enrollment.workerId, directory),
  });
  const promise = wrapper.execute(
    { argv: request.argv, timeoutMs: request.timeoutMs, outputPaths: request.outputPaths },
    context,
    controller.signal,
  );
  void promise.catch(() => {});
  const dispatch = await waitFor(
    () =>
      messages.find((m) => m.payload.type === "remote.dispatch")?.payload as
        | Extract<RemoteControlMessage["payload"], { type: "remote.dispatch" }>
        | undefined,
  );
  return { request, promise, dispatch, input, controller, wrapper };
}
async function output(
  dispatch: Extract<RemoteControlMessage["payload"], { type: "remote.dispatch" }>,
  content: Buffer,
) {
  expect(
    (await http("POST", `/api/v1/worker-transfers/${dispatch.jobId}/start`, dispatch.inputToken, Buffer.alloc(0)))
      .status,
  ).toBe(204);
  const files = [{ path: "dist/result.bin", size: content.length, sha256: sha(content) }];
  send({
    type: "remote.output",
    jobId: dispatch.jobId,
    files,
    result: {
      exitCode: 0,
      stdout: "actual protocol fixture",
      stderr: "",
      termination: "exited",
      attestationId: evidence.id,
      profileSha256: evidence.profileSha256,
      toolchainSha256: evidence.toolchainSha256,
      outputHashes: { "dist/result.bin": sha(content) },
      resources: { memoryEvents: {}, pidsEvents: {}, cpuStat: {} },
    },
  });
  const ticket = await waitFor(
    () =>
      messages.find((m) => m.payload.type === "remote.upload")?.payload as
        | Extract<RemoteControlMessage["payload"], { type: "remote.upload" }>
        | undefined,
  );
  return { files, ticket };
}
it("streams files larger than the WSS control limit and imports only verified central bytes", async () => {
  const { promise, dispatch, input, request } = await start();
  const got = await http("GET", `/api/v1/worker-transfers/${dispatch.jobId}/input/0`, dispatch.inputToken);
  expect(got.status).toBe(200);
  // Native equality is still byte-for-byte, without millions of JS matcher comparisons under CI load.
  expect(got.body.equals(input)).toBe(true);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 61),
    { files, ticket } = await output(dispatch, bytes);
  const sent = await http("PUT", `/api/v1/worker-transfers/${dispatch.jobId}/output/0`, ticket.token, bytes);
  expect(sent.status).toBe(204);
  const commit = send({ type: "remote.complete", jobId: dispatch.jobId, manifestSha256: manifestHash(files) });
  const result = await promise;
  expect((await readFile(path.join(result.outputDirectory, "dist/result.bin"))).equals(bytes)).toBe(true);
  expect(result.outputDirectory.startsWith(directory)).toBe(true);
  ws.send(JSON.stringify(commit));
  const replay = await workers.remoteExecutionPort(enrollment.workerId, directory).execute(request);
  expect(replay).toEqual(result);
  expect((await repo.events(scope)).filter((e) => e.type === "worker.remote_completed")).toHaveLength(1);
}, 60000);
it("rejects forged tickets, wrong hashes, cross-job indexes and changed generations", async () => {
  const { dispatch, promise } = await start();
  const prefix = `/api/v1/worker-transfers/${dispatch.jobId}`;
  expect((await http("GET", prefix + "/input/0", "x".repeat(43))).status).toBe(403);
  expect((await http("GET", prefix + "/input/99", dispatch.inputToken)).status).toBe(404);
  const { ticket } = await output(dispatch, Buffer.from("right"));
  expect((await http("PUT", prefix + "/output/0", ticket.token, Buffer.from("wrong"))).status).toBe(409);
  expect((await readdir(path.join(directory, "worker-transfers", dispatch.jobId, "output"))).length).toBe(0);
  await workers.rotate(enrollment.workerId);
  expect((await http("GET", prefix + "/input/0", dispatch.inputToken)).status).toBe(403);
  await expect(promise).rejects.toThrow("worker_fenced");
});
it("reissues upload tickets on reconnect without repeating execution", async () => {
  const { dispatch, promise } = await start();
  const bytes = Buffer.from("durable"),
    { files } = await output(dispatch, bytes);
  messages.length = 0;
  ws.terminate();
  await connect();
  send({ type: "remote.hello", attestation: evidence });
  const ticket = await waitFor(
    () =>
      messages.find((m) => m.payload.type === "remote.upload")?.payload as
        | Extract<RemoteControlMessage["payload"], { type: "remote.upload" }>
        | undefined,
  );
  expect(messages.some((m) => m.payload.type === "remote.dispatch")).toBe(false);
  expect((await http("PUT", `/api/v1/worker-transfers/${dispatch.jobId}/output/0`, ticket.token, bytes)).status).toBe(
    204,
  );
  send({ type: "remote.complete", jobId: dispatch.jobId, manifestSha256: manifestHash(files) });
  expect((await promise).exitCode).toBe(0);
});
it("refuses authority-free requests and casefolded file/directory collisions", async () => {
  expect(() =>
    manifestSchema.parse([
      { path: "A", size: 0, sha256: sha("") },
      { path: "a/x", size: 0, sha256: sha("") },
    ]),
  ).toThrow();
  expect(() =>
    manifestSchema.parse([
      { path: "Foo", size: 0, sha256: sha("") },
      { path: "foo", size: 0, sha256: sha("") },
    ]),
  ).toThrow();
  await expect(
    workers.remoteExecutionPort(enrollment.workerId, directory).execute({ workspaceRoot: directory, argv: ["node"] }),
  ).rejects.toThrow("execution_context_required");
});
it("cleans incomplete streams and excludes source symlinks", async () => {
  const file = path.join(directory, "bad");
  await expect(
    receiveFile(Readable.from([Buffer.from("short")]), file, { size: 8, sha256: sha("expected") }),
  ).rejects.toThrow();
  expect((await readdir(directory)).some((f) => f.includes("partial"))).toBe(false);
  const source = path.join(directory, "capture");
  await mkdir(source);
  await writeFile(path.join(source, "ok"), "okay");
  const manifest = await captureFiles(source, path.join(directory, "snapshot"));
  expect(manifest[0]?.sha256).toBe(sha("okay"));
  await symlink("ok", path.join(source, "link"));
  await expect(captureFiles(source, path.join(directory, "unsafe"))).rejects.toThrow();
});
it("restores upload receipts across control restart and rejects corrupt replay outputs", async () => {
  const { dispatch, promise, request } = await start();
  const bytes = Buffer.from("restart-durable");
  const { files, ticket } = await output(dispatch, bytes);
  expect((await http("PUT", `/api/v1/worker-transfers/${dispatch.jobId}/output/0`, ticket.token, bytes)).status).toBe(
    204,
  );
  await workers.close();
  workers = await WorkerServer.create({ server, repo, scope, directory });
  messages.length = 0;
  await connect();
  send({ type: "remote.hello", attestation: evidence });
  await waitFor(() => messages.find((m) => m.payload.type === "remote.upload"));
  send({ type: "remote.complete", jobId: dispatch.jobId, manifestSha256: manifestHash(files) });
  const result = await promise;
  expect((await readFile(path.join(result.outputDirectory, "dist/result.bin"))).equals(bytes)).toBe(true);
  await writeFile(path.join(result.outputDirectory, "dist/result.bin"), "tampered");
  await expect(workers.remoteExecutionPort(enrollment.workerId, directory).execute(request)).rejects.toThrow(
    "file_hash_mismatch",
  );
});
it("cancels child execution durably and rejects every late transfer", async () => {
  const { dispatch, promise } = await start();
  await workers.cancel(dispatch.jobId, "operator_cancel");
  await expect(promise).rejects.toThrow("operator_cancel");
  expect((await http("GET", `/api/v1/worker-transfers/${dispatch.jobId}/input/0`, dispatch.inputToken)).status).toBe(
    409,
  );
  expect((await repo.getDocument<{ state: string }>(scope, "remote-execution", dispatch.jobId))?.data.state).toBe(
    "effect_unknown",
  );
  expect(messages.some((m) => m.payload.type === "remote.cancel")).toBe(true);
});
it("rechecks revoked mandates at the zero-body start permit", async () => {
  const { dispatch, promise } = await start();
  await repo.revokeMandate(scope, dispatch.action.mandateId!, dispatch.action.mandateVersion!);
  expect(
    (await http("POST", `/api/v1/worker-transfers/${dispatch.jobId}/start`, dispatch.inputToken, Buffer.alloc(0)))
      .status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await repo.getDocument<{ permitIssuedAt?: string }>(scope, "remote-execution", dispatch.jobId))?.data
      .permitIssuedAt,
  ).toBeUndefined();
  await workers.cancelAllRemote("revoked_fixture");
  // The periodic authority check may fence the job before the explicit test cleanup.
  await expect(promise).rejects.toThrow(/revoked_fixture|execution_authority_revoked/);
});
it("refuses a second remote job beyond enrolled worker capacity", async () => {
  const { request, promise } = await start();
  await expect(
    workers
      .remoteExecutionPort(enrollment.workerId, directory)
      .execute({ ...request, argv: ["node", "different.mjs"] }),
  ).rejects.toThrow("worker_capacity");
  await workers.cancelAllRemote("capacity_fixture");
  await expect(promise).rejects.toThrow("capacity_fixture");
});

it("permanently fences new execution when shutdown drains an active port", async () => {
  const { request, promise } = await start();
  await workers.cancelAllRemote("control_shutdown");
  await expect(promise).rejects.toThrow("control_shutdown");
  await expect(
    workers.remoteExecutionPort(enrollment.workerId, directory).execute({ ...request, argv: ["node", "late.mjs"] }),
  ).rejects.toThrow("remote_dispatch_stopped");
  expect(await workers.activeRemoteExecutions()).toBe(0);
});

it("persists expired restored jobs as unknown without an execute caller", async () => {
  const { dispatch, promise } = await start();
  const source = (await repo.getDocument<Record<string, Json>>(scope, "remote-execution", dispatch.jobId))!;
  const action = (await repo.getDocument<Record<string, Json>>(scope, "action", dispatch.jobId))!;
  await workers.cancel(dispatch.jobId, "fixture_finished");
  await expect(promise).rejects.toThrow("fixture_finished");
  const id = randomUUID();
  const child = { ...action.data, id };
  await repo.putDocument(scope, "action", id, child);
  await repo.putDocument(scope, "remote-execution", id, {
    ...source.data,
    id,
    child,
    state: "dispatched",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await workers.close();
  workers = await WorkerServer.create({ server, repo, scope, directory });
  await workers.reconcileExpired();
  expect((await repo.getDocument<{ state: string }>(scope, "remote-execution", id))?.data.state).toBe("effect_unknown");
  expect((await repo.getDocument<{ status: string }>(scope, "action", id))?.data.status).toBe("effect_unknown");
});

it("forwards only the trusted AbortSignal and rejects model-supplied control fields", async () => {
  const { controller, promise, wrapper, dispatch } = await start();
  await expect(wrapper.execute({ argv: ["node"], signal: { aborted: false } })).rejects.toThrow();
  await expect(wrapper.execute({ argv: ["node"], context: { scope, orderId: randomUUID() } })).rejects.toThrow();
  controller.abort(new Error("caller_cancelled"));
  await expect(promise).rejects.toThrow("execution_cancelled");
  expect((await repo.getDocument<{ state: string }>(scope, "remote-execution", dispatch.jobId))?.data.state).toBe(
    "effect_unknown",
  );
});
