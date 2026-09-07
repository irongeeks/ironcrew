/** Opt-in real macOS control / native Linux worker test. No mounts, no mock executor. */
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, mkdtemp, rm, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import { WorkerServer } from "../../apps/control/worker-server.ts";
import { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";
import type { Attestation, ExecutionContext } from "../../packages/tools/isolation/types.ts";
const [fixtureArg, evidenceArg, profileArg] = process.argv.slice(2);
const local = process.platform === "linux";
assert.ok(fixtureArg && evidenceArg && (local ? profileArg : process.env.LIMA_HOME));
const fixture = path.resolve(fixtureArg),
  evidenceDir = path.resolve(evidenceArg);
await mkdir(evidenceDir, { recursive: true });
const directory = await mkdtemp(path.join(fixture, "control-"));
const guest = "/home/robert.guest/ironcrew-isolation";
const guestFixture = local ? path.join(directory, "worker") : guest + "/remote-host-" + randomUUID();
const profilePath = local ? path.resolve(profileArg!) : guest + "/profile-v4/profile.json";
const cgroupRoot = local
  ? (JSON.parse(await readFile(profilePath, "utf8")) as { cgroupRoot: string }).cgroupRoot
  : "/sys/fs/cgroup/ironcrew-isolation-501";
const lima = "/opt/homebrew/bin/limactl";
const repo = await Repository.open(path.join(directory, "company.sqlite"));
const setup = await repo.setup({
  companyName: "Real separated control and worker",
  ceoName: "Fixture",
  passwordHash: "fixture",
  timezone: "UTC",
  budgetLimitUsdMicros: "0",
});
const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
const server = createServer(
  { cert: await readFile(path.join(fixture, "cert.pem")), key: await readFile(path.join(fixture, "key.pem")) },
  (req, res) => void workers.handleTransfer(req, res),
);
const workers = await WorkerServer.create({ server, repo, scope, directory });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const enrollment = await workers.enroll("Native Linux VM remote worker", ["workspace.execute"], 1);
const config = {
  ...enrollment,
  capabilities: ["workspace.execute"],
  directory: guestFixture + "/state",
  caFile: guestFixture + "/ca.pem",
  isolationProfilePath: profilePath,
  url: `wss://${local ? "127.0.0.1" : "host.lima.internal"}:${(server.address() as { port: number }).port}/api/v1/workers/connect`,
};
await writeFile(path.join(directory, "worker.json"), JSON.stringify(config), { mode: 0o600 });
if (local) {
  await mkdir(guestFixture);
  await copyFile(path.join(directory, "worker.json"), path.join(guestFixture, "worker.json"));
  await copyFile(path.join(fixture, "cert.pem"), path.join(guestFixture, "ca.pem"));
} else {
  execFileSync(lima, ["shell", "ic-lab", "mkdir", "-p", guestFixture]);
  execFileSync(lima, ["copy", path.join(directory, "worker.json"), "ic-lab:" + guestFixture + "/worker.json"]);
  execFileSync(lima, ["copy", path.join(fixture, "cert.pem"), "ic-lab:" + guestFixture + "/ca.pem"]);
}
const child = spawn(
  local ? process.execPath : lima,
  local
    ? [new URL("../../apps/worker/main.ts", import.meta.url).pathname, guestFixture + "/worker.json"]
    : [
        "shell",
        "ic-lab",
        "sudo",
        guest + "/next/packages/tools/isolation/run-delegated.sh",
        "robert",
        cgroupRoot,
        guest + "/tooling/node/bin/node",
        guest + "/next/apps/worker/main.ts",
        guestFixture + "/worker.json",
      ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const cgroups = async () =>
  local
    ? 1 + (await readdir(cgroupRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).length
    : execFileSync(lima, ["shell", "ic-lab", "find", cgroupRoot, "-maxdepth", "1", "-type", "d"], { encoding: "utf8" })
        .trim()
        .split("\n").length;
let errors = "";
child.stderr.on("data", (d) => {
  errors = (errors + String(d)).slice(-5000);
});
const wait = async (predicate: () => Promise<boolean>, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    if (child.exitCode !== null) throw Error("worker exited " + errors);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("timeout " + errors);
};
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const proofs: Record<string, unknown> = {
  testedAt: new Date().toISOString(),
  control: { platform: process.platform, node: process.version },
  worker: { platform: "linux", transport: "WSS control + separate TLS HTTPS streams", noHostMounts: true },
};
try {
  await wait(async () => !!(await repo.getDocument(scope, "worker-attestation", enrollment.workerId)));
  const attestation = (await repo.getDocument<{ attestation: Attestation }>(
    scope,
    "worker-attestation",
    enrollment.workerId,
  ))!.data.attestation;
  proofs.attestation = attestation;
  assert.equal(Object.keys(attestation.probes).length, 17);
  const port = workers.remoteExecutionPort(enrollment.workerId, directory);
  const order = await repo.createOrder(scope, {
    kind: "website",
    goal: "Transport actual large files",
    budgetLimitUsdMicros: "0",
  });
  const context: ExecutionContext = {
    scope,
    orderId: order.id,
    authority: { kind: "ceo", ceoId: setup.ceo.id, requestId: randomUUID() },
  };
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const bytes = Buffer.alloc(3 * 1024 * 1024, 71);
  await writeFile(path.join(workspace, "input.bin"), bytes);
  await writeFile(
    path.join(workspace, "build.mjs"),
    `import fs from 'node:fs';fs.mkdirSync('dist');fs.copyFileSync('input.bin','dist/result.bin');process.stdout.write('L'.repeat(400000));`,
  );
  const request = { workspaceRoot: workspace, argv: ["node", "build.mjs"], outputPaths: ["dist"], context };
  const result = await port.execute(request);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 400000);
  assert.equal(sha(await readFile(path.join(result.outputDirectory, "dist/result.bin"))), sha(bytes));
  assert.ok(result.outputDirectory.startsWith(directory));
  const repeat = await port.execute(request);
  assert.deepEqual(repeat, result);
  assert.equal((await repo.events(scope)).filter((e) => e.type === "worker.remote_completed").length, 1);
  proofs.streams = {
    inputBytes: bytes.length,
    outputBytes: bytes.length,
    stdoutBytes: result.stdout.length,
    sha256: sha(bytes),
    centralOwnedOutput: true,
    idempotentReplay: true,
  };
  const web = new WebsiteWorkflow(repo, directory, async () => port);
  const builds = [];
  for (const stack of ["react", "wordpress"] as const) {
    const order = await repo.createOrder(scope, {
      kind: "website",
      goal: "Remote " + stack,
      budgetLimitUsdMicros: "0",
    });
    await web.create(scope, order.id, "Actual separate control and Linux worker", stack);
    const concepts = await web.concepts(scope, order.id, [
      {
        name: "Selected",
        rationale: "Fixture",
        html: '<!doctype html><html lang="de"><head><title>Remote build</title></head><body><h1>Native remote build</h1></body></html>',
      },
      { name: "Alternative", rationale: "Fixture", html: "<h1>Alternative</h1>" },
    ]);
    await web.select(scope, order.id, concepts.data.concepts[0]!.id);
    const artifact = await web.build(scope, order.id, {
      scope,
      orderId: order.id,
      authority: { kind: "ceo", ceoId: setup.ceo.id, requestId: randomUUID() },
    });
    const archive = await web.packageArchive(scope, artifact.id);
    assert.ok((await web.preview(artifact.id)).length > 0);
    await writeFile(path.join(evidenceDir, stack + "-remote.tar.gz"), archive.content);
    builds.push({ stack, archiveSha256: archive.sha256, evidence: artifact.buildEvidence });
  }
  proofs.builds = builds;
  const controller = new AbortController();
  const pending = port.execute({
    ...request,
    argv: ["node", "-e", "setInterval(()=>{},100)"],
    outputPaths: [],
    signal: controller.signal,
    context: { ...context, authority: { kind: "ceo", ceoId: setup.ceo.id, requestId: randomUUID() } },
  });
  void pending.catch(() => {});
  await wait(async () =>
    (
      await repo.listCompanyDocuments<{ permitIssuedAt?: string; state: string }>(scope.companyId, "remote-execution")
    ).some((d) => d.data.permitIssuedAt && d.data.state === "dispatched"),
  );
  await wait(async () => (await cgroups()) > 2, 10000);
  controller.abort();
  await assert.rejects(pending, /execution_cancelled/);
  await wait(async () => (await cgroups()) <= 2, 10000);
  proofs.cancellation = { callerAborted: true, persistedUnknown: true, cgroupChildrenRemoved: true };
  await writeFile(path.join(evidenceDir, "remote-execution.json"), JSON.stringify(proofs, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, streams: proofs.streams, builds, cancellation: proofs.cancellation }));
} finally {
  await workers.cancelAllRemote("fixture_shutdown");
  if (!local)
    execFileSync(lima, ["shell", "ic-lab", "pkill", "-TERM", "-f", guestFixture + "/worker.json"], { stdio: "ignore" });
  child.kill("SIGTERM");
  await workers.close();
  await new Promise<void>((r) => server.close(() => r()));
  await repo.close();
  if (!local) execFileSync(lima, ["shell", "ic-lab", "rm", "-rf", guestFixture]);
  await rm(directory, { recursive: true, force: true });
}
