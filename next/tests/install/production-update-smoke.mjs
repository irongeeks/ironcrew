// Explicit standalone acceptance command; no discovered user service is used.
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, writeFile, chmod, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { createPrivateKey, createPublicKey, sign, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { hashFile, verifyRelease } from "../../packages/operations/src/index.ts";
const { values } = parseArgs({
  options: {
    release: { type: "string" },
    "test-private-key": { type: "string" },
    age: { type: "string" },
    evidence: { type: "string" },
  },
});
for (const key of ["release", "test-private-key", "age", "evidence"])
  if (!values[key]) throw Error(`--${key} required`);
const run = promisify(execFile),
  release = path.resolve(values.release),
  age = path.resolve(values.age),
  signingKey = createPrivateKey(await readFile(values["test-private-key"])),
  pem = createPublicKey(signingKey).export({ type: "spki", format: "pem" }).toString();
const base = await verifyRelease(release, pem, { platform: process.platform, arch: process.arch });
const root = await mkdtemp(path.join(tmpdir(), "ironcrew-full-product-update-")),
  install = path.join(root, "install"),
  candidate = path.join(root, "candidate"),
  data = path.join(root, "data"),
  backups = path.join(root, "backups"),
  configFile = path.join(root, "updater.json");
await mkdir(data);
await mkdir(backups);
await cp(release, install, { recursive: true });
await cp(release, candidate, { recursive: true });
const nextVersion = base.version.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_m, a, b, c) => `${a}.${b}.${Number(c) + 1}`);
const candidateManifest = JSON.parse(await readFile(path.join(candidate, "release-manifest.json"), "utf8"));
candidateManifest.version = nextVersion;
const mainFile = path.join(candidate, "dist/apps/control/main.js");
await writeFile(
  mainFile,
  (await readFile(mainFile, "utf8")) + "\n// Local temporary signed update acceptance candidate.\n",
);
const entry = candidateManifest.files.find((f) => f.path === "dist/apps/control/main.js");
entry.sha256 = await hashFile(mainFile);
entry.bytes = (await stat(mainFile)).size;
const manifestBytes = Buffer.from(JSON.stringify(candidateManifest, null, 2) + "\n");
await writeFile(path.join(candidate, "release-manifest.json"), manifestBytes);
await writeFile(path.join(candidate, "release-manifest.sig"), sign(null, manifestBytes, signingKey));
await verifyRelease(candidate, pem);
const { Repository } = await import(pathToFileURL(path.join(release, "dist/packages/persistence/src/index.js")).href);
const { hashPassword } = await import(pathToFileURL(path.join(release, "dist/apps/control/auth.js")).href);
const repo = await Repository.open(path.join(data, "company.sqlite"));
const password = "temporary-product-acceptance-" + randomUUID();
const setup = await repo.setup({
  companyName: "Temporary signed product update",
  ceoName: "Test CEO",
  passwordHash: await hashPassword(password),
  timezone: "UTC",
  budgetLimitUsdMicros: "0",
});
await repo.close();
async function port() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
const httpPort = await port(),
  previewPort = await port(),
  origin = `http://127.0.0.1:${httpPort}`,
  broker = path.join(root, "broker.mjs"),
  pidFile = path.join(root, "control.pid");
await writeFile(
  broker,
  `#!${process.execPath}\nimport fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1],op=get('--operation'),install=get('--program-dir'),data=get('--data-dir'),pidFile=${JSON.stringify(pidFile)};if(op==='start'){const log=await fs.open(${JSON.stringify(path.join(root, "control.log"))},'a');const child=spawn(path.join(install,'runtime/node'),['dist/apps/control/main.js'],{cwd:install,env:{IRONCREW_DATA_DIR:data,IRONCREW_UPDATER_CONFIG:${JSON.stringify(configFile)},IRONCREW_PORT:'${httpPort}',IRONCREW_PREVIEW_PORT:'${previewPort}',IRONCREW_HOST:'127.0.0.1',IRONCREW_PUBLIC_URL:'${origin}'},detached:true,stdio:['ignore',log.fd,log.fd]});await log.close();child.unref();await fs.writeFile(pidFile,String(child.pid));}if(op==='stop'){let pid;try{pid=Number(await fs.readFile(pidFile,'utf8'));}catch{}if(pid){try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}for(let i=0;i<400;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,25));}catch(e){if(e.code==='ESRCH')break;throw e;}}try{process.kill(pid,0);throw Error('process still alive');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.unlink(pidFile);}}console.log(JSON.stringify({serviceName:get('--service'),state:op==='stop'?'stopped':'running'}));`,
  { mode: 0o755 },
);
await chmod(broker, 0o755);
const config = {
  version: 1,
  companyId: setup.company.id,
  dataDirectory: data,
  installDirectory: install,
  bootstrapDirectory: release,
  ageExecutable: age,
  ageExecutableSha256: await hashFile(age),
  backupDirectory: backups,
  trustedPublicKeyPem: pem,
  service: {
    kind: "ironcrew-service-v1",
    name: "temporary-full-control",
    executable: broker,
    executableSha256: await hashFile(broker),
  },
  healthUrl: origin + "/api/v1/health",
  healthTimeoutMs: 30000,
};
await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
const invoke = (operation) =>
  run(
    broker,
    ["--service", config.service.name, "--operation", operation, "--program-dir", install, "--data-dir", data],
    { timeout: 20000 },
  );
