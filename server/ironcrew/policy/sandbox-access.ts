import path from "node:path";
import { z } from "zod";
import { MAX_SANDBOX_GRANT_MS } from "./runtime-permissions.ts";

export const SANDBOX_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export const sandboxAccessRequestSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    provider: z.enum(SANDBOX_PROVIDERS),
    durationMs: z.number().int().min(60_000).max(MAX_SANDBOX_GRANT_MS),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();
export type SandboxAccessRequest = z.infer<typeof sandboxAccessRequestSchema>;
export const sandboxActionSchema = sandboxAccessRequestSchema
  .extend({
    kind: z.literal("sandbox_elevation"),
    version: z.literal(1),
    companyId: z.string().min(1),
    projectId: z.string().min(1),
    agentId: z.string().min(1),
    workspacePath: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root),
    maxRuns: z.literal(1),
  })
  .strict();
export type SandboxAction = z.infer<typeof sandboxActionSchema>;
export function readSandboxAction(serialized: string): SandboxAction | null {
  try {
    const parsed = sandboxActionSchema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
