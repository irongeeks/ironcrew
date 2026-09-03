import type { AutoUpdateChannel } from "./update-auto-utils.ts";

export function parseAutoUpdateChannel(rawEnv: unknown): { channel: AutoUpdateChannel; warning: string | null } {
  const raw = String(rawEnv ?? "patch")
    .trim()
    .toLowerCase();
  if (raw === "patch" || raw === "minor" || raw === "all") {
    return { channel: raw as AutoUpdateChannel, warning: null };
  }
  if (rawEnv !== undefined && String(rawEnv).trim() !== "") {
    return {
      channel: "patch",
      warning: `invalid AUTO_UPDATE_CHANNEL value "${String(rawEnv)}", fallback to "patch"`,
    };
  }
  return { channel: "patch", warning: null };
}

export function shouldSkipUpdateByGuards(reasons: string[], force: boolean): boolean {
  // Branch mismatch / busy-state reasons remain overridable when force=true.
  const hasNonOverridableGuard =
    reasons.includes("dirty_worktree") ||
    reasons.includes("git_remote_origin_missing") ||
    reasons.includes("git_status_failed") ||
    reasons.includes("channel_check_unavailable") ||
    reasons.some((reason) => reason.startsWith("channel_blocked:"));
  return hasNonOverridableGuard || (reasons.length > 0 && !force);
}

export function needsForceConfirmation(force: boolean, forceConfirmed: boolean): boolean {
  return force && !forceConfirmed;
}
