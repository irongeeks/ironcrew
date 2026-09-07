/** Actual native worker process, TLS WebSocket and generated execution in Linux. */
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../../packages/persistence/src/index.ts";
import { WorkerServer, type WorkerIdentity } from "../../apps/control/worker-server.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import type { ToolAction } from "../../packages/contracts/src/index.ts";
import type { ExecutionResult } from "../../packages/tools/isolation/types.ts";
const [profilePath, evidencePath] = process.argv.slice(2);
assert.ok(profilePath && evidencePath);
assert.equal(process.platform, "linux");
const directory = await mkdtemp(path.join(tmpdir(), "isolation-native-worker-"));
const repo = await Repository.open(path.join(directory, "company.sqlite"));
const cert = await readFile(new URL("../integration/worker-fixtures/cert.pem", import.meta.url));
const server = createServer({
  cert,
  key: await readFile(new URL("../integration/worker-fixtures/key.pem", import.meta.url)),
});
const setup = await repo.setup({
  companyName: "Native Linux worker fixture",
  ceoName: "Fixture",
  passwordHash: "fixture",
  timezone: "UTC",
  budgetLimitUsdMicros: "0",
});
const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
const workers = await WorkerServer.create({ server, repo, scope });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const enrollment = await workers.enroll("Native isolated worker", ["workspace.execute"], 1);
await writeFile(path.join(directory, "ca.pem"), cert);
await writeFile(
  path.join(directory, "worker.json"),
  JSON.stringify({
    ...enrollment,
    capabilities: ["workspace.execute"],
    directory: path.join(directory, "state"),
    caFile: path.join(directory, "ca.pem"),
    isolationProfilePath: profilePath,
    url: `wss://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/workers/connect`,
  }),
  { mode: 0o600 },
);
const child = spawn(
  process.execPath,
  [new URL("../../apps/worker/main.ts", import.meta.url).pathname, path.join(directory, "worker.json")],
  { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "ignore", "pipe"] },
);
let failure = "";
child.stderr.on("data", (chunk) => {
  failure = (failure + String(chunk)).slice(-2000);
});
const waitFor = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (child.exitCode !== null) throw new Error("Native worker exited: " + failure);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Native worker timed out: " + failure);
};
try {
  await waitFor(
    async () => !!(await repo.getDocument<WorkerIdentity>(scope, "worker", enrollment.workerId))?.data.lastSeenAt,
  );
  const order = await repo.createOrder(scope, {
    kind: "website",
    goal: "Native WSS isolated execution",
    budgetLimitUsdMicros: "0",
  });
  const mandateId = randomUUID(),
    targetId = randomUUID();
  await repo.createMandate({
    id: mandateId,
    version: 1,
    scope,
    allowedToolIds: ["workspace.execute"],
    targetIds: [targetId],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 1,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  });
  const args = {
    argv: ["node", "-e", "require('node:fs').writeFileSync('actual.txt','native-wss-kernel-isolated');"],
    outputPaths: ["actual.txt"],
  };
  const action: ToolAction = {
    id: randomUUID(),
    runId: randomUUID(),
    orderId: order.id,
    scope,
    toolId: "workspace.execute",
    toolVersion: 1,
    args,
    argumentsSha256: sha256(args),
    status: "proposed",
    mandateId,
    mandateVersion: 1,
    evidenceRefs: [],
  };
  await repo.putDocument(scope, "action", action.id, action);
  await workers.dispatch(scope, action.id, enrollment.workerId, { targetId, effect: "workspace_write" }, 30);
  await waitFor(
    async () => (await repo.getDocument<ToolAction>(scope, "action", action.id))?.data.status === "succeeded",
  );
  const receipt = (
    await repo.listDocuments<{ actionId?: string; result?: ExecutionResult }>(scope, "worker_receipt")
  ).find((d) => d.data.actionId === action.id && d.data.result);
  assert.ok(receipt?.data.result);
  const result = receipt.data.result;
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, "exited");
  assert.ok(result.attestationId);
  assert.equal(await readFile(path.join(result.outputDirectory, "actual.txt"), "utf8"), "native-wss-kernel-isolated");
  assert.equal(
    result.outputHashes["actual.txt"],
    createHash("sha256").update("native-wss-kernel-isolated").digest("hex"),
  );
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        passed: true,
        nativeWorkerProcess: true,
        authenticatedWss: true,
        generatedExecution: result,
        remoteArtifactTransport: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: true, evidencePath }));
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("close", () => resolve());
  });
  await workers.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
}
