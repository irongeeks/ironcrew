import { describe, expect, it } from "vitest";
import { needsForceConfirmation, parseAutoUpdateChannel, shouldSkipUpdateByGuards } from "./update-auto-policy.ts";

describe("update auto policy", () => {
  it("parses AUTO_UPDATE_CHANNEL with invalid-value warning", () => {
    expect(parseAutoUpdateChannel("minor")).toEqual({ channel: "minor", warning: null });
    expect(parseAutoUpdateChannel("bad-value")).toEqual({
      channel: "patch",
      warning: 'invalid AUTO_UPDATE_CHANNEL value "bad-value", fallback to "patch"',
    });
    expect(parseAutoUpdateChannel(undefined)).toEqual({ channel: "patch", warning: null });
  });

  it("enforces non-overridable guards", () => {
    expect(shouldSkipUpdateByGuards(["dirty_worktree"], true)).toBe(true);
    expect(shouldSkipUpdateByGuards(["dirty_worktree"], false)).toBe(true);
    expect(shouldSkipUpdateByGuards(["git_remote_origin_missing"], true)).toBe(true);
    expect(shouldSkipUpdateByGuards(["git_status_failed"], true)).toBe(true);
    expect(shouldSkipUpdateByGuards(["channel_blocked:minor"], true)).toBe(true);
    expect(shouldSkipUpdateByGuards(["channel_check_unavailable"], true)).toBe(true);
  });

  it("allows force when only no-update guard is present", () => {
    expect(shouldSkipUpdateByGuards(["no_update_available"], true)).toBe(false);
    expect(shouldSkipUpdateByGuards(["no_update_available"], false)).toBe(true);
  });

  it("allows force to bypass overridable guards only", () => {
    expect(shouldSkipUpdateByGuards(["busy_tasks:1"], true)).toBe(false);
    expect(shouldSkipUpdateByGuards(["busy_tasks:1"], false)).toBe(true);
    expect(shouldSkipUpdateByGuards(["branch_not_main:develop"], true)).toBe(false);
    expect(shouldSkipUpdateByGuards(["branch_not_main:develop"], false)).toBe(true);
    expect(shouldSkipUpdateByGuards([], false)).toBe(false);
  });

  it("requires explicit force confirmation", () => {
    expect(needsForceConfirmation(true, false)).toBe(true);
    expect(needsForceConfirmation(true, true)).toBe(false);
    expect(needsForceConfirmation(false, false)).toBe(false);
    expect(needsForceConfirmation(false, true)).toBe(false);
  });
});