let daemon, daemonExited;
const logs = [];
async function health() {
  return fetch(config.healthUrl).then(async (r) => {
    if (!r.ok) throw Error("health " + r.status);
    return r.json();
  });
}
async function eventually(fn, timeout = 30000) {
  const until = Date.now() + timeout;
  let last;
  do {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < until);
  throw last;
}
let cookie = "",
  csrf = "";
async function request(route, body) {
  const response = await fetch(origin + "/api/v1" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const result = await response.json();
  if (!response.ok) throw Error(route + " " + response.status + " " + JSON.stringify(result));
  if (result.csrfToken) csrf = result.csrfToken;
  return result;
}
try {
  await invoke("start");
  const before = await eventually(health);
  if (before.version !== base.version) throw Error("base version not attested");
  daemon = spawn(path.join(release, "runtime/node"), ["dist/apps/updater/main.js", "serve", "--config", configFile], {
    cwd: release,
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (b) => logs.push(b.toString()));
  daemon.stderr.on("data", (b) => logs.push(b.toString()));
  daemonExited = new Promise((resolve) => daemon.once("exit", (code, signal) => resolve({ code, signal })));
  await eventually(() => readFile(path.join(data, "update-queue/updater-heartbeat.json")));
  await request("/session", { password });
  const identity = path.join(root, "identity.age");
  await run(path.join(path.dirname(age), "age-keygen"), ["--output", identity]);
  const recipient = (await readFile(identity, "utf8")).match(/# public key: (age1\S+)/)[1];
  const backup = await request("/maintenance/backup-policies", {
    name: "Full product recovery",
    cron: "0 2 * * *",
    timezone: "UTC",
    ageExecutable: age,
    recipient,
    destination: backups,
  });
  const probe = await request("/maintenance/backup-policies/" + backup.id + "/probe", { identityPath: identity });
  await request("/maintenance/backup-policies/" + backup.id + "/activate", {});
  const policy = await request("/maintenance/update-policies", {
    name: "Full product exact update",
    backupPolicyId: backup.id,
    installDirectory: install,
    trustedPublicKeyPem: pem,
    allowedClasses: ["patch"],
    window: { cron: "* * * * *", timezone: "UTC", durationMinutes: 15 },
  });
  const plan = await request("/maintenance/updates", { policyId: policy.id, releaseDirectory: candidate });
  await request("/maintenance/updates/" + plan.id + "/approve", {});
  const queued = await request("/maintenance/updates/" + plan.id + "/apply", {});
  if (queued.state !== "queued") throw Error("not queued");
  const after = await eventually(async () => {
    const h = await health();
    if (h.version !== nextVersion || h.instanceId === before.instanceId) throw Error("waiting for new identity");
    return h;
  }, 90000);
  const manifestSha256 = await hashFile(path.join(candidate, "release-manifest.json"));
  if (after.releaseManifestSha256 !== manifestSha256) throw Error("manifest identity mismatch");
  const status = await eventually(async () => {
    const s = await request("/maintenance");
    const p = s.updatePlans.find((p) => p.id === plan.id);
    if (p?.state !== "applied") throw Error("result not applied " + JSON.stringify(p));
    return p;
  });
  const result = JSON.parse(
    await readFile(path.join(data, "update-queue", queued.jobId + ".result.json"), "utf8"),
  ).outcome;
  if (result.state !== "applied" || !result.backup) throw Error("missing external proof");
  const evidence = {
    temporaryTestKey: true,
    kind: "full-built-control-http-ceo-approval-external-signed-daemon",
    baseRelease: release,
    before,
    after,
    manifestSha256,
    probeState: probe.state,
    queued,
    finalPlanState: status.state,
    offlineBackupSha256: result.backup.sha256,
    offlineBackupBytes: (await stat(result.backup.archivePath)).size,
    daemonLog: logs,
  };
  await writeFile(values.evidence, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await daemonExited;
  }
  await invoke("stop").catch((e) => console.error("fixture cleanup:", e.message));
  await rm(root, { recursive: true, force: true });
}
