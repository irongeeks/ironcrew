import * as MI from "./mail-inbox.ts";
import { mailInboxPolicySchema, mailFinanceImportSchema } from "../mail-inbox-service.ts";
import * as F from "./finance-automation.ts";
import * as RF from "../release-feed-routes.ts";
import { z } from "zod";
import { coordinationSchema } from "../../../packages/runtime/src/coordination.ts";
import { modelCostResultSchema, modelCostsResultSchema, modelCostManualSchema } from "../model-cost-service.ts";
import { customerInputSchema, projectInputSchema, entityDetailsSchema, entitySchema } from "../entity-routes.ts";
import {
  websiteCarePolicySchema,
  websiteCarePolicyResultSchema,
  websiteCareStatusSchema,
  websiteCareJobSchema,
} from "../website-care-service.ts";
import {
  integrationChargeResultSchema,
  integrationChargesResultSchema,
  integrationReconcileInputSchema,
} from "../integration-costs.ts";
import {
  scopeSchema,
  orderKindSchema,
  mandateSchema,
  eventRecordSchema,
} from "../../../packages/contracts/src/index.ts";
import { configSchema } from "../configuration.ts";
import { channelConfigSchema } from "../channel-routes.ts";
import { conceptSchema, siteRevisionInputSchema } from "../../../packages/domain/workflows/website.ts";
import { invoiceSchema, voucherInputSchema } from "../../../packages/domain/workflows/finance.ts";
import { knowledgeSchema } from "../../../packages/domain/workflows/knowledge.ts";
import { watchReviewSchema } from "../../../packages/domain/workflows/research-watch.ts";
import { ratingInputSchema } from "../../../packages/runtime/src/ratings.ts";
import { backupPolicySchema, updatePolicySchema } from "../../../packages/operations/src/maintenance.ts";
import {
  healthProfileSchema,
  incidentActionSchema,
  repairParameters,
  checkParameters,
  messageParameters,
} from "../incident-service.ts";
import { hostingProfileSchema } from "../../../packages/integrations/src/hosting.ts";
import { hostingActionSchema, hostingPublishSchema } from "../../../packages/domain/workflows/hosting.ts";
import { id, date, hash, int, revision, text, json, object, list, document, revised, outcome } from "./common.ts";
import * as R from "./resources.ts";
import * as W from "./workflows.ts";
import * as M from "./maintenance.ts";
import * as I from "./inputs.ts";
export type Contract = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  source: string;
  input?: z.ZodType;
  output?: z.ZodType;
  security?: "ceo" | "public" | "setup" | "webhook" | "transfer";
  revision?: "quoted-positive" | "positive" | "nonnegative" | "number";
  pagination?: "offset" | "notifications" | "sse";
  status?: number;
  media?: string;
  bodyOptional?: boolean;
  headers?: Record<string, { schema: z.ZodType; description: string; required?: boolean }>;
  responseHeaders?: Record<string, { schema: z.ZodType; description: string }>;
  pathParameters?: Record<string, z.ZodType>;
  description?: string;
  errors?: number[];
  external?: boolean;
};
export const contracts: Contract[] = [];
let source = "apps/control/app.ts";
function route(
  method: Contract["method"],
  path: string,
  output: z.ZodType | undefined,
  input?: z.ZodType,
  options: Partial<Contract> = {},
) {
  const value = { method, path: "/api/v1" + path, output, input, source, ...options };
  if (contracts.some((c) => c.path === value.path && c.method === method))
    throw new Error("Duplicate contract " + method + path);
  contracts.push(value);
}
const get = (path: string, output: z.ZodType, options: Partial<Contract> = {}) =>
  route("get", path, output, undefined, options);
const post = (path: string, output: z.ZodType, input?: z.ZodType, options: Partial<Contract> = {}) =>
  route("post", path, output, input, options);
