import { z } from "zod";
import {
  HostingHttpClient,
  hostingPeerRequest,
  hostingLookup,
  type HostingProfile,
  type HostingDeployment,
  type HostingPackage,
} from "./hosting.ts";
import { IntegrationError, checkResponse, redact } from "./transport.ts";
import type { SecretResolver } from "./secrets.ts";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.string().regex(/^[A-Za-z0-9_.:-]{1,300}$/),
  micros = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const careBackupSchema = z
  .object({
    destinationId: id,
    recipient: z.string().regex(/^age1[0-9a-z]{20,100}$/),
    retentionDays: z.number().int().min(1).max(3650),
    costUsdMicros: micros,
  })
  .strict();
export const careUpdateSchema = z
  .object({
    class: z.literal("patch"),
    currentVersion: id,
    currentManifestSha256: hash,
    version: id,
    manifestSha256: hash,
    costUsdMicros: micros,
  })
  .strict()
  .refine((value) => value.version !== value.currentVersion, "Update version must change");
export const careBackupReceiptSchema = z
  .object({
    id,
    resourceId: id,
    artifactVersionId: z.uuid(),
    packageSha256: hash,
    destinationId: id,
    recipient: z.string(),
    encrypted: z.literal(true),
    archiveSha256: hash,
    bytes: z.number().int().positive(),
    costUsdMicros: micros,
  })
  .strict();
export const careRestoreProbeSchema = z
  .object({
    backupId: id,
    archiveSha256: hash,
    restoredPackageSha256: hash,
    isolated: z.literal(true),
    functionalCheckPassed: z.literal(true),
    completedAt: z.iso.datetime(),
    evidenceSha256: hash,
  })
  .strict();
export const careUpdateReceiptSchema = z
  .object({
    resourceId: id,
    version: id,
    manifestSha256: hash,
    previousVersion: id,
    previousManifestSha256: hash,
    rollbackRef: id,
    state: z.literal("applied"),
    costUsdMicros: micros,
  })
  .strict();
