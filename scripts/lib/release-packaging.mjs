import process from "node:process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const SHA = /^[a-f0-9]{40}$/;
export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value))
    throw new Error("Release requires an exact stable semantic version.");
  return value;
}
export function createReleasePackage({
  root = process.cwd(),
  commit,
  outDir,
  imageDigest = null,
  repository = "irongeeks/ironcrew",
}) {
  if (!SHA.test(commit)) throw new Error("Release requires a full commit SHA.");
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error("Invalid release repository.");
  if (imageDigest !== null && !DIGEST.test(imageDigest)) throw new Error("Invalid OCI digest.");
  const git = (args, encoding = "utf8") =>
    execFileSync("git", args, { cwd: root, encoding, maxBuffer: 512 * 1024 * 1024 });
  if (git(["rev-parse", `${commit}^{commit}`]).trim() !== commit) throw new Error("Commit cannot be resolved exactly.");
  const version = validateVersion(JSON.parse(git(["show", `${commit}:package.json`])).version);
  const files = git(["ls-tree", "-rz", "--name-only", commit]).split("\0").filter(Boolean);
  for (const file of files) {
    if (
      /(^|\/)(node_modules|\.git|\.references)(\/|$)/.test(file) ||
      /^(data|vault)\//.test(file) ||
      /\.(sqlite|sqlite3|db)$/.test(file) ||
      (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith(".example")) ||
      (file.startsWith("config/private/") && !file.endsWith(".example.yaml"))
    )
      throw new Error(`Private/generated tracked file cannot enter release: ${file}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = `ironcrew-${version}-source.tar.gz`;
  const archive = gzipSync(git(["archive", "--format=tar", `--prefix=ironcrew-${version}/`, commit], null), {
    level: 9,
  });
  fs.writeFileSync(path.join(outDir, file), archive);
  const manifest = {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    commit,
    source: { file, sha256: sha256(archive), size: archive.length },
    container: imageDigest
      ? { image: `ghcr.io/${repository.toLowerCase()}:v${version}`, digest: imageDigest, platforms: ["linux/amd64"] }
      : null,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "release-manifest.json"), manifestBytes);
  fs.writeFileSync(
    path.join(outDir, "SHA256SUMS"),
    `${sha256(archive)}  ${file}\n${sha256(manifestBytes)}  release-manifest.json\n`,
  );
  return manifest;
}

/** Retry uses the original image, never a second build under an existing version tag. */
export async function ensureVersionImage({ getDigest, run, inspect, smoke, image, version, commit, repository }) {
  let digest = await getDigest();
  if (digest) {
    const pinned = `${image}@${digest}`;
    run(["pull", pinned]);
    const labels = inspect(pinned);
    if (
      labels?.["org.opencontainers.image.revision"] !== commit ||
      labels?.["org.opencontainers.image.version"] !== version
    )
      throw new Error("Existing version image belongs to another build; refusing overwrite.");
    smoke(pinned);
    return digest;
  }
  run([
    "build",
    "--platform",
    "linux/amd64",
    "--target",
    "production",
    "--label",
    `org.opencontainers.image.revision=${commit}`,
    "--label",
    `org.opencontainers.image.version=${version}`,
    "--label",
    `org.opencontainers.image.source=https://github.com/${repository}`,
    "--tag",
    image,
    ".",
  ]);
  smoke(image);
  if (await getDigest())
    throw new Error("Version image appeared during build; refusing to replace it. Retry to verify and reuse.");
  run(["push", image]);
  digest = await getDigest();
  if (!DIGEST.test(digest)) throw new Error("Pushed version image cannot be verified.");
  return digest;
}
