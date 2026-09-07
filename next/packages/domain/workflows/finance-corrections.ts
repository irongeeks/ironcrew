import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Repository, Mutation } from "../../persistence/src/index.ts";
import type { Scope } from "../../contracts/src/index.ts";
import { scopeSchema } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../src/index.ts";
import type { ProcessingRule, StoredVoucher } from "./finance-automation.ts";
import { digest } from "../../tools/workspace.ts";
export const classificationSchema = z
  .object({
    sevdeskSupplierId: z.number().int().positive(),
    accountDatevId: z.number().int().positive(),
    taxRuleId: z.enum(["1", "2", "3", "4", "5", "11"]),
    taxRate: z.number().min(0).max(100),
  })
  .strict();
export const correctionFieldSchema = z.enum(["sevdeskSupplierId", "accountDatevId", "taxRuleId", "taxRate"]);
const changeSchema = z
  .object({ field: correctionFieldSchema, value: z.union([z.number(), z.string()]) })
  .superRefine((value, ctx) => {
    if (!classificationSchema.shape[value.field].safeParse(value.value).success)
      ctx.addIssue({ code: "custom", path: ["value"], message: "correction_value_invalid" });
  });
export const correctionInputSchema = changeSchema.safeExtend({
  reuse: z.boolean(),
  scopeDescription: z.string().trim().min(1).max(2000).optional(),
  source: z.string().trim().min(1).max(2000),
});
const bindingSchema = z
  .object({
    originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    invoiceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    supplierId: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    mediaType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  })
  .strict();
