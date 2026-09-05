import path from "node:path";
import { z } from "zod";
import type { AuthStatus, RuntimeCapabilities, RuntimeHealth, RunContext } from "../../runtime/run-events.ts";

export const enrollmentSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    workspaceRoot: z
      .string()
      .min(2)
      .max(4096)
      .refine(
        (p) => path.isAbsolute(p) && path.resolve(p) !== path.parse(p).root,
        "Absolute non-root workspace required",
      ),
    runtimeTypes: z
      .array(z.enum(["claude", "codex", "antigravity", "openrouter", "mock"]))
      .min(1)
      .max(8),
    projectIds: z.array(z.string().min(1).max(200)).max(100).default([]),
    allowUnscoped: z.boolean().default(false),
    maxConcurrent: z.number().int().min(1).max(32).default(1),
    priority: z.number().int().min(-100).max(100).default(0),
    ttlSeconds: z.number().int().min(30).max(900).default(600),
  })
  .strict();
export type EnrollmentInput = z.input<typeof enrollmentSchema>;
export interface RuntimeDescriptor {
  type: string;
  capabilities: RuntimeCapabilities;
  health: RuntimeHealth;
  auth: AuthStatus;
}
export const descriptorSchema = z
  .object({
    type: z.string().min(1).max(80),
    capabilities: z
      .object({
        workspaceRequired: z.boolean().optional(),
        streaming: z.boolean(),
        sessionResume: z.boolean(),
        usageReporting: z.boolean(),
        costReporting: z.boolean(),
        toolCalls: z.boolean(),
        subagents: z.boolean(),
        defaultConcurrency: z.number().int().min(1).max(128),
        version: z.string().max(100).optional(),
      })
      .strict(),
    health: z
      .object({ healthy: z.boolean(), installed: z.boolean(), detail: z.string().max(2000), checkedAt: z.number() })
      .strict(),
    auth: z
      .object({
        authenticated: z.boolean(),
        verification: z.enum(["verified", "unverified"]).optional(),
        method: z.enum(["subscription-cli", "oauth-cli", "api-key", "none"]),
        accountHint: z.string().max(200).optional(),
        detail: z.string().max(2000),
        setupHint: z.string().max(2000).optional(),
      })
      .strict(),
  })
  .strict();
export interface FleetWorker {
  id: string;
  companyId: string;
  label: string;
  workspaceRoot: string;
  runtimeTypes: string[];
  projectIds: string[];
  allowUnscoped: boolean;
  maxConcurrent: number;
  priority: number;
  state: "offline" | "online" | "revoked";
  generation: number;
  lastSeenAt: number | null;
  credentialExpiresAt: number | null;
  activeLeases: number;
  runtimes: RuntimeDescriptor[];
}
export interface FleetLease {
  id: string;
  worker_id: string;
  company_id: string;
  project_id: string | null;
  task_id: string;
  run_id: string;
  generation: number;
  state: "active" | "completed" | "lost" | "revoked";
  expires_at: number;
  created_at: number;
  ended_at: number | null;
}
export function permitsContext(
  worker: Pick<FleetWorker, "companyId" | "projectIds" | "allowUnscoped" | "workspaceRoot" | "runtimeTypes">,
  type: string,
  context: Pick<RunContext, "companyId" | "projectId" | "workspacePath">,
): boolean {
  if (worker.companyId !== context.companyId || !worker.runtimeTypes.includes(type)) return false;
  if (context.projectId ? !worker.projectIds.includes(context.projectId) : !worker.allowUnscoped) return false;
  if (!context.workspacePath) return true;
  if (!context.projectId || !path.isAbsolute(context.workspacePath)) return false;
  const relative = path.relative(worker.workspaceRoot, context.workspacePath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