const paginated = { pagination: "offset" } as const;
const authCookie = {
  "Set-Cookie": {
    schema: text,
    description: "HttpOnly ironcrew_session; SameSite=Strict; Path=/; Secure on HTTPS. Session lifetime 12 hours.",
  },
};
get(
  "/health",
  object({
    status: z.literal("ok"),
    database: object({ schemaVersion: int, journalMode: text, foreignKeys: z.boolean() }),
    version: text,
    instanceId: id,
    releaseManifestSha256: hash.optional(),
  }),
  { security: "public" },
);
get("/session", R.session, { security: "public" });
post("/session", object({ authenticated: z.literal(true), csrfToken: text }), z.object({ password: I.password }), {
  security: "public",
  responseHeaders: authCookie,
  errors: [401, 403, 429],
  description:
    "Login. Failed attempts are limited to ten per 15 minutes; successful logins do not consume that failure budget. Origin, when supplied, must match publicOrigin.",
});
route("delete", "/session", object({ authenticated: z.literal(false) }), undefined, { responseHeaders: authCookie });
get("/setup", R.progress, { security: "setup" });
post("/setup", R.setupResult.extend({ authenticated: z.literal(true), csrfToken: text }), I.setup, {
  security: "public",
  responseHeaders: authCookie,
  errors: [401, 429],
  description:
    "Consumes the one-time setup token and creates the company/CEO. Already initialized returns conflict. No Idempotency-Key replay.",
});
route("patch", "/setup", R.progress, z.object({ step: int.max(8), data: z.record(text, json) }), {
  security: "setup",
  description:
    "Before company creation use X-Setup-Token; afterward use CEO cookie plus CSRF. Data is step-specific JSON; top-level password/token/secret keys are rejected except secretRef.",
});
get(
  "/company",
  R.company.extend({ locale: z.enum(["de", "en"]).optional(), revision, ceo: object({ id, name: text }) }),
);
route(
  "patch",
  "/company",
  document(R.companySettings),
  object({ name: text.min(1).optional(), locale: z.enum(["de", "en"]).optional(), timezone: text.optional() }),
  { revision: "quoted-positive" },
);
get("/employees", list(revised(R.employee)), paginated);
route(
  "patch",
  "/employees/{id}",
  document(R.profile),
  object({
    displayName: text.min(1).optional(),
    persona: text.optional(),
    appearance: text.optional(),
    modelOverride: text.nullable().optional(),
  }),
  {
    revision: "quoted-positive",
    description: "Public profile revision is persisted overlay revision + 1, including the returned document revision.",
  },
);
get("/areas", list(R.area), paginated);
post("/areas", R.area, z.object({ name: text.min(1), visibility: z.enum(["company", "private"]) }));
get("/orders", list(R.order), {
  ...paginated,
  description: "Optional status query filters exact stored status. Unknown strings simply match no orders.",
});
post("/orders", R.order, I.order);
get("/orders/{id}", R.order);
get("/orders/{id}/coordination", list(coordinationSchema), paginated);
post(
  "/orders/{id}/transition",
  R.order,
  z.object({
    status: z.enum(["planning", "ready", "paused", "running", "cancelled", "reviewing", "completed"]),
    planVersion: revision.optional(),
  }),
  { revision: "quoted-positive" },
);
route("patch", "/orders/{id}/lead", R.order, z.object({ leadEmployeeId: id }), { revision: "quoted-positive" });
post("/orders/{id}/model-response/discard", R.run, z.object({ turnId: id }).strict(), {
  revision: "quoted-positive",
  description:
    "Explicitly discards a missing model response only after evidence-backed cost reconciliation. Does not invoke a model; a subsequent run request may create a new charged turn.",
});
post(
  "/orders/{id}/run",
  R.run,
  z.object({ mandateId: id, mandateVersion: revision.default(1), modelId: text.optional() }),
  {
    bodyOptional: true,
    description:
      "Starts a configured real runtime, or resumes an existing run. Body is required for the first start; existing runs reuse their persisted mandate/model and ignore a new body. No claimed successful execution when runtime is unavailable.",
  },
);
get("/orders/{id}/messages", list(revised(R.message)), paginated);
get("/orders/{id}/artifacts", list(W.artifact), paginated);
get("/orders/{id}/reviews", list(z.union([W.siteReview, W.artifactReview])), paginated);
post("/orders/{id}/messages", R.message, z.object({ content: text.trim().min(1).max(20000) }));
get("/orders/{id}/events", list(eventRecordSchema), {
  ...paginated,
  description:
    "Order-filtered persisted event history, not SSE. Pagination currently operates over the first 1000 events loaded for the scope.",
});
get("/company/messages", list(R.message), paginated);
post("/company/messages", R.message, z.object({ content: text.trim().min(1).max(20000) }));
get("/configuration", configSchema);
route(
  "put",
  "/configuration",
  object({ saved: z.literal(true), liveExecutionEnabled: z.boolean(), runtimeReady: z.boolean() }),
  configSchema,
  {
    description:
      "Admin configuration references Proton secrets, never raw credentials. Runtime is prepared before committing configuration. Paths and remote worker availability are checked by the runtime; live execution defaults off.",
  },
);
post(
  "/backups",
  R.backup,
  object({ ageExecutable: text.min(1), recipient: text.startsWith("age1"), outputDirectory: text.min(1) }),
);
get("/recovery", R.recovery);
post("/recovery/resume", document(R.recovery), z.object({ reviewedExternalEffects: z.literal(true) }));
post("/models/refresh", object({ count: int, observedAt: date }));
get("/budget", R.budget);
post("/budget", R.budget, I.budget);
post("/mandates", mandateSchema, mandateSchema);
get("/approvals", list(revised(R.approvalRequest)), paginated);
post("/approvals/{id}/decision", R.approval, z.object({ decision: z.enum(["approved", "denied"]) }), {
  revision: "quoted-positive",
});
for (const [path, schema] of Object.entries({
  workers: revised(R.worker),
  integrations: R.extensionResource,
  schedules: revised(W.schedule),
  knowledge: revised(W.knowledge),
  backups: revised(R.backup),
  mandates: mandateSchema.extend({ revision }),
  models: R.model,
  projects: R.extensionResource,
}))
  get("/" + path, list(schema), paginated);
