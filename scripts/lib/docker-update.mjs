import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { releaseVersionOrderOverride } from "./release-version.mjs";

const REPOSITORY = "ghcr.io/irongeeks/ironcrew";
const IMAGE_ENV = "release-image.env";
const ID = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;
const HEALTH_SCRIPT =
  'const r=await fetch("http://127.0.0.1:8790/health",{signal:globalThis.AbortSignal.timeout(10000)});if(!r.ok)throw new Error("health failed");process.stdout.write(JSON.stringify(await r.json()));';

export function parseDockerUpdateArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--check", "--dry-run", "--help"].includes(flag)) {
      options[flag.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    const names = {
      "--to": "to",
      "--backup-dir": "backupDir",
      "--manifest": "manifestFile",
      "--expected-version": "expectedVersion",
    };
    const key = names[flag];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--") || options[key] !== undefined)
      throw new Error(`Invalid or duplicate option: ${flag}`);
    options[key] = args[++i];
  }
  if (options.help) return options;
  if (!options.to || !options.backupDir || !path.isAbsolute(options.backupDir))
    throw new Error("Use --to <version> and --backup-dir <absolute private directory>.");
  const digest = options.to.startsWith(`${REPOSITORY}@`);
  const version = (digest ? options.expectedVersion : options.to)?.replace(/^v/, "");
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "") ||
    (digest && !ID.test(options.to.slice(REPOSITORY.length + 1)))
  )
    throw new Error("Choose a fixed vX.Y.Z release; GHCR digest targets also need --expected-version vX.Y.Z.");
  if (!digest && options.expectedVersion && options.expectedVersion.replace(/^v/, "") !== version)
    throw new Error("Target and expected version disagree.");
  return { ...options, version, dryRun: !!(options.check || options.dry_run) };
}

export function validateReleaseManifest(value, options) {
  const version = options.version;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.version !== version ||
    value.tag !== `v${version}` ||
    !/^[a-f0-9]{40}$/.test(value.commit ?? "") ||
    value.container?.image !== `${REPOSITORY}:v${version}` ||
    !ID.test(value.container?.digest ?? "")
  )
    throw new Error("Release manifest version, source revision or pinned container digest is invalid.");
  const image = `${REPOSITORY}@${value.container.digest}`;
  if (options.to.startsWith(`${REPOSITORY}@`) && options.to !== image)
    throw new Error("Requested digest differs from the release manifest.");
  return { version, revision: value.commit, image };
}

export function compareVersions(left, right) {
  const a = VERSION.exec(left.replace(/^v/, "")),
    b = VERSION.exec(right.replace(/^v/, ""));
  if (!a || !b) throw new Error("Installed or target version is not valid SemVer.");
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
  if (!a[4] && !b[4]) return 0;
  if (!a[4] || !b[4]) return a[4] ? -1 : 1;
  const ap = a[4].split("."),
    bp = b[4].split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(ap[i]),
      bn = /^\d+$/.test(bp[i]);
    if (an && bn) return Number(ap[i]) < Number(bp[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] < bp[i] ? -1 : 1;
  }
  return 0;
}

