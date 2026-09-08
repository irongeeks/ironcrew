import { APP_VERSION } from "../../contracts/src/version.ts";
import { createHash, createPublicKey, verify } from "node:crypto";
import { request } from "node:https";
import { mkdir, mkdtemp, rename, rm, lstat, open } from "node:fs/promises";
import { createWriteStream, createReadStream, constants } from "node:fs";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import * as tar from "tar";
import { z } from "zod";
import type { Repository } from "../../persistence/src/index.ts";
import type { Scope, Json } from "../../contracts/src/index.ts";
import { canonicalJson, sha256, DomainError } from "../../domain/src/index.ts";
import { updatePolicySchema, updateClass } from "./maintenance.ts";
import { verifyRelease } from "./releases.ts";
import { hashFile, OperationError, safeRelative } from "./common.ts";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const https = z.url().refine((value) => {
  const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search;
});
export const releaseFeedConfigurationSchema = z
  .object({
    id: z.uuid(),
    indexUrl: https,
    archiveBaseUrl: https,
    trustedPublicKeyPem: z.string().min(40).max(16000),
    channel: z.literal("stable"),
    caCertificatePem: z.string().min(40).max(32000).optional(),
  })
  .strict();
export type ReleaseFeedConfiguration = z.infer<typeof releaseFeedConfigurationSchema>;
export const feedReleaseSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    platform: z.enum(["linux", "darwin", "win32"]),
    arch: z.enum(["x64", "arm64"]),
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(1),
    nodeVersion: z.literal("26.4.0"),
    archiveUrl: https,
    archiveSha256: digest,
    archiveBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    manifestSha256: digest,
  })
  .strict();
export const releaseFeedPayloadSchema = z
  .object({
    format: z.literal("ironcrew-release-feed"),
    formatVersion: z.literal(1),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    publishedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    channel: z.literal("stable"),
    releases: z.array(feedReleaseSchema).max(100),
  })
  .strict();
export const releaseFeedEnvelopeSchema = z
  .object({ signed: releaseFeedPayloadSchema, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) })
  .strict();
export const releaseCandidateSchema = z
  .object({
    id: z.uuid(),
    feedId: z.uuid(),
    feedFingerprint: digest,
    feedSequence: z.number().int().positive(),
    feedExpiresAt: z.iso.datetime(),
    policyId: z.uuid(),
    policyFingerprint: digest,
    release: feedReleaseSchema,
    updateClass: z.enum(["patch", "minor", "major"]),
    classAllowed: z.boolean(),
    state: z.enum(["available", "staged"]),
    discoveredAt: z.iso.datetime(),
    releaseDirectory: z.string().optional(),
  })
  .strict();
