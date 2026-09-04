import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import type { UtilContext } from "../../../../types/runtime-context-domains.ts";
import { PKG_VERSION } from "../../../../config/runtime.ts";
import { isAuthenticated } from "../../../../security/auth.ts";
import { isRemoteVersionNewer, normalizeVersionTag, type AutoUpdateChannel } from "../../update-auto-utils.ts";
import { parseAutoUpdateChannel } from "../../update-auto-policy.ts";
import { createAutoUpdateLock } from "../../update-auto-lock.ts";
import { createCommandCaptureTools } from "./command-capture.ts";
import { toErrorMessage } from "../../validation.ts";
import {
  applyUpdateNow,
  type AutoUpdateRestartMode,
  type UpdateApplyResult,
  type UpdateStatusPayload,
} from "./apply-update.ts";
import { logger } from "../../../../observability/logger.ts";

const log = logger.child({ module: "core" });

interface UpdateAutoRouteBaseDeps {
  app: Express;
  db: DatabaseSync;
  dbPath: string;
  activeProcesses: Map<string, ChildProcess>;
}

export function registerUpdateAutoRoutes(base: UpdateAutoRouteBaseDeps, util: UtilContext): void {
  const { app, db, dbPath, activeProcesses } = base;
  const appendTaskLog = util.appendTaskLog;
  const notifyCeo = util.notifyCeo;
  const readSettingString = util.readSettingString;
  const killPidTree = util.killPidTree;

  const UPDATE_CHECK_ENABLED = String(process.env.UPDATE_CHECK_ENABLED ?? "1").trim() !== "0";
  // Where this build looks for a newer release.
  //
  // Not a mechanical rename: this is a GitHub repository slug, and turning
  // "Chepko932/OctoOffice" into "Chepko932/IronCrew" names a repository that
  // does not exist, so every update check would 404 while looking like it had
  // simply found nothing. It now points at the repository that actually ships
  // this product. An installation tracking a different fork sets
  // UPDATE_CHECK_REPO and is unaffected either way.
  const UPDATE_CHECK_REPO = String(process.env.UPDATE_CHECK_REPO ?? "irongeeks/ironcrew").trim();
  const UPDATE_CHECK_TTL_MS = Math.max(
    60_000,
    Number(process.env.UPDATE_CHECK_TTL_MS ?? 30 * 60 * 1000) || 30 * 60 * 1000,
  );
  const UPDATE_CHECK_TIMEOUT_MS = Math.max(1_000, Number(process.env.UPDATE_CHECK_TIMEOUT_MS ?? 4_000) || 4_000);

  let updateStatusCache: UpdateStatusPayload | null = null;
  let updateStatusCachedAt = 0;
  let updateStatusInFlight: Promise<UpdateStatusPayload> | null = null;

  const AUTO_UPDATE_DEFAULT_ENABLED = String(process.env.AUTO_UPDATE_ENABLED ?? "0").trim() === "1";
  const AUTO_UPDATE_ENABLED_SETTING_KEY = "autoUpdateEnabled";
  const parsedAutoUpdateChannel = parseAutoUpdateChannel(process.env.AUTO_UPDATE_CHANNEL);
  const AUTO_UPDATE_CHANNEL = parsedAutoUpdateChannel.channel;
  if (parsedAutoUpdateChannel.warning) {
    log.warn({ warning: parsedAutoUpdateChannel.warning }, "auto-update channel warning");
  }
  const AUTO_UPDATE_IDLE_ONLY = String(process.env.AUTO_UPDATE_IDLE_ONLY ?? "1").trim() !== "0";
  const AUTO_UPDATE_CHECK_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.AUTO_UPDATE_CHECK_INTERVAL_MS ?? UPDATE_CHECK_TTL_MS) || UPDATE_CHECK_TTL_MS,
  );
  // Delay before first automatic update check after startup (AUTO_UPDATE_INITIAL_DELAY_MS, default/minimum 60s).
  const AUTO_UPDATE_INITIAL_DELAY_MS = Math.max(
    60_000,
    Number(process.env.AUTO_UPDATE_INITIAL_DELAY_MS ?? 60_000) || 60_000,
  );
  const AUTO_UPDATE_TARGET_BRANCH = String(process.env.AUTO_UPDATE_TARGET_BRANCH ?? "main").trim() || "main";
  const AUTO_UPDATE_RESTART_MODE = (() => {
    const raw = String(process.env.AUTO_UPDATE_RESTART_MODE ?? "notify")
      .trim()
      .toLowerCase();
    if (raw === "exit" || raw === "command") return raw as AutoUpdateRestartMode;
    return "notify";
  })();
  const AUTO_UPDATE_RESTART_COMMAND = String(process.env.AUTO_UPDATE_RESTART_COMMAND ?? "").trim();
  const AUTO_UPDATE_EXIT_DELAY_MS = Math.max(1_200, Number(process.env.AUTO_UPDATE_EXIT_DELAY_MS ?? 10_000) || 10_000);
  const AUTO_UPDATE_TOTAL_TIMEOUT_MS = Math.max(
    60_000,
    Number(process.env.AUTO_UPDATE_TOTAL_TIMEOUT_MS ?? 900_000) || 900_000,
  );

  const updateCommandTimeoutMs = {
    // AUTO_UPDATE_GIT_FETCH_TIMEOUT_MS / AUTO_UPDATE_GIT_PULL_TIMEOUT_MS / AUTO_UPDATE_INSTALL_TIMEOUT_MS
    gitFetch: Math.max(10_000, Number(process.env.AUTO_UPDATE_GIT_FETCH_TIMEOUT_MS ?? 120_000) || 120_000),
    gitPull: Math.max(10_000, Number(process.env.AUTO_UPDATE_GIT_PULL_TIMEOUT_MS ?? 180_000) || 180_000),
    pnpmInstall: Math.max(20_000, Number(process.env.AUTO_UPDATE_INSTALL_TIMEOUT_MS ?? 300_000) || 300_000),
  };

  let autoUpdateActive = AUTO_UPDATE_DEFAULT_ENABLED;
  let autoUpdateSchedulerReady = false;
  const autoUpdateState: {
    running: boolean;
    last_checked_at: number | null;
    last_result: UpdateApplyResult | null;
    last_error: string | null;
    last_runtime_error: string | null;
    next_check_at: number | null;
  } = {
    running: false,
    last_checked_at: null,
    last_result: null,
    last_error: null,
    last_runtime_error: null,
    next_check_at: null,
  };

  let autoUpdateInFlight: Promise<unknown> | null = null;
  const autoUpdateLock = createAutoUpdateLock();
  let autoUpdateBootTimer: ReturnType<typeof setTimeout> | null = null;
  let autoUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let autoUpdateExitTimer: ReturnType<typeof setTimeout> | null = null;

  const { runCommandCaptureSync, runCommandCapture } = createCommandCaptureTools({ killPidTree });

  function stopAutoUpdateTimers(): void {
    if (autoUpdateBootTimer) {
      clearTimeout(autoUpdateBootTimer);
      autoUpdateBootTimer = null;
    }
    if (autoUpdateInterval) {
      clearInterval(autoUpdateInterval);
      autoUpdateInterval = null;
    }
    if (autoUpdateExitTimer) {
      clearTimeout(autoUpdateExitTimer);
      autoUpdateExitTimer = null;
    }
  }

  function maybeUnrefTimer(timer: { unref?: () => void } | null): void {
    timer?.unref?.();
  }

  function tryAcquireAutoUpdateLock(): boolean {
    return autoUpdateLock.tryAcquire();
  }

  function releaseAutoUpdateLock(): void {
    autoUpdateLock.release();
  }

  function getInProgressTaskCount(): number {
    try {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'in_progress'").get() as
        | { cnt?: number }
        | undefined;
      return Number(row?.cnt ?? 0);
    } catch {
      return 0;
    }
  }

  function validateAutoUpdateDependencies(): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const cmd of ["git", "pnpm"]) {
      const check = runCommandCaptureSync(cmd, ["--version"], 5_000);
      if (!check.ok) missing.push(cmd);
    }
    return { ok: missing.length === 0, missing };
  }

  function logAutoUpdate(message: string): void {
    try {
      appendTaskLog("", "system", `[auto-update] ${message}`);
    } catch {
      // ignore log failures
    }
  }

  function parseUpdateBooleanFlag(body: any, key: string): boolean {
    const raw = body?.[key];
    if (raw === true || raw === false) return raw;

    const value = String(raw ?? "").trim();
    if (!value || value === "0") return false;
    if (value === "1") return true;

    logAutoUpdate(
      `warning: invalid boolean value for "${key}" in /api/update-apply: ${JSON.stringify(raw)}; treating as false`,
    );
    return false;
  }

  function parseStoredBoolean(raw: string | undefined, fallback: boolean): boolean {
    if (raw == null) return fallback;
    const value = String(raw).trim().toLowerCase();
    if (!value) return fallback;
    if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
    if (value === "0" || value === "false" || value === "no" || value === "off") return false;
    return fallback;
  }

  function readAutoUpdateEnabledSetting(): boolean {
    return parseStoredBoolean(readSettingString(AUTO_UPDATE_ENABLED_SETTING_KEY), AUTO_UPDATE_DEFAULT_ENABLED);
  }

  function writeAutoUpdateEnabledSetting(enabled: boolean): void {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(AUTO_UPDATE_ENABLED_SETTING_KEY, enabled ? "true" : "false");
  }

  function refreshAutoUpdateActiveState(): boolean {
    autoUpdateActive = readAutoUpdateEnabledSetting();
    return autoUpdateActive;
  }

  function isLikelyManagedRuntime(): boolean {
    return Boolean(
      process.env.pm_id ||
      process.env.PM2_HOME ||
      process.env.INVOCATION_ID ||
      process.env.KUBERNETES_SERVICE_HOST ||
      process.env.CONTAINER ||
      process.env.DOCKER_CONTAINER,
    );
  }

  async function fetchUpdateStatus(forceRefresh = false): Promise<UpdateStatusPayload> {
    const now = Date.now();
    if (!UPDATE_CHECK_ENABLED) {
      return {
        current_version: PKG_VERSION,
        latest_version: null,
        update_available: false,
        release_url: null,
        checked_at: now,
        enabled: false,
        repo: UPDATE_CHECK_REPO,
        error: null,
      };
    }

    const cacheValid = updateStatusCache && now - updateStatusCachedAt < UPDATE_CHECK_TTL_MS;
    if (!forceRefresh && cacheValid && updateStatusCache) return updateStatusCache;
    if (!forceRefresh && updateStatusInFlight) return updateStatusInFlight;

    updateStatusInFlight = (async () => {
      let latestVersion: string | null = null;
      let releaseUrl: string | null = null;
      let error: string | null = null;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
        try {
          const response = await fetch(`https://api.github.com/repos/${UPDATE_CHECK_REPO}/releases/latest`, {
            method: "GET",
            headers: {
              accept: "application/vnd.github+json",
              "user-agent": "ironcrew-update-check",
            },
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`github_http_${response.status}`);
          }
          const body = (await response.json().catch(() => null)) as { tag_name?: unknown; html_url?: unknown } | null;
          latestVersion = typeof body?.tag_name === "string" ? normalizeVersionTag(body.tag_name) : null;
          releaseUrl = typeof body?.html_url === "string" ? body.html_url : null;
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const next = {
        current_version: PKG_VERSION,
        latest_version: latestVersion,
        update_available: Boolean(latestVersion && isRemoteVersionNewer(latestVersion, PKG_VERSION)),
        release_url: releaseUrl,
        checked_at: Date.now(),
        enabled: true,
        repo: UPDATE_CHECK_REPO,
        error,
      };
      updateStatusCache = next;
      updateStatusCachedAt = Date.now();
      return next;
    })().finally(() => {
      updateStatusInFlight = null;
    });

    return updateStatusInFlight;
  }

  const scheduleExit = (delayMs: number) => {
    if (autoUpdateExitTimer) clearTimeout(autoUpdateExitTimer);
    autoUpdateExitTimer = setTimeout(() => {
      logAutoUpdate("auto-update initiating graceful shutdown (mode=exit); shutdown handlers should listen to SIGTERM");
      process.exitCode = 0;
      let gracefulDelayMs = 0;
      if (process.listenerCount("SIGTERM") > 0) {
        try {
          process.kill(process.pid, "SIGTERM");
          gracefulDelayMs = 1500;
        } catch {
          // ignore and fallback to hard exit below
        }
      }
      setTimeout(() => process.exit(0), gracefulDelayMs);
    }, delayMs);
    maybeUnrefTimer(autoUpdateExitTimer);
  };

  async function runAutoUpdateCycle(): Promise<void> {
    if (!autoUpdateSchedulerReady) return;
    refreshAutoUpdateActiveState();
    if (!autoUpdateActive) {
      autoUpdateState.next_check_at = Date.now() + AUTO_UPDATE_CHECK_INTERVAL_MS;
      return;
    }
    if (autoUpdateInFlight) return;
    if (!tryAcquireAutoUpdateLock()) return;

    autoUpdateInFlight = (async () => {
      autoUpdateState.running = true;
      const now = Date.now();
      autoUpdateState.last_checked_at = now;
      autoUpdateState.next_check_at = now + AUTO_UPDATE_CHECK_INTERVAL_MS;
      autoUpdateState.last_runtime_error = null;
      logAutoUpdate("auto check started");

      try {
        const result = await applyUpdateNow(
          {
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
          },
          { trigger: "auto", dryRun: false },
        );
        autoUpdateState.last_result = result;
        autoUpdateState.last_error = result.error;
      } catch (err) {
        autoUpdateState.last_runtime_error = err instanceof Error ? err.message : String(err);
        logAutoUpdate(`auto check runtime error (${autoUpdateState.last_runtime_error})`);
      } finally {
        autoUpdateState.running = false;
        autoUpdateInFlight = null;
        releaseAutoUpdateLock();
      }
    })();

    await autoUpdateInFlight;
  }

  const buildHealthPayload = () => ({
    ok: true,
    version: PKG_VERSION,
    app: "IronCrew",
    dbPath,
  });

  {
    const dep = validateAutoUpdateDependencies();
    if (!dep.ok) {
      autoUpdateSchedulerReady = false;
      autoUpdateActive = false;
      autoUpdateState.last_error = `missing_dependencies:${dep.missing.join(",")}`;
      logAutoUpdate(`disabled - missing dependencies (${dep.missing.join(",")})`);
    } else {
      autoUpdateSchedulerReady = true;
      refreshAutoUpdateActiveState();
      autoUpdateState.next_check_at = Date.now() + AUTO_UPDATE_INITIAL_DELAY_MS;
      logAutoUpdate(
        `scheduler ready (enabled=${autoUpdateActive ? "1" : "0"}, first_check_in_ms=${AUTO_UPDATE_INITIAL_DELAY_MS}, interval_ms=${AUTO_UPDATE_CHECK_INTERVAL_MS})`,
      );
      if (AUTO_UPDATE_RESTART_MODE === "exit" && !isLikelyManagedRuntime()) {
        logAutoUpdate(
          "warning: restart_mode=exit is enabled but no process manager was detected; process may stop after update",
        );
      }

      autoUpdateBootTimer = setTimeout(() => {
        void runAutoUpdateCycle();
      }, AUTO_UPDATE_INITIAL_DELAY_MS);
      maybeUnrefTimer(autoUpdateBootTimer);

      autoUpdateInterval = setInterval(() => {
        void runAutoUpdateCycle();
      }, AUTO_UPDATE_CHECK_INTERVAL_MS);
      maybeUnrefTimer(autoUpdateInterval);

      process.once("SIGTERM", stopAutoUpdateTimers);
      process.once("SIGINT", stopAutoUpdateTimers);
      process.once("beforeExit", stopAutoUpdateTimers);
    }
  }

  app.get("/health", (_req, res) => res.json(buildHealthPayload()));
  app.get("/healthz", (_req, res) => res.json(buildHealthPayload()));
  app.get("/api/health", (_req, res) => res.json(buildHealthPayload()));
  app.get("/api/update-status", async (req, res) => {
    const refresh = String(req.query?.refresh ?? "").trim() === "1";
    const status = await fetchUpdateStatus(refresh);
    res.json({ ok: true, ...status });
  });

  app.get("/api/update-auto-status", async (req, res) => {
    // This endpoint is also protected by global /api auth middleware.
    // Keep an explicit guard here because it exposes operational update state.
    if (!isAuthenticated(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const settingsEnabled = readAutoUpdateEnabledSetting();
    autoUpdateActive = autoUpdateSchedulerReady ? settingsEnabled : false;
    const status = await fetchUpdateStatus(false);
    res.json({
      ok: true,
      auto_update: {
        enabled: autoUpdateActive,
        configured_enabled: AUTO_UPDATE_DEFAULT_ENABLED,
        settings_enabled: settingsEnabled,
        scheduler_ready: autoUpdateSchedulerReady,
        channel: AUTO_UPDATE_CHANNEL as AutoUpdateChannel,
        idle_only: AUTO_UPDATE_IDLE_ONLY,
        interval_ms: AUTO_UPDATE_CHECK_INTERVAL_MS,
        restart_mode: AUTO_UPDATE_RESTART_MODE as AutoUpdateRestartMode,
        restart_command_configured: Boolean(AUTO_UPDATE_RESTART_COMMAND),
      },
      runtime: {
        running: autoUpdateState.running,
        lock_held: autoUpdateLock.isHeld(),
        last_checked_at: autoUpdateState.last_checked_at,
        last_result: autoUpdateState.last_result,
        last_error: autoUpdateState.last_error,
        last_runtime_error: autoUpdateState.last_runtime_error,
        next_check_at: autoUpdateState.next_check_at,
      },
      update_status: status,
    });
  });

  app.post("/api/update-auto-config", async (req, res) => {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const body = req.body ?? {};
    const enabled = parseUpdateBooleanFlag(body, "enabled");
    writeAutoUpdateEnabledSetting(enabled);
    autoUpdateActive = autoUpdateSchedulerReady ? enabled : false;

    if (autoUpdateSchedulerReady && enabled) {
      autoUpdateState.next_check_at = Date.now();
      setTimeout(() => {
        void runAutoUpdateCycle();
      }, 250);
    } else {
      autoUpdateState.next_check_at = Date.now() + AUTO_UPDATE_CHECK_INTERVAL_MS;
    }

    logAutoUpdate(
      `runtime toggle updated (enabled=${autoUpdateActive ? "1" : "0"}, scheduler_ready=${autoUpdateSchedulerReady ? "1" : "0"})`,
    );
    return res.json({
      ok: true,
      auto_update: {
        enabled: autoUpdateActive,
        configured_enabled: AUTO_UPDATE_DEFAULT_ENABLED,
        settings_enabled: enabled,
        scheduler_ready: autoUpdateSchedulerReady,
      },
    });
  });

  app.post("/api/update-apply", async (req, res) => {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const body = req.body ?? {};
    const dryRun = parseUpdateBooleanFlag(body, "dry_run");
    const force = parseUpdateBooleanFlag(body, "force");
    const forceConfirm = parseUpdateBooleanFlag(body, "force_confirm");

    if (!tryAcquireAutoUpdateLock()) {
      return res.status(409).json({ ok: false, error: "update_already_running" });
    }

    let inFlight: Promise<UpdateApplyResult>;
    try {
      autoUpdateInFlight = (async () => {
        autoUpdateState.running = true;
        autoUpdateState.last_checked_at = Date.now();
        autoUpdateState.last_runtime_error = null;
        logAutoUpdate(`manual apply requested (dry_run=${dryRun ? "1" : "0"}, force=${force ? "1" : "0"})`);

        const result = await applyUpdateNow(
          {
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
          },
          { trigger: "manual", dryRun, force, forceConfirmed: forceConfirm },
        );
        autoUpdateState.last_result = result;
        autoUpdateState.last_error = result.error;
        return result;
      })()
        .catch((err) => {
          autoUpdateState.last_runtime_error = err instanceof Error ? err.message : String(err);
          throw err;
        })
        .finally(() => {
          autoUpdateState.running = false;
          autoUpdateInFlight = null;
          updateStatusCachedAt = 0;
          updateStatusCache = null;
          releaseAutoUpdateLock();
        });
      inFlight = autoUpdateInFlight as Promise<UpdateApplyResult>;
    } catch (err: unknown) {
      autoUpdateState.running = false;
      autoUpdateInFlight = null;
      updateStatusCachedAt = 0;
      updateStatusCache = null;
      releaseAutoUpdateLock();
      return res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }

    try {
      const result = await inFlight;
      if (result.reasons.includes("force_confirmation_required")) {
        return res.status(400).json({
          ok: false,
          error: "force_confirmation_required",
          message: "force=true requires force_confirm=true because it bypasses safety guards",
          result,
        });
      }
      const code = result.status === "failed" ? 500 : 200;
      return res.status(code).json({ ok: result.status !== "failed", result });
    } catch (err: unknown) {
      return res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });
}
