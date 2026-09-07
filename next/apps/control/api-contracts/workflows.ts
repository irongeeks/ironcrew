import { z } from "zod";
import { scopeSchema } from "../../../packages/contracts/src/index.ts";
import { conceptSchema } from "../../../packages/domain/workflows/website.ts";
import { reportSchema, sourceSchema } from "../../../packages/domain/workflows/research.ts";
import { knowledgeSchema } from "../../../packages/domain/workflows/knowledge.ts";
import { invoiceSchema } from "../../../packages/domain/workflows/finance.ts";
import { scheduleInputSchema } from "../../../packages/domain/workflows/automation.ts";
import { researchWatchCreateSchema, watchReviewSchema } from "../../../packages/domain/workflows/research-watch.ts";
import { healthProfileSchema } from "../incident-service.ts";
import { hostingProfileSchema } from "../../../packages/integrations/src/hosting.ts";
import { metadataSchema } from "../../../packages/tools/remote-execution/protocol.ts";
import { id, date, hash, int, revision, text, json, object, pendingAction } from "./common.ts";
import { genericArtifact } from "./resources.ts";
export const site = object({
  id,
  orderId: id,
  briefing: text,
  stack: z.enum(["static", "react", "wordpress"]),
  concepts: z.array(conceptSchema.extend({ id, sha256: hash }).strict()),
  selectedConceptId: id.optional(),
  sourceRevisionId: id.optional(),
  predecessorArtifactVersionId: id.optional(),
  artifactVersionId: id.optional(),
  sha256: hash.optional(),
  state: z.enum(["briefing", "concepts", "selected", "built", "reviewed", "accepted", "published"]),
  acceptedVersionId: id.optional(),
  previewUrl: text.optional(),
  reviewId: id.optional(),
  publication: object({
    url: text,
    httpsVerified: z.literal(true),
    functionalCheckPassed: z.literal(true),
    rollbackRef: text,
  }).optional(),
});
export const siteArtifact = object({
  sourceRevisionId: id.optional(),
  predecessorArtifactVersionId: id.optional(),
  id,
  artifactId: id,
  scope: scopeSchema,
  orderId: id,
  sha256: hash,
  packageSha256: hash,
  mediaType: z.literal("text/html"),
  bytes: int,
  stack: z.enum(["static", "react", "wordpress"]),
  previewPath: text,
  buildEvidence: metadataSchema
    .extend({ stdout: text, stderr: text, php: metadataSchema.extend({ stdout: text, stderr: text }).optional() })
    .optional(),
  canonicalStore: z.literal("internal"),
  delivery: z.literal("staged"),
  files: z.array(object({ path: text, sha256: hash, bytes: int })),
  createdAt: date,
  revision: revision.optional(),
});
export { sitePinInputSchema as pinInput } from "../../../packages/domain/workflows/website.ts";
import { sitePinInputSchema } from "../../../packages/domain/workflows/website.ts";
export const pin = sitePinInputSchema
  .omit({ deferDispatch: true })
  .extend({
    id,
    orderId: id,
    state: z.enum(["draft", "open", "resolved"]),
    sourceMessageId: id.optional(),
    submittedAt: date.optional(),
    createdAt: date,
    resolvedArtifactVersionId: id.optional(),
    evidence: text.optional(),
    reviewerId: id.optional(),
  })
  .strict();
