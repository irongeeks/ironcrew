/** Opt-in real launchd user-domain lifecycle; never touches system daemons or existing labels. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm, realpath, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeServiceBundle } from "../../packages/operations/src/services.ts";
import { NativeServiceControl } from "../../packages/operations/src/service-control.ts";
import { hashFile } from "../../packages/operations/src/common.ts";
assert.equal(process.platform, "darwin");
const evidencePath = process.argv[2];
assert.ok(evidencePath);
const run = promisify(execFile),
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "ironcrew-launchd-")));
const programDirectory = path.join(directory, "app"),
  dataDirectory = path.join(directory, "data"),
  bundleDirectory = path.join(directory, "bundle");
await mkdir(path.join(programDirectory, "runtime"), { recursive: true });
await mkdir(path.join(programDirectory, "dist/apps/control"), { recursive: true });
await mkdir(dataDirectory);
const runtime = process.env.IRONCREW_TEST_NODE ?? "/tmp/ironcrew-node26/node-v26.4.0-darwin-arm64/bin/node";
await copyFile(runtime, path.join(programDirectory, "runtime/node"));
await cp(path.resolve("dist/packages/operations"), path.join(programDirectory, "dist/packages/operations"), {
  recursive: true,
});
await writeFile(path.join(programDirectory, "dist/packages/operations/package.json"), '{"type":"module"}');
const entry = path.join(programDirectory, "dist/apps/control/main.js");
await writeFile(
  entry,
  `const fs=require('node:fs'),http=require('node:http'),path=require('node:path');const server=http.createServer((req,res)=>res.end('native-launchd-fixture'));server.listen(Number(process.env.IRONCREW_PORT),'127.0.0.1');process.once('SIGTERM',()=>server.close(()=>{fs.writeFileSync(path.join(process.env.IRONCREW_DATA_DIR,'graceful-stop'),'SIGTERM');process.exit(0);}));`,
);
const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const port = s.address().port;
    s.close(() => resolve(port));
  });
});
const domain = `gui/${process.getuid()}`,
  serviceName = "ironcrew-fixture-" + randomUUID();
const bundle = await writeServiceBundle(bundleDirectory, {
  platform: "darwin",
  role: "control",
  programDirectory,
  dataDirectory,
  serviceName,
  launchdDomain: domain,
  port,
});
const label = bundle.name.replace(/\.plist$/, ""),
  plistPath = path.join(dataDirectory, bundle.name);
const wait = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    try {
      if (await predicate()) return;
    } catch {
      /* Wait for the dedicated launchd child to finish booting. */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Native launchd fixture timed out");
};
try {
  await run("/bin/sh", [path.join(bundleDirectory, bundle.scriptName)], { cwd: bundleDirectory });
  await wait(async () => (await fetch(`http://127.0.0.1:${port}`)).text().then((v) => v === "native-launchd-fixture"));
  await run("/bin/sh", [path.join(bundleDirectory, bundle.scriptName)], { cwd: bundleDirectory });
  const control = new NativeServiceControl(
    {
      kind: "launchd",
      executable: "/bin/launchctl",
      executableSha256: await hashFile("/bin/launchctl"),
      name: label,
      plistPath,
      configurationSha256: await hashFile(plistPath),
      domain,
    },
    programDirectory,
    dataDirectory,
  );
  await control.invoke("status");
  await control.invoke("stop");
  await wait(async () => (await readFile(path.join(dataDirectory, "graceful-stop"), "utf8")) === "SIGTERM");
  await assert.rejects(() => control.invoke("status"));
  await control.invoke("start");
  await wait(async () => (await fetch(`http://127.0.0.1:${port}`)).ok);
  await control.invoke("status");
  await control.invoke("stop");
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        domain,
        nativeLaunchctl: true,
        systemDaemonInstalled: false,
        dedicatedSystemAccountTested: false,
        registrationIdempotent: true,
        actualHttp: true,
        stopSignal: "SIGTERM",
        restart: true,
        definitionSha256: await hashFile(plistPath),
        cleanup: { ownLabelUnloaded: true, temporaryDirectoryRemoved: true },
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Native launchd registration, HTTP, idempotency, stop, restart and cleanup passed");
} finally {
  await run("/bin/launchctl", ["bootout", domain + "/" + label]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
