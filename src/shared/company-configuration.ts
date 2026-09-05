import { z } from "zod";

const keys = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_.:-]+$/),
  )
  .max(500)
  .refine((values) => new Set(values).size === values.length, "Doppelte Schlüssel sind nicht erlaubt.");
export const companyConfigurationSchema = z
  .object({
    version: z.literal(1),
    approvals: z.object({ additionalRequiredTypes: keys }).strict(),
    runtime: z
      .object({
        maxConcurrentRuns: z.number().int().min(1).max(64),
        maxRunTimeoutMs: z.number().int().min(1000).max(86400000),
      })
      .strict(),
    tools: z
      .object({
        blockedToolKeys: keys,
        requireApprovalForRiskClasses: z
          .array(z.enum(["read", "write", "external"]))
          .max(3)
          .refine((values) => new Set(values).size === values.length),
      })
      .strict(),
    memory: z
      .object({
        runContextEnabled: z.boolean(),
        maxContextEntries: z.number().int().min(1).max(30),
        semanticSearchEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type CompanyConfiguration = z.infer<typeof companyConfigurationSchema>;
export const saveCompanyConfigurationSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(10).max(1000),
    configuration: companyConfigurationSchema,
  })
  .strict();
export type SaveCompanyConfigurationInput = z.infer<typeof saveCompanyConfigurationSchema>;
export const DEFAULT_COMPANY_CONFIGURATION: CompanyConfiguration = {
  version: 1,
  approvals: { additionalRequiredTypes: [] },
  runtime: { maxConcurrentRuns: 64, maxRunTimeoutMs: 86400000 },
  tools: { blockedToolKeys: [], requireApprovalForRiskClasses: [] },
  memory: { runContextEnabled: true, maxContextEntries: 5, semanticSearchEnabled: true },
};
export interface CompanyConfigurationRevision {
  revision: number;
  configuration: CompanyConfiguration;
  reason: string;
  createdBy: string;
  createdAt: number;
  correlationId: string;
  auditEventId: string;
}
export interface CompanyConfigurationSnapshot {
  revision: number;
  configuration: CompanyConfiguration;
  history: CompanyConfigurationRevision[];
  constraints: { alwaysApprovalRequired: string[] };
  toolChoices: Array<{ key: string; label: string; riskClass: "read" | "write" | "external" }>;
  canEdit: boolean;
}

export const ALWAYS_APPROVAL_REQUIRED = [
  "bank_transfer",
  "tax_filing",
  "contract_execution",
  "legally_binding_statement",
  "external_customer_commitment",
  "pricing_or_discount_override",
  "production_deployment",
  "tier0_change",
  "irreversible_data_change",
  "secret_disclosure",
  "permission_change",
  "agent_lifecycle_change",
  "sandbox_elevation",
] as const;
