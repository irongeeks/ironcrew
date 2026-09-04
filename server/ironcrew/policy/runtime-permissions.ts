/**
 * IronCrew — CLI runtime permission policy.
 *
 * Upstream OctoOffice hardcoded `--dangerously-skip-permissions` (Claude Code)
 * and `--yolo` (Codex, Gemini) into every invocation, so every agent ran with
 * an unbounded capability surface. docs/THREAT_MODEL.md T-01 covers the impact.
 *
 * This module makes elevation an explicit, expiring, owner-approved decision:
 *
 *   restricted        default. Read-only / plan-only. No destructive tool use.
 *   workspace_write   may edit files inside its assigned workspace.
 *   elevated          the dangerous flags. Requires a valid SandboxGrant.
 *
 * `resolvePermissionMode()` is the only way to reach `elevated`, and it fails
 * closed: a missing, expired, mis-scoped or unapproved grant yields
 * `restricted`, never an error that a caller might swallow.
 *
 * NOTE ON FLAG NAMES: the argv fragments below are the flags published by the
 * respective CLIs at the time of writing. Runtimes must still capability-detect
 * (`--help`) before use rather than assuming a flag exists; see
 * docs/PROVIDER_AUTH.md. Detection is a runtime concern, policy is this module.
 */

import { z } from "zod";

