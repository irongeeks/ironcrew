import path from "node:path";
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { createPublicKey, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, lstat, realpath, mkdir, open, rename, readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { Repository } from "../../persistence/src/index.ts";
import { scopeSchema, type Scope } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../../domain/src/index.ts";
import { OperationError, hashFile } from "./common.ts";
import { verifyRelease, readInstalledReleaseIdentity, activateRelease } from "./releases.ts";
import { createBackup, type BackupResult } from "./backup.ts";
import { acquireInstanceLock, type InstanceLock } from "./instance-lock.ts";
import {
  inMaintenanceWindow,
  updateClass,
  verifyOwnedArchive,
  type BackupPolicyInput,
  type UpdatePolicyInput,
  type OwnedArchive,
} from "./maintenance.ts";
import { ownerFile } from "./owner-files.ts";
import { openOwnerRepository } from "./owner-repository.ts";
import { NativeServiceControl, serviceControlSchema } from "./service-control.ts";
const absolute = z.string().refine((v) => path.isAbsolute(v) && !v.includes("\0"));
export const updaterConfigurationSchema = z
  .object({
    version: z.literal(1),
    companyId: z.uuid(),
    dataDirectory: absolute,
    installDirectory: absolute,
    bootstrapDirectory: absolute,
    ageExecutable: absolute,
    ageExecutableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    backupDirectory: absolute,
    trustedPublicKeyPem: z.string().min(40).max(16000),
    service: serviceControlSchema,
    healthUrl: z.url().refine((v) => {
      const u = new URL(v);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
      );
    }),
    trustedCaPem: z.string().min(40).max(20000).optional(),
    healthTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  })
  .strict();
