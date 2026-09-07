import { z } from "zod";
import {
  scopeSchema,
  orderSchema,
  orderStatusSchema,
  microsSchema,
  reservationSchema,
  orderKindSchema,
  approvalBindingSchema,
  artifactVersionSchema,
} from "../../../packages/contracts/src/index.ts";
import { modelSchema } from "../../../packages/runtime/src/openrouter.ts";
import { coordinationSchema } from "../../../packages/runtime/src/coordination.ts";
import { ratingInputSchema } from "../../../packages/runtime/src/ratings.ts";
import { id, date, hash, int, revision, text, json, object } from "./common.ts";
export const company = object({ id, name: text, timezone: text, createdAt: date });
export const area = object({ id, companyId: id, name: text, visibility: z.enum(["company", "private"]) });
export const employee = object({
  id,
  companyId: id,
  seedKey: text,
  displayName: text,
  role: text,
  rank: text,
  appearance: text,
  persona: text,
  modelOverride: text.nullable(),
  permissionsFromPersona: z.literal(false),
});
export const companySettings = object({
  name: text.optional(),
  timezone: text.optional(),
  locale: z.enum(["de", "en"]).optional(),
});
export const profile = object({
  displayName: text.optional(),
  persona: text.optional(),
  appearance: text.optional(),
  modelOverride: text.nullable().optional(),
});
export const setupResult = object({
  company,
  ceo: object({ id, name: text }),
  areas: z.array(area),
  employees: z.array(employee),
  periodId: id,
  setupProgress: object({ version: int, completedStep: int }),
});
export const session = z.union([
  object({ authenticated: z.literal(false), setupRequired: z.literal(true) }),
  object({ authenticated: z.boolean(), csrfToken: text.optional(), setupRequired: z.literal(false) }),
]);
export const progress = object({ step: int.min(0).max(8), data: z.record(text, json) });
export const budget = object({
  startsAt: date.optional(),
  endsAt: date.optional(),
  renewal: z.enum(["none", "fixed_duration"]).optional(),
  periodActive: z.boolean().optional(),
  periodId: id,
  limitUsdMicros: microsSchema,
  spentUsdMicros: microsSchema,
  reservedUsdMicros: microsSchema,
  unreconciledUsdMicros: microsSchema,
  availableUsdMicros: microsSchema,
  reservations: z.array(reservationSchema),
});
export const approval = object({
  id,
  binding: approvalBindingSchema,
  decision: z.enum(["approved", "denied"]).optional(),
  decidedAt: date.optional(),
});
export const message = object({
  id,
  orderId: id.optional(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: text,
  createdAt: date,
  modelTurnId: id.optional(),
  modelId: text.optional(),
});
const modelMessage = object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: text.nullable().optional(),
  tool_call_id: text.optional(),
  tool_calls: z
    .array(object({ id: text, type: z.literal("function"), function: object({ name: text, arguments: text }) }))
    .optional(),
});
export const run = object({
  id,
  orderId: id,
  scope: scopeSchema,
  messages: z.array(modelMessage),
  consumedMessageIds: z.array(id).optional(),
  profileVersion: revision.optional(),
  profileSnapshot: object({ employeeId: id, displayName: text, persona: text, role: text }).optional(),
  actionIds: z.array(id),
  step: int,
  state: z.enum(["running", "approval", "reviewing", "blocked"]),
  modelId: text,
  mandateId: id,
  mandateVersion: revision,
  targetId: id,
  pendingTurnId: id.optional(),
  waitingApprovalRequestId: id.optional(),
  testPassed: z.boolean(),
  artifactIds: z.array(id),
  testedHashes: z.record(text, hash).optional(),
  unreconciledTurnIds: z.array(id).optional(),
  blockedReason: text.optional(),
});
export const worker = object({
  id,
  name: text,
  capabilities: z.array(text),
  maxConcurrent: revision,
  generation: revision,
  revoked: z.boolean(),
  sequence: int,
  enrolledAt: date,
  status: text.optional(),
  recoveryGeneration: id.optional(),
  lastSeenAt: date.optional(),
});
export const enrollment = object({ workerId: id, token: text, generation: revision });
export const workerStatus = object({
  tlsConfigured: z.boolean(),
  connectUrl: text.nullable(),
  capabilities: z.array(text),
});
export const model = modelSchema
  .extend({ revision })
  .describe("OpenRouter catalog entry; provider-defined extra properties are preserved by the runtime modelSchema.");
export const backup = object({
  id,
  archivePath: text,
  sha256: hash,
  createdAt: date,
  state: z.literal("verified_archive"),
  restoreTested: z.literal(false),
});
export const recovery = object({
  dispatchPaused: z.boolean(),
  schedulesPaused: z.boolean(),
  reason: text.optional(),
  reviewedExternalEffects: z.boolean().optional(),
  resumedAt: date.optional(),
  restoredAt: date.optional(),
  backupId: text.optional(),
  updateJobId: id.optional(),
  generation: id.optional(),
  revokedSessions: int.optional(),
  fencedWorkers: int.optional(),
  pausedSchedules: int.optional(),
  unknownActions: int.optional(),
  unknownRemoteExecutions: int.optional(),
  invalidatedUpdateApprovals: int.optional(),
  requiresEffectReconciliation: z.boolean().optional(),
});
export const rating = ratingInputSchema
  .extend({
    id,
    seriesId: text,
    version: revision,
    modelId: text,
    orderKind: orderKindSchema,
    artifactSha256: hash,
    actionId: id,
    reviewerKind: z.enum(["human", "agent"]),
    reviewerId: id,
    createdAt: date,
  })
  .strict();
export const ratingTarget = object({
  orderId: id,
  artifactVersionId: id,
  artifactSha256: hash,
  modelTurnId: id,
  modelId: text,
  actionId: id,
  latencyMs: z.number().nonnegative().nullable(),
});
const ratingSample = object({ samples: int, qualityMean: z.number().min(1).max(5).nullable() });
export const ratingSummary = object({
  modelId: text,
  human: ratingSample,
  agent: ratingSample,
  latency: object({ samples: int, meanMs: z.number().nonnegative().nullable() }),
  observedTurns: int,
});
export const notification = object({
  id,
  sequence: revision,
  type: text,
  aggregateId: id,
  scope: scopeSchema,
  occurredAt: date,
  orderId: id.optional(),
});
export const binding = object({
  id,
  provider: z.enum(["discord", "telegram"]),
  accountId: text,
  userId: text,
  role: z.literal("ceo"),
  verifiedAt: date,
  scope: scopeSchema,
  revision,
});
// These two collections currently have no HTTP creation contract. Repository documents preserve their JSON properties.
export const extensionResource = z
  .object({ id: text, revision })
  .catchall(json)
  .describe(
    "Repository extension record. There is currently no project/integration creation route or stronger persisted payload schema.",
  );
export const genericArtifact = artifactVersionSchema.extend({
  createdAt: date.optional(),
  path: text.optional(),
  name: text.optional(),
  executionActionId: id.optional(),
  revision: revision.optional(),
});

export const order = orderSchema
  .extend({
    activeCoordination: coordinationSchema.optional(),
    resumeState: orderStatusSchema.optional(),
    requiredReviewsPassed: z.boolean().optional(),
    deliveryComplete: z.boolean().optional(),
  })
  .strict();
export const approvalRequest = object({
  id,
  binding: approvalBindingSchema,
  args: json,
  summary: text.optional(),
  toolId: text.optional(),
  status: z.enum(["pending", "approved", "denied"]),
});
