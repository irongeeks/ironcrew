import { it, expect } from "vitest";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../../packages/persistence/src/index.ts";
import { productionUpdates } from "../../apps/control/production-update.ts";

it("binds advertised release identity to the actual installed entrypoint, runtime and company", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "production-update-binding-")));
  const data = path.join(root, "data"),
    install = path.join(root, "install"),
    bootstrap = path.join(root, "bootstrap");
  for (const directory of [data, install, bootstrap]) await mkdir(directory);
  const repo = await Repository.open(path.join(data, "company.sqlite"));
  try {
    const setup = await repo.setup({
      companyName: "Release identity fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "0",
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const runtimeRelative = process.platform === "win32" ? "runtime/node.exe" : "runtime/node";
    // Signed inert file fixtures test the startup binding. A real service-switch test lives in install/updater tests.
    const inputs: Record<string, string> = {
      [runtimeRelative]: "inert fixture runtime",
      "dist/apps/control/main.js": "inert fixture entrypoint",
    };
    if (process.platform === "win32") inputs["winsw/WinSW-x64.exe"] = "inert fixture wrapper";
    const files = [];
    for (const [relative, content] of Object.entries(inputs)) {
      const file = path.join(install, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      files.push({
        path: relative,
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        executable: relative !== "dist/apps/control/main.js",
      });
    }
    const manifest = Buffer.from(
      JSON.stringify({
        format: "ironcrew-release",
        version: "0.4.1",
        schemaVersion: 1,
        protocolVersion: 1,
        nodeVersion: "26.4.0",
        platform: process.platform,
        arch: process.arch,
        files,
      }),
    );
    await writeFile(path.join(install, "release-manifest.json"), manifest);
    await writeFile(path.join(install, "release-manifest.sig"), sign(null, manifest, privateKey));
    const configurationPath = path.join(root, "updater.json");
    const ageExecutable = path.join(root, "fixture-age"),
      backupDirectory = path.join(root, "backups");
    await writeFile(ageExecutable, "inert fixture age", { mode: 0o755 });
    await mkdir(backupDirectory);
    await writeFile(
      configurationPath,
      JSON.stringify({
        version: 1,
        companyId: setup.company.id,
        dataDirectory: data,
        installDirectory: install,
        bootstrapDirectory: bootstrap,
        ageExecutable,
        ageExecutableSha256: createHash("sha256").update("inert fixture age").digest("hex"),
        backupDirectory,
        trustedPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
        service: {
          kind: "ironcrew-service-v1",
          executable: process.execPath,
          executableSha256: "a".repeat(64),
          name: "fixture",
        },
        healthUrl: "http://127.0.0.1:8790/api/v1/health",
      }),
      { mode: 0o600 },
    );
    const options = {
      repo,
      directory: data,
      configurationPath,
      cwd: install,
      entrypoint: path.join(install, "dist/apps/control/main.js"),
      executable: path.join(install, runtimeRelative),
    };
    const selected = await productionUpdates(options);
    expect(selected.releaseIdentity).toEqual({
      version: "0.4.1",
      releaseManifestSha256: createHash("sha256").update(manifest).digest("hex"),
    });
    await expect(productionUpdates({ ...options, executable: process.execPath })).rejects.toMatchObject({
      code: "updater_installation_mismatch",
    });
    await expect(productionUpdates({ ...options, cwd: root })).rejects.toMatchObject({
      code: "updater_installation_mismatch",
    });
    await writeFile(options.entrypoint, "modified after signing");
    await expect(productionUpdates(options)).rejects.toMatchObject({ code: "release_hash" });
  } finally {
    await repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