export type UpdaterConfiguration = z.infer<typeof updaterConfigurationSchema>;
type Plan = {
  id: string;
  policyId: string;
  policyFingerprint: string;
  releaseDirectory: string;
  manifestSha256: string;
  executorConfigurationSha256?: string;
  fromVersion: string;
  toVersion: string;
  updateClass: "patch" | "minor" | "major";
  state: string;
  approvedBy?: string;
  expiresAt?: string;
  jobId?: string;
};
type Policy = UpdatePolicyInput & { id: string; fingerprint: string };
type BackupPolicy = BackupPolicyInput & { id: string; fingerprint: string; enabled: boolean; probeId?: string };
type Job = {
  id: string;
  scope: Scope;
  ceoId: string;
  planId: string;
  configSha256: string;
  token: string;
  generation: string | null;
  state: "queued" | "running" | "applied" | "rolled_back" | "effect_unknown";
  createdAt: string;
  phase?: string;
  priorRecovery?: Record<string, unknown>;
};
export type UpdateQueueResult = { state: "queued"; jobId: string; planId: string };
type Identity = { version: string; releaseManifestSha256: string; instanceId: string };
export const updateOutcomeSchema = z
  .object({
    jobId: z.uuid(),
    planId: z.uuid(),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["applied", "rolled_back", "effect_unknown"]),
    phase: z.string(),
    completedAt: z.iso.datetime(),
    backup: z
      .object({ archivePath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
    health: z
      .object({ version: z.string(), releaseManifestSha256: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.uuid() })
      .strict()
      .optional(),
    errorCode: z.string().optional(),
    previousDirectory: z.string().optional(),
  })
  .strict();
type Outcome = z.infer<typeof updateOutcomeSchema>;

async function privateJson(file: string) {
  const s = await lstat(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    s.size > 2_000_000 ||
    (process.platform !== "win32" && (s.mode & 0o022) !== 0)
  )
    throw new OperationError("updater_file", "Updaterdatei ist nicht regulär oder fremd beschreibbar.");
  return JSON.parse(await readFile(file, "utf8"));
}
async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp",
    h = await open(temporary, "wx", 0o600);
  try {
    await h.writeFile(JSON.stringify(value) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(temporary, file);
}
const queueDirectory = (config: UpdaterConfiguration) => path.join(config.dataDirectory, "update-queue");
export async function readUpdaterConfiguration(file: string): Promise<UpdaterConfiguration> {
  const parsed = updaterConfigurationSchema.parse(await privateJson(file));
  const configFile = await realpath(file);
  for (const key of ["dataDirectory", "installDirectory", "bootstrapDirectory", "backupDirectory"] as const)
    parsed[key] = await realpath(parsed[key]);
  parsed.ageExecutable = await realpath(parsed.ageExecutable);
  parsed.service.executable = await realpath(parsed.service.executable);
  if (parsed.service.kind === "launchd") parsed.service.plistPath = await realpath(parsed.service.plistPath);
  if (parsed.service.kind === "winsw")
    parsed.service.configurationPath = await realpath(parsed.service.configurationPath);
  for (const [a, b] of [
    [parsed.installDirectory, parsed.dataDirectory],
    [parsed.installDirectory, parsed.bootstrapDirectory],
    [parsed.dataDirectory, parsed.bootstrapDirectory],
    [parsed.backupDirectory, parsed.installDirectory],
    [parsed.backupDirectory, parsed.bootstrapDirectory],
  ])
    if (a === b || a!.startsWith(b! + path.sep) || b!.startsWith(a! + path.sep))
      throw new OperationError(
        "updater_directory_overlap",
        "Programm, Daten und Updaterbootstrap müssen getrennt liegen.",
      );
  if (configFile.startsWith(parsed.installDirectory + path.sep))
    throw new OperationError(
      "updater_config_overlap",
      "Administrative Konfiguration muss außerhalb der Installation liegen.",
    );
  for (const file of [
    parsed.service.executable,
    ...(parsed.service.kind === "launchd" ? [parsed.service.plistPath] : []),
    ...(parsed.service.kind === "winsw" ? [parsed.service.configurationPath] : []),
  ]) {
    const canonical = await realpath(file);
    if (canonical === parsed.installDirectory || canonical.startsWith(parsed.installDirectory + path.sep))
      throw new OperationError(
        "updater_controller_overlap",
        "Dienstcontroller und Definition müssen außerhalb der austauschbaren Installation liegen.",
      );
  }
  if (process.platform !== "win32" && process.getuid?.() === 0) {
    for (const target of [
      configFile,
      parsed.bootstrapDirectory,
      parsed.installDirectory,
      parsed.service.executable,
      parsed.ageExecutable,
      parsed.backupDirectory,
      parsed.dataDirectory,
      ...(parsed.service.kind === "launchd" ? [parsed.service.plistPath] : []),
      ...(parsed.service.kind === "winsw" ? [parsed.service.configurationPath] : []),
    ]) {
      let ancestor = path.dirname(await realpath(target));
      for (;;) {
        const parent = await stat(ancestor);
        if (parent.uid !== 0 || ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0))
          throw new OperationError(
            "updater_admin_ownership",
            "Privilegierter Updaterpfad hat einen fremd beschreibbaren Elternordner.",
          );
        const next = path.dirname(ancestor);
        if (next === ancestor) break;
        ancestor = next;
      }
      const owner = await stat(target);
      if (
        (owner.uid !== 0 &&
          !(
            [parsed.backupDirectory, parsed.dataDirectory].includes(target) &&
            owner.uid === (await stat(parsed.dataDirectory)).uid
          )) ||
        (owner.mode & 0o022) !== 0
      )
        throw new OperationError(
          "updater_admin_ownership",
          "Privilegierter Updater benötigt administrative Konfiguration, Bootstrap und Controller im Rootbesitz ohne fremde Schreibrechte.",
        );
    }
  }
  if (createPublicKey(parsed.trustedPublicKeyPem).asymmetricKeyType !== "ed25519")
    throw new OperationError("release_trust", "Ed25519-Vertrauensanker erforderlich.");
  return parsed;
}
const parsedAge = (config: UpdaterConfiguration) => path.resolve(config.ageExecutable);
const publicIdentity = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" }).toString("hex");
async function approved(
  repo: Repository,
  scope: Scope,
  ceoId: string,
  planId: string,
  config: UpdaterConfiguration,
  jobId?: string,
) {
  const setup = await repo.snapshot(scope.companyId);
  if (
    config.companyId !== scope.companyId ||
    setup.ceo.id !== ceoId ||
    scope.customerId ||
    scope.projectId ||
    !setup.areas.some((a) => a.id === scope.areaId && a.visibility === "company")
  )
    throw new OperationError("update_scope", "Nur der Firmen-CEO darf das konfigurierte System aktualisieren.");
  const record = await repo.getDocument<Plan>(scope, "update-plan", planId),
    plan = record?.data;
  if (
    !record ||
    !plan ||
    !(plan.state === "approved" || (jobId && ["queued", "running"].includes(plan.state) && plan.jobId === jobId)) ||
    plan.approvedBy !== ceoId ||
    !plan.expiresAt ||
    Date.parse(plan.expiresAt) <= Date.now()
  )
    throw new OperationError("update_approval", "Konkreter Updateplan ist nicht gültig freigegeben.");
  if (plan.executorConfigurationSha256 !== sha256(config))
    throw new OperationError(
      "update_configuration_changed",
      "Administrative Updatekonfiguration wurde nicht konkret freigegeben.",
    );
  const policy = (await repo.getDocument<Policy>(scope, "update-policy", plan.policyId))?.data;
  if (
    !policy ||
    policy.fingerprint !== plan.policyFingerprint ||
    (await repo.getDocument(scope, "update-policy-revocation", plan.policyId)) ||
    (await realpath(policy.installDirectory)) !== config.installDirectory ||
    publicIdentity(policy.trustedPublicKeyPem) !== publicIdentity(config.trustedPublicKeyPem) ||
    !policy.allowedClasses.includes(plan.updateClass) ||
    !inMaintenanceWindow(policy.window, new Date())
  )
    throw new OperationError("update_policy", "Wartungsfenster, Ziel oder Vertrauensanker ist nicht freigegeben.");
  const release = await verifyRelease(plan.releaseDirectory, config.trustedPublicKeyPem, {
    platform: process.platform,
    arch: process.arch,
  });
  if (
    (await hashFile(path.join(plan.releaseDirectory, "release-manifest.json"))) !== plan.manifestSha256 ||
    release.version !== plan.toVersion ||
    updateClass(plan.fromVersion, plan.toVersion) !== plan.updateClass
  )
    throw new OperationError("update_release_changed", "Release passt nicht zum freigegebenen Manifest.");
  const installed = await readInstalledReleaseIdentity(config.installDirectory, config.trustedPublicKeyPem);
  if (installed.version !== plan.fromVersion)
    throw new OperationError("update_base_changed", "Tatsächlich installiertes Release entspricht nicht der Freigabe.");
  const backup = (await repo.getDocument<BackupPolicy>(scope, "backup-policy", policy.backupPolicyId))?.data;
  if (
    !backup ||
    (await realpath(backup.ageExecutable)) !== parsedAge(config) ||
    (await realpath(backup.destination)) !== config.backupDirectory ||
    (await hashFile(config.ageExecutable)) !== config.ageExecutableSha256
  )
    throw new OperationError(
      "update_backup_configuration",
      "Backupziel und age-Binary müssen zur administrativen Konfiguration passen.",
    );
  const proof = backup?.probeId
    ? (
        await repo.getDocument<{
          fingerprint: string;
          companyId: string;
          state: string;
          completedAt: string;
          archiveId: string;
          archiveSha256: string;
        }>(scope, "maintenance-probe", backup.probeId)
      )?.data
    : undefined;
  if (
    !backup?.enabled ||
    !proof ||
    proof.state !== "passed" ||
    proof.fingerprint !== backup.fingerprint ||
    proof.companyId !== scope.companyId ||
    Date.now() - Date.parse(proof.completedAt) > 30 * 86400000 ||
    Date.parse(proof.completedAt) > Date.now() + 60000
  )
    throw new OperationError("restore_probe_required", "Passender echter Restoreproben-Nachweis fehlt.");
  const archive = (await repo.getDocument<OwnedArchive>(scope, "maintenance-archive", proof.archiveId))?.data;
  if (!archive || archive.sha256 !== proof.archiveSha256 || archive.state !== "available")
    throw new OperationError("restore_probe_required", "Restoreprobenarchiv fehlt.");
  if (await ownerNeeded(config)) {
    if (path.dirname(path.resolve(archive.archivePath)) !== config.backupDirectory)
      throw new OperationError("restore_probe_required", "Archivziel passt nicht.");
    const observed = (await ownerFile(config, { operation: "archive", file: archive.archivePath })) as {
      sha256: string;
    };
    if (observed.sha256 !== archive.sha256)
      throw new OperationError("restore_probe_required", "Archiv wurde verändert.");
  } else await verifyOwnedArchive(archive, backup.destination);
  return { record, plan, policy, backup, installed };
}
export async function queueProductionUpdate(options: {
  repo: Repository;
  scope: Scope;
  ceoId: string;
  planId: string;
  configurationPath: string;
}): Promise<UpdateQueueResult> {
  let queued = false;
  try {
    const config = await readUpdaterConfiguration(options.configurationPath),
      fingerprint = sha256(config);
    await verifyRelease(config.bootstrapDirectory, config.trustedPublicKeyPem, {
      platform: process.platform,
      arch: process.arch,
    });
    const heartbeat = await queueJson(config, "updater-heartbeat.json").catch(() => undefined);
    if (!heartbeat || heartbeat.configSha256 !== fingerprint || Date.now() - Date.parse(heartbeat.at) > 10000)
      throw new OperationError("updater_unavailable", "Separater Updaterdienst ist nicht bereit.");
    const { record, plan } = await approved(options.repo, options.scope, options.ceoId, options.planId, config),
      guard = await options.repo.getDocument<{ state: string }>(
        options.scope,
        "maintenance-update-active",
        options.scope.companyId,
      );
    if (guard && guard.data.state !== "idle")
      throw new OperationError("maintenance_update_busy", "Ein anderer oder ungeklärter Dienstwechsel besteht.");
    const recovery = (
      await options.repo.getDocument<Record<string, unknown>>(options.scope, "recovery-state", options.scope.companyId)
    )?.data;
    const job: Job = {
      id: randomUUID(),
      scope: options.scope,
      ceoId: options.ceoId,
      planId: options.planId,
      configSha256: fingerprint,
      token: randomBytes(32).toString("hex"),
      generation: typeof recovery?.generation === "string" ? recovery.generation : null,
      state: "queued",
      createdAt: new Date().toISOString(),
      priorRecovery: recovery,
    };
    await options.repo.transact(
      options.scope,
      [
        { kind: "update-executor-job", id: job.id, data: job, expectedRevision: 0 },
        {
          kind: "update-plan",
          id: plan.id,
          data: { ...plan, state: "queued", jobId: job.id },
          expectedRevision: record.revision,
        },
        {
          kind: "maintenance-update-active",
          id: options.scope.companyId,
          data: { state: "queued", planId: plan.id, jobId: job.id },
          expectedRevision: guard?.revision ?? 0,
        },
      ],
      { type: "maintenance.update_queued", aggregateId: plan.id },
    );
    queued = true;
    await writeQueueJson(config, job.id + ".request.json", {
      jobId: job.id,
      scope: job.scope,
      configSha256: fingerprint,
    });
    return { state: "queued", jobId: job.id, planId: plan.id };
  } catch (error) {
    if (!queued && error instanceof OperationError) throw new DomainError(error.code);
    throw error;
  }
}
async function ownerNeeded(config: UpdaterConfiguration) {
  return process.platform !== "win32" && process.getuid?.() === 0 && (await stat(config.dataDirectory)).uid !== 0;
}
async function queueJson(config: UpdaterConfiguration, name: string): Promise<ReturnType<typeof JSON.parse>> {
  return (await ownerNeeded(config))
    ? ownerFile(config, { operation: "read", name })
    : privateJson(path.join(queueDirectory(config), name));
}
async function writeQueueJson(config: UpdaterConfiguration, name: string, value: unknown) {
  if (await ownerNeeded(config)) {
    await ownerFile(config, { operation: "write", name, value });
    return;
  }
  await ensureQueue(config);
  await atomicJson(path.join(queueDirectory(config), name), value);
}
async function ensureQueue(config: UpdaterConfiguration) {
  if (await ownerNeeded(config)) {
    await ownerFile(config, { operation: "ensure" });
    return;
  }
  const directory = queueDirectory(config);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new OperationError("updater_queue_path", "Queue darf keine symbolische Verknüpfung sein.");
}
async function listQueue(config: UpdaterConfiguration): Promise<string[]> {
  return (await ownerNeeded(config))
    ? ((await ownerFile(config, { operation: "list" })) as string[])
    : readdir(queueDirectory(config));
}
async function health(config: UpdaterConfiguration): Promise<Identity> {
  return new Promise((resolve, reject) => {
    const url = new URL(config.healthUrl),
      req = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: "GET",
          agent: false,
          ...(url.protocol === "https:" ? { rejectUnauthorized: true, ca: config.trustedCaPem } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 64000) res.destroy();
            else chunks.push(chunk);
          });
          res.on("error", () => reject(new OperationError("update_health", "Healthantwort unterbrochen.")));
          res.on("end", () => {
            try {
              const body = z
                .object({
                  status: z.literal("ok"),
                  version: z.string(),
                  releaseManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
                  instanceId: z.uuid(),
                  database: z.object({ schemaVersion: z.literal(1) }),
                })
                .parse(JSON.parse(Buffer.concat(chunks).toString()));
              if (res.statusCode !== 200) throw new Error();
              resolve({
                version: body.version,
                releaseManifestSha256: body.releaseManifestSha256,
                instanceId: body.instanceId,
              });
            } catch {
              reject(new OperationError("update_health", "Versionsgebundener Healthnachweis fehlt."));
            }
          });
        },
      );
    const deadline = setTimeout(() => req.destroy(new Error("deadline")), Math.min(3000, config.healthTimeoutMs));
    req.once("close", () => clearTimeout(deadline));
    req.setTimeout(Math.min(3000, config.healthTimeoutMs), () => req.destroy());
    req.on("error", () => reject(new OperationError("update_health", "Healthziel nicht erreichbar.")));
    req.end();
  });
}
async function waitHealth(
  config: UpdaterConfiguration,
  expected: { version: string; releaseManifestSha256: string },
  previousInstanceId: string,
) {
  const deadline = Date.now() + config.healthTimeoutMs;
  do {
    try {
      const observed = await health(config);
      if (
        observed.version === expected.version &&
        observed.releaseManifestSha256 === expected.releaseManifestSha256 &&
        observed.instanceId !== previousInstanceId
      )
        return observed;
    } catch {
      /* Failed health or recovery remains unconfirmed. */
    }
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  throw new OperationError("update_health", "Neuer Prozess bestätigt nicht die erwartete Releaseidentität.");
}
const outcomeMac = (job: Job, outcome: Outcome) =>
  createHmac("sha256", Buffer.from(job.token, "hex")).update(JSON.stringify(outcome)).digest("hex");
/** Runs in an independent updater service, never inside the service being replaced. */
export async function executeQueuedUpdate(configurationPath: string, jobId: string) {
  z.uuid().parse(jobId);
  const config = await readUpdaterConfiguration(configurationPath),
    fingerprint = sha256(config);
  await verifyRelease(config.bootstrapDirectory, config.trustedPublicKeyPem, {
    platform: process.platform,
    arch: process.arch,
  });
  const request = z
    .object({ jobId: z.literal(jobId), scope: scopeSchema, configSha256: z.literal(fingerprint) })
    .parse(await queueJson(config, jobId + ".request.json"));
  const dataOwner = await stat(config.dataDirectory);
  const dropPrivileges = process.platform !== "win32" && process.getuid?.() === 0 && dataOwner.uid !== 0;
  if (dropPrivileges) {
    const bootstrap = await verifyRelease(config.bootstrapDirectory, config.trustedPublicKeyPem);
    for (const file of ["dist/apps/updater/database.js", "dist/apps/updater/backup.js", "dist/apps/updater/files.js"])
      if (!bootstrap.files.some((entry) => entry.path === file))
        throw new OperationError("updater_owner_helper", "Signierter Helfer für die Dienstidentität fehlt.");
  }
  const updaterLock = await acquireInstanceLock(
    path.join(path.dirname(await realpath(configurationPath)), ".updater-execution-" + config.companyId),
    "updater-execution",
  );
  let repo: Repository | undefined,
    lease: InstanceLock | undefined,
    job: Job | undefined,
    phase = "validating",
    backup: BackupResult | undefined,
    rollbackHealth: Identity | undefined,
    newHealth: Identity | undefined,
    oldHealth: Identity | undefined,
    previousDirectory: string | undefined;
  const controller = new NativeServiceControl(config.service, config.installDirectory, config.dataDirectory);
  const openRepo = async () =>
    repo ??
    (repo = dropPrivileges
      ? openOwnerRepository({
          bootstrapDirectory: config.bootstrapDirectory,
          dataDirectory: config.dataDirectory,
          uid: dataOwner.uid,
          gid: dataOwner.gid,
        })
      : await Repository.open(path.join(config.dataDirectory, "company.sqlite")));
  const closeRepo = async () => {
    await repo?.close();
    repo = undefined;
  };
  const checkpoint = async (value: string) => {
    phase = value;
    await writeQueueJson(config, jobId + ".progress.json", {
      jobId,
      phase,
      at: new Date().toISOString(),
      pid: process.pid,
    });
  };
  try {
    const database = await openRepo(),
      stored = await database.getDocument<Job>(request.scope, "update-executor-job", jobId);
    job = stored?.data;
    if (!job || job.configSha256 !== fingerprint || job.scope.companyId !== config.companyId)
      throw new OperationError("update_job_binding", "Updaterauftrag stimmt nicht überein.");
    const previousResult = await queueJson(config, job.id + ".result.json").catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    if (previousResult) {
      if (previousResult.mac !== outcomeMac(job, previousResult.outcome))
        throw new OperationError("update_result_binding", "Vorheriges Ergebnis ist verändert.");
      return previousResult.outcome as Outcome;
    }
    if (job.state !== "queued")
      throw new OperationError(
        "update_restart_unknown",
        "Bereits begonnener Dienstwechsel wird nicht automatisch wiederholt.",
      );
    const approvedPlan = await approved(database, job.scope, job.ceoId, job.planId, config, job.id),
      currentGeneration =
        (await database.getDocument<Record<string, unknown>>(job.scope, "recovery-state", job.scope.companyId))?.data
          ?.generation ?? null;
    if (currentGeneration !== job.generation)
      throw new OperationError("update_recovery_changed", "Wiederherstellung hat den Updateauftrag entwertet.");
    oldHealth = await health(config);
    if (
      oldHealth.version !== approvedPlan.installed.version ||
      oldHealth.releaseManifestSha256 !== approvedPlan.installed.releaseManifestSha256
    )
      throw new OperationError("update_base_health", "Laufender Dienst bestätigt nicht das signierte Ausgangsrelease.");
    await database.transact(
      job.scope,
      [
        {
          kind: "update-executor-job",
          id: job.id,
          data: { ...job, state: "running" },
          expectedRevision: stored!.revision,
        },
        {
          kind: "update-plan",
          id: job.planId,
          data: { ...approvedPlan.plan, state: "running" },
          expectedRevision: approvedPlan.record.revision,
        },
      ],
      { type: "maintenance.external_update_started", aggregateId: job.planId },
    );
    await closeRepo();
    await checkpoint("stopping");
    await controller.invoke("stop");
    lease = await acquireInstanceLock(config.dataDirectory, "offline-self-update");
    await checkpoint("stopped");
    const offline = await openRepo(),
      fresh = await approved(offline, job.scope, job.ceoId, job.planId, config, job.id),
      recovery = await offline.getDocument<Record<string, unknown>>(job.scope, "recovery-state", job.scope.companyId);
    await offline.putDocument(
      job.scope,
      "recovery-state",
      job.scope.companyId,
      { ...recovery?.data, dispatchPaused: true, schedulesPaused: true, reason: "self_update", updateJobId: job.id },
      { expectedRevision: recovery?.revision ?? 0 },
    );
    let configuration: Record<string, unknown> = {};
    try {
      if (!dropPrivileges)
        configuration = JSON.parse(await readFile(path.join(config.dataDirectory, "configuration.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((await hashFile(config.ageExecutable)) !== config.ageExecutableSha256)
      throw new OperationError("update_backup_configuration", "age-Binary wurde vor dem Offlinebackup verändert.");
    if (dropPrivileges) {
      await closeRepo();
      const bootstrap = await verifyRelease(config.bootstrapDirectory, config.trustedPublicKeyPem, {
        platform: process.platform,
        arch: process.arch,
      });
      if (!bootstrap.files.some((f) => f.path === "dist/apps/updater/backup.js"))
        throw new OperationError("updater_backup_helper", "Signierter Backuphelper fehlt.");
      backup = await new Promise<BackupResult>((resolve, reject) => {
        const child = execFile(
          path.join(config.bootstrapDirectory, "runtime/node"),
          [path.join(config.bootstrapDirectory, "dist/apps/updater/backup.js")],
          {
            cwd: config.bootstrapDirectory,
            uid: dataOwner.uid,
            gid: dataOwner.gid,
            env: { PATH: path.dirname(config.ageExecutable), LANG: "C", TZ: "UTC" },
            timeout: 600000,
            maxBuffer: 2_000_000,
          },
          (error, stdout) => {
            if (error)
              return reject(
                new OperationError("update_backup_failed", "Backup unter Dienstidentität ist fehlgeschlagen."),
              );
            try {
              const result = JSON.parse(stdout);
              if (
                result.executionIdentity?.uid !== dataOwner.uid ||
                result.executionIdentity?.gid !== dataOwner.gid ||
                !Array.isArray(result.executionIdentity?.groups) ||
                !result.executionIdentity.groups.every((group: unknown) => group === dataOwner.gid)
              )
                throw new Error("Backup identity mismatch");
              resolve(result);
            } catch {
              reject(new OperationError("update_backup_failed", "Backuphelper lieferte keinen Nachweis."));
            }
          },
        );
        child.stdin!.end(
          JSON.stringify({
            dataDirectory: config.dataDirectory,
            outputDirectory: config.backupDirectory,
            ageExecutable: config.ageExecutable,
            recipient: fresh.backup.recipient,
            appVersion: fresh.plan.fromVersion,
          }),
        );
      });
      if (path.dirname(path.resolve(backup.archivePath)) !== config.backupDirectory)
        throw new OperationError("update_backup_failed", "Backup liegt nicht im administrativen Ziel.");
      const observed = (await ownerFile(config, { operation: "archive", file: backup.archivePath })) as {
        sha256: string;
        uid: number;
        bytes: number;
      };
      if (observed.sha256 !== backup.sha256 || observed.uid !== dataOwner.uid || observed.bytes < 32)
        throw new OperationError("update_backup_failed", "Backupnachweis stimmt nicht überein.");
    } else {
      backup = await createBackup({
        databasePath: path.join(config.dataDirectory, "company.sqlite"),
        blobDirectory: path.join(config.dataDirectory, "blobs"),
        outputDirectory: config.backupDirectory,
        ageExecutable: config.ageExecutable,
        recipient: fresh.backup.recipient,
        appVersion: fresh.plan.fromVersion,
        configuration,
        quiesce: async () => async () => {},
        snapshotDatabase: (destination) => offline.backup(destination),
      });
    }
    await checkpoint("backed_up");
    const result = await activateRelease({
      releaseDirectory: fresh.plan.releaseDirectory,
      installDirectory: config.installDirectory,
      trustedPublicKeyPem: config.trustedPublicKeyPem,
      currentSchemaVersion: 1,
      beforeActivate: async () => {
        await approved(await openRepo(), job!.scope, job!.ceoId, job!.planId, config, job!.id);
        await checkpoint("activating");
      },
      healthCheck: async () => {
        await closeRepo();
        await lease?.release();
        lease = undefined;
        await checkpoint("starting_new");
        await controller.invoke("start");
        newHealth = await waitHealth(
          config,
          { version: fresh.plan.toVersion, releaseManifestSha256: fresh.plan.manifestSha256 },
          oldHealth!.instanceId,
        );
        return true;
      },
      beforeRollback: async () => {
        await checkpoint("stopping_failed_release");
        await controller.invoke("stop");
        lease = await acquireInstanceLock(config.dataDirectory, "offline-update-rollback");
      },
      restartPrevious: async () => {
        await checkpoint("starting_previous");
        await lease?.release();
        lease = undefined;
        await controller.invoke("start");
        rollbackHealth = await waitHealth(config, fresh.installed, oldHealth!.instanceId);
      },
    });
    previousDirectory = result.previousDirectory;
    const verified = newHealth!;
    const outcome: Outcome = {
      jobId: job.id,
      planId: job.planId,
      configSha256: fingerprint,
      state: "applied",
      phase: "verified",
      completedAt: new Date().toISOString(),
      backup: { archivePath: backup.archivePath, sha256: backup.sha256 },
      health: verified,
      previousDirectory,
    };
    await writeQueueJson(config, job.id + ".result.json", {
      outcome,
      mac: outcomeMac(job, outcome),
    });
    return outcome;
  } catch (error) {
    await closeRepo();
    if (job && oldHealth && lease && !rollbackHealth && ["stopped", "backed_up", "activating"].includes(phase)) {
      try {
        const identity = await readInstalledReleaseIdentity(config.installDirectory, config.trustedPublicKeyPem);
        if (
          identity.version === oldHealth.version &&
          identity.releaseManifestSha256 === oldHealth.releaseManifestSha256
        ) {
          await lease.release();
          lease = undefined;
          await controller.invoke("start");
          rollbackHealth = await waitHealth(config, identity, oldHealth.instanceId);
        }
      } catch {
        /* Failed health or recovery remains unconfirmed. */
      }
    }
    if (!job) throw error;
    const outcome: Outcome = {
      jobId: job.id,
      planId: job.planId,
      configSha256: fingerprint,
      state: rollbackHealth ? "rolled_back" : "effect_unknown",
      phase,
      completedAt: new Date().toISOString(),
      ...(backup ? { backup: { archivePath: backup.archivePath, sha256: backup.sha256 } } : {}),
      ...(rollbackHealth ? { health: rollbackHealth } : {}),
      errorCode: error instanceof OperationError ? error.code : "update_failed",
    };
    await writeQueueJson(config, job.id + ".result.json", {
      outcome,
      mac: outcomeMac(job, outcome),
    });
    return outcome;
  } finally {
    await closeRepo();
    await lease?.release();
    await updaterLock.release();
  }
}
export async function consumeUpdateResults(repo: Repository, configurationPath: string) {
  const config = await readUpdaterConfiguration(configurationPath),
    scope = (await repo.setupState())?.areas.find((a) => a.visibility === "company");
  if (!scope || scope.companyId !== config.companyId) return 0;
  const actor = { companyId: scope.companyId, areaId: scope.id };
  let count = 0;
  for (const record of await repo.listDocuments<Job>(actor, "update-executor-job")) {
    if (!["queued", "running"].includes(record.data.state)) continue;
    let signed: { outcome: Outcome; mac: string };
    try {
      signed = await queueJson(config, record.id + ".result.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const { mac } = signed,
      outcome = updateOutcomeSchema.parse(signed.outcome),
      expected = outcomeMac(record.data, outcome);
    if (
      !/^[a-f0-9]{64}$/.test(mac) ||
      !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex")) ||
      outcome.jobId !== record.id ||
      outcome.planId !== record.data.planId ||
      outcome.configSha256 !== record.data.configSha256 ||
      outcome.configSha256 !== sha256(config)
    )
      throw new OperationError("update_result_binding", "Updatergebnis ist nicht dem Auftrag zugeordnet.");
    const plan = await repo.getDocument<Plan>(actor, "update-plan", record.data.planId),
      guard = await repo.getDocument<{ jobId: string }>(actor, "maintenance-update-active", actor.companyId);
    const currentRecovery = await repo.getDocument<Record<string, unknown>>(actor, "recovery-state", actor.companyId);
    if ((currentRecovery?.data.generation ?? null) !== record.data.generation) {
      const reason = "update_result_recovery_changed";
      await repo.transact(
        actor,
        [
          {
            kind: "update-executor-job",
            id: record.id,
            data: {
              ...record.data,
              state: "effect_unknown",
              resultDiscarded: { reason, at: new Date().toISOString() },
            },
            expectedRevision: record.revision,
          },
          ...(plan?.data.jobId === record.id
            ? [
                {
                  kind: "update-plan",
                  id: plan.id,
                  data: { ...plan.data, state: "effect_unknown", errorCode: reason },
                  expectedRevision: plan.revision,
                },
              ]
            : []),
          ...(guard?.data.jobId === record.id
            ? [
                {
                  kind: "maintenance-update-active",
                  id: actor.companyId,
                  data: { ...guard.data, state: "effect_unknown", errorCode: reason },
                  expectedRevision: guard.revision,
                },
              ]
            : []),
        ],
        { type: "maintenance.update_result_discarded", aggregateId: record.id },
      );
      count++;
      continue;
    }
    if (!plan || guard?.data.jobId !== record.id)
      throw new OperationError("update_result_guard", "Updatewächter stimmt nicht überein.");
    if (outcome.state !== "effect_unknown") {
      const identity = await readInstalledReleaseIdentity(config.installDirectory, config.trustedPublicKeyPem);
      if (
        !outcome.health ||
        outcome.health.version !== (outcome.state === "applied" ? plan.data.toVersion : plan.data.fromVersion) ||
        identity.version !== outcome.health.version ||
        identity.releaseManifestSha256 !== outcome.health.releaseManifestSha256
      )
        throw new OperationError("update_result_health", "Installierte Version stimmt nicht mit dem Ergebnis überein.");
    }
    const recovery = await repo.getDocument<Record<string, unknown>>(actor, "recovery-state", actor.companyId),
      installed = await repo.getDocument(actor, "maintenance-installed-release", actor.companyId);
    await repo.transact(
      actor,
      [
        {
          kind: "update-executor-job",
          id: record.id,
          data: { ...record.data, state: outcome.state, result: outcome },
          expectedRevision: record.revision,
        },
        {
          kind: "update-plan",
          id: plan.id,
          data: {
            ...plan.data,
            state:
              outcome.state === "applied" ? "applied" : outcome.state === "rolled_back" ? "failed" : "effect_unknown",
            executorResult: outcome,
          },
          expectedRevision: plan.revision,
        },
        {
          kind: "maintenance-update-active",
          id: actor.companyId,
          data: {
            jobId: record.id,
            planId: plan.id,
            state: outcome.state === "effect_unknown" ? "effect_unknown" : "idle",
          },
          expectedRevision: guard.revision,
        },
        ...(outcome.health
          ? [
              {
                kind: "maintenance-installed-release",
                id: actor.companyId,
                data: {
                  version: outcome.health.version,
                  manifestSha256: outcome.health.releaseManifestSha256,
                  observedAt: outcome.completedAt,
                },
                expectedRevision: installed?.revision ?? 0,
              },
            ]
          : []),
        ...(outcome.state !== "effect_unknown" &&
        recovery?.data.reason === "self_update" &&
        recovery.data.updateJobId === record.id
          ? [
              {
                kind: "recovery-state",
                id: actor.companyId,
                data: record.data.priorRecovery ?? { dispatchPaused: false, schedulesPaused: false },
                expectedRevision: recovery.revision,
              },
            ]
          : []),
      ],
      { type: "maintenance.external_update_result", aggregateId: plan.id },
    );
    count++;
  }
  return count;
}
let heartbeatBootstrapFingerprint: string | undefined;
export async function updaterTick(configurationPath: string) {
  const config = await readUpdaterConfiguration(configurationPath);
  const fingerprint = sha256(config);
  if (heartbeatBootstrapFingerprint !== fingerprint) {
    await verifyRelease(config.bootstrapDirectory, config.trustedPublicKeyPem, {
      platform: process.platform,
      arch: process.arch,
    });
    heartbeatBootstrapFingerprint = fingerprint;
  }
  await ensureQueue(config);
  await writeQueueJson(config, "updater-heartbeat.json", {
    pid: process.pid,
    configSha256: sha256(config),
    at: new Date().toISOString(),
  });
  for (const file of (await listQueue(config)).filter((f) => /^[a-f0-9-]{36}\.request\.json$/.test(f)).sort()) {
    const id = file.slice(0, 36);
    try {
      await queueJson(config, id + ".result.json");
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await executeQueuedUpdate(configurationPath, id);
  }
}
