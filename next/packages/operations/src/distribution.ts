import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, lstat, realpath, copyFile, chmod, stat, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { create as createTar } from "tar";
import { OperationError, hashFile, safeRelative } from "./common.ts";
import { verifyRelease, releaseManifestSchema, type ReleaseManifest } from "./releases.ts";
export interface DistributionOptions {
  projectDirectory: string;
  runtimePath: string;
  runtimeSha256: string;
  outputDirectory: string;
  privateKeyPath: string;
  version: string;
  platform?: "linux" | "darwin" | "win32";
  arch?: "x64" | "arm64";
  wrapperPath?: string;
  archivePath?: string;
}
/** Assemble a standalone runtime + built product + recursively materialized production dependencies; never includes a signing key. */
export async function packageDistribution(options: DistributionOptions) {
  const project = await realpath(options.projectDirectory),
    output = path.resolve(options.outputDirectory),
    runtime = await realpath(options.runtimePath),
    keyFile = await realpath(options.privateKeyPath);
  if (
    output === project ||
    output.startsWith(project + path.sep) ||
    project.startsWith(output + path.sep) ||
    keyFile === output ||
    keyFile.startsWith(output + path.sep)
  )
    throw new OperationError("distribution_path", "Ausgabe muss vom Quellprojekt und Signaturschlüssel getrennt sein.");
  if ((await hashFile(runtime)) !== options.runtimeSha256)
    throw new OperationError("distribution_runtime_hash", "Private Runtime entspricht nicht dem expliziten Hash.");
  if ((options.platform && options.platform !== process.platform) || (options.arch && options.arch !== process.arch))
    throw new OperationError(
      "distribution_platform",
      "Distribution wird nur für die tatsächlich gebaute Hostplattform erstellt.",
    );
  const version = (
    await promisify(execFile)(runtime, ["--version"], { env: {}, timeout: 10000, maxBuffer: 1024 })
  ).stdout.trim();
  if (version !== "v26.4.0") throw new OperationError("distribution_runtime_version", "Node26.4.0 erforderlich.");
  const privateKey = createPrivateKey(await readFile(keyFile));
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new OperationError("distribution_key", "Ed25519-Signaturschlüssel erforderlich.");
  await mkdir(output, { mode: 0o700 });
  let complete = false;
  const files: ReleaseManifest["files"] = [];
  let total = 0;
  const copy = async (source: string, relative: string) => {
    if (!safeRelative(relative)) throw new OperationError("distribution_path", "Ungültiger Paketpfad.");
    const info = await stat(source);
    if (!info.isFile()) throw new OperationError("distribution_file", "Nur reguläre Dateien sind zulässig.");
    total += info.size;
    if (total > 2_000_000_000 || files.length >= 100000)
      throw new OperationError("distribution_limit", "Distribution überschreitet Grenze.");
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(source, destination);
    const executable =
      (info.mode & 0o111) !== 0 ||
      relative === "runtime/node" ||
      relative === "runtime/node.exe" ||
      relative === "winsw/WinSW-x64.exe";
    await chmod(destination, executable ? 0o755 : 0o644);
    files.push({ path: relative, sha256: await hashFile(destination), bytes: info.size, executable });
  };
  const tree = async (source: string, relative: string, ancestors = new Set<string>(), allowedRoot?: string) => {
    const canonical = await realpath(source);
    const boundary = allowedRoot ?? canonical;
    if (canonical !== boundary && !canonical.startsWith(boundary + path.sep))
      throw new OperationError("distribution_path", "Quelldateilink verlässt sein Paket.");
    if (ancestors.has(canonical))
      throw new OperationError("distribution_cycle", "Zyklische Quelldateien sind nicht zulässig.");
    const info = await lstat(canonical);
    if (info.isFile()) return copy(canonical, relative);
    if (!info.isDirectory()) throw new OperationError("distribution_file", "Ungültige Quelle.");
    const chain = new Set(ancestors).add(canonical);
    for (const item of (await readdir(canonical)).sort()) {
      if (item === "node_modules") continue;
      await tree(path.join(canonical, item), relative + "/" + item, chain, boundary);
    }
  };
  const findPackage = async (start: string, name: string) => {
    let current = start;
    for (;;) {
      try {
        return await realpath(path.join(current, "node_modules", name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current)
        throw new OperationError("distribution_dependency", `Produktionsabhängigkeit fehlt: ${name}`);
      current = parent;
    }
  };
  try {
    await tree(path.join(project, "dist"), "dist");
    const pkg = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")),
      roots = new Map<string, string>();
    for (const name of Object.keys(pkg.dependencies ?? {}).sort()) roots.set(name, await findPackage(project, name));
    const install = async (name: string, source: string, destination: string, ancestors: Map<string, string>) => {
      await tree(source, destination);
      const metadata = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")),
        dependencies = { ...metadata.peerDependencies, ...metadata.optionalDependencies, ...metadata.dependencies };
      const next = new Map(ancestors).set(name, source);
      for (const child of Object.keys(dependencies).sort()) {
        let resolved: string;
        try {
          resolved = await findPackage(source, child);
        } catch (error) {
          if (metadata.optionalDependencies?.[child] || metadata.peerDependenciesMeta?.[child]?.optional) continue;
          throw error;
        }
        if (next.get(child) === resolved) continue;
        await install(child, resolved, destination + "/node_modules/" + child, next);
      }
    };
    for (const [name, source] of roots) await install(name, source, "node_modules/" + name, roots);
    const packageFile = path.join(output, "package.json");
    await writeFile(
      packageFile,
      JSON.stringify(
        { name: pkg.name, version: options.version, type: "module", private: true, engines: pkg.engines },
        null,
        2,
      ) + "\n",
      { mode: 0o644 },
    );
    files.push({
      path: "package.json",
      sha256: await hashFile(packageFile),
      bytes: (await stat(packageFile)).size,
      executable: false,
    });
    const platform = options.platform ?? (process.platform as "linux" | "darwin" | "win32"),
      arch = options.arch ?? (process.arch as "x64" | "arm64");
    const runtimeRelative = platform === "win32" ? "runtime/node.exe" : "runtime/node";
    await copy(runtime, runtimeRelative);
    let observed: { version: string; platform: string; arch: string };
    try {
      observed = JSON.parse(
        (
          await promisify(execFile)(
            path.join(output, runtimeRelative),
            [
              "--eval",
              "console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}))",
            ],
            { cwd: output, env: {}, timeout: 10000, maxBuffer: 2048 },
          )
        ).stdout,
      );
    } catch {
      throw new OperationError(
        "distribution_runtime_portability",
        "Kopierte private Runtime ist nicht eigenständig ausführbar.",
      );
    }
    if (observed.version !== "v26.4.0" || observed.platform !== platform || observed.arch !== arch)
      throw new OperationError(
        "distribution_platform",
        "Tatsächlich gestartete Runtime passt nicht zur Zielplattform.",
      );
    let runtimeLicense: string | undefined;
    for (const candidate of [
      path.join(path.dirname(runtime), "LICENSE"),
      path.resolve(path.dirname(runtime), "../LICENSE"),
    ]) {
      try {
        if ((await lstat(candidate)).isFile()) {
          runtimeLicense = candidate;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!runtimeLicense)
      throw new OperationError(
        "distribution_runtime_license",
        "LICENSE aus derselben offiziellen Node-Distribution erforderlich.",
      );
    await copy(runtimeLicense, "runtime/LICENSE");
    for (const [source, destination] of [
      ["LICENSE", "LICENSE"],
      ["docs/distribution-start.md", "README.md"],
      ["docs/production-updater.md", "docs/production-updater.md"],
      ["docs/remote-execution.md", "docs/remote-execution.md"],
      ["packages/operations/README.md", "docs/operations.md"],
      ["packages/tools/isolation/README.md", "packages/tools/isolation/README.md"],
    ])
      await copy(path.join(project, source!), destination!);
    if (platform === "win32") {
      if (!options.wrapperPath)
        throw new OperationError("distribution_wrapper", "Signierter WinSW-Wrapper erforderlich.");
      await copy(options.wrapperPath, "winsw/WinSW-x64.exe");
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = releaseManifestSchema.parse({
        format: "ironcrew-release",
        version: options.version,
        schemaVersion: 1,
        protocolVersion: 1,
        nodeVersion: "26.4.0",
        platform,
        arch,
        files,
      }),
      bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(path.join(output, "release-manifest.json"), bytes, { mode: 0o644 });
    await writeFile(path.join(output, "release-manifest.sig"), sign(null, bytes, privateKey), { mode: 0o644 });
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    await verifyRelease(output, publicKey, { platform, arch });
    if (options.archivePath) {
      await createTar({ cwd: output, file: options.archivePath, gzip: true, portable: true, mtime: new Date(0) }, [
        ...files.map((f) => f.path),
        "release-manifest.json",
        "release-manifest.sig",
      ]);
    }
    complete = true;
    return {
      directory: output,
      manifest,
      manifestSha256: await hashFile(path.join(output, "release-manifest.json")),
      ...(options.archivePath
        ? { archivePath: options.archivePath, archiveSha256: await hashFile(options.archivePath) }
        : {}),
    };
  } finally {
    if (!complete) await rm(output, { recursive: true, force: true });
  }
}