export const reviewCheck = z.object({ name: text.trim().min(1), passed: z.boolean(), evidence: text.trim().min(1) });
export const siteReview = object({
  id,
  orderId: id,
  artifactVersionId: id,
  reviewerId: id,
  reviewerKind: z.enum(["ceo", "employee"]).optional(),
  checks: z.array(reviewCheck),
  actor: z.enum(["human", "agent"]),
  passed: z.boolean(),
  createdAt: date,
  revision: revision.optional(),
});
export const delivery = object({
  id,
  artifactVersionId: id,
  state: z.enum(["pending", "approval", "delivered", "conflict", "failed", "effect_unknown"]),
  actionId: id.optional(),
  actionHash: hash.optional(),
  target: z.enum(["internal", "nextcloud", "gdrive", "git"]),
  externalId: text.optional(),
  externalRevision: text.optional(),
  errorCode: text.optional(),
  gitCommit: text.optional(),
  gitStageActionId: id.optional(),
  gitStageHash: hash.optional(),
});
export const report = object({
  ...reportSchema.shape,
  id,
  scope: scopeSchema,
  sha256: hash,
  bytes: int,
  createdAt: date,
  completeness: z.enum(["complete", "incomplete"]),
  delivery: z.literal("staged"),
  mediaType: z.literal("text/markdown"),
  canonicalStore: z.literal("internal"),
  artifactId: id,
  revision: revision.optional(),
  deliveryRecord: delivery.optional(),
});
export const source = sourceSchema.strict();
export const knowledge = object({
  ...knowledgeSchema.shape,
  id,
  scope: scopeSchema,
  status: z.enum(["proposed", "lead_reviewed", "active", "rejected"]),
  version: revision,
  createdAt: date,
  reviewedBy: id.optional(),
  reviewedAt: date.optional(),
});
export const diff = object({
  url: text,
  beforeSourceId: text,
  afterSourceId: text,
  beforeSha256: hash,
  afterSha256: hash,
  removedExcerpt: text,
  addedExcerpt: text,
  truncated: z.boolean(),
  interpretation: z.literal("review_required"),
});
export const watch = object({
  ...researchWatchCreateSchema.shape,
  id,
  scope: scopeSchema,
  createdAt: date,
  nextCheckAt: date,
  baselineSourceIds: z.array(text),
  latestArtifactId: id,
  lastChangeFingerprint: hash.optional(),
  activeCheckId: id.optional(),
  lastCheckId: id.optional(),
  lastSuccessfulCheckAt: date.optional(),
  lastStatus: z.enum(["running", "unchanged", "changed", "incomplete"]).optional(),
});
export const watchArtifact = report.extend({
  previousRecommendation: text,
  watchId: id,
  checkId: id,
  version: revision,
  recommendationStatus: z.literal("review_required"),
  diffs: z.array(diff),
});
export const artifact = z.union([siteArtifact, watchArtifact, report, genericArtifact]);
export const watchCheck = object({
  id,
  watchId: id,
  orderId: id,
  startedAt: date,
  leaseExpiresAt: date,
  completedAt: date.optional(),
  status: z.enum(["running", "unchanged", "changed", "incomplete"]),
  sourceIds: z.array(text),
  diffs: z.array(diff),
  failures: z.array(object({ url: text.optional(), code: text })),
  artifactVersionId: id.optional(),
  reservationId: id.optional(),
  recommendationStatus: z.enum(["review_required", "not_reassessed"]),
});
export const watchReview = object({
  ...watchReviewSchema.shape,
  id,
  watchId: id,
  checkId: id,
  artifactVersionId: id,
  artifactSha256: hash,
  reviewerId: id,
  reviewerKind: z.enum(["ceo", "employee"]),
  createdAt: date,
  companyKnowledgeChanged: z.literal(false),
});
export const schedule = object({
  ...scheduleInputSchema.shape,
  id,
  scope: scopeSchema,
  version: revision,
  nextDueAt: date,
  mandateVersion: revision,
  activeOrderIds: z.array(id),
});
export const voucher = object({
  classificationCorrectionIds: z
    .partialRecord(z.enum(["sevdeskSupplierId", "accountDatevId", "taxRuleId", "taxRate"]), id)
    .optional(),
  voucherDate: text.optional(),
  externalId: text.optional(),
  id,
  orderId: id,
  originalSha256: hash,
  originalMediaType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  originalBytes: int,
  invoice: invoiceSchema,
  state: z.enum(["received", "draft_created"]),
  createdAt: date,
  correction: object({ field: text, value: json, source: text }).optional(),
});
export const snapshot = object({
  id,
  observedAt: date,
  invoices: z.array(invoiceSchema),
  metrics: z.array(
    object({
      currency: text,
      openMinor: text.regex(/^\d+$/),
      overdueMinor: text.regex(/^\d+$/),
      sources: z.array(text),
      definition: text,
    }),
  ),
  bankBalance: object({ status: z.literal("unavailable"), reason: text }),
});
export const payment = object({
  id,
  orderId: id,
  voucherId: id,
  recipient: text,
  bankAccount: text,
  reference: text,
  amountMinor: text.regex(/^\d+$/),
  currency: text,
  state: z.literal("prepared"),
  bankAccountReviewRequired: z.boolean(),
  importAvailable: z.literal(false),
  importReason: text,
  paid: z.literal(false),
});
export const incident = object({
  id,
  orderId: id,
  targetId: id,
  state: z.enum(["investigating", "repairing", "observing", "resolved", "blocked"]),
  cause: object({ status: z.enum(["unknown", "suspected", "confirmed"]), explanation: text }),
  timeline: z.array(
    object({
      at: date,
      kind: z.enum(["alarm", "diagnosis", "repair", "functional_check", "observation", "recurrence"]),
      targetId: id,
      data: json,
    }),
  ),
  observationEndsAt: date.optional(),
  lastCheckAt: date.optional(),
  preventionOrderId: id.optional(),
});
export const healthProfile = object({
  ...healthProfileSchema.shape,
  fingerprint: hash,
  configuredBy: id,
  configuredAt: date,
});
export const observation = object({
  scope: scopeSchema,
  orderId: id,
  profile: healthProfile,
  mandateId: id,
  mandateVersion: revision,
  state: z.enum(["active", "resolved", "blocked", "recurrence"]),
  nextCheckAt: date,
  lastCheckAt: date,
  endsAt: date,
  reason: text.optional(),
});
export const incidentStatus = object({
  incident,
  observation: observation.optional(),
  healthProfile: healthProfile.extend({ revision }).optional(),
  serviceTargets: z.array(object({ id, kind: text, resourceName: text, configSha256: hash })),
  mailTargets: z.array(object({ id, from: text, host: text, configSha256: hash })),
  pendingActions: z.array(pendingAction),
});
export const hostingProfile = object({
  ...hostingProfileSchema.shape,
  id,
  fingerprint: hash,
  configuredBy: id,
  configuredAt: date,
});
export const hostingHealth = object({
  observedAt: date,
  dnsAddresses: z.array(text),
  connectedAddress: text,
  tlsFingerprint256: text,
  tlsValidTo: text,
  httpsVerified: z.literal(true),
  functionalCheckPassed: z.literal(true),
  bodySha256: hash,
  deploymentProofSha256: hash,
  checks: z.array(text),
});
export const hostingResource = object({
  profileId: id,
  profileFingerprint: hash,
  orderId: id,
  actionId: id,
  resource: object({
    id: text,
    publicUrl: text,
    stack: z.enum(["static", "react", "wordpress"]),
    monthlyCostUsdMicros: text,
    state: z.literal("ready"),
  }),
});
export const hostingDeployment = object({
  id,
  profileId: id,
  profileFingerprint: hash,
  orderId: id,
  actionId: id,
  artifactVersionId: id,
  packageSha256: hash,
  state: z.enum(["verifying", "verified", "effect_unknown", "rollback_accepted"]),
  deployment: object({
    id: text,
    resourceId: text,
    publicUrl: text,
    artifactVersionId: id,
    packageSha256: hash,
    archiveSha256: hash,
    rollbackRef: text,
  }),
  health: hostingHealth.optional(),
});
export const hostingStatus = object({
  resources: z.array(hostingResource),
  deployments: z.array(hostingDeployment),
  pendingActions: z.array(pendingAction),
});

export const artifactReview = object({
  id,
  orderId: id,
  artifactVersionId: id,
  authorEmployeeId: id,
  verdict: z.enum(["passed", "changes_requested"]),
  evidenceRefs: z.array(text),
  summary: text,
  reviewerId: id,
  reviewerKind: z.enum(["human", "agent"]),
  createdAt: date,
  revision: revision.optional(),
});
