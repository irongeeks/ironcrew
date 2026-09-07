import { z } from "zod";
export * from "./types.ts";
export const idSchema = z.uuid();
export const microsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (v) => /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 9223372036854775807n,
    "Amount exceeds SQLite integer range",
  );
export const scopeSchema = z
  .object({ companyId: idSchema, areaId: idSchema, customerId: idSchema.optional(), projectId: idSchema.optional() })
  .strict();
export const orderStatusSchema = z.enum([
  "inbox",
  "planning",
  "ready",
  "running",
  "reviewing",
  "completed",
  "paused",
  "blocked",
  "cancelled",
  "failed",
]);
export const orderKindSchema = z.enum(["website", "incident", "finance", "research"]);
export const orderCreateSchema = z.object({
  id: idSchema.optional(),
  kind: orderKindSchema,
  goal: z.string().trim().min(1).max(20000),
  leadEmployeeId: idSchema.optional(),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  budgetLimitUsdMicros: microsSchema,
});
export const orderPatchSchema = z
  .object({
    goal: z.string().trim().min(1).optional(),
    status: orderStatusSchema.optional(),
    waitReason: z
      .enum(["approval", "budget", "external", "worker", "tool_error", "unknown_effect", "user_input"])
      .nullable()
      .optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    planVersion: z.number().int().positive().optional(),
    budgetLimitUsdMicros: microsSchema.optional(),
    requiredReviewsPassed: z.boolean().optional(),
    deliveryComplete: z.boolean().optional(),
  })
  .strict();
export const setupSchema = z.object({
  companyName: z.string().trim().min(1),
  ceoName: z.string().trim().min(1),
  passwordHash: z.string().min(1),
  timezone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }),
  budgetLimitUsdMicros: microsSchema,
});
export const mandateSchema = z
  .object({
    id: idSchema,
    version: z.number().int().positive(),
    scope: scopeSchema,
    allowedToolIds: z.array(z.string().min(1)),
    targetIds: z.array(idSchema),
    parameterConstraints: z.json(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().optional(),
    maxAttempts: z.number().int().positive(),
    maxDurationSeconds: z.number().int().positive(),
    maxCostUsdMicros: microsSchema,
  })
  .strict();
export const approvalBindingSchema = z
  .object({
    companyId: idSchema,
    orderId: idSchema,
    mandateId: idSchema,
    mandateVersion: z.number().int().positive(),
    actionId: idSchema,
    targetId: idSchema,
    argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    artifactVersionId: idSchema.optional(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type CreateOrderInput = z.input<typeof orderCreateSchema>;
export type OrderPatch = z.infer<typeof orderPatchSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export const effectClassSchema = z.enum([
  "read",
  "workspace_write",
  "external_draft",
  "external_change",
  "external_send",
  "publish",
]);
export const actionStatusSchema = z.enum([
  "proposed",
  "authorized",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "effect_unknown",
  "denied",
  "expired",
]);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const orderSchema = z.object({
  id: idSchema,
  scope: scopeSchema,
  kind: orderKindSchema,
  goal: z.string().min(1),
  leadEmployeeId: idSchema,
  status: orderStatusSchema,
  waitReason: z
    .enum(["approval", "budget", "external", "worker", "tool_error", "unknown_effect", "user_input"])
    .optional(),
  revision: z.number().int().positive(),
  planVersion: z.number().int().nonnegative(),
  acceptanceCriteria: z.array(z.string()),
  budgetLimitUsdMicros: microsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const secretRefSchema = z
  .object({
    provider: z.literal("proton-pass"),
    shareId: z.string().min(1),
    itemId: z.string().min(1),
    field: z.string().min(1),
  })
  .strict();
export const toolDefinitionSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    effect: effectClassSchema,
    retryPolicy: z.enum(["safe", "idempotency_key", "reconcile_first", "never_automatic"]),
    inputSchemaId: z.string().min(1),
    outputSchemaId: z.string().min(1),
    capability: z.string().min(1),
    reconcileToolId: z.string().optional(),
  })
  .strict();
export const toolActionSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    orderId: idSchema,
    scope: scopeSchema,
    toolId: z.string().min(1),
    toolVersion: z.number().int().positive(),
    args: z.json(),
    argumentsSha256: sha256Schema,
    status: actionStatusSchema,
    mandateId: idSchema,
    mandateVersion: z.number().int().positive(),
    approvalId: idSchema.optional(),
    externalId: z.string().optional(),
    resultSha256: sha256Schema.optional(),
    evidenceRefs: z.array(idSchema),
  })
  .strict();
export const modelTurnSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    sequence: z.number().int().nonnegative(),
    modelId: z.string().min(1),
    profileVersion: z.number().int().positive(),
    messagesArtifactId: idSchema,
    requestSha256: sha256Schema,
    reservationId: idSchema,
    state: z.enum(["prepared", "sent", "streaming", "complete", "interrupted", "failed"]),
    providerGenerationId: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reportedCostUsdMicros: microsSchema.optional(),
    usageState: z.enum(["pending", "reconciled", "unreconciled"]),
  })
  .strict();