export type ReleaseCandidate = z.infer<typeof releaseCandidateSchema>;
type Policy = z.infer<typeof updatePolicySchema> & { id: string; fingerprint: string };
type State = { sequence: number; fingerprint: string; payloadSha256: string };
const queues = new WeakMap<Repository, Map<string, Promise<unknown>>>();
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;
const idFor = (value: unknown) => {
  const h = sha256(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const releaseFeedTrustFingerprint = (pem: string) => {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new OperationError("feed_trust", "Ed25519-Vertrauensanker erforderlich.");
  return sha256(key.export({ type: "spki", format: "pem" }));
};
/** Canonical signed bytes shared by offline release publishers and consumers. */
export const releaseFeedSigningBytes = (payload: unknown) =>
  Buffer.from(canonicalJson(releaseFeedPayloadSchema.parse(payload)));
export async function readReleaseFeedConfiguration(directory: string): Promise<ReleaseFeedConfiguration | undefined> {
  const file = path.join(directory, "release-feed.json");
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 64000 ||
    (process.platform !== "win32" && (info.mode & 0o022) !== 0)
  )
    throw new OperationError(
      "feed_configuration",
      "Administrative Feedkonfiguration ist nicht regulär oder fremd beschreibbar.",
    );
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const current = await handle.stat();
    if (current.dev !== info.dev || current.ino !== info.ino || current.size > 64000 || current.nlink !== 1)
      throw new OperationError("feed_configuration", "Feedkonfiguration wurde während des Lesens ersetzt.");
    return releaseFeedConfigurationSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}
export class ReleaseFeedService {
  readonly options: {
    repo: Repository;
    directory: string;
    configuration: ReleaseFeedConfiguration;
    platform?: string;
    arch?: string;
    currentVersion?: string;
    now?: () => Date;
  };
  readonly config: ReleaseFeedConfiguration;
  constructor(options: ReleaseFeedService["options"]) {
    this.options = options;
    this.config = Object.freeze(releaseFeedConfigurationSchema.parse(options.configuration));
    releaseFeedTrustFingerprint(this.config.trustedPublicKeyPem);
    if (!new URL(this.config.archiveBaseUrl).pathname.endsWith("/"))
      throw new OperationError("feed_configuration", "Archivbasis muss mit / enden.");
  }
  private now() {
    return (this.options.now ?? (() => new Date()))();
  }
  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let map = queues.get(this.options.repo);
    if (!map) {
      map = new Map();
      queues.set(this.options.repo, map);
    }
    const prior = map.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    map.set(key, next);
    try {
      return await next;
    } finally {
      if (map.get(key) === next) map.delete(key);
    }
  }
  private async actor(scope: Scope, ceoId: string) {
    const setup = await this.options.repo.snapshot(scope.companyId);
    if (
      setup.ceo.id !== ceoId ||
      scope.customerId ||
      scope.projectId ||
      !setup.areas.some((a) => a.id === scope.areaId && a.visibility === "company")
    )
      throw new DomainError("maintenance_ceo_required", "Company CEO context required", 403);
    return { companyId: scope.companyId, areaId: setup.areas.find((a) => a.visibility === "company")!.id };
  }
  private async policy(scope: Scope, id: string) {
    const doc = await this.options.repo.getDocument<Policy>(scope, "update-policy", id);
    if (!doc || (await this.options.repo.getDocument(scope, "update-policy-revocation", id)))
      throw new DomainError("update_policy_revoked");
    updatePolicySchema.parse(
      Object.fromEntries(
        Object.entries(doc.data).filter(([k]) => !["id", "fingerprint", "proposedBy", "proposedAt"].includes(k)),
      ),
    );
    if (
      releaseFeedTrustFingerprint(doc.data.trustedPublicKeyPem) !==
      releaseFeedTrustFingerprint(this.config.trustedPublicKeyPem)
    )
      throw new DomainError("feed_policy_trust");
    return doc.data;
  }
  private allowedUrl(value: string) {
    const target = new URL(value),
      base = new URL(this.config.archiveBaseUrl);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(base.pathname) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      /%2f|%5c|%2e/i.test(target.pathname)
    )
      throw new OperationError("feed_archive_origin", "Archiv liegt außerhalb der administrativen Releaseherkunft.");
  }
  private async response(url: string, timeout: number) {
    return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          ca: this.config.caCertificatePem,
          headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
        },
        (res) => {
          if (res.statusCode !== 200 || res.headers["content-encoding"]) {
            res.resume();
            reject(
              new OperationError("feed_http", "Releaseherkunft lieferte keine unveränderte erfolgreiche Antwort."),
            );
            return;
          }
          resolve(res);
        },
      );
      const timer = setTimeout(() => req.destroy(new Error("feed_timeout")), timeout);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end();
    });
  }
  async list(scope: Scope, ceoId: string) {
    const companyScope = await this.actor(scope, ceoId);
    const state = await this.options.repo.getDocument<State>(companyScope, "release-feed-state", this.config.id);
    const fingerprint = sha256(this.config);
    const out: ReleaseCandidate[] = [];
    for (const doc of await this.options.repo.listDocuments<ReleaseCandidate>(scope, "release-candidate")) {
      if (
        doc.data.feedSequence !== state?.data.sequence ||
        doc.data.feedFingerprint !== fingerprint ||
        Date.parse(doc.data.feedExpiresAt) <= this.now().getTime()
      )
        continue;
      try {
        const policy = await this.policy(scope, doc.data.policyId);
        if (policy.fingerprint === doc.data.policyFingerprint) out.push(releaseCandidateSchema.parse(doc.data));
      } catch {
        /* Revoked policies never expose actionable candidates. */
      }
    }
    return out;
  }
  async discover(scope: Scope, ceoId: string, policyId: string) {
    const companyScope = await this.actor(scope, ceoId);
    return this.lock("feed:" + scope.companyId + ":" + this.config.id, async () => {
      const policy = await this.policy(scope, policyId);
      const response = await this.response(this.config.indexUrl, 15000);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy();
          throw new OperationError("feed_limit", "Releaseindex überschreitet 1 MiB.");
        }
        chunks.push(Buffer.from(chunk));
      }
      const envelope = releaseFeedEnvelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const bytes = releaseFeedSigningBytes(envelope.signed);
      if (
        !verify(
          null,
          bytes,
          createPublicKey(this.config.trustedPublicKeyPem),
          Buffer.from(envelope.signature, "base64"),
        )
      )
        throw new OperationError("feed_signature", "Signierter Releaseindex wurde nicht akzeptiert.");
      const feed = envelope.signed,
        now = this.now().getTime();
      if (
        feed.channel !== this.config.channel ||
        Date.parse(feed.publishedAt) > now + 30000 ||
        Date.parse(feed.expiresAt) <= now ||
        Date.parse(feed.expiresAt) - Date.parse(feed.publishedAt) > 7 * 86400000
      )
        throw new OperationError("feed_expired", "Releaseindex ist abgelaufen oder zeitlich ungültig.");
      const fingerprint = sha256(this.config),
        payloadSha256 = sha256(feed);
      const previous = await this.options.repo.getDocument<State>(companyScope, "release-feed-state", this.config.id);
      if (
        previous &&
        (previous.data.fingerprint !== fingerprint ||
          feed.sequence < previous.data.sequence ||
          (feed.sequence === previous.data.sequence && previous.data.payloadSha256 !== payloadSha256))
      )
        throw new OperationError("feed_replay", "Releaseindex-Sequenz wurde zurückgesetzt oder verändert.");
      const seen = new Set<string>();
      const installed = await this.options.repo.getDocument<{ version: string }>(
        scope,
        "maintenance-installed-release",
        scope.companyId,
      );
      const current = installed?.data.version ?? this.options.currentVersion ?? APP_VERSION;
      const candidates: ReleaseCandidate[] = [];
      for (const release of feed.releases) {
        this.allowedUrl(release.archiveUrl);
        const key = [release.version, release.platform, release.arch].join("/");
        if (seen.has(key)) throw new OperationError("feed_duplicate", "Doppelte Releaseidentität.");
        seen.add(key);
        if (
          release.platform !== (this.options.platform ?? process.platform) ||
          release.arch !== (this.options.arch ?? process.arch)
        )
          continue;
        let kind;
        try {
          kind = updateClass(current, release.version);
        } catch {
          continue;
        }
        candidates.push({
          id: idFor({ feedId: this.config.id, policyId, policyFingerprint: policy.fingerprint, release }),
          feedId: this.config.id,
          feedFingerprint: fingerprint,
          feedSequence: feed.sequence,
          feedExpiresAt: feed.expiresAt,
          policyId,
          policyFingerprint: policy.fingerprint,
          release,
          updateClass: kind,
          classAllowed: policy.allowedClasses.includes(kind),
          state: "available",
          discoveredAt: this.now().toISOString(),
        });
      }
      const fresh = await this.policy(scope, policyId);
      if (fresh.fingerprint !== policy.fingerprint) throw new DomainError("update_policy_changed");
      await this.options.repo.putDocument(
        companyScope,
        "release-feed-state",
        this.config.id,
        { sequence: feed.sequence, fingerprint, payloadSha256 },
        previous ? { expectedRevision: previous.revision } : {},
      );
      for (const candidate of candidates) {
        const old = await this.options.repo.getDocument<ReleaseCandidate>(scope, "release-candidate", candidate.id);
        await this.options.repo.putDocument(
          scope,
          "release-candidate",
          candidate.id,
          json({
            ...candidate,
            ...(old?.data.releaseDirectory ? { state: "staged", releaseDirectory: old.data.releaseDirectory } : {}),
          }),
          old ? { expectedRevision: old.revision } : {},
        );
      }
      return candidates;
    });
  }
  async stage(scope: Scope, ceoId: string, candidateId: string) {
    const companyScope = await this.actor(scope, ceoId);
    return this.lock("candidate:" + candidateId, async () => {
      const doc = await this.options.repo.getDocument<ReleaseCandidate>(scope, "release-candidate", candidateId);
      if (!doc) throw new DomainError("release_candidate_missing");
      const candidate = releaseCandidateSchema.parse(doc.data),
        policy = await this.policy(scope, candidate.policyId);
      const state = await this.options.repo.getDocument<State>(companyScope, "release-feed-state", this.config.id);
      if (
        candidate.feedSequence !== state?.data.sequence ||
        candidate.feedFingerprint !== sha256(this.config) ||
        candidate.policyFingerprint !== policy.fingerprint ||
        Date.parse(candidate.feedExpiresAt) <= this.now().getTime()
      )
        throw new DomainError("release_candidate_stale");
      if (!policy.allowedClasses.includes(candidate.updateClass)) throw new DomainError("update_class_denied");
      this.allowedUrl(candidate.release.archiveUrl);
      const root = path.join(this.options.directory, "release-cache");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new DomainError("release_cache_unsafe");
      const target = path.join(root, candidate.id);
      let existing = false;
      try {
        const entry = await lstat(target);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new DomainError("release_cache_unsafe");
        existing = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        const manifest = await verifyRelease(target, this.config.trustedPublicKeyPem, {
          platform: candidate.release.platform,
          arch: candidate.release.arch,
        });
        if (
          manifest.version !== candidate.release.version ||
          (await hashFile(path.join(target, "release-manifest.json"))) !== candidate.release.manifestSha256
        )
          throw new DomainError("release_candidate_changed");
        const next = { ...candidate, state: "staged" as const, releaseDirectory: target };
        if (candidate.state !== "staged")
          await this.options.repo.putDocument(scope, "release-candidate", candidate.id, json(next), {
            expectedRevision: doc.revision,
          });
        return { releaseDirectory: target, candidate: next };
      }
      const temporary = await mkdtemp(path.join(root, ".download-"));
      try {
        const archive = path.join(temporary, "release.tgz"),
          response = await this.response(candidate.release.archiveUrl, 180000);
        if (Number(response.headers["content-length"]) !== candidate.release.archiveBytes) {
          response.destroy();
          throw new OperationError("feed_archive_size", "Archivgröße stimmt nicht.");
        }
        let bytes = 0;
        const digest = createHash("sha256");
        await pipeline(
          response,
          new Transform({
            transform(chunk, _, callback) {
              bytes += chunk.length;
              if (bytes > candidate.release.archiveBytes) {
                callback(new Error("feed_archive_size"));
                return;
              }
              digest.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        );
        if (bytes !== candidate.release.archiveBytes || digest.digest("hex") !== candidate.release.archiveSha256)
          throw new OperationError("feed_archive_hash", "Releasearchiv stimmt nicht mit dem signierten Index überein.");
        let issue = false,
          total = 0;
        const names = new Map<string, string>();
        let expanded = 0;
        await pipeline(
          createReadStream(archive),
          createGunzip(),
          new Transform({
            transform(chunk, _, callback) {
              expanded += chunk.length;
              callback(expanded > 2 * 1024 * 1024 * 1024 ? new Error("feed_archive_limit") : null, chunk);
            },
          }),
          tar.t({
            strict: true,
            onReadEntry(entry) {
              const name = entry.path.replace(/\/$/, "");
              const key = name.normalize("NFC").toLowerCase();
              total += entry.size;
              if (
                !safeRelative(name) ||
                !["File", "Directory"].includes(entry.type) ||
                names.has(key) ||
                total > 2 * 1024 * 1024 * 1024 ||
                entry.size > 512 * 1024 * 1024 ||
                names.size >= 100002
              )
                issue = true;
              names.set(key, entry.type);
              entry.resume();
            },
          }),
        );
        for (const name of names.keys()) {
          let parent = name;
          while (parent.includes("/")) {
            parent = parent.slice(0, parent.lastIndexOf("/"));
            if (names.get(parent) === "File") issue = true;
          }
        }
        if (issue)
          throw new OperationError(
            "feed_archive_unsafe",
            "Releasearchiv enthält unsichere Pfade oder überschreitet Grenzen.",
          );
        const staged = path.join(temporary, "release");
        await mkdir(staged, { mode: 0o700 });
        await tar.x({
          file: archive,
          cwd: staged,
          strict: true,
          preservePaths: false,
          noChmod: true,
          noMtime: true,
          preserveOwner: false,
          umask: 0o077,
        });
        const manifest = await verifyRelease(staged, this.config.trustedPublicKeyPem, {
          platform: candidate.release.platform,
          arch: candidate.release.arch,
        });
        if (
          manifest.version !== candidate.release.version ||
          (await hashFile(path.join(staged, "release-manifest.json"))) !== candidate.release.manifestSha256
        )
          throw new DomainError("release_candidate_changed");
        const declared = new Set(
          ["release-manifest.json", "release-manifest.sig", ...manifest.files.map((f) => f.path)].map((name) =>
            name.normalize("NFC").toLowerCase(),
          ),
        );
        for (const [name, type] of names)
          if (type === "File" && !declared.has(name)) throw new DomainError("release_archive_extra");
        const fresh = await this.policy(scope, candidate.policyId);
        if (fresh.fingerprint !== candidate.policyFingerprint) throw new DomainError("update_policy_changed");
        await rename(staged, target);
        const next = { ...candidate, state: "staged" as const, releaseDirectory: target };
        await this.options.repo.putDocument(scope, "release-candidate", candidate.id, json(next), {
          expectedRevision: doc.revision,
        });
        return { releaseDirectory: target, candidate: next };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
}
