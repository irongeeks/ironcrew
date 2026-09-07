import { createPublicKey, verify } from "node:crypto";
import { chown, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { confinedFile, hashFile, OperationError, safeRelative } from "./common.ts";
const releaseFile = z
  .object({
    path: z.string().refine(safeRelative),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(0),
    executable: z.boolean().default(false),
  })
  .strict();
export const releaseManifestSchema = z
  .object({
    format: z.literal("ironcrew-release"),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/),
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(1),
    nodeVersion: z.literal("26.4.0"),
    platform: z.enum(["linux", "darwin", "win32"]),
    arch: z.enum(["x64", "arm64"]),
    files: z.array(releaseFile).min(1).max(100000),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
/** Public trust key must come from existing administrator configuration, independently of the release. */
export async function verifyRelease(
  directory: string,
  trustedPublicKeyPem: string,
  expected?: { platform: string; arch: string },
): Promise<ReleaseManifest> {
  if (!trustedPublicKeyPem)
    throw new OperationError("release_trust", "Keine vertrauenswürdige Releaseherkunft eingerichtet.");
  const manifestFile = await confinedFile(directory, "release-manifest.json");
  if ((await stat(manifestFile)).size > 16 * 1024 * 1024)
    throw new OperationError("release_manifest", "Manifest überschreitet Größenlimit.");
  const bytes = await readFile(manifestFile);
  const signature = await readFile(await confinedFile(directory, "release-manifest.sig"));
  try {
    const key = createPublicKey(trustedPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || !verify(null, bytes, key, signature))
      throw new Error("signature");
  } catch {
    throw new OperationError("release_signature", "Releasesignatur wurde nicht akzeptiert.");
  }
  let manifest: ReleaseManifest;
  try {
    manifest = releaseManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new OperationError("release_manifest", "Releaseversion oder Manifest ist nicht kompatibel.");
  }
  if (expected && (manifest.platform !== expected.platform || manifest.arch !== expected.arch))
    throw new OperationError("release_platform", "Release passt nicht zu Plattform und Architektur.");
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new OperationError("release_manifest", "Doppelte Releasepfade.");
    seen.add(key);
    const file = await confinedFile(directory, entry.path);
    if ((await stat(file)).size !== entry.bytes || (await hashFile(file)) !== entry.sha256)
      throw new OperationError("release_hash", "Releasehash stimmt nicht mit signiertem Manifest überein.");
  }
  if (
    !manifest.files.some(
      (entry) =>
        entry.path === (manifest.platform === "win32" ? "runtime/node.exe" : "runtime/node") && entry.executable,
    )
  )
    throw new OperationError("release_runtime", "Signierte private Node-Runtime fehlt.");
  if (!manifest.files.some((entry) => entry.path === "dist/apps/control/main.js"))
    throw new OperationError("release_entrypoint", "Gebauter Zentrale-Einstieg fehlt.");
  if (
    manifest.platform === "win32" &&
    !manifest.files.some((entry) => entry.path === "winsw/WinSW-x64.exe" && entry.executable)
  )
    throw new OperationError("release_wrapper", "Signierter WinSW-Wrapper fehlt.");
  return manifest;
}
export interface ActivateReleaseOptions {
  releaseDirectory: string;
  installDirectory: string;
  trustedPublicKeyPem: string;
  platform?: string;
  arch?: string;
  currentSchemaVersion: number;
  beforeActivate: () => Promise<void>;
  healthCheck: (directory: string) => Promise<boolean>;
  restartPrevious: () => Promise<void>;
  beforeRollback?: () => Promise<void>;
}
/** Stages and verifies a complete release, then swaps directories. Callback must quiesce/backup/stop before activation. */
export async function activateRelease(
  options: ActivateReleaseOptions,
): Promise<{ manifest: ReleaseManifest; previousDirectory?: string; installedDirectory: string }> {
  const expected = { platform: options.platform ?? process.platform, arch: options.arch ?? process.arch };
  const manifest = await verifyRelease(options.releaseDirectory, options.trustedPublicKeyPem, expected);
  if (options.currentSchemaVersion !== manifest.schemaVersion)
    throw new OperationError(
      "release_schema",
      "Schemaänderung benötigt einen gesonderten Migrations- und Rückwegplan.",
    );
  const target = path.resolve(options.installDirectory);
  if (target === path.parse(target).root)
    throw new OperationError("release_target", "Root-Verzeichnis ist kein Installationsziel.");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const staging = await mkdtemp(path.join(path.dirname(target), ".release-"));
  let previousDirectory: string | undefined;
  let activated = false;
  try {
    for (const entry of manifest.files) {
      const source = await confinedFile(options.releaseDirectory, entry.path);
      const destination = path.join(staging, entry.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await copyFile(source, destination);
      await chmod(destination, entry.executable ? 0o755 : 0o644);
      if (process.platform !== "win32" && process.getuid?.() === 0) await chown(destination, 0, process.getgid!());
    }
    for (const name of ["release-manifest.json", "release-manifest.sig"]) {
      await copyFile(path.join(options.releaseDirectory, name), path.join(staging, name));
      await chmod(path.join(staging, name), 0o644);
      if (process.platform !== "win32" && process.getuid?.() === 0)
        await chown(path.join(staging, name), 0, process.getgid!());
    }
    await verifyRelease(staging, options.trustedPublicKeyPem, expected);
    await chmod(staging, 0o755);
    await options.beforeActivate();
    try {
      const old = await lstat(target);
      if (!old.isDirectory() || old.isSymbolicLink())
        throw new OperationError("release_target", "Installationsziel ist kein reguläres Verzeichnis.");
      previousDirectory = `${target}.previous-${Date.now()}`;
      await rename(target, previousDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, target);
      activated = true;
      if (!(await options.healthCheck(target)))
        throw new OperationError("release_health", "Healthcheck des neuen Release fehlgeschlagen.");
    } catch (error) {
      await options.beforeRollback?.();
      if (activated) {
        const failed = `${target}.failed-${Date.now()}`;
        await rename(target, failed);
      }
      if (previousDirectory) await rename(previousDirectory, target);
      await options.restartPrevious();
      throw error;
    }
    return { manifest, previousDirectory, installedDirectory: target };
  } finally {
    if (!activated) await rm(staging, { recursive: true, force: true });
  }
}

export async function readInstalledReleaseIdentity(
  installRoot: string,
  trustedPublicKeyPem: string,
  expected?: { platform: string; arch: string },
) {
  const manifest = await verifyRelease(
    installRoot,
    trustedPublicKeyPem,
    expected ?? { platform: process.platform, arch: process.arch },
  );
  return {
    version: manifest.version,
    releaseManifestSha256: await hashFile(path.join(installRoot, "release-manifest.json")),
  };
}