export type CareBackup = z.infer<typeof careBackupSchema>;
export type CareUpdate = z.infer<typeof careUpdateSchema>;
export type CareBackupReceipt = z.infer<typeof careBackupReceiptSchema>;
export type CareUpdateReceipt = z.infer<typeof careUpdateReceiptSchema>;
export interface HostingCarePort {
  check(
    profile: HostingProfile,
    deployment: HostingDeployment,
    artifact: HostingPackage,
    authorize: () => Promise<void>,
  ): Promise<unknown>;
  backup(
    profile: HostingProfile,
    deployment: HostingDeployment,
    actionId: string,
    input: CareBackup,
    authorize: () => Promise<void>,
  ): Promise<{ backup: CareBackupReceipt; probe: z.infer<typeof careRestoreProbeSchema> }>;
  update(
    profile: HostingProfile,
    deployment: HostingDeployment,
    actionId: string,
    input: CareUpdate,
    backup: CareBackupReceipt,
    authorize: () => Promise<void>,
  ): Promise<CareUpdateReceipt>;
  version(
    profile: HostingProfile,
    deployment: HostingDeployment,
    version: string,
    manifestSha256: string,
    authorize: () => Promise<void>,
  ): Promise<unknown>;
  rollback(
    profile: HostingProfile,
    deployment: HostingDeployment,
    actionId: string,
    receipt: CareUpdateReceipt,
    authorize: () => Promise<void>,
  ): Promise<void>;
}
export class HostingCareHttpClient implements HostingCarePort {
  readonly secrets?: SecretResolver;
  constructor(secrets?: SecretResolver) {
    this.secrets = secrets;
  }
  private async call(
    profile: HostingProfile,
    route: string,
    actionId: string,
    payload: unknown,
    authorize: () => Promise<void>,
  ) {
    await authorize();
    const token = profile.secretRef
      ? await this.secrets?.resolve(profile.secretRef, `Authorized website care ${actionId}`)
      : undefined;
    if (profile.secretRef && !token) throw new IntegrationError("configuration", "Hosting-Pflegezugang fehlt.");
    await authorize();
    const response = await hostingPeerRequest(
      profile,
      new URL(profile.endpoint.replace(/\/$/, "") + route),
      "POST",
      Buffer.from(JSON.stringify({ protocolVersion: 1, actionId, targetId: profile.id, ...(payload as object) })),
      token,
    );
    checkResponse(response, true);
    if (response.status !== 200 && response.status !== 201)
      throw new IntegrationError("provider", "Pflegewirkung wurde nicht abschließend bestätigt.", "effect_unknown");
    try {
      return redact(JSON.parse(response.body.toString("utf8")), token ? [token] : []);
    } catch {
      throw new IntegrationError("provider", "Ungültige Pflegeantwort.", "effect_unknown");
    }
  }
  async check(
    profile: HostingProfile,
    deployment: HostingDeployment,
    artifact: HostingPackage,
    authorize: () => Promise<void>,
  ) {
    await authorize();
    try {
      return await new HostingHttpClient().verify(profile, deployment, artifact);
    } catch {
      throw new IntegrationError("provider", "Gehostete Website besteht die DNS/TLS/Funktionsprüfung nicht.", "failed");
    }
  }
  async backup(
    profile: HostingProfile,
    deployment: HostingDeployment,
    actionId: string,
    input: CareBackup,
    authorize: () => Promise<void>,
  ) {
    const raw = await this.call(
      profile,
      `/v1/resources/${encodeURIComponent(deployment.resourceId)}/backups`,
      actionId,
      {
        deploymentId: deployment.id,
        artifactVersionId: deployment.artifactVersionId,
        packageSha256: deployment.packageSha256,
        ...input,
      },
      authorize,
    );
    const parsed = careBackupReceiptSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.resourceId !== deployment.resourceId ||
      parsed.data.artifactVersionId !== deployment.artifactVersionId ||
      parsed.data.packageSha256 !== deployment.packageSha256 ||
      parsed.data.destinationId !== input.destinationId ||
      parsed.data.recipient !== input.recipient ||
      parsed.data.costUsdMicros !== input.costUsdMicros
    )
      throw new IntegrationError(
        "provider",
        "Backupbeleg stimmt nicht mit dem Pflegemandat überein.",
        "effect_unknown",
      );
    const backup = parsed.data;
    const proof = careRestoreProbeSchema.safeParse(
      await this.call(
        profile,
        `/v1/resources/${encodeURIComponent(deployment.resourceId)}/backups/${encodeURIComponent(backup.id)}/restore-probe`,
        actionId,
        { archiveSha256: backup.archiveSha256, expectedPackageSha256: deployment.packageSha256 },
        authorize,
      ),
    );
    if (
      !proof.success ||
      proof.data.backupId !== backup.id ||
      proof.data.archiveSha256 !== backup.archiveSha256 ||
      proof.data.restoredPackageSha256 !== deployment.packageSha256
    )
      throw new IntegrationError("provider", "Isolierte Wiederherstellungsprobe nicht bestätigt.", "effect_unknown");
    return { backup, probe: proof.data };
  }
  async update(
    profile: HostingProfile,
    deployment: HostingDeployment,
    actionId: string,
    input: CareUpdate,
    backup: CareBackupReceipt,
    authorize: () => Promise<void>,
  ) {
    const raw = await this.call(
      profile,
      `/v1/resources/${encodeURIComponent(deployment.resourceId)}/maintenance`,
      actionId,
      {
        deploymentId: deployment.id,
        artifactVersionId: deployment.artifactVersionId,
        packageSha256: deployment.packageSha256,
        backupId: backup.id,
        backupArchiveSha256: backup.archiveSha256,
        ...input,
      },
      authorize,
    );
    const parsed = careUpdateReceiptSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.resourceId !== deployment.resourceId ||
      parsed.data.version !== input.version ||
      parsed.data.manifestSha256 !== input.manifestSha256 ||
      parsed.data.previousVersion !== input.currentVersion ||
      parsed.data.previousManifestSha256 !== input.currentManifestSha256 ||
      parsed.data.costUsdMicros !== input.costUsdMicros
    )
      throw new IntegrationError(
        "provider",
        "Updateantwort ist nicht an die freigegebene Patchversion gebunden.",
        "effect_unknown",
      );
    return parsed.data;
  }
  async version(
    profile: HostingProfile,
    deployment: HostingDeployment,
    version: string,
    manifestSha256: string,
    authorize: () => Promise<void>,
  ) {
    await authorize();
    const url = new URL("/.well-known/ironcrew-maintenance.json", profile.publicUrl);
    const addresses = await hostingLookup(url.hostname, profile.timeoutMs);
    if (!addresses.length || addresses.some((a) => !profile.expectedDnsAddresses.includes(a.address)))
      throw new IntegrationError("provider", "Pflegeversionsnachweis hat unerwartetes DNS-Ziel.");
    const response = await hostingPeerRequest(profile, url, "GET", undefined, undefined, addresses[0]);
    checkResponse(response, false);
    try {
      const proof = z
        .object({
          resourceId: z.literal(deployment.resourceId),
          version: z.literal(version),
          manifestSha256: z.literal(manifestSha256),
        })
        .parse(JSON.parse(response.body.toString("utf8")));
      return { ...proof, tlsFingerprint256: response.fingerprint256, observedAt: new Date().toISOString() };
    } catch {
      throw new IntegrationError("provider", "Öffentlicher Laufzeitversionsnachweis fehlt.");
    }
  }
  async rollback(
    profile: HostingProfile,
    deployment: HostingDeployment,
    actionId: string,
    receipt: CareUpdateReceipt,
    authorize: () => Promise<void>,
  ) {
    const raw = await this.call(
      profile,
      `/v1/resources/${encodeURIComponent(deployment.resourceId)}/maintenance/rollback`,
      actionId,
      {
        rollbackRef: receipt.rollbackRef,
        expectedVersion: receipt.version,
        restoreVersion: receipt.previousVersion,
        restoreManifestSha256: receipt.previousManifestSha256,
      },
      authorize,
    );
    if (
      !z
        .object({
          state: z.literal("restored"),
          version: z.literal(receipt.previousVersion),
          manifestSha256: z.literal(receipt.previousManifestSha256),
        })
        .safeParse(raw).success
    )
      throw new IntegrationError("provider", "Rollbackwirkung unklar.", "effect_unknown");
  }
}
