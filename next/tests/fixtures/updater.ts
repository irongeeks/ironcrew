import { testNodeRuntime } from "./node-runtime.ts";
import { afterEach } from "vitest";
import { createFixtureLauncher } from "./launcher.ts";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  copyFile,
  chmod,
  chown,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "../../packages/domain/src/index.ts";
import { Repository } from "../../packages/persistence/src/index.ts";
import { MaintenanceService } from "../../apps/control/maintenance-service.ts";
import {
  createBackup,
  hashFile,
  updaterTick,
  queueProductionUpdate,
  NativeServiceControl,
  readUpdaterConfiguration,
} from "../../packages/operations/src/index.ts";
export const run = promisify(execFile),
  age = process.env.IRONCREW_TEST_AGE ?? "/tmp/ironcrew-age-1.3.2/age/age";
export const portableNode = testNodeRuntime();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
export async function fixture(unhealthy = false, aliases = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ironcrew-updater-real-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const diagnostics = process.env.IRONCREW_TEST_UPDATER_DIAGNOSTICS === "1";
  const brokerDiagnostic = path.join(root, "broker-diagnostic.json");
  const phase = (value: string) => {
    if (diagnostics) process.stderr.write(`[updater-fixture] ${value}\n`);
  };
  const inspectBroker = async () => {
    if (!diagnostics) return;
    const record = JSON.parse(await readFile(brokerDiagnostic, "utf8").catch(() => "null"));
    if (record) {
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      process.stderr.write(
        `[updater-fixture] cleanup broker=${JSON.stringify(record)} alive=${JSON.stringify({ broker: alive(record.pid), launcher: alive(record.ppid), service: record.servicePid ? alive(record.servicePid) : false })}\n`,
      );
    }
  };
  cleanup.push(inspectBroker);
  phase("prepare releases");
  const fixtureAge = path.join(root, process.platform === "win32" ? "trusted-age.exe" : "trusted-age");
  await copyFile(age, fixtureAge);
  await chmod(fixtureAge, 0o755);
  if (process.getuid?.() === 0) await chown(fixtureAge, 0, 0);
  await mkdir(path.join(root, "backups"), { mode: 0o700 });
  const data = path.join(root, "data"),
    install = path.join(root, "installed"),
    bootstrap = path.join(root, "bootstrap");
  await mkdir(path.join(data, "blobs"), { recursive: true });
  await writeFile(path.join(data, "blobs", "evidence"), "real offline backup");
  const keys = generateKeyPairSync("ed25519"),
    pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const runtimeRelative = process.platform === "win32" ? "runtime/node.exe" : "runtime/node";
  const shutdownToken = randomUUID();
  const program = `import http from 'node:http'; import fs from 'node:fs/promises'; import crypto from 'node:crypto'; import path from 'node:path';
 const data=process.argv[2], port=Number(process.argv[3]);
 const manifest=await fs.readFile('release-manifest.json'); const version=JSON.parse(manifest).version; const instanceId=crypto.randomUUID();
 const lock=await fs.open(path.join(data,'instance.lock'),'wx',0o600); const token=crypto.randomUUID(); await lock.writeFile(JSON.stringify({version:1,pid:process.pid,token,purpose:'fixture',createdAt:new Date().toISOString()})); await lock.close();
 const server=http.createServer((req,res)=>{if(process.platform==='win32'&&req.method==='POST'&&req.url==='/fixture-shutdown'&&req.headers['x-fixture-token']===${JSON.stringify(shutdownToken)}){res.end('stopping');shutdown();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',version:version==='0.4.1'&&${unhealthy}?'wrong':version,releaseManifestSha256:crypto.createHash('sha256').update(manifest).digest('hex'),instanceId,database:{schemaVersion:1}}));});
 server.listen(port,'127.0.0.1',async()=>await fs.writeFile(path.join(data,'fixture.pid'),String(process.pid)));
 const shutdown=()=>server.close(async()=>{await fs.unlink(path.join(data,'instance.lock'));await fs.unlink(path.join(data,'fixture.pid'));process.exit(0);});process.on('SIGTERM',shutdown);`;
  async function release(directory: string, version: string) {
    await mkdir(path.join(directory, "runtime"), { recursive: true });
    await mkdir(path.join(directory, "dist/apps/control"), { recursive: true });
    await copyFile(portableNode, path.join(directory, runtimeRelative));
    await chmod(path.join(directory, runtimeRelative), 0o755);
    if (process.getuid?.() === 0) await chown(path.join(directory, runtimeRelative), 0, 0);
    await writeFile(path.join(directory, "dist/apps/control/main.js"), program);
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    await chmod(directory, 0o755);
    await mkdir(path.join(directory, "dist/apps/updater"), { recursive: true, mode: 0o755 });
    for (const helper of ["backup", "database", "files"]) {
      let source = await readFile(new URL("../../apps/updater/" + helper + ".ts", import.meta.url), "utf8");
      source = source
        .replaceAll(
          '"../../packages/persistence/src/index.ts"',
          JSON.stringify(new URL("../../packages/persistence/src/index.ts", import.meta.url).href),
        )
        .replaceAll(
          '"../../packages/operations/src/backup.ts"',
          JSON.stringify(new URL("../../packages/operations/src/backup.ts", import.meta.url).href),
        )
        .replaceAll('"zod"', JSON.stringify(new URL("../../node_modules/zod/index.js", import.meta.url).href));
      await writeFile(path.join(directory, "dist/apps/updater", helper + ".js"), source);
    }
    // The native broker below controls this fixture. WinSW is manifest-only and never executed.
    const executableFiles = [runtimeRelative];
    if (process.platform === "win32") {
      await mkdir(path.join(directory, "winsw"));
      await writeFile(path.join(directory, "winsw/WinSW-x64.exe"), "Inert signed wrapper fixture; never executed.");
      executableFiles.push("winsw/WinSW-x64.exe");
    }
    const files = [];
    for (const file of [
      ...executableFiles,
      "dist/apps/control/main.js",
      "package.json",
      "dist/apps/updater/backup.js",
      "dist/apps/updater/database.js",
      "dist/apps/updater/files.js",
    ]) {
      const content = await readFile(path.join(directory, file));
      files.push({
        path: file,
        bytes: content.length,
        sha256: await hashFile(path.join(directory, file)),
        executable: executableFiles.includes(file),
      });
    }
    const bytes = Buffer.from(
      JSON.stringify({
        format: "ironcrew-release",
        version,
        schemaVersion: 1,
        protocolVersion: 1,
        nodeVersion: "26.4.0",
        platform: process.platform,
        arch: process.arch,
        files,
      }),
    );
    await writeFile(path.join(directory, "release-manifest.json"), bytes);
    await writeFile(path.join(directory, "release-manifest.sig"), sign(null, bytes, keys.privateKey));
  }
  await release(install, "0.4.0");
  await release(bootstrap, "0.4.0");
  const candidate = path.join(root, "candidate");
  await release(candidate, "0.4.1");
  if (process.env.IRONCREW_TEST_SYSTEMD === "1") await chown(path.join(candidate, "runtime/node"), 501, 501);
  phase("compile broker launcher");
  const broker = await createFixtureLauncher(
    root,
    "service-broker",
    `import fs from 'node:fs/promises'; import path from 'node:path'; import {spawn} from 'node:child_process';
 const argv=process.argv.slice(2), get=k=>argv[argv.indexOf(k)+1], op=get('--operation'), data=get('--data-dir'), program=get('--program-dir'); const pidFile=path.join(data,'fixture.pid');
 const report=async(stage,servicePid)=>{if(${JSON.stringify(diagnostics)})await fs.writeFile(${JSON.stringify(brokerDiagnostic)},JSON.stringify({stage,operation:op,pid:process.pid,ppid:process.ppid,servicePid}));};
 await report('entered');
 const wait=async(check)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Fixture service transition timed out');};
 if(op==='start'){ const child=spawn(path.join(program,${JSON.stringify(runtimeRelative)}),[path.join(program,'dist/apps/control/main.js'),data,'${port}'],{cwd:program,env:{...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot??process.env.SYSTEMROOT}:{})},detached:true,stdio:'ignore'});child.unref(); await report('spawned',child.pid); await wait(async()=>{try{await fs.access(pidFile);return true;}catch{return false;}}); await report('ready',child.pid); }
 if(op==='stop'){let pid;try{pid=Number(await fs.readFile(pidFile,'utf8'));}catch{} if(pid){if(process.platform==='win32'){const r=await fetch('http://127.0.0.1:${port}/fixture-shutdown',{method:'POST',headers:{'x-fixture-token':${JSON.stringify(shutdownToken)}},signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Fixture shutdown denied');}else process.kill(pid,'SIGTERM');await wait(async()=>{try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}});try{await fs.access(pidFile);throw Error('still running');}catch(e){if(e.code!=='ENOENT')throw e;}}}
 await report('returning',Number(await fs.readFile(pidFile,'utf8').catch(()=>'0'))); console.log(JSON.stringify({serviceName:get('--service'),state:op==='stop'?'stopped':'running'}));`,
  );
  phase("open repository");
  const repo = await Repository.open(path.join(data, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Updater local fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas.find((a) => a.visibility === "company")!.id };
  let repoClosed = false;
  cleanup.push(async () => {
    if (!repoClosed) await repo.close();
  });
  phase("generate age identity");
  const identity = path.join(root, "age-identity");
  await run(
    process.env.IRONCREW_TEST_AGE_KEYGEN ??
      path.join(path.dirname(age), process.platform === "win32" ? "age-keygen.exe" : "age-keygen"),
    ["--output", identity],
  );
  const recipient = (await readFile(identity, "utf8")).match(/# public key: (age1\S+)/)![1];
  let serviceConfiguration: Record<string, unknown> = {
    kind: "ironcrew-service-v1",
    name: "fixture",
    executable: broker,
    executableSha256: await hashFile(broker),
  };
  if (process.env.IRONCREW_TEST_SYSTEMD === "1") {
    if (process.platform !== "linux" || process.getuid?.() !== 0)
      throw new Error("Explicit Linux root test VM required");
    await chmod(root, 0o755);
    await chown(data, 501, 501);
    await chown(path.join(root, "backups"), 501, 501);
    await chown(path.join(data, "company.sqlite"), 501, 501);
    const unitName = "ironcrew-updater-fixture-" + path.basename(root) + ".service",
      unitPath = "/etc/systemd/system/" + unitName;
    await writeFile(
      unitPath,
      `[Unit]\nDescription=Temporary IronCrew updater acceptance fixture\n[Service]\nType=simple\nUser=robert\nWorkingDirectory=${install}\nExecStart=${install}/runtime/node ${install}/dist/apps/control/main.js ${data} ${port}\nRestart=no\nTimeoutStopSec=10\n`,
    );
    cleanup.push(async () => {
      await run("/usr/bin/systemctl", ["stop", unitName]).catch(() => {});
      await run("/usr/bin/systemctl", ["disable", unitName]).catch(() => {});
      await rm(unitPath, { force: true });
      await run("/usr/bin/systemctl", ["daemon-reload"]);
    });
    await run("/usr/bin/systemctl", ["daemon-reload"]);
    serviceConfiguration = {
      kind: "systemd",
      name: unitName,
      executable: "/usr/bin/systemctl",
      executableSha256: await hashFile("/usr/bin/systemctl"),
    };
  }
  const configPath = path.join(root, "updater.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      companyId: scope.companyId,
      dataDirectory: data,
      installDirectory: install,
      bootstrapDirectory: bootstrap,
      ageExecutable: fixtureAge,
      ageExecutableSha256: await hashFile(fixtureAge),
      backupDirectory: path.join(root, "backups"),
      trustedPublicKeyPem: pem,
      service: serviceConfiguration,
      healthUrl: `http://127.0.0.1:${port}/health`,
      healthTimeoutMs: 1000,
    }),
    { mode: 0o600 },
  );
  const config = await readUpdaterConfiguration(configPath);
  const controller = new NativeServiceControl(config.service, install, data);
  cleanup.push(async () => {
    await inspectBroker();
    await controller.invoke("stop").catch(() => {});
  });
  phase("controller start");
  await controller.invoke("start");
  phase("controller start returned");
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(config.healthUrl);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const before = await (await fetch(config.healthUrl)).json();
  const policyInstall = aliases ? path.join(root, "install-alias") : install;
  const policyAge = aliases
    ? process.platform === "win32"
      ? path.join(root, "age-parent-alias", path.basename(fixtureAge))
      : path.join(root, "age-alias")
    : fixtureAge;
  const policyBackup = aliases ? path.join(root, "backup-alias") : path.join(root, "backups");
  if (aliases) {
    await symlink(install, policyInstall, process.platform === "win32" ? "junction" : "dir");
    if (process.platform === "win32") await symlink(root, path.join(root, "age-parent-alias"), "junction");
    else await symlink(fixtureAge, policyAge);
    await symlink(path.join(root, "backups"), policyBackup, process.platform === "win32" ? "junction" : "dir");
  }
  const service = new MaintenanceService({
    repo,
    directory: data,
    currentVersion: "0.4.0",
    onlineBackup: (input) =>
      createBackup({
        databasePath: path.join(data, "company.sqlite"),
        blobDirectory: path.join(data, "blobs"),
        ...input,
        appVersion: "0.4.0",
        configuration: {},
        quiesce: async () => async () => {},
        snapshotDatabase: (destination) => repo.backup(destination),
      }),
    updateConfigurationFingerprint: async () => sha256(config),
    updateExecutor: (request) => queueProductionUpdate({ repo, ...request, configurationPath: configPath }),
  });
  const backup = await service.proposeBackupPolicy(scope, setup.ceo.id, {
    name: "Recovery proven",
    cron: "0 2 * * *",
    timezone: "UTC",
    ageExecutable: policyAge,
    recipient,
    destination: policyBackup,
  });
  phase("backup restore probe");
  await service.probeBackupPolicy(scope, setup.ceo.id, backup.id, { identityPath: identity });
  phase("backup restore probe returned");
  await service.activateBackupPolicy(scope, setup.ceo.id, backup.id);
  if (process.env.IRONCREW_TEST_SYSTEMD === "1")
    for (const name of await readdir(path.join(root, "backups")))
      await chown(path.join(root, "backups", name), 501, 501);
  const policy = await service.proposeUpdatePolicy(scope, setup.ceo.id, {
    name: "Fixture update",
    backupPolicyId: backup.id,
    installDirectory: policyInstall,
    trustedPublicKeyPem: pem,
    allowedClasses: ["patch"],
    window: { cron: "* * * * *", timezone: "UTC", durationMinutes: 10 },
  });
  phase("propose signed update");
  const plan = await service.proposeUpdate(scope, setup.ceo.id, policy.id, candidate);
  await service.approveUpdate(scope, setup.ceo.id, plan.id);
  await updaterTick(configPath);
  phase("ready");
  return {
    root,
    repo,
    scope,
    setup,
    service,
    plan,
    configPath,
    config,
    before,
    candidate,
    closeRepo: async () => {
      await repo.close();
      repoClosed = true;
    },
  };
}
