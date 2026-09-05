import type { RuntimeContext } from "../types/runtime-context.ts";
import type { IncomingMessage } from "node:http";
import type { WebSocket as WsSocket } from "ws";
import fs from "node:fs";
import path from "path";
import { HOST, PKG_VERSION, PORT } from "../config/runtime.ts";
import { notifyTaskStatus } from "../gateway/client.ts";
import { startDiscordReceiver } from "../messenger/discord-receiver.ts";
import { startTelegramReceiver } from "../messenger/telegram-receiver.ts";
import { registerGracefulShutdownHandlers } from "./lifecycle/register-graceful-shutdown.ts";
import { processQueuedServerAllocations, runServerHealthChecks } from "./workflow/orchestration/server-allocation.ts";
import { createAutonomousScheduler } from "./lifecycle/autonomous-scheduler.ts";
import { createCeoOrchestrator } from "./lifecycle/ceo-orchestrator.ts";
import { createScheduledTaskRunner } from "./lifecycle/scheduled-task-runner.ts";
import { attachWsBroadcast, logger, shutdownLogger } from "../observability/logger.ts";
import { runRetention } from "../observability/retention.ts";
import { getEncryptionSecretStatus } from "../oauth/helpers.ts";

const log = logger.child({ module: "lifecycle" });

