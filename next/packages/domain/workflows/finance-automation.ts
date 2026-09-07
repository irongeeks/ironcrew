import { randomUUID } from "node:crypto";
import { z } from "zod";
import { scopeSchema, type Scope } from "../../contracts/src/index.ts";
import { Repository } from "../../persistence/src/index.ts";
import { DomainError, sha256 } from "../src/index.ts";
import { invoiceSchema, reminderRuleSchema, type Invoice } from "./finance.ts";
const minor = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);
export const processingRuleInputSchema = z
  .object({
    scope: scopeSchema,
    sourceVoucherId: z.uuid(),
    supplierId: z.string().min(1).max(200),
    currency: z.string().regex(/^[A-Z]{3}$/),
    minTotalMinor: minor,
    maxTotalMinor: minor,
    mediaTypes: z
      .array(z.enum(["application/pdf", "image/png", "image/jpeg"]))
      .min(1)
      .max(3),
    targetId: z.uuid(),
    mandateId: z.uuid(),
    mandateVersion: z.number().int().positive(),
    sevdeskSupplierId: z.number().int().positive(),
    accountDatevId: z.number().int().positive(),
    taxRuleId: z.enum(["1", "2", "3", "4", "5", "11"]),
    taxRate: z.number().min(0).max(100),
    source: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine((v) => BigInt(v.minTotalMinor) <= BigInt(v.maxTotalMinor), "Amount interval invalid");
export const processingRuleSchema = processingRuleInputSchema.safeExtend({
  id: z.uuid(),
  version: z.literal(1),
  state: z.enum(["proposed", "reviewed", "active", "disabled"]),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  review: z
    .object({ reviewerId: z.uuid(), evidence: z.string().min(1), at: z.iso.datetime(), fingerprint: z.string() })
    .optional(),
  approvedBy: z.uuid().optional(),
  approvedAt: z.iso.datetime().optional(),
});
export type ProcessingRule = z.infer<typeof processingRuleSchema>;
export const reminderPolicyInputSchema = z
  .object({
    scope: scopeSchema,
    orderId: z.uuid(),
    targetId: z.uuid(),
    mandateId: z.uuid(),
    mandateVersion: z.number().int().positive(),
    invoiceId: z.string().regex(/^[1-9][0-9]*$/),
    recipient: z.email(),
    stage: z.number().int().min(1).max(10),
    minOverdueDays: z.number().int().min(1).max(365),
    maxDataAgeSeconds: z.number().int().min(1).max(300),
    subject: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(20000),
    intervalSeconds: z.number().int().min(60).max(86400),
  })
  .strict();
export const reminderPolicySchema = reminderPolicyInputSchema.extend({
  id: z.uuid(),
  version: z.literal(1),
  state: z.enum(["proposed", "active", "disabled"]),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  nextCheckAt: z.iso.datetime(),
  approvedBy: z.uuid().optional(),
  approvedAt: z.iso.datetime().optional(),
});
export type ReminderPolicy = z.infer<typeof reminderPolicySchema>;
export const invoiceHoldSchema = z
  .object({
    scope: scopeSchema,
    targetId: z.uuid(),
    invoiceId: z.string().min(1),
    disputed: z.boolean(),
    paymentPause: z.boolean(),
    source: z.string().trim().min(1).max(2000),
  })
  .strict();
export type StoredVoucher = {
  id: string;
  orderId: string;
  invoice: Invoice;
  originalSha256: string;
  originalMediaType: string;
  originalBytes: number;
  state: string;
  voucherDate?: string;
};
const ruleFingerprint = (rule: ProcessingRule) =>
  sha256(
    processingRuleInputSchema.parse(
      Object.fromEntries(
        Object.keys(processingRuleInputSchema.shape).map((key) => [key, rule[key as keyof ProcessingRule]]),
      ),
    ),
  );
export class FinanceAutomation {
  readonly repo: Repository;
  readonly now: () => Date;
  constructor(repo: Repository, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.now = now;
  }
  private async ceo(scope: Scope, ceoId: string) {
    if ((await this.repo.snapshot(scope.companyId)).ceo.id !== ceoId) throw new DomainError("ceo_required");
  }
  async propose(scope: Scope, ceoId: string, input: unknown) {
    await this.ceo(scope, ceoId);
    const valid = processingRuleInputSchema.parse(input);
    if (sha256(valid.scope) !== sha256(scope)) throw new DomainError("scope_denied");
    const voucher = await this.repo.getDocument<StoredVoucher>(scope, "voucher", valid.sourceVoucherId);
    if (
      !voucher ||
      voucher.data.invoice.supplierId !== valid.supplierId ||
      voucher.data.invoice.currency !== valid.currency
    )
      throw new DomainError("rule_source_mismatch");
    const rule: ProcessingRule = {
      ...valid,
      id: randomUUID(),
      version: 1,
      state: "proposed",
      createdBy: ceoId,
      createdAt: this.now().toISOString(),
    };
    await this.repo.putDocument(scope, "finance-processing-rule", rule.id, rule);
    return rule;
  }
  async review(scope: Scope, id: string, reviewerId: string, evidence: string) {
    if ((await this.repo.snapshot(scope.companyId)).employees.find((e) => e.seedKey === "finance")?.id !== reviewerId)
      throw new DomainError("finance_lead_required");
    if (!evidence.trim()) throw new DomainError("review_evidence_required");
    const doc = await this.repo.getDocument<ProcessingRule>(scope, "finance-processing-rule", id);
    if (!doc || doc.data.state !== "proposed") throw new DomainError("rule_not_proposed");
    await this.noConflict(scope, doc.data);
    return this.repo.putDocument(
      scope,
      "finance-processing-rule",
      id,
      {
        ...doc.data,
        state: "reviewed",
        review: { reviewerId, evidence, at: this.now().toISOString(), fingerprint: ruleFingerprint(doc.data) },
      },
      { expectedRevision: doc.revision },
    );
  }
  private async noConflict(scope: Scope, rule: ProcessingRule) {
    for (const prior of await this.repo.listDocuments<ProcessingRule>(scope, "finance-processing-rule"))
      if (
        prior.id !== rule.id &&
        prior.data.state === "active" &&
        prior.data.supplierId === rule.supplierId &&
        prior.data.currency === rule.currency &&
        BigInt(prior.data.minTotalMinor) <= BigInt(rule.maxTotalMinor) &&
        BigInt(rule.minTotalMinor) <= BigInt(prior.data.maxTotalMinor) &&
        prior.data.mediaTypes.some((t) => rule.mediaTypes.includes(t))
      )
        throw new DomainError("processing_rules_overlap");
  }
  async activate(scope: Scope, id: string, ceoId: string) {
    await this.ceo(scope, ceoId);
    const doc = await this.repo.getDocument<ProcessingRule>(scope, "finance-processing-rule", id);
    if (!doc || doc.data.state !== "reviewed" || doc.data.review?.fingerprint !== ruleFingerprint(doc.data))
      throw new DomainError("finance_review_required");
    const key = sha256([doc.data.supplierId, doc.data.currency]);
    const guard = await this.repo.getDocument(scope, "finance-processing-activation", key);
    await this.noConflict(scope, doc.data);
    await this.repo.transact(
      scope,
      [
        {
          kind: "finance-processing-activation",
          id: key,
          data: { ruleId: id, sequence: (guard?.revision ?? 0) + 1 },
          expectedRevision: guard?.revision ?? 0,
        },
        {
          kind: "finance-processing-rule",
          id,
          data: { ...doc.data, state: "active", approvedBy: ceoId, approvedAt: this.now().toISOString() },
          expectedRevision: doc.revision,
        },
      ],
      { type: "finance.processing_rule_approved", aggregateId: id },
    );
    return (await this.repo.getDocument<ProcessingRule>(scope, "finance-processing-rule", id))!;
  }
  async disable(scope: Scope, kind: "finance-processing-rule" | "finance-reminder-policy", id: string, ceoId: string) {
    await this.ceo(scope, ceoId);
    const doc = await this.repo.getDocument<ProcessingRule | ReminderPolicy>(scope, kind, id);
    if (!doc) throw new DomainError("finance_rule_not_found");
    await this.repo.transact(
      scope,
      [
        { kind, id, data: { ...doc.data, state: "disabled" }, expectedRevision: doc.revision },
        ...(kind === "finance-reminder-policy"
          ? [
              {
                kind: "reminder-rule-revocation",
                id: `${id}:1`,
                data: { id, revokedBy: ceoId, at: this.now().toISOString() },
                immutable: true,
              },
            ]
          : []),
      ],
      { type: "finance.rule_disabled", aggregateId: id },
    );
    return { id, state: "disabled" as const };
  }
  async proposeReminder(scope: Scope, ceoId: string, input: unknown) {
    await this.ceo(scope, ceoId);
    const valid = reminderPolicyInputSchema.parse(input);
    if (sha256(valid.scope) !== sha256(scope)) throw new DomainError("scope_denied");
    if ((await this.repo.getOrder(scope, valid.orderId)).kind !== "finance")
      throw new DomainError("workflow_kind_mismatch");
    const existing = await this.repo.listDocuments<ReminderPolicy>(scope, "finance-reminder-policy");
    if (
      existing.some(
        (p) =>
          p.data.targetId === valid.targetId && p.data.invoiceId === valid.invoiceId && p.data.stage === valid.stage,
      )
    )
      throw new DomainError("reminder_stage_already_configured");
    const policy: ReminderPolicy = {
      ...valid,
      id: randomUUID(),
      version: 1,
      state: "proposed",
      createdBy: ceoId,
      createdAt: this.now().toISOString(),
      nextCheckAt: this.now().toISOString(),
    };
    const claimId = sha256([valid.targetId, valid.invoiceId, valid.stage]);
    try {
      await this.repo.transact(
        scope,
        [
          {
            kind: "finance-reminder-claim",
            id: claimId,
            data: { policyId: policy.id, targetId: valid.targetId, invoiceId: valid.invoiceId, stage: valid.stage },
            immutable: true,
          },
          { kind: "finance-reminder-policy", id: policy.id, data: policy, expectedRevision: 0 },
        ],
        { type: "finance.reminder_proposed", aggregateId: policy.id },
      );
    } catch (error) {
      if (await this.repo.getDocument(scope, "finance-reminder-claim", claimId))
        throw new DomainError("reminder_stage_already_configured");
      throw error;
    }
    return policy;
  }
  async activateReminder(scope: Scope, id: string, ceoId: string) {
    await this.ceo(scope, ceoId);
    const doc = await this.repo.getDocument<ReminderPolicy>(scope, "finance-reminder-policy", id);
    if (!doc || doc.data.state !== "proposed") throw new DomainError("rule_not_proposed");
    const p = doc.data;
    const rule = reminderRuleSchema.parse({
      id,
      version: 1,
      approvedByCeo: true,
      enabled: true,
      invoiceIds: [p.invoiceId],
      recipients: [p.recipient],
      targetIds: [p.targetId],
      minOverdueDays: p.minOverdueDays,
      maxDataAgeSeconds: p.maxDataAgeSeconds,
      stage: p.stage,
      feesMinor: "0",
    });
    await this.repo.transact(
      scope,
      [
        {
          kind: "finance-reminder-policy",
          id,
          data: { ...p, state: "active", approvedBy: ceoId, approvedAt: this.now().toISOString() },
          expectedRevision: doc.revision,
        },
        { kind: "reminder-rule", id: `${id}:1`, data: rule, immutable: true },
      ],
      { type: "finance.reminder_approved", aggregateId: id },
    );
    return { id, state: "active" as const };
  }
}
/** Never infer unpaid from missing/null payment data; provider status 200 is an open invoice. */
export function normalizeSevdeskInvoice(
  data: unknown,
  observedAt: string,
  targetId: string,
  hold: { disputed: boolean; paymentPause: boolean },
): Invoice {
  const object = z.object({ objects: z.array(z.record(z.string(), z.unknown())).length(1) }).parse(data).objects[0]!;
  const money = (value: unknown) => {
    if ((typeof value !== "string" && typeof value !== "number") || !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(value)))
      throw new DomainError("payment_data_incomplete");
    const [whole, fraction = ""] = String(value).split(".");
    return (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
  };
  if (String(object.status) !== "200" || object.invoiceType !== "RE" || object.currency !== "EUR")
    throw new DomainError("invoice_not_remindable");
  const raw = z.string().min(1).parse(object.invoiceDate);
  const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  const timestamp = /^\d{10}$/.test(raw) ? new Date(Number(raw) * 1000).toISOString() : raw;
  const issue = german
    ? `${german[3]}-${german[2]}-${german[1]}T00:00:00.000Z`
    : z.iso.datetime({ offset: true }).parse(timestamp);
  if (
    !Number.isFinite(Date.parse(issue)) ||
    (german && new Date(issue).toISOString().slice(0, 10) !== issue.slice(0, 10))
  )
    throw new DomainError("invoice_date_invalid");
  if (
    !(
      (typeof object.timeToPay === "number" && Number.isInteger(object.timeToPay)) ||
      (typeof object.timeToPay === "string" && /^[0-9]{1,4}$/.test(object.timeToPay))
    )
  )
    throw new DomainError("payment_data_incomplete");
  const days = z.coerce.number().int().min(0).max(3650).parse(object.timeToPay);
  const contact = z.object({ id: z.union([z.string().min(1), z.number().int().positive()]) }).parse(object.contact);
  return invoiceSchema.parse({
    id: String(object.id),
    supplierId: String(contact.id),
    direction: "receivable",
    reference: object.invoiceNumber,
    currency: object.currency,
    totalMinor: money(object.sumGross),
    paidMinor: money(object.paidAmount),
    dueAt: new Date(Date.parse(issue) + days * 86400000).toISOString(),
    observedAt,
    source: `sevdesk:${targetId}:Invoice/${String(object.id)}`,
    ...hold,
  });
}
