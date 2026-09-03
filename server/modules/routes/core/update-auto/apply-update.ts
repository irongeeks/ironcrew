import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { PKG_VERSION } from "../../../../config/runtime.ts";
import { parseSafeRestartCommand } from "../../update-auto-command.ts";
import { needsForceConfirmation, shouldSkipUpdateByGuards } from "../../update-auto-policy.ts";
import {
  computeVersionDeltaKind,
  isDeltaAllowedByChannel,
  type AutoUpdateChannel,
  type UpdateDeltaKind,
} from "../../update-auto-utils.ts";
import { tailText, type CommandCaptureResult } from "./command-capture.ts";

export type UpdateStatusPayload = {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string | null;
  checked_at: number;
  enabled: boolean;
  repo: string;
  error: string | null;
};

export type AutoUpdateRestartMode = "notify" | "exit" | "command";
export type UpdateApplyStatus = "applied" | "skipped" | "failed";

export type UpdateApplyResult = {
  status: UpdateApplyStatus;
  trigger: "manual" | "auto";
  dry_run: boolean;
  started_at: number;
  finished_at: number;
  current_version: string;
  latest_version: string | null;
  delta_kind: UpdateDeltaKind;
  channel: AutoUpdateChannel;
  reasons: string[];
  before_head: string | null;
  after_head: string | null;
  commands: Array<{ cmd: string; ok: boolean; code: number; stdout_tail: string; stderr_tail: string }>;
  restart: { mode: AutoUpdateRestartMode; scheduled: boolean; command?: string; scheduled_exit_at?: number };
  error: string | null;
};

type ApplyDeps = {
  AUTO_UPDATE_CHANNEL: AutoUpdateChannel;
  AUTO_UPDATE_IDLE_ONLY: boolean;
  AUTO_UPDATE_TARGET_BRANCH: string;
  AUTO_UPDATE_RESTART_MODE: AutoUpdateRestartMode;
  AUTO_UPDATE_RESTART_COMMAND: string;
  AUTO_UPDATE_EXIT_DELAY_MS: number;
  AUTO_UPDATE_TOTAL_TIMEOUT_MS: number;
  updateCommandTimeoutMs: { gitFetch: number; gitPull: number; pnpmInstall: number };
  activeProcesses: Map<string, unknown>;
  getInProgressTaskCount: () => number;
  fetchUpdateStatus: (forceRefresh?: boolean) => Promise<UpdateStatusPayload>;
  runCommandCapture: (cmd: string, args: string[], timeoutMs: number) => Promise<CommandCaptureResult>;
  logAutoUpdate: (message: string) => void;
  notifyCeo: (message: string, taskId: string | null, messageType?: string) => void;
  scheduleExit: (delayMs: number) => void;
};