export const reservationSchema = z
  .object({
    id: idSchema,
    periodId: idSchema,
    orderId: idSchema,
    modelTurnId: idSchema.optional(),
    actionId: idSchema.optional(),
    reservedUsdMicros: microsSchema,
    settledUsdMicros: microsSchema.optional(),
    state: z.enum(["held", "settled", "released", "unreconciled"]),
  })
  .strict();
export const artifactVersionSchema = z
  .object({
    id: idSchema,
    artifactId: idSchema,
    scope: scopeSchema,
    orderId: idSchema,
    sha256: sha256Schema,
    mediaType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    predecessorId: idSchema.optional(),
    canonicalStore: z.enum(["internal", "git", "nextcloud", "gdrive"]),
    delivery: z.enum(["staged", "pending", "delivered", "conflict", "failed"]),
    externalId: z.string().optional(),
    externalRevision: z.string().optional(),
  })
  .strict();
const envelopeShape = {
  protocolVersion: z.literal(1),
  messageId: idSchema,
  workerId: idSchema,
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  sentAt: z.iso.datetime(),
};
export const workerMessageSchema = z
  .object({
    ...envelopeShape,
    payload: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("hello"),
          capabilities: z.array(z.string()),
          appVersion: z.string(),
          maxConcurrent: z.number().int().positive(),
        })
        .strict(),
      z.object({ type: z.literal("heartbeat"), activeActionIds: z.array(idSchema) }).strict(),
      z.object({ type: z.literal("started"), actionId: idSchema, leaseId: idSchema }).strict(),
      z
        .object({
          type: z.literal("result"),
          actionId: idSchema,
          leaseId: idSchema,
          resultSha256: sha256Schema,
          status: z.enum(["succeeded", "failed", "effect_unknown"]),
          data: z.json(),
          evidenceRefs: z.array(idSchema),
        })
        .strict(),
    ]),
  })
  .strict();
export const controlMessageSchema = z
  .object({
    ...envelopeShape,
    payload: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("dispatch"),
          action: toolActionSchema,
          leaseId: idSchema,
          expiresAt: z.iso.datetime(),
        })
        .strict(),
      z.object({ type: z.literal("ack"), acknowledgedMessageId: idSchema, actionId: idSchema.optional() }).strict(),
      z.object({ type: z.literal("cancel"), actionId: idSchema, reason: z.string() }).strict(),
      z.object({ type: z.literal("reconcile"), actionId: idSchema }).strict(),
    ]),
  })
  .strict();
export const eventRecordSchema = z
  .object({
    id: idSchema,
    sequence: z.number().int().positive(),
    scope: scopeSchema,
    aggregateId: idSchema,
    aggregateRevision: z.number().int().positive(),
    type: z.string().min(1),
    occurredAt: z.iso.datetime(),
    data: z.json(),
  })
  .strict();
export const apiErrorSchema = z
  .object({
    code: z.string(),
    messageKey: z.string(),
    requestId: idSchema,
    retryable: z.boolean(),
    actionId: idSchema.optional(),
    details: z.json().optional(),
  })
  .strict();