export const PERMISSION_MODES = ["restricted", "workspace_write", "elevated"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Maximum lifetime of a sandbox grant, regardless of what the caller asks for. */
export const MAX_SANDBOX_GRANT_MS = 4 * 60 * 60 * 1000; // 4 hours

export const sandboxGrantSchema = z.object({
  grantId: z.string().min(1),
  companyId: z.string().min(1),
  /** Owner/CEO who approved the elevation. */
  approvedBy: z.string().min(1),
  /** The ApprovalRequest this grant was minted from — required for audit. */
  approvalId: z.string().min(1),
  reason: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  /** Runtime providers this grant covers, e.g. ["claude"]. */
  providers: z.array(z.string().min(1)).min(1),
  /** When set, the grant only applies to this single task. */
  taskId: z.string().min(1).optional(),
  /** When set, the grant only applies inside this workspace path. */
  workspacePath: z.string().min(1).optional(),
});

export type SandboxGrant = z.infer<typeof sandboxGrantSchema>;

export interface PermissionResolution {
  mode: PermissionMode;
  /** Machine-readable reason, recorded on the run and in the audit log. */
  code:
    | "default_restricted"
    | "granted_elevated"
    | "workspace_write_requested"
    | "grant_expired"
    | "grant_provider_mismatch"
    | "grant_task_mismatch"
    | "grant_company_mismatch"
    | "grant_invalid";
  reason: string;
  /** Populated only when mode === "elevated". */
  grantId?: string;
}

export interface ResolveInput {
  provider: string;
  companyId: string;
  taskId?: string;
  /** What the caller would like. Never sufficient on its own for elevation. */
  requested?: PermissionMode;
  grant?: SandboxGrant | null;
  now?: number;
}

/**
 * Decide the effective permission mode. Fails closed to "restricted".
 */
export function resolvePermissionMode(input: ResolveInput): PermissionResolution {
  const now = input.now ?? Date.now();
  const requested = input.requested ?? "restricted";

  if (requested !== "elevated") {
    if (requested === "workspace_write") {
      return {
        mode: "workspace_write",
        code: "workspace_write_requested",
        reason: "Agent may write inside its assigned workspace only.",
      };
    }
    return {
      mode: "restricted",
      code: "default_restricted",
      reason: "Default restricted mode; no elevation requested.",
    };
  }

  // Elevation requested — every check below must pass.
  const parsed = sandboxGrantSchema.safeParse(input.grant);
  if (!parsed.success) {
    return {
      mode: "restricted",
      code: "grant_invalid",
      reason: "Elevation requested without a valid sandbox grant; denied.",
    };
  }
  const grant = parsed.data;

  if (grant.companyId !== input.companyId) {
    return {
      mode: "restricted",
      code: "grant_company_mismatch",
      reason: "Sandbox grant belongs to a different company; denied.",
    };
  }

  const hardExpiry = Math.min(grant.expiresAt, grant.issuedAt + MAX_SANDBOX_GRANT_MS);
  if (now >= hardExpiry) {
    return {
      mode: "restricted",
      code: "grant_expired",
      reason: "Sandbox grant has expired; elevation denied.",
    };
  }

  const provider = input.provider.trim().toLowerCase();
  if (!grant.providers.map((p) => p.trim().toLowerCase()).includes(provider)) {
    return {
      mode: "restricted",
      code: "grant_provider_mismatch",
      reason: `Sandbox grant does not cover runtime "${input.provider}"; denied.`,
    };
  }

  if (grant.taskId && grant.taskId !== input.taskId) {
    return {
      mode: "restricted",
      code: "grant_task_mismatch",
      reason: "Sandbox grant is scoped to a different task; denied.",
    };
  }

  return {
    mode: "elevated",
    code: "granted_elevated",
    reason: `Elevated by ${grant.approvedBy} under approval ${grant.approvalId}: ${grant.reason}`,
    grantId: grant.grantId,
  };
}

/**
 * Per-provider argv fragment for a permission mode.
 * Returns argv tokens only — never a shell string.
 */
export function permissionArgsFor(provider: string, mode: PermissionMode): string[] {
  switch (provider.trim().toLowerCase()) {
    case "claude":
      // Claude Code: only the elevated mode gets the skip-permissions flag.
      // Restricted relies on the CLI's own default prompting/deny behaviour.
      return mode === "elevated" ? ["--dangerously-skip-permissions"] : [];
    case "codex":
      if (mode === "elevated") return ["--yolo"];
      if (mode === "workspace_write") return ["--sandbox", "workspace-write"];
      return ["--sandbox", "read-only"];
    case "gemini":
      if (mode === "elevated") return ["--approval-mode", "yolo"];
      if (mode === "workspace_write") return ["--approval-mode", "auto_edit"];
      return ["--approval-mode", "default"];
    case "antigravity":
      // agy documents exactly two levels on the command line: its default
      // ("request-review", which in headless mode means nothing gets
      // approved) and --dangerously-skip-permissions ("always-proceed").
      // Finer rules live in its own settings.json, not in argv. So the two
      // non-elevated modes deliberately produce the same flags — inventing a
      // middle flag that does not exist would read as policy and enforce
      // nothing.
      if (mode === "elevated") return ["--dangerously-skip-permissions"];
      return ["--sandbox"];
    default:
      return [];
  }
}

/** True when the argv contains a flag that bypasses runtime permission checks. */
export function containsDangerousFlag(args: readonly string[]): boolean {
  return args.some((a) => {
    const t = a.trim().toLowerCase();
    return (
      t === "--dangerously-skip-permissions" ||
      t === "--yolo" ||
      t === "--dangerously-bypass-approvals-and-sandbox" ||
      t === "yolo" ||
      t === "--sandbox=danger-full-access"
    );
  });
}

/**
 * Guard applied immediately before spawn. Throws when argv carries a dangerous
 * flag that the resolved mode does not authorise — this is the last line of
 * defence against a caller assembling argv by hand.
 */
export class PermissionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionPolicyError";
  }
}

export function assertArgsMatchMode(args: readonly string[], mode: PermissionMode): void {
  if (mode !== "elevated" && containsDangerousFlag(args)) {
    throw new PermissionPolicyError(
      `Refusing to spawn: argv contains a permission-bypass flag but the resolved ` +
        `permission mode is "${mode}". An owner-approved, unexpired sandbox grant is required.`,
    );
  }
}

/** Clamp a requested expiry to the policy maximum. */
export function clampGrantExpiry(issuedAt: number, requestedExpiry: number): number {
  return Math.min(requestedExpiry, issuedAt + MAX_SANDBOX_GRANT_MS);
}
