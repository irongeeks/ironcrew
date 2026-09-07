import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  hashFile,
  verifyRelease,
  activateRelease,
  renderService,
  writeServiceBundle,
  PLATFORM_MATRIX,
  type ReleaseManifest,
} from "../../packages/operations/src/index.ts";
const exec = promisify(execFile);
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ironcrew-release-fixture-"));
  directories.push(directory);
  const release = path.join(directory, "release");
  await mkdir(path.join(release, "runtime"), { recursive: true });
  await mkdir(path.join(release, "dist", "apps", "control"), { recursive: true });
  await writeFile(path.join(release, "runtime", "node"), "fixture runtime", { mode: 0o755 });
  await writeFile(path.join(release, "dist", "apps", "control", "main.js"), 'console.log("fixture")');
  const manifest: ReleaseManifest = {
    format: "ironcrew-release",
    version: "0.4.0",
    schemaVersion: 1,
    protocolVersion: 1,
    nodeVersion: "26.4.0",
    platform: "darwin",
    arch: "arm64",
    files: [],
  };
  for (const file of ["runtime/node", "dist/apps/control/main.js"]) {
    const content = await readFile(path.join(release, file));
    manifest.files.push({
      path: file,
      bytes: content.length,
      sha256: await hashFile(path.join(release, file)),
      executable: file === "runtime/node",
    });
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(release, "release-manifest.json"), bytes);
  await writeFile(path.join(release, "release-manifest.sig"), sign(null, bytes, privateKey));
  return { directory, release, manifest, pem, privateKey };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe("signed release verification and rollback", () => {
  it("verifies signature, exact files and target platform", async () => {
    const f = await fixture();
    expect(await verifyRelease(f.release, f.pem, { platform: "darwin", arch: "arm64" })).toMatchObject({
      nodeVersion: "26.4.0",
      version: "0.4.0",
    });
    await expect(verifyRelease(f.release, f.pem, { platform: "win32", arch: "x64" })).rejects.toMatchObject({
      code: "release_platform",
    });
  });
  it("rejects untrusted signing keys and modified binary before activation", async () => {
    const f = await fixture();
    const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    await expect(verifyRelease(f.release, wrong)).rejects.toMatchObject({ code: "release_signature" });
    await writeFile(path.join(f.release, "runtime", "node"), "modified");
    await expect(verifyRelease(f.release, f.pem)).rejects.toMatchObject({ code: "release_hash" });
  });
  it("rejects a correctly signed incompatible schema", async () => {
    const f = await fixture();
    const bytes = Buffer.from(JSON.stringify({ ...f.manifest, schemaVersion: 2 }));
    await writeFile(path.join(f.release, "release-manifest.json"), bytes);
    await writeFile(path.join(f.release, "release-manifest.sig"), sign(null, bytes, f.privateKey));
    await expect(verifyRelease(f.release, f.pem)).rejects.toMatchObject({ code: "release_manifest" });
  });
  it("rejects symlink file replacement even with identical bytes", async () => {
    const f = await fixture();
    const node = path.join(f.release, "runtime", "node");
    const external = path.join(f.directory, "outside");
    await writeFile(external, "fixture runtime");
    await rm(node);
    await symlink(external, node);
    await expect(verifyRelease(f.release, f.pem)).rejects.toMatchObject({ code: "unsafe_path" });
  });
  it("restores previous release when new healthcheck fails", async () => {
    const f = await fixture();
    const target = path.join(f.directory, "installed");
    await mkdir(target);
    await writeFile(path.join(target, "previous"), "usable prior version");
    let stopped = 0;
    let restarted = 0;
    await expect(
      activateRelease({
        releaseDirectory: f.release,
        installDirectory: target,
        trustedPublicKeyPem: f.pem,
        platform: "darwin",
        arch: "arm64",
        currentSchemaVersion: 1,
        beforeActivate: async () => {
          stopped++;
        },
        healthCheck: async () => false,
        restartPrevious: async () => {
          restarted++;
        },
      }),
    ).rejects.toMatchObject({ code: "release_health" });
    expect(stopped).toBe(1);
    expect(restarted).toBe(1);
    expect(await readFile(path.join(target, "previous"), "utf8")).toBe("usable prior version");
  });
  it("only activates files covered by the signed manifest", async () => {
    const f = await fixture();
    await writeFile(path.join(f.release, "extra-secret"), "not part of release");
    const target = path.join(f.directory, "installed");
    await activateRelease({
      releaseDirectory: f.release,
      installDirectory: target,
      trustedPublicKeyPem: f.pem,
      platform: "darwin",
      arch: "arm64",
      currentSchemaVersion: 1,
      beforeActivate: async () => {},
      healthCheck: async () => true,
      restartPrevious: async () => {},
    });
    await expect(access(path.join(target, "extra-secret"))).rejects.toThrow();
    expect(await readFile(path.join(target, "runtime", "node"), "utf8")).toBe("fixture runtime");
  });
});
describe("native service definitions (render validation, no OS install claim)", () => {
  it.each(PLATFORM_MATRIX)("renders $platform/$arch with private runtime and production JS", (entry) => {
    const bundle = renderService({ platform: entry.platform, role: "control" });
    expect(bundle.definition).toContain("main.js");
    expect(bundle.definition).toContain("runtime");
    expect(bundle.definition).toContain("production");
    expect(bundle.definition).not.toContain("pnpm");
    expect(bundle.definition).not.toContain("tsx");
  });
  it("renders escaped systemd and shell syntax without evaluating path metacharacters", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ironcrew-service-fixture-"));
    directories.push(directory);
    const bundle = await writeServiceBundle(directory, {
      platform: "linux",
      role: "control",
      programDirectory: "/opt/ironcrew $literal % path",
    });
    expect(bundle.definition).toContain("$$literal %% path");
    await exec("/bin/sh", ["-n", path.join(directory, bundle.scriptName)]);
  });
  it("validates launchd plist on macOS and installer shell grammar", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ironcrew-plist-fixture-"));
    directories.push(directory);
    const bundle = await writeServiceBundle(directory, {
      platform: "darwin",
      role: "control",
      programDirectory: "/Library/Application Support/IronCrew & fixture",
    });
    expect(bundle.definition).toContain("&amp;");
    await exec("/bin/sh", ["-n", path.join(directory, bundle.scriptName)]);
    if (process.platform === "darwin") await exec("/usr/bin/plutil", ["-lint", path.join(directory, bundle.name)]);
  });
  it("Windows uses least-privilege service identity and fails if private runtime/wrapper is absent", () => {
    const bundle = renderService({ platform: "win32", role: "control" });
    expect(bundle.definition).toContain("NT AUTHORITY\\LocalService");
    expect(bundle.registrationScript).toContain("Verified WinSW 2.12.0 is missing");
    expect(bundle.registrationScript).toContain("icacls");
  });
  it("rejects root service account, relative paths and non-TLS external URLs", () => {
    expect(() => renderService({ platform: "linux", role: "control", user: "root" })).toThrow();
    expect(() => renderService({ platform: "linux", role: "control", programDirectory: "relative" })).toThrow();
    expect(() => renderService({ platform: "linux", role: "control", publicUrl: "http://public.example" })).toThrow();
  });
});