get("/events", text, {
  media: "text/event-stream",
  pagination: "sse",
  description:
    "Company-scoped SSE. Last-Event-ID overrides query after. Each update contains id: persisted sequence; event: update; data: {type,aggregateId}. Heartbeat comments follow. If an error occurs after headers, event: stale with data: {} is emitted. No event body text or secrets are streamed.",
  responseHeaders: {
    "Cache-Control": { schema: z.literal("no-cache"), description: "No intermediary cache." },
    Connection: { schema: z.literal("keep-alive"), description: "Streaming response." },
  },
});
get("/workers/status", R.workerStatus);
post(
  "/workers/enroll",
  R.enrollment,
  z.object({ name: text.min(1), capabilities: z.array(text).min(1), maxConcurrent: revision.max(16).default(1) }),
  {
    errors: [410],
    description: "One-time token. Save securely: an idempotency replay returns 410, never the credential.",
  },
);
post("/workers/{id}/rotate", R.enrollment, undefined, { errors: [410] });
post("/workers/{id}/revoke", object({ revoked: z.literal(true) }));
source = "apps/control/workflow-routes.ts";
get(
  "/orders/{id}/workflow",
  z.union([
    revised(W.site),
    revised(W.incident),
    revised(W.report),
    object({ kind: orderKindSchema, state: z.literal("not_started") }),
  ]),
  {
    description:
      "Current kind-specific stored workflow, or not_started. Finance snapshots and research artifacts are separate resources; no finance-workflow document is currently written.",
  },
);
post(
  "/orders/{id}/plan",
  R.order,
  z.object({ steps: z.array(text.min(1)).min(1), acceptanceCriteria: z.array(text.min(1)).min(1) }),
  { revision: "quoted-positive" },
);
post(
  "/orders/{id}/website",
  document(W.site),
  z.object({ briefing: text.min(1), stack: z.enum(["static", "react", "wordpress"]).default("static") }),
);
post("/orders/{id}/website/concepts", document(W.site), z.object({ concepts: z.array(conceptSchema).min(2).max(10) }));
post("/orders/{id}/website/select", document(W.site), z.object({ conceptId: id }));
post("/orders/{id}/website/build", W.siteArtifact);
post("/orders/{id}/website/revision", document(W.site), siteRevisionInputSchema);
post("/orders/{id}/website/pins", document(W.pin), W.pinInput);
post(
  "/orders/{id}/website/pins/{pinId}/resolve",
  document(W.pin),
  z.object({ artifactVersionId: id, evidence: text.min(1) }),
);
get("/orders/{id}/website/pins", list(W.pin));
post(
  "/orders/{id}/website/feedback/submit",
  object({ messageId: id, pinIds: z.array(id) }),
  object({ pinIds: z.array(id).min(1).max(50) }),
);
post(
  "/orders/{id}/website/review",
  object({ id, passed: z.boolean() }),
  z.object({ artifactVersionId: id, checks: z.array(W.reviewCheck).min(1) }),
  {
    description:
      "Authenticated CEO manual review. Unique check names must include mobile, functional, quality. Every check requires evidence. Client cannot impersonate an employee.",
  },
);
post("/orders/{id}/website/accept", document(W.site), z.object({ artifactVersionId: id }));
post("/orders/{id}/finance/vouchers", object({ duplicate: z.boolean(), voucherId: id }), voucherInputSchema.strip(), {
  description:
    "Canonical base64 of an original PDF/PNG/JPEG, <=8 MB decoded, matching SHA-256 and file signature. The route strips extra envelope keys before domain validation.",
});
get(
  "/finance",
  object({
    items: z.array(W.snapshot.extend({ scope: scopeSchema })),
    vouchers: z.array(W.voucher.extend({ scope: scopeSchema, revision })),
    nextCursor: z.null(),
    bankImport: object({ available: z.literal(false), reason: z.literal("bank_format_unconfigured") }),
  }),
);
post("/finance/snapshot", W.snapshot, z.object({ invoices: z.array(invoiceSchema) }));
post(
  "/finance/vouchers/{id}/payment",
  W.payment,
  z.object({
    recipient: text.min(1),
    bankAccount: text.min(1),
    reference: text.min(1),
    amountMinor: text.regex(/^\d+$/),
  }),
);
post(
  "/finance/vouchers/{id}/correction",
  z.union([object({ ruleCreated: z.literal(true), id }), object({ ruleCreated: z.literal(false) })]),
  I.correction,
);
post(
  "/incidents",
  document(W.incident),
  z.object({
    provider: text,
    accountId: text,
    eventId: text,
    targetId: id,
    summary: text.min(1),
    budgetLimitUsdMicros: text.regex(/^\d+$/),
  }),
);
post("/orders/{id}/incident", document(W.incident), z.object({ targetId: id }));
post(
  "/orders/{id}/incident/diagnosis",
  document(W.incident),
  z.object({ evidence: text, causeStatus: z.enum(["unknown", "suspected", "confirmed"]), explanation: text }),
);
post(
  "/orders/{id}/incident/prevention",
  R.order,
  z.object({ goal: text.min(1), budgetLimitUsdMicros: text.regex(/^\d+$/) }),
);
post("/schedules", W.schedule, I.schedule);
post(
  "/channels/challenge",
  object({ challenge: text, expiresAt: date }),
  z.object({ provider: z.enum(["discord", "telegram"]), scope: scopeSchema.optional() }),
);
get("/orders/{id}/research", list(W.artifact));
get("/orders/{id}/research/sources", list(W.source));
post(
  "/orders/{id}/research/sources",
  W.source,
  z.object({ targetId: id, url: z.url(), title: text.min(1), mandateId: id, mandateVersion: revision.default(1) }),
);
post("/orders/{id}/research", W.report, I.report);
post("/orders/{id}/research/deliver", W.delivery, I.delivery);
post("/knowledge", document(W.knowledge), knowledgeSchema.strip());
post("/knowledge/{id}/decision", document(W.knowledge), z.object({ decision: z.enum(["approve", "reject"]) }), {
  revision: "number",
  description:
    "Explicit CEO approval/rejection. This endpoint uses Number(If-Match); missing or stale revisions conflict. Employee review is a separate domain action.",
});
const downloadHeaders = {
  "Content-Disposition": {
    schema: text,
    description: "Attachment filename generated from the scoped artifact/voucher UUID.",
  },
  "Content-Security-Policy": {
    schema: z.literal("default-src 'none'; sandbox"),
    description: "Downloaded original is not an active application document.",
  },
};
get("/finance/vouchers/{id}/original", text, {
  media: "application/octet-stream",
  responseHeaders: downloadHeaders,
  description:
    "Binary original; stored SHA-256 is rechecked before sending. Extension reflects the verified uploaded media type.",
});
get("/artifacts/{id}/download", text, {
  media: "application/octet-stream",
  responseHeaders: {
    ...downloadHeaders,
    "X-Content-SHA256": { schema: hash, description: "Verified SHA-256 of the actual response bytes." },
    "Cache-Control": { schema: z.literal("no-store"), description: "Do not cache artifact bytes." },
  },
  description:
    "Stored binary artifact, confined against symlink/hardlink replacement. Byte digest must match the persisted SHA-256; changed content returns artifact_content_changed (409).",
});
get("/artifacts/{id}/package", text, {
  media: "application/gzip",
  responseHeaders: {
    "Content-Disposition": downloadHeaders["Content-Disposition"],
    "X-Content-SHA256": { schema: hash, description: "SHA-256 of archive bytes." },
    "X-Package-SHA256": { schema: hash, description: "SHA-256 of canonical package manifest." },
    "Cache-Control": { schema: z.literal("no-store"), description: "Do not persist HTTP cache." },
  },
  description: "Complete manifest-verified website tar.gz with source and built assets.",
});
source = "apps/control/research-watch-routes.ts";
get("/orders/{id}/research/watches", list(revised(W.watch)));
post("/orders/{id}/research/watches", W.watch, I.watch);
get(
  "/orders/{id}/research/watches/{watchId}/checks",
  object({ items: z.array(W.watchCheck), reviews: z.array(W.watchReview), nextCursor: z.null() }),
);
post("/orders/{id}/research/watches/{watchId}/check", W.watchCheck, object({ checkId: id.optional() }), {
  bodyOptional: true,
});
source = "apps/control/admin-routes.ts";
get("/channels/config", object({ config: channelConfigSchema, revision: int }));
route(
  "put",
  "/channels/config",
  object({ config: channelConfigSchema, revision }),
  object({ config: channelConfigSchema }),
  { revision: "nonnegative" },
);
get("/channels/bindings", list(R.binding));
route("patch", "/orders/{id}/research/watches/{watchId}", document(W.watch), object({ enabled: z.boolean() }), {
  revision: "nonnegative",
});
post("/orders/{id}/research/watches/{watchId}/checks/{checkId}/review", W.watchReview, watchReviewSchema);
get("/notifications", object({ items: z.array(R.notification), nextCursor: text.nullable(), lastSequence: int }), {
  pagination: "notifications",
});
source = "apps/control/rating-routes.ts";
get("/models/ratings", list(R.ratingSummary));
get(
  "/orders/{id}/model-ratings",
  object({ items: z.array(R.rating), targets: z.array(R.ratingTarget), nextCursor: z.null() }),
);
post("/orders/{id}/model-ratings", R.rating, ratingInputSchema.omit({ orderId: true }));
source = "apps/control/incident-routes.ts";
get("/incident/health-profiles", object({ items: z.array(revised(W.healthProfile)) }));
post("/incident/health-profiles", document(W.healthProfile), healthProfileSchema);
route("put", "/incident/health-profiles/{id}", document(W.healthProfile), healthProfileSchema, {
  revision: "positive",
});
get("/orders/{id}/incident/status", W.incidentStatus);
post("/orders/{id}/incident/repair", outcome, incidentActionSchema.extend(repairParameters.shape));
post("/orders/{id}/incident/check", outcome, incidentActionSchema.extend(checkParameters.shape));
post("/orders/{id}/incident/customer-message", outcome, incidentActionSchema.extend(messageParameters.shape));
source = "apps/control/hosting-routes.ts";
get("/hosting/profiles", object({ items: z.array(revised(W.hostingProfile)) }));
post("/hosting/profiles", W.hostingProfile, hostingProfileSchema);
route("put", "/hosting/profiles/{id}", W.hostingProfile, hostingProfileSchema, { revision: "positive" });
get("/orders/{id}/hosting", W.hostingStatus);
post("/orders/{id}/hosting/provision", outcome, hostingActionSchema);
post("/orders/{id}/hosting/publish", outcome, hostingPublishSchema);
post("/orders/{id}/hosting/rollback", outcome, hostingActionSchema.extend({ deploymentId: id }));
source = "apps/control/maintenance-routes.ts";
get("/maintenance", M.maintenance);
post("/maintenance/backup-policies", M.backupPolicy, backupPolicySchema);
post("/maintenance/backup-policies/{id}/probe", M.probe, object({ identityPath: text.min(1) }));
post("/maintenance/backup-policies/{id}/activate", M.backupPolicy, object({}), { bodyOptional: true });
post("/maintenance/backup-policies/{id}/pause", M.backupPolicy);
post("/maintenance/update-policies", M.updatePolicy, updatePolicySchema);
post("/maintenance/update-policies/{id}/revoke", object({ policyId: id, revokedBy: id, revokedAt: date }));
post("/maintenance/updates", M.updatePlan, object({ policyId: id, releaseDirectory: text.min(1) }));
post("/maintenance/updates/{id}/approve", M.updatePlan);
post("/maintenance/updates/{id}/apply", z.union([M.updatePlan, M.updateQueue]), undefined, {
  description:
    "Production executor durably queues the approved plan and returns queued/jobId/planId before Control shutdown. Final verified result appears in GET maintenance updatePlans. In-process fixture lifecycle can return a completed plan directly.",
});
source = "apps/control/channel-routes.ts";
post(
  "/channel-webhooks/{provider}/{id}",
  z.union([
    object({ type: z.literal(1) }),
    object({ type: z.literal(4), data: object({ content: text, flags: z.literal(64) }) }),
    object({ accepted: z.literal(true), bound: z.literal(true) }),
    object({ accepted: z.literal(true), duplicate: z.boolean() }),
  ]),
  z.union([I.telegram, I.discord, I.email]),
  {
    security: "webhook",
    errors: [400, 401, 404, 409, 500, 503],
    description:
      "Provider-specific raw JSON <=1 MiB, uncompressed. Telegram uses its configured webhook secret, Discord Ed25519(timestamp || raw body), email HMAC-SHA256(timestamp + '.' + raw body). Discord/mail timestamp window is five minutes. Only the configured provider/account/conversation allowlist determines scope; claimed identities cannot authorize a CEO.",
    headers: {
      "X-Telegram-Bot-Api-Secret-Token": { schema: text, description: "Required for Telegram." },
      "X-Signature-Ed25519": { schema: text.regex(/^[a-fA-F0-9]{128}$/), description: "Required for Discord." },
      "X-Signature-Timestamp": { schema: text.regex(/^\d+$/), description: "Required for Discord; Unix seconds." },
      "X-IronCrew-Timestamp": { schema: text.regex(/^\d+$/), description: "Required for email; Unix seconds." },
      "X-IronCrew-Signature": { schema: hash, description: "Required for email bridge." },
    },
  },
);
source = "apps/control/app.ts + packages/tools/remote-execution/server.ts";
const transferHeaders = {
  "Content-Length": { schema: text.regex(/^\d+$/), description: "Exact manifest file size in bytes." },
};
get("/worker-transfers/{jobId}/input/{index}", text, {
  security: "transfer",
  media: "application/octet-stream",
  errors: [400, 403, 404, 409, 413, 503],
  responseHeaders: { ...transferHeaders, "X-Content-SHA256": { schema: hash, description: "Manifest file SHA-256." } },
  description:
    "TLS-only directional job ticket from remote.dispatch. Scoped to worker generation, manifest and expiry. No CEO cookie. <=32 MiB total manifest; <=1024 files.",
});
route("put", "/worker-transfers/{jobId}/output/{index}", undefined, text, {
  security: "transfer",
  media: "application/octet-stream",
  status: 204,
  errors: [400, 403, 404, 409, 413, 503],
  headers: { "Content-Length": { ...transferHeaders["Content-Length"], required: true } },
  description:
    "TLS-only directional remote.upload ticket. Streams one exact manifest file (output indexes include the optional stdout/stderr log files after artifact files; combined logs <=1 MiB); 204 only after SHA-256 verification and fsync. No CEO cookie, CSRF or Idempotency-Key.",
});
route("post", "/worker-transfers/{jobId}/start", undefined, undefined, {
  security: "transfer",
  status: 204,
  errors: [400, 403, 404, 409, 413, 423, 503],
  headers: { "Content-Length": { schema: z.literal("0"), required: true, description: "Empty body required." } },
  description:
    "Final TLS input-ticket authority check immediately before dispatching the approved isolated child process. Rechecks mandate, generation and recovery state; no new authority is granted.",
});
source = "apps/control/finance-routes.ts";
get("/finance/automation", F.automationListSchema);
post("/finance/processing-rules", F.processingRuleSchema, F.processingRuleInputSchema);
post("/finance/processing-rules/{id}/activate", document(F.processingRuleSchema), object({}));
post("/finance/processing-rules/{id}/disable", F.disableResultSchema, object({}));
post("/finance/reminder-policies", F.reminderPolicySchema, F.reminderPolicyInputSchema);
post("/finance/reminder-policies/{id}/activate", F.activateReminderResultSchema, object({}));
post("/finance/reminder-policies/{id}/disable", F.disableResultSchema, object({}));
post("/finance/invoice-holds", document(F.invoiceHoldRecordSchema), F.invoiceHoldSchema);
source = "apps/control/finance-correction-routes.ts";
post("/finance/correction-rules/{id}/activate", F.correctionRuleSchema, object({}));
post("/finance/correction-rules/{id}/disable", F.disableResultSchema, object({}));
post(
  "/finance/correction-rules/{id}/revision",
  F.correctionRuleSchema,
  object({ value: z.union([z.string(), z.number()]), source: text.trim().min(1).max(2000) }),
);
source = "apps/control/integration-cost-routes.ts";
get("/integration-costs", integrationChargesResultSchema);
post("/integration-costs/{id}/reconcile", integrationChargeResultSchema, integrationReconcileInputSchema, {
  revision: "positive",
});
source = "apps/control/model-cost-routes.ts";
get("/model-costs", modelCostsResultSchema);
post("/model-costs/{id}/provider", modelCostResultSchema, object({}), { revision: "positive" });
post("/model-costs/{id}/manual", modelCostResultSchema, modelCostManualSchema, { revision: "positive" });
source = "apps/control/website-care-routes.ts";
get("/orders/{id}/website-care", websiteCareStatusSchema);
post("/orders/{id}/website-care", websiteCarePolicyResultSchema, websiteCarePolicySchema);
route("put", "/orders/{id}/website-care/{policyId}", websiteCarePolicyResultSchema, websiteCarePolicySchema, {
  revision: "positive",
});
post(
  "/orders/{id}/website-care/{policyId}/run",
  websiteCareJobSchema,
  object({ kind: z.enum(["check", "backup", "update"]) }),
);
source = "apps/control/entity-routes.ts";
get("/customers", list(entitySchema));
post("/customers", entitySchema, customerInputSchema);
post("/projects", entitySchema, projectInputSchema);
route("patch", "/customers/{id}", entitySchema, entityDetailsSchema, { revision: "positive" });
route("patch", "/projects/{id}", entitySchema, entityDetailsSchema, { revision: "positive" });
source = "apps/control/release-feed-routes.ts";
get("/maintenance/releases", RF.releaseCandidatesResultSchema);
post("/maintenance/releases/discover", RF.releaseDiscoverResultSchema, RF.releaseDiscoverInputSchema);
post(
  "/maintenance/releases/candidates/{id}/stage-plan",
  RF.releaseStagePlanResultSchema,
  RF.releaseStagePlanInputSchema,
);
source = "apps/control/mail-inbox-routes.ts";
get("/mail-inbox", MI.mailInboxStatusSchema);
post("/mail-inbox/policies", MI.mailInboxPolicyResultSchema, mailInboxPolicySchema);
route("put", "/mail-inbox/policies/{id}", MI.mailInboxPolicyResultSchema, mailInboxPolicySchema, {
  revision: "positive",
});
post("/mail-inbox/policies/{id}/poll", MI.mailPollResultSchema, object({}));
get("/mail-inbox/messages/{id}", MI.storedMailMessageSchema, { pathParameters: { id: hash } });
get("/mail-inbox/messages/{id}/blobs/{hash}", text, {
  media: "application/octet-stream",
  pathParameters: { id: hash, hash },
});
post("/mail-inbox/messages/{id}/finance", MI.mailFinanceImportResultSchema, mailFinanceImportSchema, {
  pathParameters: { id: hash },
});
export function contractFor(method: string, path: string) {
  return contracts.find(
    (c) =>
      c.method === method.toLowerCase() &&
      new RegExp("^" + c.path.replace(/\{[^}]+\}/g, "[^/]+") + "$").test(path.split("?")[0]!),
  );
}
