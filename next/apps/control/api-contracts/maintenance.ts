import { z } from "zod";
import { updateOutcomeSchema } from "../../../packages/operations/src/updater.ts";
import { backupPolicySchema, updatePolicySchema } from "../../../packages/operations/src/maintenance.ts";
import { backupManifestSchema } from "../../../packages/operations/src/backup.ts";
import { id, date, hash, int, revision, text, object } from "./common.ts";
export const backupPolicy = object({
  ...backupPolicySchema.shape,
  id,
  enabled: z.boolean(),
  fingerprint: hash,
  proposedBy: id,
  proposedAt: date,
  probeId: id.optional(),
  activatedBy: id.optional(),
  nextDueAt: date.optional(),
  lastLocalSlot: text.optional(),
  retryNotBefore: date.optional(),
});
export const archive = object({
  id,
  archivePath: text,
  sha256: hash,
  createdAt: date,
  state: z.enum(["available", "deleted"]),
  policyId: id,
  policyFingerprint: hash,
  manifest: backupManifestSchema,
});
export const probe = object({
  id,
  policyId: id,
  fingerprint: hash,
  archiveId: id,
  archiveSha256: hash,
  completedAt: date,
  state: z.literal("passed"),
  companyId: id,
  revokedSessions: int,
});
export const job = object({
  id,
  policyId: id,
  dueAt: date,
  state: z.enum(["running", "succeeded", "deferred", "effect_unknown"]),
  bootId: id.optional(),
  startedAt: date.optional(),
  archiveId: id.optional(),
  finishedAt: date.optional(),
  code: text.optional(),
  retryAt: date.optional(),
  errorCode: text.optional(),
});
export const updatePolicy = object({
  ...updatePolicySchema.shape,
  id,
  fingerprint: hash,
  proposedBy: id,
  proposedAt: date,
});
export const updatePlan = object({
  id,
  policyId: id,
  policyFingerprint: hash,
  releaseDirectory: text,
  manifestSha256: hash,
  fromVersion: text,
  toVersion: text,
  updateClass: z.enum(["patch", "minor", "major"]),
  state: z.enum(["planned", "approved", "queued", "running", "applied", "failed", "effect_unknown"]),
  createdAt: date,
  approvedBy: id.optional(),
  approvedAt: date.optional(),
  expiresAt: date.optional(),
  backupId: id.optional(),
  errorCode: text.optional(),
  previousDirectory: text.optional(),
  jobId: id.optional(),
  bootId: id.optional(),
  executorResult: updateOutcomeSchema.optional(),
  executorConfigurationSha256: hash.optional(),
  recoveryGeneration: id.optional(),
});
export const updateScheduleAttempt = object({
  planId: id,
  state: z.enum(["running", "queued", "applied", "deferred", "failed", "effect_unknown"]),
  bootId: id,
  attemptedAt: date,
  recoveryGeneration: id.optional(),
  retryNotBefore: date.optional(),
  code: text.optional(),
});
export const maintenance = object({
  backupPolicies: z.array(backupPolicy.extend({ revision })),
  backups: z.array(archive),
  probes: z.array(probe),
  backupJobs: z.array(job),
  updatePolicies: z.array(updatePolicy),
  updatePlans: z.array(updatePlan),
  updateScheduleAttempts: z.array(updateScheduleAttempt),
});

export const updateQueue = object({ state: z.literal("queued"), jobId: id, planId: id });
