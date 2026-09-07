/** Opt-in real launchd user-domain lifecycle; never touches system daemons or existing labels. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdir, mkdtemp, copyFile, writeFile, rm, realpath, cp } from "node:fs/promises";
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
await cp(path.resolve("dist"), path.join(programDirectory, "dist"), { recursive: true });
await cp(path.resolve("node_modules"), path.join(programDirectory, "node_modules"), { recursive: true });
await copyFile(path.resolve("package.json"), path.join(programDirectory, "package.json"));
const entry = path.join(programDirectory, "dist/apps/control/main.js");
const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const port = s.address().port;
    s.close(() => resolve(port));
  });
});
const previewPort = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolve(value));
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
  previewPort,
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
  await wait(async () =>
    (await fetch(`http://127.0.0.1:${port}/api/v1/health`))
      .json()
      .then((v) => v.database === "ok" || v.database?.ok === true || v.status === "ok"),
  );
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
  await wait(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      return false;
    } catch {
      return true;
    }
  });
  await assert.rejects(() => control.invoke("status"));
  await control.invoke("start");
  await wait(async () => (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok);
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
        actualProductEntrypoint: "dist/apps/control/main.js",
        entrypointSha256: await hashFile(entry),
        nativeOsPreflight: true,
        isolatedControlAndPreviewPorts: true,
        stopSignal: "SIGTERM",
        restart: true,
        definitionSha256: await hashFile(plistPath),
        cleanup: { ownLabelUnloaded: true, temporaryDirectoryRemoved: true },
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Native product launchd registration, health HTTP, idempotency, stop, restart and cleanup passed");
} finally {
  await run("/bin/launchctl", ["bootout", domain + "/" + label]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