/** No shell, inherited terminal output, or unredacted Docker stderr. */
export async function runDocker(args, { cwd, env, outputFile, discardOutput = false, signal, timeout = 600_000 } = {}) {
  const output = outputFile ? await fs.open(outputFile, "wx", 0o600) : null;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        cwd,
        env,
        signal,
        stdio: ["ignore", output ? output.fd : discardOutput ? "ignore" : "pipe", "pipe"],
      });
      const chunks = [];
      let size = 0;
      let errorSize = 0;
      const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
      timer.unref();
      child.stdout?.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) child.kill("SIGTERM");
        else chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        errorSize += chunk.length;
        if (errorSize > 16 * 1024 * 1024) child.kill("SIGTERM");
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error(`Docker ${args[0]} could not run.`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && size <= 16 * 1024 * 1024) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error(`Docker ${args[0]} failed (exit ${code ?? "interrupted"}).`));
      });
    });
    if (output) await output.sync();
    return result;
  } finally {
    await output?.close();
  }
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await fs.realpath(directory);
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Backup directory must be owned by the current user with mode 0700.");
  return canonical;
}
async function plainFile(file, required = true) {
  const stat = await fs.lstat(file).catch((error) => {
    if (error.code === "ENOENT" && !required) return null;
    throw error;
  });
  if (stat && !stat.isFile())
    throw new Error("Compose, environment and image-state inputs must be regular files, not symlinks.");
  return stat !== null;
}
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const mountIdentity = (mount) => [
  mount.Type,
  mount.Destination,
  mount.Type === "volume" ? mount.Name : path.resolve(mount.Source),
  !!mount.RW,
];
function validateMounts(config, container, cwd) {
  const service = config.services?.ironcrew;
  if (!service || !Array.isArray(service.volumes))
    throw new Error("Missing production service or volume configuration.");
  const current = container.Mounts;
  if (!Array.isArray(current) || current.some((m) => !["bind", "volume"].includes(m.Type)))
    throw new Error("Unsupported persistent mounts; use a reviewed manual update.");
  const expected = service.volumes.map((v) => [
    v.type,
    v.target,
    v.type === "volume"
      ? (config.volumes?.[v.source]?.name ?? `${config.name}_${v.source}`)
      : path.resolve(cwd, v.source),
    !v.read_only,
  ]);
  const actual = current.map(mountIdentity);
  const ordered = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  if (JSON.stringify(ordered(expected)) !== JSON.stringify(ordered(actual)))
    throw new Error("Compose mounts differ from the existing container; refusing to move company data.");
  const data = current.find((m) => m.Destination === "/data"),
    relative = current.find((m) => m.Destination === "/app/data");
  const logical = service.volumes.find((v) => v.target === "/data");
  if (logical?.source !== "octooffice-data" || data?.Type !== "volume" || relative?.Name !== data.Name)
    throw new Error("The existing octooffice-data volume must remain mounted at /data and /app/data.");
  if (service.environment?.DB_PATH !== "/data/octooffice.sqlite")
    throw new Error("Refusing a changed database location.");
  for (const mount of current) {
    const source = mount.Type === "volume" ? mount.Name : mount.Source;
    if (
      typeof source !== "string" ||
      !source ||
      source.includes(",") ||
      source.includes("\n") ||
      (mount.Type === "bind" && path.parse(source).root === source)
    )
      throw new Error("Unsupported or overly broad backup mount.");
  }
  return current;
}
async function digestFile(file, allowEmpty = false) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const stat = await fs.stat(file);
  if (!stat.size && !allowEmpty) throw new Error("Empty backup archive.");
  return { file, size: stat.size, sha256: hash.digest("hex") };
}
async function writePrivate(file, value) {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const descriptor = await fs.open(tmp, "wx", 0o600);
  try {
    await descriptor.writeFile(value);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await fs.rename(tmp, file);
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function canonicalDestination(directory) {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(await canonicalDestination(path.dirname(directory)), path.basename(directory));
  }
}

async function readManifest(options, fetchImpl) {
  let raw;
  if (options.manifestFile) {
    const stat = await fs.stat(options.manifestFile);
    if (stat.size > 65536) throw new Error("Release manifest is too large.");
    raw = await fs.readFile(options.manifestFile, "utf8");
  } else {
    const response = await fetchImpl(
      `https://github.com/irongeeks/ironcrew/releases/download/v${options.version}/release-manifest.json`,
      { signal: globalThis.AbortSignal.timeout(30_000) },
    );
    if (!response.ok) throw new Error("Published release manifest is unavailable.");
    raw = "";
    for await (const chunk of response.body) {
      raw += Buffer.from(chunk).toString("utf8");
      if (raw.length > 65536) throw new Error("Release manifest is too large.");
    }
  }
  return validateReleaseManifest(JSON.parse(raw), options);
}

export async function updateDockerRelease(
  options,
  { cwd = process.cwd(), env = process.env, run = runDocker, fetchImpl = globalThis.fetch, signal } = {},
) {
  cwd = await fs.realpath(cwd);
  for (const file of ["compose.yaml", "compose.release.yaml", ".env"]) await plainFile(path.join(cwd, file));
  const existingImageEnv = await plainFile(path.join(cwd, IMAGE_ENV), false);
  const release = await readManifest(options, fetchImpl);
  const commandEnv = { ...env, IRONCREW_RELEASE_IMAGE: release.image };
  const prefix = (hasState = existingImageEnv) => [
    "compose",
    "--env-file",
    ".env",
    ...(hasState ? ["--env-file", IMAGE_ENV] : []),
    "-f",
    "compose.yaml",
    "-f",
    "compose.release.yaml",
    "--profile",
    "prod",
  ];
  const call = (args, extra = {}) => run(args, { cwd, env: commandEnv, signal, ...extra });
  const json = async (args) => JSON.parse(await call(args));
  if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://"))
    throw new Error("Updater supports only a local Unix-socket Docker daemon.");
  const contexts = await json(["context", "inspect"]);
  if (!env.DOCKER_HOST && !contexts[0]?.Endpoints?.docker?.Host?.startsWith("unix://"))
    throw new Error("Remote Docker contexts are unsupported for host backups.");
  const config = await json([...prefix(), "config", "--format", "json"]);
  const ids = (await call([...prefix(), "ps", "--all", "--quiet", "ironcrew"])).trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1)
    throw new Error("Exactly one existing ironcrew production container is required; this is not an installer.");
  const container = (await json(["inspect", ids[0]]))[0];
  const labels = container.Config?.Labels ?? {};
  if (
    labels["com.docker.compose.project"] !== config.name ||
    labels["com.docker.compose.service"] !== "ironcrew" ||
    !ID.test(container.Image ?? "")
  )
    throw new Error("Existing Compose project, service or image identity is invalid.");
  if ((await fs.realpath(labels["com.docker.compose.project.working_dir"] ?? "")) !== cwd)
    throw new Error("Run this updater from the existing Compose project directory.");
  const permittedFiles = new Set([path.join(cwd, "compose.yaml"), path.join(cwd, "compose.release.yaml")]);
  const previousFiles = (labels["com.docker.compose.project.config_files"] ?? "").split(",");
  if (!previousFiles.length || previousFiles.some((file) => !file))
    throw new Error("Existing additional Compose overrides require a reviewed manual update.");
  for (const file of previousFiles) {
    if (!permittedFiles.has(await fs.realpath(path.resolve(cwd, file))))
      throw new Error("Existing additional Compose overrides require a reviewed manual update.");
  }
  const mounts = validateMounts(config, container, cwd);
  if (!container.State?.Running) throw new Error("Existing service must be running and healthy before an update.");
  const health = await json(["exec", container.Id, "node", "--input-type=module", "-e", HEALTH_SCRIPT]);
  if (health.ok !== true || typeof health.version !== "string")
    throw new Error("Existing application health or version cannot be verified.");
  if (
    (releaseVersionOrderOverride(release.version, health.version) ?? compareVersions(release.version, health.version)) <
    0
  )
    throw new Error(
      "Downgrades are forbidden; restore a matching backup through the documented manual recovery procedure.",
    );
  const backupRoot = await canonicalDestination(path.resolve(options.backupDir));
  const canonicalSources = [];
  for (const mount of mounts) {
    if (mount.Type === "bind") {
      const stat = await fs.lstat(mount.Source);
      if (!stat.isDirectory())
        throw new Error("Only regular bind directories are supported; symlinks and file binds require manual backup.");
      canonicalSources.push(await fs.realpath(mount.Source));
    } else {
      try {
        canonicalSources.push(await canonicalDestination(mount.Source));
      } catch (error) {
        // A local Docker daemon owns these paths; Docker Desktop keeps them inside
        // its VM. Operators need not traverse daemon storage to back up by volume
        // name. Backup and bind paths above still require host canonicalization.
        if (!["EACCES", "EPERM"].includes(error.code)) throw error;
        canonicalSources.push(path.resolve(mount.Source));
      }
    }
  }
  const outsideMounts = (directory) => {
    for (const source of canonicalSources)
      if (within(source, directory)) throw new Error("Backup destination must be outside every application mount.");
  };
  outsideMounts(backupRoot);
  const volumes = [...new Set(mounts.filter((m) => m.Type === "volume").map((m) => m.Name))];
  const noOtherWriters = async () => {
    for (const volume of volumes) {
      const writers = (await call(["ps", "--quiet", "--filter", `volume=${volume}`]))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (writers.some((id) => !container.Id.startsWith(id)))
        throw new Error("Another running container writes a company volume; stop it explicitly first.");
    }
  };
  await noOtherWriters();
  const plan = {
    mode: options.dryRun ? "check" : "update",
    project: config.name,
    cwd,
    oldImage: container.Image,
    currentVersion: health.version,
    ...release,
    backupDirectory: backupRoot,
    mounts: mounts.map((m) => ({
      type: m.Type,
      source: m.Type === "volume" ? m.Name : m.Source,
      target: m.Destination,
    })),
  };
  if (options.dryRun)
    return {
      ...plan,
      verified: false,
      steps: [
        "pull and verify published digest/OCI labels",
        "save old image",
        "stop existing service",
        "back up complete persistent mounts and operator config",
        "write separate private image env",
        "up --no-build --pull never --wait",
        "verify image, mounts, health and version",
      ],
    };

  const lock = path.join(cwd, ".ironcrew-docker-update.lock");
  await fs.mkdir(lock, { mode: 0o700 });
  let record,
    recordFile,
    stopping = false,
    backup;
  try {
    const root = await privateDirectory(backupRoot);
    outsideMounts(root);
    backup = await fs.mkdtemp(path.join(root, `update-${release.version}-`));
    await fs.chmod(backup, 0o700);
    recordFile = path.join(backup, "recovery.json");
    record = {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      operator: { uid: process.getuid?.() ?? null, platform: process.platform },
      ...plan,
      status: "preparing",
      migrationMayHaveRun: false,
      backups: [],
      oldContainerId: container.Id,
      composeFiles: previousFiles,
      recovery: [
        "Keep the service stopped until an operator has reviewed this record.",
        "If migrations may have run, restore the complete pre-update data/config snapshot before starting old code.",
        "Load old-image.tar with docker image load --input, then explicitly select the recorded old image ID.",
        "Never run old code against a database changed by the failed update. No automatic restore is performed.",
      ],
    };
    const saveRecord = () => writePrivate(recordFile, JSON.stringify(record, null, 2) + "\n");
    await saveRecord();
    await call(["pull", release.image], { discardOutput: true });
    const image = (await json(["image", "inspect", release.image]))[0];
    if (
      !ID.test(image?.Id ?? "") ||
      !image.RepoDigests?.includes(release.image) ||
      image.Config?.Labels?.["org.opencontainers.image.version"] !== release.version ||
      image.Config?.Labels?.["org.opencontainers.image.revision"] !== release.revision
    )
      throw new Error("Pulled image digest or OCI version/revision does not match the release manifest.");
    record.newImage = image.Id;
    const oldArchive = path.join(backup, "old-image.tar");
    await call(["image", "save", container.Image], { outputFile: oldArchive, timeout: 3_600_000 });
    record.backups.push({ kind: "old-image", ...(await digestFile(oldArchive)) });
    for (const file of ["compose.yaml", "compose.release.yaml", ".env", ...(existingImageEnv ? [IMAGE_ENV] : [])]) {
      const destination = path.join(backup, file === ".env" ? "operator.env" : file);
      await fs.copyFile(path.join(cwd, file), destination);
      await fs.chmod(destination, 0o600);
      record.backups.push({
        kind: "operator-config",
        original: path.join(cwd, file),
        ...(await digestFile(destination, true)),
      });
    }
    record.status = "stopping";
    await saveRecord();
    stopping = true;
    await call([...prefix(), "stop", "--timeout", "60", "ironcrew"]);
    if ((await json(["inspect", container.Id]))[0]?.State?.Running)
      throw new Error("Service did not stop; backup refused.");
    await noOtherWriters();
    record.status = "backing-up";
    await saveRecord();
    const sources = new Map(mounts.map((m) => [`${m.Type}:${m.Type === "volume" ? m.Name : m.Source}`, m]));
    let index = 0;
    for (const mount of sources.values()) {
      const source = mount.Type === "volume" ? mount.Name : mount.Source;
      const file = path.join(backup, `mount-${++index}.tar`);
      await call(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--user",
          "0:0",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "DAC_READ_SEARCH",
          "--security-opt",
          "no-new-privileges",
          "--mount",
          `type=${mount.Type},src=${source},dst=/source,readonly`,
          "--entrypoint",
          "tar",
          container.Image,
          "--numeric-owner",
          "--acls",
          "--xattrs",
          "-cpf",
          "-",
          "-C",
          "/source",
          ".",
        ],
        { outputFile: file, timeout: 3_600_000 },
      );
      record.backups.push({ kind: "mount", mountType: mount.Type, source, ...(await digestFile(file)) });
      await saveRecord();
    }
    record.status = "backup-complete";
    await saveRecord();
    await writePrivate(
      path.join(cwd, IMAGE_ENV),
      `# Written by the explicit IronCrew release updater.\nIRONCREW_RELEASE_IMAGE=${release.image}\n`,
    );
    record.migrationMayHaveRun = true;
    record.status = "starting-new-image";
    await saveRecord();
    await call(
      [...prefix(true), "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "ironcrew"],
      { timeout: 240_000, discardOutput: true },
    );
    const nextIds = (await call([...prefix(true), "ps", "--all", "--quiet", "ironcrew"]))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (nextIds.length !== 1) throw new Error("Updated service container identity is ambiguous.");
    const next = (await json(["inspect", nextIds[0]]))[0];
    validateMounts(config, next, cwd);
    if (
      next.Image !== image.Id ||
      next.Config?.Labels?.["com.docker.compose.project"] !== config.name ||
      !next.State?.Running ||
      next.State?.Health?.Status !== "healthy"
    )
      throw new Error("Updated image, project or container health failed verification.");
    const nextHealth = await json(["exec", next.Id, "node", "--input-type=module", "-e", HEALTH_SCRIPT]);
    if (nextHealth.ok !== true || nextHealth.version !== release.version)
      throw new Error("Application /health version differs from the requested release.");
    record.status = "verified";
    record.newContainerId = next.Id;
    await saveRecord();
    return {
      ...plan,
      verified: true,
      backupDirectory: backup,
      recoveryRecord: recordFile,
      composeCommand: ["docker", ...prefix(true), "up", "-d", "--no-build", "--pull", "never", "--wait", "ironcrew"],
    };
  } catch (error) {
    let stopVerified = !stopping;
    if (stopping) {
      try {
        await call(
          [...prefix(await plainFile(path.join(cwd, IMAGE_ENV), false)), "stop", "--timeout", "60", "ironcrew"],
          { signal: undefined },
        );
        const running = (
          await call(
            [
              ...prefix(await plainFile(path.join(cwd, IMAGE_ENV), false)),
              "ps",
              "--quiet",
              "--status",
              "running",
              "ironcrew",
            ],
            { signal: undefined },
          )
        ).trim();
        stopVerified = running === "";
      } catch {
        stopVerified = false;
      }
    }
    if (record) {
      record.status = "failed";
      record.serviceStopped = stopping && stopVerified;
      record.failure = error instanceof Error ? error.message : "Update failed";
      await writePrivate(recordFile, JSON.stringify(record, null, 2) + "\n");
    }
    throw new Error(
      `${error instanceof Error ? error.message : "Update failed"} ${stopping ? (stopVerified ? "Service remains stopped; manual recovery is required." : "STOP COULD NOT BE VERIFIED: stop the service manually now.") : "Existing service was not stopped."}${recordFile ? ` Recovery record: ${recordFile}` : ""}`,
    );
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
