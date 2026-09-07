import { z } from "zod";
import { classificationSchema, correctionRuleSchema } from "../../../packages/domain/workflows/finance-corrections.ts";
import {
  processingRuleInputSchema,
  processingRuleSchema,
  reminderPolicyInputSchema,
  reminderPolicySchema,
  invoiceHoldSchema,
} from "../../../packages/domain/workflows/finance-automation.ts";
import { scopeSchema } from "../../../packages/contracts/src/index.ts";
import { document, object, id, date, text, json } from "./common.ts";
export {
  processingRuleInputSchema,
  processingRuleSchema,
  reminderPolicyInputSchema,
  reminderPolicySchema,
  invoiceHoldSchema,
};
export const automationStatusSchema = object({
  classification: classificationSchema.optional(),
  corrections: z
    .array(
      object({
        field: text,
        value: json,
        correctionId: id,
        ruleId: id.optional(),
        ruleVersion: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  classificationFingerprint: text.regex(/^[a-f0-9]{64}$/).optional(),
  id,
  at: date,
  voucherId: id.optional(),
  orderId: id.optional(),
  policyId: id.optional(),
  ruleId: id.optional(),
  ruleVersion: z.number().int().positive().optional(),
  targetId: id.optional(),
  externalId: text.optional(),
  state: text,
  reason: text.optional(),
  actionId: id.optional(),
});
export const invoiceHoldRecordSchema = invoiceHoldSchema.extend({ id, changedBy: id, changedAt: date });
export { correctionRuleSchema };
export const automationListSchema = object({
  processingRules: z.array(document(processingRuleSchema)),
  reminderPolicies: z.array(document(reminderPolicySchema)),
  statuses: z.array(document(automationStatusSchema)),
  holds: z.array(document(invoiceHoldRecordSchema)),
  corrections: z.array(document(correctionRuleSchema)),
});
export const disableResultSchema = object({ id, state: z.literal("disabled") });
export const activateReminderResultSchema = object({ id, state: z.literal("active") });
// Explicitly retained for consumers constructing scope-bound policy forms.
export const financeScopeSchema = scopeSchema;
