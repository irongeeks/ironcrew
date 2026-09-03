/**
 * Iron Command OS — Vendor policy enforcement.
 *
 * Loads `config/vendor-policy.yaml` and decides whether a given model /
 * provider combination may be used.
 *
 * Design rules (see docs/THREAT_MODEL.md):
 *  - Deny by default. A model that matches no allowed family is rejected.
 *  - Blocklist wins over allowlist, always.
 *  - Matching is done on a normalised id so that re-hosted or aliased
 *    variants ("openrouter/deepseek-chat", "Qwen2.5-72B-Instruct") are caught.
 *  - This module is the ONLY place that answers "may I use this model?".
 *    Callers must not re-implement the check.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";

const blockedFamilySchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  match: z.array(z.string().min(1)).min(1),
});

const blockedEndpointSchema = blockedFamilySchema;

export const vendorPolicySchema = z.object({
  version: z.number().int().positive(),
  policy_name: z.string().min(1),
  allowed_families: z.array(z.string().min(1)),
  blocked_families: z.array(blockedFamilySchema),
  openrouter: z.object({
    allowed_providers: z.array(z.string().min(1)),
    allow_fallbacks: z.boolean(),
    sensitive_defaults: z.object({
      data_collection: z.enum(["allow", "deny"]),
      zdr: z.boolean(),
      allow_fallbacks: z.boolean(),
    }),
  }),
  blocked_endpoints: z.array(blockedEndpointSchema).default([]),
  telemetry: z.object({ enabled: z.boolean() }),
});

export type VendorPolicy = z.infer<typeof vendorPolicySchema>;
export type BlockedFamily = z.infer<typeof blockedFamilySchema>;

export interface PolicyDecision {
  allowed: boolean;
  /** Stable machine-readable reason code, suitable for audit events. */
  code: "allowed" | "blocked_family" | "not_in_allowlist" | "empty_model";
  /** Human-readable reason, safe to show in the UI. */
  reason: string;
  /** Which blocklist entry matched, when code === "blocked_family". */
  matchedRule?: string;
}

/**
 * Normalise a model identifier for matching.
 * Lowercases, trims, and collapses separators that vendors use
 * interchangeably (":" and "_" behave like "-").
 */
export function normaliseModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/[_:]/g, "-");
}

/**
 * Match a normalised id against a family pattern such as "openai/*".
 * "*" matches one or more characters inside a single "/"-delimited segment.
 */
function matchesFamily(normalisedId: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]+");
  return new RegExp(`^${escaped}$`).test(normalisedId);
}

/**
 * Decide whether `modelId` may be used.
 *
 * `provider` is an optional upstream provider/host name. It is checked
 * against the blocklist too, so routing a permitted-looking model through a
 * blocked host is still denied.
 */
export function evaluateModel(policy: VendorPolicy, modelId: string, provider?: string): PolicyDecision {
  const normalised = normaliseModelId(modelId ?? "");
  if (!normalised) {
    return {
      allowed: false,
      code: "empty_model",
      reason: "No model id was supplied; vendor policy denies empty selections.",
    };
  }

  const haystacks = [normalised];
  if (provider && provider.trim()) haystacks.push(normaliseModelId(provider));

  // 1. Blocklist always wins.
  for (const family of policy.blocked_families) {
    for (const needle of family.match) {
      const n = normaliseModelId(needle);
      if (haystacks.some((h) => h.includes(n))) {
        return {
          allowed: false,
          code: "blocked_family",
          reason: family.reason,
          matchedRule: family.id,
        };
      }
    }
  }

  // 2. Allowlist. Deny by default.
  const allowed = policy.allowed_families.some((p) => matchesFamily(normalised, p));
  if (!allowed) {
    return {
      allowed: false,
      code: "not_in_allowlist",
      reason:
        `Model "${modelId}" matches no allowed vendor family. ` + `Allowed: ${policy.allowed_families.join(", ")}.`,
    };
  }

  return { allowed: true, code: "allowed", reason: "Model permitted by vendor policy." };
}

/** Thrown when a denied model reaches an execution path. */
export class VendorPolicyError extends Error {
  readonly decision: PolicyDecision;
  readonly modelId: string;
  constructor(modelId: string, decision: PolicyDecision) {
    super(`Vendor policy denied model "${modelId}": ${decision.reason}`);
    this.name = "VendorPolicyError";
    this.decision = decision;
    this.modelId = modelId;
  }
}

/** Throwing variant used at execution boundaries. */
export function assertModelAllowed(policy: VendorPolicy, modelId: string, provider?: string): void {
  const decision = evaluateModel(policy, modelId, provider);
  if (!decision.allowed) throw new VendorPolicyError(modelId, decision);
}

/** Filter a dynamically fetched model catalogue down to permitted entries. */
export function filterModelCatalogue<T extends { id: string; provider?: string }>(
  policy: VendorPolicy,
  models: readonly T[],
): { allowed: T[]; denied: Array<{ model: T; decision: PolicyDecision }> } {
  const allowedModels: T[] = [];
  const denied: Array<{ model: T; decision: PolicyDecision }> = [];
  for (const model of models) {
    const decision = evaluateModel(policy, model.id, model.provider);
    if (decision.allowed) allowedModels.push(model);
    else denied.push({ model, decision });
  }
  return { allowed: allowedModels, denied };
}

/** Check an outbound URL/host against the blocked-endpoint list. */
export function evaluateEndpoint(policy: VendorPolicy, target: string): PolicyDecision {
  const normalised = normaliseModelId(target ?? "");
  if (!normalised) {
    return { allowed: false, code: "empty_model", reason: "No endpoint supplied." };
  }
  for (const rule of policy.blocked_endpoints) {
    for (const needle of rule.match) {
      if (normalised.includes(normaliseModelId(needle))) {
        return {
          allowed: false,
          code: "blocked_family",
          reason: rule.reason,
          matchedRule: rule.id,
        };
      }
    }
  }
  return { allowed: true, code: "allowed", reason: "Endpoint permitted by vendor policy." };
}

/**
 * Build the OpenRouter `provider` routing block for a request.
 * Sensitive tasks additionally pin data_collection/zdr.
 */
export function buildOpenRouterProviderPolicy(
  policy: VendorPolicy,
  opts: { sensitive?: boolean } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    order: [...policy.openrouter.allowed_providers],
    only: [...policy.openrouter.allowed_providers],
    allow_fallbacks: policy.openrouter.allow_fallbacks,
  };
  if (opts.sensitive) {
    const s = policy.openrouter.sensitive_defaults;
    base.data_collection = s.data_collection;
    base.zdr = s.zdr;
    base.allow_fallbacks = s.allow_fallbacks;
  }
  return base;
}

export function parseVendorPolicy(raw: unknown): VendorPolicy {
  return vendorPolicySchema.parse(raw);
}

export function loadVendorPolicyFromFile(filePath: string): VendorPolicy {
  const text = readFileSync(filePath, "utf8");
  return parseVendorPolicy(parseYaml(text));
}

export function defaultVendorPolicyPath(): string {
  return path.resolve(process.cwd(), "config", "vendor-policy.yaml");
}

let cached: VendorPolicy | null = null;

/** Process-wide policy singleton. Fails loudly if the config is invalid. */
export function getVendorPolicy(): VendorPolicy {
  if (!cached) cached = loadVendorPolicyFromFile(defaultVendorPolicyPath());
  return cached;
}

/** Test seam: drop the cached policy. */
export function resetVendorPolicyCache(): void {
  cached = null;
}