export const correctionRecordSchema = changeSchema.safeExtend({
  id: z.uuid(),
  scope: scopeSchema,
  voucherId: z.uuid(),
  source: z.string(),
  binding: bindingSchema,
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
});
export const correctionRuleSchema = changeSchema.safeExtend({
  id: z.uuid(),
  version: z.number().int().positive(),
  supersedesId: z.uuid().optional(),
  scope: scopeSchema,
  state: z.enum(["proposed", "reviewed", "active", "disabled"]),
  source: z.string(),
  scopeDescription: z.string(),
  voucherId: z.uuid(),
  correctionId: z.uuid(),
  binding: bindingSchema,
  explicitlyRequested: z.literal(true),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  review: z
    .object({ reviewerId: z.uuid(), evidence: z.string(), at: z.iso.datetime(), fingerprint: z.string() })
    .optional(),
  approvedBy: z.uuid().optional(),
  approvedAt: z.iso.datetime().optional(),
});
export type CorrectionRule = z.infer<typeof correctionRuleSchema>;
type Correction = z.infer<typeof correctionRecordSchema>;
type Voucher = StoredVoucher & {
  classificationCorrectionIds?: Partial<Record<z.infer<typeof correctionFieldSchema>, string>>;
};
const fields = correctionFieldSchema.options;
function ruleFingerprint(rule: CorrectionRule) {
  return sha256({
    id: rule.id,
    version: rule.version,
    supersedesId: rule.supersedesId,
    scope: rule.scope,
    field: rule.field,
    value: rule.value,
    source: rule.source,
    scopeDescription: rule.scopeDescription,
    voucherId: rule.voucherId,
    correctionId: rule.correctionId,
    binding: rule.binding,
  });
}
function conflictKey(rule: CorrectionRule) {
  return sha256({
    scope: rule.scope,
    field: rule.field,
    supplier: rule.binding.supplierId,
    currency: rule.binding.currency,
    media: rule.binding.mediaType,
  });
}
export class FinanceCorrections {
  readonly repo: Repository;
  readonly directory: string;
  readonly now: () => Date;
  constructor(repo: Repository, directory: string, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.directory = directory;
    this.now = now;
  }
  private async source(scope: Scope, voucherId: string) {
    const doc = await this.repo.getDocument<Voucher>(scope, "voucher", voucherId);
    if (!doc) throw new DomainError("voucher_not_found");
    const binding = bindingSchema.parse({
      originalSha256: doc.data.originalSha256,
      invoiceSha256: sha256(doc.data.invoice),
      supplierId: doc.data.invoice.supplierId,
      currency: doc.data.invoice.currency,
      mediaType: doc.data.originalMediaType,
    });
    if (digest(await readFile(path.join(this.directory, "blobs", binding.originalSha256))) !== binding.originalSha256)
      throw new DomainError("original_blob_corrupt");
    return { doc, binding };
  }
  private async ceo(scope: Scope, id: string) {
    if ((await this.repo.snapshot(scope.companyId)).ceo.id !== id) throw new DomainError("ceo_required");
  }
  async correct(scope: Scope, voucherId: string, input: unknown) {
    const valid = correctionInputSchema.parse(input);
    if (valid.reuse && !valid.scopeDescription) throw new DomainError("rule_scope_required");
    const { doc, binding } = await this.source(scope, voucherId);
    const seal = await this.repo.getDocument<{ sealed: boolean }>(scope, "finance-classification-seal", voucherId);
    if (seal?.data.sealed || (await this.repo.getDocument(scope, "finance-voucher-export", voucherId)))
      throw new DomainError(
        "voucher_classification_locked",
        "Der Beleg ist bereits zur Übertragung gebunden. Eine nachträgliche Änderung benötigt einen eigenen abgeglichenen Korrekturvorgang.",
      );
    const actor = (await this.repo.snapshot(scope.companyId)).ceo.id;
    const correction = correctionRecordSchema.parse({
      ...valid,
      id: randomUUID(),
      scope,
      voucherId,
      binding,
      createdBy: actor,
      createdAt: this.now().toISOString(),
    });
    const mutations: Mutation[] = [
      {
        kind: "voucher",
        id: voucherId,
        data: {
          ...doc.data,
          classificationCorrectionIds: { ...doc.data.classificationCorrectionIds, [valid.field]: correction.id },
        },
        expectedRevision: doc.revision,
      },
      { kind: "voucher-correction", id: correction.id, data: correction, immutable: true },
      {
        kind: "finance-classification-seal",
        id: voucherId,
        data: { sealed: false, correctionId: correction.id },
        expectedRevision: seal?.revision ?? 0,
      },
    ];
    const ruleId = randomUUID();
    if (valid.reuse)
      mutations.push({
        kind: "finance-rule",
        id: ruleId,
        data: correctionRuleSchema.parse({
          ...correction,
          id: ruleId,
          correctionId: correction.id,
          version: 1,
          state: "proposed",
          scopeDescription: valid.scopeDescription!,
          explicitlyRequested: true,
        }),
        expectedRevision: 0,
      });
    await this.repo.transact(scope, mutations, { type: "finance.corrected", aggregateId: voucherId });
    return valid.reuse ? { ruleCreated: true, id: ruleId } : { ruleCreated: false };
  }
  async revise(scope: Scope, id: string, input: unknown, ceoId: string) {
    await this.ceo(scope, ceoId);
    const valid = z
      .object({ value: z.union([z.number(), z.string()]), source: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(input);
    const doc = await this.repo.getDocument<CorrectionRule>(scope, "finance-rule", id);
    if (!doc || !["active", "disabled"].includes(doc.data.state))
      throw new DomainError("correction_revision_unavailable");
    const original = correctionRuleSchema.parse(doc.data);
    changeSchema.parse({ field: original.field, value: valid.value });
    await this.validateSource(scope, original);
    const correction = correctionRecordSchema.parse({
      id: randomUUID(),
      scope,
      voucherId: original.voucherId,
      field: original.field,
      value: valid.value,
      source: valid.source,
      binding: original.binding,
      createdBy: ceoId,
      createdAt: this.now().toISOString(),
    });
    const rule = correctionRuleSchema.parse({
      ...correction,
      id: randomUUID(),
      correctionId: correction.id,
      version: original.version + 1,
      supersedesId: original.id,
      state: "proposed",
      scopeDescription: original.scopeDescription,
      explicitlyRequested: true,
    });
    await this.repo.transact(
      scope,
      [
        { kind: "voucher-correction", id: correction.id, data: correction, immutable: true },
        { kind: "finance-rule", id: rule.id, data: rule, expectedRevision: 0 },
        { kind: "finance-rule", id, data: original, expectedRevision: doc.revision },
      ],
      { type: "finance.correction_rule_revised", aggregateId: rule.id },
    );
    return rule;
  }
  private async validateSource(scope: Scope, rule: CorrectionRule) {
    const { binding } = await this.source(scope, rule.voucherId);
    if (sha256(binding) !== sha256(rule.binding)) throw new DomainError("correction_source_changed");
    const original = await this.repo.getDocument<Correction>(scope, "voucher-correction", rule.correctionId);
    if (
      !original ||
      original.data.voucherId !== rule.voucherId ||
      sha256(original.scope) !== sha256(scope) ||
      original.data.field !== rule.field ||
      original.data.value !== rule.value ||
      sha256(original.data.binding) !== sha256(rule.binding)
    )
      throw new DomainError("correction_source_mismatch");
  }
  private async noConflict(scope: Scope, rule: CorrectionRule) {
    for (const doc of await this.repo.listDocuments<CorrectionRule>(scope, "finance-rule")) {
      const prior = correctionRuleSchema.safeParse(doc.data);
      if (
        prior.success &&
        prior.data.id !== rule.id &&
        prior.data.id !== rule.supersedesId &&
        ["reviewed", "active"].includes(prior.data.state) &&
        conflictKey(prior.data) === conflictKey(rule)
      )
        throw new DomainError("correction_rules_overlap");
    }
  }
  async review(scope: Scope, id: string, reviewerId: string, evidence: string) {
    if (
      (await this.repo.snapshot(scope.companyId)).employees.find((employee) => employee.seedKey === "finance")?.id !==
      reviewerId
    )
      throw new DomainError("finance_lead_required");
    if (!evidence.trim()) throw new DomainError("review_evidence_required");
    const doc = await this.repo.getDocument<CorrectionRule>(scope, "finance-rule", id);
    if (!doc || doc.data.state !== "proposed") throw new DomainError("rule_not_proposed");
    const rule = correctionRuleSchema.parse(doc.data);
    await this.validateSource(scope, rule);
    await this.noConflict(scope, rule);
    return this.repo.putDocument(
      scope,
      "finance-rule",
      id,
      {
        ...rule,
        state: "reviewed",
        review: { reviewerId, evidence, at: this.now().toISOString(), fingerprint: ruleFingerprint(rule) },
      },
      { expectedRevision: doc.revision },
    );
  }
  async activate(scope: Scope, id: string, ceoId: string) {
    await this.ceo(scope, ceoId);
    const doc = await this.repo.getDocument<CorrectionRule>(scope, "finance-rule", id);
    if (!doc || doc.data.state !== "reviewed") throw new DomainError("finance_review_required");
    const rule = correctionRuleSchema.parse(doc.data);
    if (rule.review?.fingerprint !== ruleFingerprint(rule)) throw new DomainError("finance_review_required");
    await this.validateSource(scope, rule);
    await this.noConflict(scope, rule);
    const key = conflictKey(rule),
      head = await this.repo.getDocument<{ activeId: string | null }>(scope, "finance-correction-head", key);
    if (head?.data.activeId && head.data.activeId !== id && head.data.activeId !== rule.supersedesId)
      throw new DomainError("correction_rules_overlap");
    const predecessor = rule.supersedesId
      ? await this.repo.getDocument<CorrectionRule>(scope, "finance-rule", rule.supersedesId)
      : null;
    if (
      rule.supersedesId &&
      (!predecessor || conflictKey(predecessor.data) !== key || predecessor.data.version + 1 !== rule.version)
    )
      throw new DomainError("correction_predecessor_changed");
    const data = { ...rule, state: "active" as const, approvedBy: ceoId, approvedAt: this.now().toISOString() };
    await this.repo.transact(
      scope,
      [
        ...(predecessor
          ? [
              {
                kind: "finance-rule",
                id: predecessor.id,
                data: { ...predecessor.data, state: "disabled" },
                expectedRevision: predecessor.revision,
              },
            ]
          : []),
        { kind: "finance-rule", id, data, expectedRevision: doc.revision },
        { kind: "finance-correction-head", id: key, data: { activeId: id }, expectedRevision: head?.revision ?? 0 },
      ],
      { type: "finance.correction_rule_activated", aggregateId: id },
    );
    return data;
  }
  async disable(scope: Scope, id: string, ceoId: string) {
    await this.ceo(scope, ceoId);
    const doc = await this.repo.getDocument<CorrectionRule>(scope, "finance-rule", id);
    if (!doc) throw new DomainError("finance_rule_not_found");
    const rule = correctionRuleSchema.parse(doc.data),
      key = conflictKey(rule),
      head = await this.repo.getDocument<{ activeId: string | null }>(scope, "finance-correction-head", key);
    const mutations: Mutation[] = [
      { kind: "finance-rule", id, data: { ...rule, state: "disabled" }, expectedRevision: doc.revision },
    ];
    if (head?.data.activeId === id)
      mutations.push({
        kind: "finance-correction-head",
        id: key,
        data: { activeId: null },
        expectedRevision: head.revision,
      });
    await this.repo.transact(scope, mutations, { type: "finance.correction_rule_disabled", aggregateId: id });
    return { id, state: "disabled" as const };
  }
  async resolve(scope: Scope, voucherId: string, base: ProcessingRule) {
    const { doc, binding } = await this.source(scope, voucherId);
    const classification = classificationSchema.parse(Object.fromEntries(fields.map((field) => [field, base[field]])));
    const applied: {
      field: string;
      value: string | number;
      correctionId: string;
      ruleId?: string;
      ruleVersion?: number;
    }[] = [];
    const seen = new Set<string>();
    for (const stored of await this.repo.listDocuments<CorrectionRule>(scope, "finance-rule")) {
      const parsed = correctionRuleSchema.safeParse(stored.data);
      if (!parsed.success || parsed.data.state !== "active") continue;
      const rule = parsed.data;
      if (
        rule.binding.supplierId !== binding.supplierId ||
        rule.binding.currency !== binding.currency ||
        rule.binding.mediaType !== binding.mediaType
      )
        continue;
      if (!rule.approvedBy || rule.review?.fingerprint !== ruleFingerprint(rule))
        throw new DomainError("finance_review_required");
      await this.validateSource(scope, rule);
      if (sha256(rule.scope) !== sha256(scope)) throw new DomainError("scope_denied");
      if (seen.has(rule.field)) throw new DomainError("correction_rules_overlap");
      seen.add(rule.field);
      Object.assign(classification, { [rule.field]: rule.value });
      applied.push({
        field: rule.field,
        value: rule.value,
        correctionId: rule.correctionId,
        ruleId: rule.id,
        ruleVersion: rule.version,
      });
    }
    for (const field of fields) {
      const id = doc.data.classificationCorrectionIds?.[field];
      if (!id) continue;
      const stored = await this.repo.getDocument<Correction>(scope, "voucher-correction", id);
      if (!stored) throw new DomainError("correction_source_missing");
      const correction = correctionRecordSchema.parse(stored.data);
      if (
        correction.voucherId !== voucherId ||
        correction.field !== field ||
        sha256(correction.binding) !== sha256(binding)
      )
        throw new DomainError("correction_source_changed");
      Object.assign(classification, { [field]: correction.value });
      // A one-off correction deliberately takes precedence for this voucher alone.
      const prior = applied.findIndex((entry) => entry.field === field);
      if (prior >= 0) applied.splice(prior, 1);
      applied.push({ field, value: correction.value, correctionId: id });
    }
    return {
      classification: classificationSchema.parse(classification),
      applied,
      fingerprint: sha256({ binding, classification, applied }),
    };
  }
  async seal(scope: Scope, voucherId: string, fingerprint: string, voucherRevision: number) {
    const head = await this.repo.getDocument<{ sealed: boolean; fingerprint?: string }>(
      scope,
      "finance-classification-seal",
      voucherId,
    );
    if (head?.data.sealed) {
      if (head.data.fingerprint !== fingerprint) throw new DomainError("voucher_classification_changed");
      return;
    }
    const voucher = await this.repo.getDocument<Voucher>(scope, "voucher", voucherId);
    if (!voucher || voucher.revision !== voucherRevision) throw new DomainError("voucher_classification_changed");
    await this.repo.transact(
      scope,
      [
        {
          kind: "finance-classification-seal",
          id: voucherId,
          data: { sealed: true, fingerprint, at: this.now().toISOString() },
          expectedRevision: head?.revision ?? 0,
        },
        { kind: "voucher", id: voucherId, data: voucher.data, expectedRevision: voucher.revision },
      ],
      { type: "finance.classification_bound", aggregateId: voucherId },
    );
  }
}
