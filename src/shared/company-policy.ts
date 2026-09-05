/** Owner restrictions are an intersection with the operator's YAML policy, never a replacement. */
import { z } from "zod";
const selection = z
  .array(z.string().trim().min(1).max(200))
  .max(200)
  .refine((values) => new Set(values).size === values.length, "Auswahl darf keine Duplikate enthalten.");
export const companyPolicyRestrictionsSchema = z
  .object({
    allowedFamilies: selection,
    allowedProviders: selection,
  })
  .strict();
export const saveCompanyPolicySchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    baselineFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(10).max(1000),
    restrictions: companyPolicyRestrictionsSchema,
  })
  .strict();
export type CompanyPolicyRestrictions = z.infer<typeof companyPolicyRestrictionsSchema>;
export type SaveCompanyPolicyInput = z.infer<typeof saveCompanyPolicySchema>;
export interface CompanyEffectivePolicy {
  version: number;
  policy_name: string;
  allowed_families: string[];
  blocked_families: Array<{ id: string; reason: string; match: string[] }>;
  blocked_endpoints: Array<{ id: string; reason: string; match: string[] }>;
  openrouter: {
    allowed_providers: string[];
    allow_fallbacks: boolean;
    sensitive_defaults: { data_collection: "allow" | "deny"; zdr: boolean; allow_fallbacks: boolean };
  };
  telemetry: { enabled: boolean };
}
export interface CompanyPolicyRevision {
  revision: number;
  createdAt: number;
  createdBy: string;
  reason: string;
  baselineFingerprint: string;
  restrictions: CompanyPolicyRestrictions;
  correlationId: string;
  auditEventId: string;
}
export interface CompanyPolicySnapshot {
  revision: number;
  baselineFingerprint: string;
  baseline: CompanyPolicyRestrictions;
  restrictions: CompanyPolicyRestrictions;
  effectivePolicy: CompanyEffectivePolicy;
  history: CompanyPolicyRevision[];
}