export function startLifecycle(ctx: RuntimeContext): void {
  const {
    IN_PROGRESS_ORPHAN_GRACE_MS,
    IN_PROGRESS_ORPHAN_SWEEP_MS,
    SUBTASK_DELEGATION_SWEEP_MS,
    WebSocketServer,
    activeProcesses,
    app,
    appendTaskLog,
    broadcast,
    handleClientMessage,
    clearTaskWorkflowState,
    db,
    dbPath,
    detectAllCli,
    distDir,
    endTaskExecutionSession,
    express,
    finishReview,
    getDecryptedOAuthToken,
    handleTaskRunComplete,
    cancelPendingReRuns,
    isAgentInMeeting,
    isIncomingMessageAuthenticated,
    isIncomingMessageOriginTrusted,
    isPidAlive,
    isProduction,
    killPidTree,
    notifyCeo,
    nowMs,
    processSubtaskDelegations,
    reconcileCrossDeptSubtasks,
    refreshGoogleToken,
    resolveLang,
    rollbackTaskWorktree,
    runInTransaction,
    stopProgressTimer,
    stopRequestedTasks,
    wsClients,
    logsDir,
  } = ctx;

  // ---------------------------------------------------------------------------
  // Production: serve React UI from dist/
  // ---------------------------------------------------------------------------
  if (isProduction) {
    app.use(express.static(distDir));
    // SPA fallback: serve index.html for non-API routes (Express 5 named wildcard)
    app.get(
      "/{*splat}",
      (
        req: { path: string },
        res: {
          status(code: number): { json(payload: unknown): unknown };
          sendFile(filePath: string): unknown;
        },
      ) => {
        if (req.path.startsWith("/api/") || req.path === "/health" || req.path === "/healthz") {
          return res.status(404).json({ error: "not_found" });
        }
        res.sendFile(path.join(distDir, "index.html"));
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Auto break rotation: idle ↔ break every 60s
  // ---------------------------------------------------------------------------
  function rotateBreaks(): void {
    // Rule: max 1 agent per department on break at a time
    const allAgents = db
      .prepare("SELECT id, department_id, status FROM agents WHERE status IN ('idle','break')")
      .all() as { id: string; department_id: string; status: string }[];

    if (allAgents.length === 0) return;

    // Meeting/CEO-office summoned agents should stay in office, not break room.
    for (const a of allAgents) {
      if (a.status === "break" && isAgentInMeeting(a.id)) {
        db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a.id);
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id));
      }
    }

    const candidates = allAgents.filter((a) => !isAgentInMeeting(a.id));
    if (candidates.length === 0) return;

    // Group by department
    const byDept = new Map<string, typeof candidates>();
    for (const a of candidates) {
      const list = byDept.get(a.department_id) || [];
      list.push(a);
      byDept.set(a.department_id, list);
    }

    for (const [, members] of byDept) {
      const onBreak = members.filter((a) => a.status === "break");
      const idle = members.filter((a) => a.status === "idle");

      if (onBreak.length > 1) {
        // Too many on break from same dept — return extras to idle
        const extras = onBreak.slice(1);
        for (const a of extras) {
          db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a.id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id));
        }
      } else if (onBreak.length === 1) {
        // 40% chance to return from break (avg ~2.5 min break)
        if (Math.random() < 0.4) {
          db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(onBreak[0].id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(onBreak[0].id));
        }
      } else if (onBreak.length === 0 && idle.length > 0) {
        // 50% chance to send one idle agent on break
        if (Math.random() < 0.5) {
          const pick = idle[Math.floor(Math.random() * idle.length)];
          db.prepare("UPDATE agents SET status = 'break' WHERE id = ?").run(pick.id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(pick.id));
        }
      }
    }
  }

  function pruneDuplicateReviewMeetings(): void {
    const rows = db
      .prepare(
        `
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY task_id, round, status
          ORDER BY started_at DESC, created_at DESC, id DESC
        ) AS rn
      FROM meeting_minutes
      WHERE meeting_type = 'review'
        AND status IN ('in_progress', 'failed')
    )
    SELECT id
    FROM ranked
    WHERE rn > 1
  `,
      )
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return;

    const delEntries = db.prepare("DELETE FROM meeting_minute_entries WHERE meeting_id = ?");
    const delMeetings = db.prepare("DELETE FROM meeting_minutes WHERE id = ?");
    runInTransaction(() => {
      for (const id of rows.map((r) => r.id)) {
        delEntries.run(id);
        delMeetings.run(id);
      }
    });
  }

  type InProgressRecoveryReason = "startup" | "interval";
  const ORPHAN_RECENT_ACTIVITY_WINDOW_MS = Math.max(120_000, IN_PROGRESS_ORPHAN_GRACE_MS);

  function recoverOrphanInProgressTasks(reason: InProgressRecoveryReason): void {
    const inProgressTasks = db
      .prepare(
        `
    SELECT id, title, assigned_agent_id, created_at, started_at, updated_at, workflow_pack_key
    FROM tasks
    WHERE status = 'in_progress'
    ORDER BY updated_at ASC
  `,
      )
      .all() as Array<{
      id: string;
      title: string;
      assigned_agent_id: string | null;
      created_at: number | null;
      started_at: number | null;
      updated_at: number | null;
      workflow_pack_key: string | null;
    }>;

    const now = nowMs();
    for (const task of inProgressTasks) {
      const active = activeProcesses.get(task.id);
      if (active) {
        const pid = typeof active.pid === "number" ? active.pid : null;
        if (pid !== null && pid > 0 && !isPidAlive(pid)) {
          activeProcesses.delete(task.id);
          appendTaskLog(task.id, "system", `Recovery (${reason}): removed stale process handle (pid=${pid})`);
        } else {
          continue;
        }
      }

      const lastTouchedAt = Math.max(task.updated_at ?? 0, task.started_at ?? 0, task.created_at ?? 0);
      const ageMs = lastTouchedAt > 0 ? Math.max(0, now - lastTouchedAt) : IN_PROGRESS_ORPHAN_GRACE_MS + 1;
      if (ageMs < IN_PROGRESS_ORPHAN_GRACE_MS) continue;

      // Safety check 1: if task_logs activity is within recent window, consider still active
      const recentLog = db
        .prepare(
          `
      SELECT created_at FROM task_logs
      WHERE task_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 1
    `,
        )
        .get(task.id, now - ORPHAN_RECENT_ACTIVITY_WINDOW_MS) as { created_at: number } | undefined;
      if (recentLog) {
        continue;
      }

      // Safety check 2: if terminal log file recently updated, consider output still in progress
      // (e.g., in-memory process handle lost during server reload/restart)
      try {
        const logPath = path.join(logsDir, `${task.id}.log`);
        const stat = fs.statSync(logPath);
        const logIdleMs = Math.max(0, now - Math.floor(stat.mtimeMs || 0));
        if (logIdleMs <= ORPHAN_RECENT_ACTIVITY_WINDOW_MS) {
          continue;
        }
      } catch {
        // If log file missing or inaccessible, continue with existing recovery logic
      }

      const latestRunLog = db
        .prepare(
          `
      SELECT message
      FROM task_logs
      WHERE task_id = ?
        AND kind = 'system'
        AND (message LIKE 'RUN %' OR message LIKE 'Agent spawn failed:%')
      ORDER BY created_at DESC
      LIMIT 1
    `,
        )
        .get(task.id) as { message: string } | undefined;
      const latestRunMessage = latestRunLog?.message ?? "";

      if (latestRunMessage.startsWith("RUN completed (exit code: 0)")) {
        // For pipeline tasks (any pack with [pipeline:*] subtasks), skip replay if no active phase exists.
        // Without this guard, recovery would advance the next blocked phase without execution.
        if (task.workflow_pack_key) {
          const anyPipelineSubtask = db
            .prepare("SELECT COUNT(*) AS cnt FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%'")
            .get(task.id) as { cnt: number } | undefined;
          if ((anyPipelineSubtask?.cnt ?? 0) > 0) {
            const activePhase = db
              .prepare(
                "SELECT title, status FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND status IN ('pending', 'in_progress') LIMIT 1",
              )
              .get(task.id) as { title: string; status: string } | undefined;
            if (!activePhase) {
              appendTaskLog(task.id, "system", `Recovery (${reason}): skip replay — no active pipeline phase (none)`);
              const t2 = nowMs();
              db.prepare(
                "UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ? AND status = 'in_progress'",
              ).run(t2, task.id);
              stopProgressTimer(task.id);
              clearTaskWorkflowState(task.id);
              endTaskExecutionSession(task.id, `orphan_recovery_pipeline_skip_${reason}`);
              const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
              broadcast("task_update", updatedTask);
              continue;
            }
          }
        }

        appendTaskLog(
          task.id,
          "system",
          `Recovery (${reason}): orphan in_progress detected (age_ms=${ageMs}) → replaying successful completion`,
        );
        handleTaskRunComplete(task.id, 0);
        continue;
      }

      if (latestRunMessage.startsWith("RUN ") || latestRunMessage.startsWith("Agent spawn failed:")) {
        appendTaskLog(
          task.id,
          "system",
          `Recovery (${reason}): orphan in_progress detected (age_ms=${ageMs}) → replaying failed completion`,
        );
        handleTaskRunComplete(task.id, 1);
        continue;
      }

      const t = nowMs();
      const move = db
        .prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ? AND status = 'in_progress'")
        .run(t, task.id) as { changes?: number };
      if ((move.changes ?? 0) === 0) continue;

      stopProgressTimer(task.id);
      clearTaskWorkflowState(task.id);
      endTaskExecutionSession(task.id, `orphan_in_progress_${reason}`);
      appendTaskLog(
        task.id,
        "system",
        `Recovery (${reason}): in_progress without active process/run log (age_ms=${ageMs}) → inbox`,
      );

      if (task.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
        const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
        broadcast("agent_status", updatedAgent);
      }

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
      broadcast("task_update", updatedTask);
      const lang = resolveLang(task.title);
      notifyTaskStatus(task.id, task.title, "inbox", lang);
      const watchdogMessage =
        lang === "en"
          ? `[WATCHDOG] '${task.title}' was in progress but had no active process. Recovered to inbox.`
          : lang === "ja"
            ? `[WATCHDOG] '${task.title}' は in_progress でしたが実行プロセスが存在しないため inbox に復旧しました。`
            : lang === "zh"
              ? `[WATCHDOG] '${task.title}' 处于 in_progress，但未发现执行进程，已恢复到 inbox。`
              : `[WATCHDOG] '${task.title}' 작업이 in_progress 상태였지만 실행 프로세스가 없어 inbox로 복구했습니다.`;
      notifyCeo(watchdogMessage, task.id);
    }
  }

  function recoverInterruptedWorkflowOnStartup(): void {
    pruneDuplicateReviewMeetings();
    try {
      reconcileCrossDeptSubtasks();
    } catch (err) {
      log.error({ err }, "startup reconciliation failed");
    }

    recoverOrphanInProgressTasks("startup");

    const reviewTasks = db
      .prepare(
        `
    SELECT id, title
    FROM tasks
    WHERE status = 'review'
    ORDER BY updated_at ASC
  `,
      )
      .all() as Array<{ id: string; title: string }>;

    reviewTasks.forEach((task, idx) => {
      const delay = 1200 + idx * 400;
      setTimeout(() => {
        const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as
          | { status: string }
          | undefined;
        if (!current || current.status !== "review") return;
        finishReview(task.id, task.title);
      }, delay);
    });
  }

  function sweepPendingSubtaskDelegations(): void {
    const parents = db
      .prepare(
        `
    SELECT DISTINCT t.id
    FROM tasks t
    JOIN subtasks s ON s.task_id = t.id
    WHERE t.status IN ('planned', 'collaborating', 'in_progress', 'review')
      AND s.target_department_id IS NOT NULL
      AND s.status != 'done'
      AND (s.delegated_task_id IS NULL OR s.delegated_task_id = '')
    ORDER BY t.updated_at ASC
    LIMIT 80
  `,
      )
      .all() as Array<{ id: string }>;

    for (const row of parents) {
      if (!row.id) continue;
      processSubtaskDelegations(row.id);
    }
  }

  async function sweepServerResources(): Promise<void> {
    const t = nowMs();
    const activated = processQueuedServerAllocations(db as any, t);
    if (activated.length > 0) {
      broadcast("server_update", { action: "queue_processed", activated });
    }
    const health = await runServerHealthChecks(db as any, t);
    if (health.length > 0) {
      broadcast("server_update", { action: "health_sweep", updates: health });
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-assign agent providers on startup
  // ---------------------------------------------------------------------------
  async function autoAssignAgentProviders(): Promise<void> {
    const autoAssignRow = db.prepare("SELECT value FROM settings WHERE key = 'autoAssign'").get() as
      | { value: string }
      | undefined;
    if (!autoAssignRow || autoAssignRow.value === "false") return;

    const cliStatus = (await detectAllCli()) as Record<string, { installed?: boolean; authenticated?: boolean }>;
    const authenticated = Object.entries(cliStatus)
      .filter(([, s]) => s.installed && s.authenticated)
      .map(([name]) => name);

    if (authenticated.length === 0) {
      log.info("auto-assign skipped: no authenticated CLI providers");
      return;
    }

    const dpRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultProvider'").get() as
      | { value: string }
      | undefined;
    const defaultProv = dpRow?.value?.replace(/"/g, "") || "claude";
    const fallback = authenticated.includes(defaultProv) ? defaultProv : authenticated[0];

    const agents = db.prepare("SELECT id, name, cli_provider FROM agents").all() as Array<{
      id: string;
      name: string;
      cli_provider: string | null;
    }>;

    let count = 0;
    for (const agent of agents) {
      const prov = agent.cli_provider || "";
      if (prov === "copilot" || prov === "antigravity" || prov === "api" || prov === "openclaw") continue;
      if (authenticated.includes(prov)) continue;

      db.prepare("UPDATE agents SET cli_provider = ? WHERE id = ?").run(fallback, agent.id);
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id));
      log.info({ agent: agent.name, from: prov || "none", to: fallback }, "auto-assigned agent provider");
      count++;
    }
    if (count > 0) log.info({ count }, "auto-assigned agents");
  }

  // Run rotation every 60 seconds, and once on startup after 5s
  setTimeout(rotateBreaks, 5_000);
  setInterval(rotateBreaks, 60_000);
  setTimeout(recoverInterruptedWorkflowOnStartup, 3_000);
  setInterval(() => recoverOrphanInProgressTasks("interval"), IN_PROGRESS_ORPHAN_SWEEP_MS);
  setTimeout(sweepPendingSubtaskDelegations, 4_000);
  setInterval(sweepPendingSubtaskDelegations, SUBTASK_DELEGATION_SWEEP_MS);
  setTimeout(() => {
    void sweepServerResources();
  }, 2_500);
  setInterval(() => {
    void sweepServerResources();
  }, 20_000);
  setTimeout(autoAssignAgentProviders, 4_000);

  // Observability retention — run every hour, reads config from DB each time
  setInterval(
    () => {
      try {
        // Read retention config from DB (falls back to defaults if not set)
        let dbConfig: Record<string, unknown> = {};
        try {
          const row = db.prepare("SELECT value FROM settings WHERE key = 'observability_config' LIMIT 1").get() as
            | { value: string }
            | undefined;
          if (row) dbConfig = JSON.parse(row.value);
        } catch {
          /* no config yet */
        }

        runRetention(db, {
          metricsRetentionDays: (dbConfig.metrics_retention_days as number) || 7,
          aggregateRetentionDays: (dbConfig.metrics_aggregate_retention_days as number) || 90,
          spanRetentionDays: (dbConfig.trace_retention_days as number) || 30,
          logRetentionDays: (dbConfig.log_retention_days as number) || 7,
          maxLogRows: (dbConfig.max_log_rows as number) || 500_000,
        });
      } catch (err) {
        log.error({ err }, "retention job failed");
      }
    },
    60 * 60 * 1000,
  ).unref();

  // ---------------------------------------------------------------------------
  // Autonomous scheduler: auto-assign idle agents to waiting tasks
  // ---------------------------------------------------------------------------
  const autonomousScheduler = createAutonomousScheduler({
    db,
    app,
    activeProcesses,
    broadcast,
    notifyCeo,
    appendTaskLog,
    nowMs,
  });
  // Export for use by run-complete-handler (task chaining)
  (ctx as any).autonomousSchedulerTick = autonomousScheduler.schedulerTick;
  setTimeout(() => autonomousScheduler.schedulerTick(), 10_000);
  setInterval(() => autonomousScheduler.schedulerTick(), 30_000);

  // ---------------------------------------------------------------------------
  // CEO Orchestrator: LLM-based autonomous decision-making
  // ---------------------------------------------------------------------------
  const ceoOrchestrator = createCeoOrchestrator({
    db,
    app,
    broadcast,
    notifyCeo,
    appendTaskLog,
    nowMs,
  });
  setTimeout(() => {
    void ceoOrchestrator.ceoTick();
  }, 15_000);
  setInterval(() => {
    void ceoOrchestrator.ceoTick();
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Scheduled Task Runner: cron-based recurring task creation
  // ---------------------------------------------------------------------------
  const scheduledTaskRunner = createScheduledTaskRunner({
    db,
    app,
    broadcast,
    appendTaskLog,
    nowMs,
  });
  setTimeout(() => {
    void scheduledTaskRunner.tick();
  }, 15_000);
  setInterval(() => {
    void scheduledTaskRunner.tick();
  }, 60_000);

  const telegramReceiver = startTelegramReceiver({ db });
  const discordReceiver = startDiscordReceiver({ db });

  // ---------------------------------------------------------------------------
  // Start HTTP server + WebSocket
  // ---------------------------------------------------------------------------
  const server = app.listen(PORT, HOST, () => {
    log.info({ version: PKG_VERSION, host: HOST, port: PORT, dbPath }, "server listening");
    if (isProduction) {
      log.info({ distDir }, "mode: production");
    } else {
      log.info("mode: development (UI served by Vite on separate port)");
    }

    // Print health check table
    try {
      const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c;
      const deptCount = (db.prepare("SELECT COUNT(*) as c FROM departments").get() as { c: number }).c;
      const providerRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultProvider' LIMIT 1").get() as
        | { value: string }
        | undefined;
      const provider = providerRow?.value?.replace(/^["']|["']$/g, "") || "none";
      const apiKeyCount = (db.prepare("SELECT COUNT(*) as c FROM api_providers").get() as { c: number }).c;

      let oauthCount = 0;
      try {
        oauthCount = (db.prepare("SELECT COUNT(*) as c FROM oauth_credentials").get() as { c: number }).c;
      } catch {
        // table may not exist in fresh installs
      }

      const onboardingRow = db
        .prepare("SELECT value FROM settings WHERE key = 'onboarding_completed' LIMIT 1")
        .get() as { value: string } | undefined;
      const onboardingDone = onboardingRow?.value === "true";

      const g = (msg: string) => `  \x1b[32m✓\x1b[0m ${msg}`;
      const y = (msg: string) => `  \x1b[33m✗\x1b[0m ${msg}`;
      const r = (msg: string) => `  \x1b[31m✗\x1b[0m ${msg}`;

      const secretStatus = getEncryptionSecretStatus();
      const secretsCell =
        secretStatus.status === "ok"
          ? g("Secrets")
          : secretStatus.status === "fallback"
            ? y("Secrets (legacy)")
            : r(`Secrets (${secretStatus.status})`);

      const lines = [
        "",
        "\x1b[36m┌─────────────────────────────────────────────────┐\x1b[0m",
        `\x1b[36m│\x1b[0m  IronCrew v${PKG_VERSION} — Health Check`,
        "\x1b[36m├─────────────────────────────────────────────────┤\x1b[0m",
        `${g("Database")}        ${secretsCell}`,
        `${g(`Agents (${agentCount})`)}     ${g(`Departments (${deptCount})`)}`,
        `${g(`CLI: ${provider}`)}     ${apiKeyCount > 0 ? g("API key") : y("API key (optional)")}`,
        `${oauthCount > 0 ? g("OAuth") : y("OAuth (optional)")}      ${onboardingDone ? g("Onboarded") : y("Onboarding pending")}`,
        "\x1b[36m├─────────────────────────────────────────────────┤\x1b[0m",
        `\x1b[36m│\x1b[0m  → http://${HOST === "0.0.0.0" ? "localhost" : HOST}:8800`,
        ...(!onboardingDone ? [`\x1b[36m│\x1b[0m  → Complete setup in browser`] : []),
        "\x1b[36m└─────────────────────────────────────────────────┘\x1b[0m",
        "",
      ];
      console.log(lines.join("\n"));
    } catch {
      // Health check printing is best-effort
    }
  });

  // Background token refresh: check every 5 minutes for tokens expiring within 5 minutes
  setInterval(
    async () => {
      try {
        const cred = getDecryptedOAuthToken("google_antigravity");
        if (!cred || !cred.refreshToken) return;
        const expiresAtMs = cred.expiresAt && cred.expiresAt < 1e12 ? cred.expiresAt * 1000 : cred.expiresAt;
        if (!expiresAtMs) return;
        // Refresh if expiring within 5 minutes
        if (expiresAtMs < Date.now() + 5 * 60_000) {
          await refreshGoogleToken(cred);
          log.info("background refresh: Antigravity token renewed");
        }
      } catch (err) {
        log.error({ err }, "background refresh failed");
      }
    },
    5 * 60 * 1000,
  );

  // WebSocket server on same HTTP server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WsSocket, req: IncomingMessage) => {
    if (!isIncomingMessageOriginTrusted(req) || !isIncomingMessageAuthenticated(req)) {
      ws.close(1008, "unauthorized");
      return;
    }

    // CLI Auth PTY terminal — route to dedicated handler
    const url = req.url ?? "";
    const ptyMatch = url.match(/^\/ws\/cli-auth\/(\w+)/);
    if (ptyMatch) {
      import("./routes/ops/cli-auth/pty-ws.ts")
        .then(({ handleCliAuthPtyConnection }) => {
          handleCliAuthPtyConnection(ws, ptyMatch[1]);
        })
        .catch((err) => {
          console.error("[ws] message_error:", err);
          ws.send(JSON.stringify({ type: "error", message: "internal_error" }));
          ws.close();
        });
      return;
    }

    wsClients.add(ws);
    log.info({ total: wsClients.size }, "WebSocket client connected");

    // Send initial state to the newly connected client
    ws.send(
      JSON.stringify({
        type: "connected",
        payload: {
          version: PKG_VERSION,
          app: "IronCrew",
        },
        ts: nowMs(),
      }),
    );

    ws.on("message", (data) => {
      handleClientMessage(ws, data.toString());
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      log.info({ total: wsClients.size }, "WebSocket client disconnected");
    });

    ws.on("error", () => {
      wsClients.delete(ws);
    });
  });

  // Forward pino log entries to subscribed WS clients
  attachWsBroadcast(broadcast);

  registerGracefulShutdownHandlers({
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    rollbackTaskWorktree,
    db,
    nowMs,
    endTaskExecutionSession,
    wsClients,
    wss,
    server,
    onBeforeClose: () => {
      const closeFleet = (ctx as unknown as { closeFleet?: () => void }).closeFleet;
      closeFleet?.();
      cancelPendingReRuns();
      telegramReceiver.stop();
      discordReceiver.stop();
      ctx.tracer.shutdown();
      ctx.metrics.shutdown();
      shutdownLogger();
    },
  });
}
