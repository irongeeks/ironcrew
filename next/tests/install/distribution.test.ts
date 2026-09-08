import { testNodeRuntime } from "../fixtures/node-runtime.ts";
import { test, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  packageDistribution,
  hashFile,
  verifyRelease,
  installUpdaterBootstrap,
} from "../../packages/operations/src/index.ts";
const runtime = testNodeRuntime();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ironcrew-distribution-"));
  roots.push(root);
  const source = path.join(root, "source");
  await mkdir(path.join(source, "dist/apps/control"), { recursive: true });
  await mkdir(path.join(source, "dist/apps/updater"), { recursive: true });
  await mkdir(path.join(source, "node_modules/alpha/node_modules/beta"), { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "fixture",
      type: "module",
      dependencies: { alpha: "1.0.0" },
      devDependencies: { "excluded-dev": "1.0.0" },
    }),
  );
  await writeFile(path.join(source, "dist/apps/control/main.js"), `import value from 'alpha'; console.log(value);`);
  await writeFile(path.join(source, "dist/apps/updater/main.js"), 'console.log("bootstrap fixture");');
  await writeFile(
    path.join(source, "node_modules/alpha/package.json"),
    JSON.stringify({ name: "alpha", version: "1.0.0", main: "index.js", dependencies: { beta: "1.0.0" } }),
  );
  await writeFile(path.join(source, "node_modules/alpha/index.js"), 'module.exports=require("beta")+1;');
  await writeFile(
    path.join(source, "node_modules/alpha/node_modules/beta/package.json"),
    JSON.stringify({ name: "beta", version: "1.0.0", main: "index.js" }),
  );
  await writeFile(path.join(source, "node_modules/alpha/node_modules/beta/index.js"), "module.exports=41;");
  for (const file of [
    "LICENSE",
    "docs/distribution-start.md",
    "docs/production-updater.md",
    "docs/remote-execution.md",
    "packages/operations/README.md",
    "packages/tools/isolation/README.md",
  ]) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), "Explicit fixture notice: " + file);
  }
  const wrapper = path.join(root, "WinSW-x64.exe");
  await writeFile(wrapper, "Inert wrapper fixture; never executed by this package test.");
  const key = generateKeyPairSync("ed25519");
  const privateKeyPath = path.join(root, "TEMPORARY-TEST-KEY.pem");
  await writeFile(privateKeyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return {
    root,
    source,
    pem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
    options: {
      projectDirectory: source,
      runtimePath: runtime,
      runtimeSha256: await hashFile(runtime),
      outputDirectory: path.join(root, "release"),
      privateKeyPath,
      version: "0.4.1",
      ...(process.platform === "win32" ? { wrapperPath: wrapper } : {}),
    },
  };
}
test("signed standalone distribution materializes transitive dependencies, executes private runtime and installs independent bootstrap", async () => {
  const f = await fixture();
  const result = await packageDistribution({ ...f.options, archivePath: path.join(f.root, "release.tgz") });
  const observed = await promisify(execFile)(
    path.join(result.directory, process.platform === "win32" ? "runtime/node.exe" : "runtime/node"),
    ["dist/apps/control/main.js"],
    { cwd: result.directory, env: {} },
  );
  expect(observed.stdout.trim()).toBe("42");
  expect(await readFile(path.join(result.directory, "README.md"), "utf8")).toBe(
    "Explicit fixture notice: docs/distribution-start.md",
  );
  expect((await readFile(path.join(result.directory, "runtime/LICENSE"), "utf8")).length).toBeGreaterThan(100);
  expect(result.manifest.files.some((file) => file.path === "runtime/LICENSE")).toBe(true);
  expect(result.manifest.files.some((f) => f.path.includes("beta/index.js"))).toBe(true);
  expect(result.manifest.files.some((f) => /TEST-KEY|excluded-dev/.test(f.path))).toBe(false);
  expect(await verifyRelease(result.directory, f.pem)).toEqual(result.manifest);
  expect((await readFile(result.archivePath!)).length).toBeGreaterThan(1000);
  const bootstrap = path.join(f.root, "bootstrap");
  await installUpdaterBootstrap({
    releaseDirectory: result.directory,
    bootstrapDirectory: bootstrap,
    trustedPublicKeyPem: f.pem,
  });
  expect(
    (
      await promisify(execFile)(
        path.join(bootstrap, process.platform === "win32" ? "runtime/node.exe" : "runtime/node"),
        ["dist/apps/updater/main.js"],
        {
          cwd: bootstrap,
          env: {},
        },
      )
    ).stdout.trim(),
  ).toBe("bootstrap fixture");
  await expect(
    installUpdaterBootstrap({
      releaseDirectory: result.directory,
      bootstrapDirectory: bootstrap,
      trustedPublicKeyPem: f.pem,
    }),
  ).rejects.toMatchObject({ code: "bootstrap_exists" });
}, 30000);
test("distribution denies platform lies, wrong runtime and source symlink escape", async () => {
  const f = await fixture();
  await expect(
    packageDistribution({ ...f.options, arch: process.arch === "arm64" ? "x64" : "arm64" }),
  ).rejects.toMatchObject({ code: "distribution_platform" });
  await expect(packageDistribution({ ...f.options, runtimeSha256: "0".repeat(64) })).rejects.toMatchObject({
    code: "distribution_runtime_hash",
  });
  await symlink(f.options.privateKeyPath, path.join(f.source, "dist/escape.pem"));
  await expect(packageDistribution(f.options)).rejects.toMatchObject({ code: "distribution_path" });
  expect(existsSync(f.options.outputDirectory)).toBe(false);
});