export async function applyUpdateNow(
  deps: ApplyDeps,
  options: {
    trigger: "manual" | "auto";
    dryRun?: boolean;
    force?: boolean;
    forceConfirmed?: boolean;
  },
): Promise<UpdateApplyResult> {
  const {
    AUTO_UPDATE_CHANNEL,
    AUTO_UPDATE_IDLE_ONLY,
    AUTO_UPDATE_TARGET_BRANCH,
    AUTO_UPDATE_RESTART_MODE,
    AUTO_UPDATE_RESTART_COMMAND,
    AUTO_UPDATE_EXIT_DELAY_MS,
    AUTO_UPDATE_TOTAL_TIMEOUT_MS,
    updateCommandTimeoutMs,
    activeProcesses,
    getInProgressTaskCount,
    fetchUpdateStatus,
    runCommandCapture,
    logAutoUpdate,
    notifyCeo,
    scheduleExit,
  } = deps;

  const startedAt = Date.now();
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const forceConfirmed = Boolean(options.forceConfirmed);
  const reasons: string[] = [];
  const commands: UpdateApplyResult["commands"] = [];
  let beforeHead: string | null = null;
  let afterHead: string | null = null;
  let error: string | null = null;
  const addManualRecoveryReason = () => {
    if (!reasons.includes("manual_recovery_may_be_required")) {
      reasons.push("manual_recovery_may_be_required");
    }
  };
  const startedTickMs = performance.now();
  const elapsedMs = (): number => Math.max(0, performance.now() - startedTickMs);
  const remainingTimeout = (fallbackMs: number): number => {
    const remain = AUTO_UPDATE_TOTAL_TIMEOUT_MS - elapsedMs();
    return Math.max(1_000, Math.min(fallbackMs, remain));
  };
  const hasExceededTotalTimeout = (): boolean => elapsedMs() >= AUTO_UPDATE_TOTAL_TIMEOUT_MS;

  if (needsForceConfirmation(force, forceConfirmed)) {
    const finishedAt = Date.now();
    return {
      status: "skipped",
      trigger: options.trigger,
      dry_run: dryRun,
      started_at: startedAt,
      finished_at: finishedAt,
      current_version: PKG_VERSION,
      latest_version: null,
      delta_kind: "none",
      channel: AUTO_UPDATE_CHANNEL,
      reasons: ["force_confirmation_required"],
      before_head: null,
      after_head: null,
      commands: [],
      restart: {
        mode: AUTO_UPDATE_RESTART_MODE,
        scheduled: false,
        command: AUTO_UPDATE_RESTART_COMMAND || undefined,
      },
      error: null,
    };
  }

  const forceRefresh = options.trigger === "manual" && !dryRun;
  const status = await fetchUpdateStatus(forceRefresh);
  const deltaKind = computeVersionDeltaKind(PKG_VERSION, status.latest_version);

  if (!status.update_available) reasons.push("no_update_available");
  // Fail closed when channel enforcement needs release metadata but latest version is unavailable.
  if (AUTO_UPDATE_CHANNEL !== "all" && !status.latest_version) {
    reasons.push("channel_check_unavailable");
  }
  if (deltaKind !== "none" && !isDeltaAllowedByChannel(deltaKind, AUTO_UPDATE_CHANNEL)) {
    reasons.push(`channel_blocked:${deltaKind}`);
  }

  const branchRes = await runCommandCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], 10_000);
  const branchName = branchRes.stdout.trim();
  if (!branchRes.ok || !branchName) {
    reasons.push("git_branch_unknown");
  } else if (branchName !== AUTO_UPDATE_TARGET_BRANCH) {
    reasons.push(`branch_not_${AUTO_UPDATE_TARGET_BRANCH}:${branchName}`);
  }

  const remoteRes = await runCommandCapture("git", ["remote", "get-url", "origin"], 10_000);
  if (!remoteRes.ok || !remoteRes.stdout.trim()) {
    reasons.push("git_remote_origin_missing");
  }

  const dirtyRes = await runCommandCapture("git", ["status", "--porcelain"], 10_000);
  if (!dirtyRes.ok) {
    reasons.push("git_status_failed");
  } else if (dirtyRes.stdout.trim()) {
    reasons.push("dirty_worktree");
  }

  const inProgress = getInProgressTaskCount();
  if (AUTO_UPDATE_IDLE_ONLY && inProgress > 0) reasons.push(`busy_tasks:${inProgress}`);
  if (AUTO_UPDATE_IDLE_ONLY && activeProcesses.size > 0) reasons.push(`active_cli_processes:${activeProcesses.size}`);

  const skipByGuard = shouldSkipUpdateByGuards(reasons, force);
  if (skipByGuard || dryRun) {
    const finishedAt = Date.now();
    if (dryRun) reasons.push("dry_run");
    logAutoUpdate(`${options.trigger} check skipped (${reasons.join(",") || "no_reason"})`);
    return {
      status: "skipped",
      trigger: options.trigger,
      dry_run: dryRun,
      started_at: startedAt,
      finished_at: finishedAt,
      current_version: PKG_VERSION,
      latest_version: status.latest_version,
      delta_kind: deltaKind,
      channel: AUTO_UPDATE_CHANNEL,
      reasons,
      before_head: beforeHead,
      after_head: afterHead,
      commands,
      restart: {
        mode: AUTO_UPDATE_RESTART_MODE,
        scheduled: false,
        command: AUTO_UPDATE_RESTART_COMMAND || undefined,
      },
      error: null,
    };
  }

  const beforeRes = await runCommandCapture("git", ["rev-parse", "--short", "HEAD"], 10_000);
  beforeHead = beforeRes.ok ? beforeRes.stdout.trim() : null;

  if (hasExceededTotalTimeout()) {
    error = "update_total_timeout_exceeded";
    reasons.push("update_total_timeout_exceeded");
  }

  if (!error) {
    const fetchRes = await runCommandCapture(
      "git",
      ["fetch", "--tags", "--prune", "origin", AUTO_UPDATE_TARGET_BRANCH],
      remainingTimeout(updateCommandTimeoutMs.gitFetch),
    );
    commands.push({
      cmd: `git fetch --tags --prune origin ${AUTO_UPDATE_TARGET_BRANCH}`,
      ok: fetchRes.ok,
      code: fetchRes.code,
      stdout_tail: tailText(fetchRes.stdout),
      stderr_tail: tailText(fetchRes.stderr),
    });
    if (!fetchRes.ok) {
      logAutoUpdate("git fetch failed; repository state should be verified before retrying update");
      addManualRecoveryReason();
      error = "git_fetch_failed";
    }
  }

  if (!error) {
    if (hasExceededTotalTimeout()) {
      error = "update_total_timeout_exceeded";
      reasons.push("update_total_timeout_exceeded");
    } else {
      const pullRes = await runCommandCapture(
        "git",
        ["pull", "--ff-only", "origin", AUTO_UPDATE_TARGET_BRANCH],
        remainingTimeout(updateCommandTimeoutMs.gitPull),
      );
      commands.push({
        cmd: `git pull --ff-only origin ${AUTO_UPDATE_TARGET_BRANCH}`,
        ok: pullRes.ok,
        code: pullRes.code,
        stdout_tail: tailText(pullRes.stdout),
        stderr_tail: tailText(pullRes.stderr),
      });
      if (!pullRes.ok) {
        // fetch succeeded but pull failed: local repo may need manual recovery.
        logAutoUpdate("git pull failed after successful fetch; manual recovery may be required");
        addManualRecoveryReason();
        error = "git_pull_failed";
      }
    }
  }

  if (!error) {
    if (hasExceededTotalTimeout()) {
      error = "update_total_timeout_exceeded";
      reasons.push("update_total_timeout_exceeded");
    } else {
      const installRes = await runCommandCapture(
        "pnpm",
        ["install", "--frozen-lockfile"],
        remainingTimeout(updateCommandTimeoutMs.pnpmInstall),
      );
      commands.push({
        cmd: "pnpm install --frozen-lockfile",
        ok: installRes.ok,
        code: installRes.code,
        stdout_tail: tailText(installRes.stdout),
        stderr_tail: tailText(installRes.stderr),
      });
      if (!installRes.ok) error = "install_failed";
    }
  }

  if (!error && AUTO_UPDATE_RESTART_MODE === "notify") {
    reasons.push("manual_restart_required");
  }

  const afterRes = await runCommandCapture("git", ["rev-parse", "--short", "HEAD"], 10_000);
  afterHead = afterRes.ok ? afterRes.stdout.trim() : null;

  const finishedAt = Date.now();
  const applied = !error;
  const restart: UpdateApplyResult["restart"] = {
    mode: AUTO_UPDATE_RESTART_MODE,
    scheduled: false,
    command: AUTO_UPDATE_RESTART_COMMAND || undefined,
  };

  if (applied) {
    if (options.trigger === "auto") {
      const summary = `[Auto Update] applied ${beforeHead || "?"} -> ${afterHead || "?"} (latest=${status.latest_version || "unknown"}, mode=${AUTO_UPDATE_RESTART_MODE})`;
      try {
        notifyCeo(summary, null, "status_update");
      } catch {
        /* ignore */
      }
    }

    if (AUTO_UPDATE_RESTART_MODE === "exit") {
      // Best-effort delayed graceful exit. Prefer running under a process manager.
      logAutoUpdate(`restart mode=exit scheduled (delay_ms=${AUTO_UPDATE_EXIT_DELAY_MS})`);
      restart.scheduled = true;
      restart.scheduled_exit_at = Date.now() + AUTO_UPDATE_EXIT_DELAY_MS;
      scheduleExit(AUTO_UPDATE_EXIT_DELAY_MS);
    } else if (AUTO_UPDATE_RESTART_MODE === "command" && AUTO_UPDATE_RESTART_COMMAND) {
      const parsed = parseSafeRestartCommand(AUTO_UPDATE_RESTART_COMMAND);
      if (!parsed) {
        logAutoUpdate("restart mode=command rejected (unsafe command format)");
        restart.scheduled = false;
      } else {
        logAutoUpdate(`restart mode=command executing ${parsed.cmd} (args=${parsed.args.length})`);
        try {
          const child = spawn(parsed.cmd, parsed.args, {
            cwd: process.cwd(),
            shell: false,
            detached: true,
            stdio: "ignore",
          });
          // `restart.scheduled` reflects spawn-time acceptance only.
          // Post-spawn failures are logged asynchronously below.
          child.once("error", (err) => {
            logAutoUpdate(
              `restart mode=command process error for ${parsed.cmd}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          child.once("exit", (code, signal) => {
            if (code !== 0) {
              logAutoUpdate(
                `restart mode=command process for ${parsed.cmd} exited with code=${code}${signal ? ` signal=${signal}` : ""}`,
              );
            }
          });
          child.unref();
          restart.scheduled = true;
        } catch (err) {
          restart.scheduled = false;
          logAutoUpdate(
            `restart mode=command failed to spawn ${parsed.cmd}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  logAutoUpdate(
    `${options.trigger} apply ${applied ? "completed" : "failed"} (${beforeHead || "?"}->${afterHead || "?"}${error ? `, error=${error}` : ""})`,
  );

  return {
    status: applied ? "applied" : "failed",
    trigger: options.trigger,
    dry_run: false,
    started_at: startedAt,
    finished_at: finishedAt,
    current_version: PKG_VERSION,
    latest_version: status.latest_version,
    delta_kind: deltaKind,
    channel: AUTO_UPDATE_CHANNEL,
    reasons,
    before_head: beforeHead,
    after_head: afterHead,
    commands,
    restart,
    error,
  };
}
