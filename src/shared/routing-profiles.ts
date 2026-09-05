import { z } from "zod";
export const ROUTING_PROFILE_KEYS = [
  "fast",
  "balanced",
  "deep_reasoning",
  "coding",
  "research",
  "legal_research",
  "finance",
  "vision",
  "long_context",
] as const;
export const ROUTING_CAPABILITIES = [
  "streaming",
  "toolCalls",
  "sessionResume",
  "subagents",
  "vision",
  "longContext",
] as const;
export const routeTargetSchema = z
  .object({
    vesselId: z.string().min(1).max(150),
    runtimeType: z.enum(["mock", "claude", "codex", "antigravity", "gemini", "openrouter"]),
    model: z.string().trim().min(1).max(200),
    vendorModel: z.string().trim().min(1).max(250),
  })
  .strict();
export const routingProfileSchema = z
  .object({
    key: z.enum(ROUTING_PROFILE_KEYS),
    label: z.string().trim().min(1).max(120),
    primary: routeTargetSchema.nullable(),
    fallbacks: z.array(routeTargetSchema).max(4),
    allowFallback: z.boolean(),
    allowedSensitivity: z
      .array(z.enum(["internal", "confidential"]))
      .min(1)
      .max(2),
    requiredCapabilities: z.array(z.enum(ROUTING_CAPABILITIES)).max(6),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (!profile.primary && profile.fallbacks.length)
      ctx.addIssue({ code: "custom", message: "Fallbacks require a primary route." });
    const keys = [...(profile.primary ? [profile.primary] : []), ...profile.fallbacks].map((t) => JSON.stringify(t));
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate routing targets." });
  });
export const routingConfigSchema = z
  .object({ version: z.literal(1), profiles: z.array(routingProfileSchema).length(9) })
  .strict()
  .superRefine((config, ctx) => {
    if (new Set(config.profiles.map((p) => p.key)).size !== ROUTING_PROFILE_KEYS.length)
      ctx.addIssue({ code: "custom", message: "Every routing profile must occur exactly once." });
  });
export type RouteTarget = z.infer<typeof routeTargetSchema>;
export type RoutingProfile = z.infer<typeof routingProfileSchema>;
export type RoutingConfig = z.infer<typeof routingConfigSchema>;
export interface RoutingSnapshot {
  revision: number;
  config: RoutingConfig;
  bindings: Array<{ agentId: string; profileKey: string }>;
  vessels: Array<{ id: string; key: string; label: string; runtime_provider: string; model: string }>;
  history: Array<{ revision: number; createdAt: number; createdBy: string }>;
}
