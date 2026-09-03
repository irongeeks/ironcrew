import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { DbLike } from "../../../types/db-like.ts";
import type { AdapterRegistry } from "../../../adapters/index.ts";
import { isCliAdapter } from "../../../adapters/index.ts";
import type { MetricsCollector } from "../../../observability/metrics.ts";
import { logger } from "../../../observability/logger.ts";
import { TokenAccumulator } from "./token-accumulator.ts";
import { assertArgsMatchMode } from "../../../ironcommand/policy/runtime-permissions.ts";

const log = logger.child({ module: "cli-runtime" });

type CliRuntimeDeps = {
  db: DbLike;
  logsDir: string;
  adapterRegistry: AdapterRegistry;
  clearCliOutputDedup: (taskId: string) => void;
  normalizeStreamChunk: (chunk: Buffer, options?: { dropCliNoise?: boolean }) => string;
  shouldSkipDuplicateCliOutput: (taskId: string, stream: "stdout" | "stderr", text: string) => boolean;
  broadcast: (event: string, payload: unknown) => void;
  TASK_RUN_IDLE_TIMEOUT_MS: number;
  TASK_RUN_HARD_TIMEOUT_MS: number;
  killPidTree: (pid: number) => void;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, "pause" | "cancel">;
  createSubtaskFromCli: (taskId: string, toolUseId: string, title: string) => void;
  completeSubtaskFromCli: (toolUseId: string) => void;
  metrics?: MetricsCollector;
  nowMs: () => number;
  checkTokenFreshness?: (provider: string) => "valid" | "expired" | "unknown";
};

export function createCliRuntimeTools(deps: CliRuntimeDeps) {
  const {
    db,
    logsDir,
    adapterRegistry,
    clearCliOutputDedup,
    normalizeStreamChunk,
    shouldSkipDuplicateCliOutput,
    broadcast,
    TASK_RUN_IDLE_TIMEOUT_MS,
    TASK_RUN_HARD_TIMEOUT_MS,
    killPidTree,
    appendTaskLog,
    activeProcesses,
    stopRequestedTasks,
    stopRequestModeByTask,
    createSubtaskFromCli,
    completeSubtaskFromCli,
    metrics,
    nowMs,
    checkTokenFreshness,
  } = deps;

  // Codex multi-agent: map thread_id → cli_tool_use_id (item.id from spawn_agent)
  const codexThreadToSubtask = new Map<string, string>();

  function parseAndCreateSubtasks(
    taskId: string,
    provider: string,
    data: string,
    preParsedEvents?: import("../../../adapters/adapter-interface.ts").AdapterStreamEvent[],
  ): void {
    try {
      let adapter;
      try {
        adapter = adapterRegistry.get(provider);
      } catch {
        // Unknown provider — fall back to no subtask parsing
        return;
      }

      const events = preParsedEvents ?? adapter.parseStreamChunk(data);
      for (const event of events) {
        if (event.type === "subtask_created") {
          const id = (event.metadata?.id as string) || `sub-${Date.now()}`;
          const title = event.content || "Sub-task";
          // Check for duplicate
          const existing = dbPrepareSubtaskByToolUseId().get(id) as { id: string } | undefined;
          if (existing) continue;
          createSubtaskFromCli(taskId, id, title);

          // For Codex: track spawn_agent item.id for later close_agent thread mapping
          // The codex adapter emits subtask_created with metadata.id = itemId
          // We store it in the map as a self-reference so close_agent can look it up via threadId
          // (The actual thread_id → itemId mapping is set when item.completed fires for spawn_agent)
        } else if (event.type === "subtask_done") {
          if (event.metadata?.threadId) {
            // Codex close_agent path: resolve thread_id → original tool_use_id
            const threadId = event.metadata.threadId as string;
            const origItemId = codexThreadToSubtask.get(threadId);
            if (origItemId) {
              completeSubtaskFromCli(origItemId);
              codexThreadToSubtask.delete(threadId);
            }
          } else if (event.metadata?.id) {
            // Claude / direct id path
            const id = event.metadata.id as string;
            if (id) completeSubtaskFromCli(id);
          } else if (event.metadata?.title) {
            // Gemini title-based done path
            const doneTitle = event.metadata.title as string;
            const sub = dbPrepareOpenSubtaskToolUseIdByTitle().get(taskId, doneTitle) as
              | { cli_tool_use_id: string }
              | undefined;
            if (sub) completeSubtaskFromCli(sub.cli_tool_use_id);
          }
        }
      }

      // Codex: update thread mapping when spawn_agent item.completed fires
      // The codex adapter's parseStreamChunk emits subtask_created with item.id on item.started,
      // but we also need to capture item.completed for spawn_agent to build the thread_id map.
      // Re-parse lines for this Codex-specific state update.
      if (provider === "codex") {
        const lines = data.split("\n").filter(Boolean);
        for (const line of lines) {
          let j: Record<string, unknown>;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j.type === "item.completed") {
            const item = j.item as Record<string, unknown> | undefined;
            if (item?.type === "collab_tool_call" && item?.tool === "spawn_agent") {
              const itemId = item.id as string;
              const threadIds = (item.receiver_thread_ids as string[]) || [];
              if (itemId && threadIds[0]) {
                codexThreadToSubtask.set(threadIds[0], itemId);
              }
            }
          }
        }
      }
    } catch {
      // Not parseable — ignore
    }
  }

  const dbPrepareSubtaskByToolUseId = () => db.prepare("SELECT id FROM subtasks WHERE cli_tool_use_id = ?");
  const dbPrepareOpenSubtaskToolUseIdByTitle = () =>
    db.prepare("SELECT cli_tool_use_id FROM subtasks WHERE task_id = ? AND title = ? AND status != 'done' LIMIT 1");

  function createSafeLogStreamOps(logStream: any): {
    safeWrite: (text: string) => boolean;
    safeEnd: (onDone?: () => void) => void;
    isClosed: () => boolean;
  } {
    let ended = false;
    const isClosed = () => ended || Boolean(logStream?.destroyed || logStream?.writableEnded || logStream?.closed);
    const safeWrite = (text: string): boolean => {
      if (!text || isClosed()) return false;
      try {
        logStream.write(text);
        return true;
      } catch {
        ended = true;
        return false;
      }
    };
    const safeEnd = (onDone?: () => void): void => {
      if (isClosed()) {
        ended = true;
        onDone?.();
        return;
      }
      ended = true;
      try {
        logStream.end(() => onDone?.());
      } catch {
        onDone?.();
      }
    };
    return { safeWrite, safeEnd, isClosed };
  }

  const CLI_PATH_FALLBACK_DIRS =
    process.platform === "win32"
      ? [
          path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs"),
          path.join(process.env.APPDATA || "", "npm"),
        ].filter(Boolean)
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          path.join(os.homedir(), ".local", "bin"),
          path.join(os.homedir(), "bin"),
        ];

  function withCliPathFallback(pathValue: string | undefined): string {
    const parts = (pathValue ?? "")
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean);
    const seen = new Set(parts);
    for (const dir of CLI_PATH_FALLBACK_DIRS) {
      if (!dir || seen.has(dir)) continue;
      parts.push(dir);
      seen.add(dir);
    }
    return parts.join(path.delimiter);
  }

  function spawnCliAgent(
    taskId: string,
    provider: string,
    prompt: string,
    projectPath: string,
    logPath: string,
    model?: string,
    reasoningLevel?: string,
    profile?: string,
  ): ChildProcess {
    clearCliOutputDedup(taskId);
    // Save prompt for debugging
    const promptPath = path.join(logsDir, `${taskId}.prompt.txt`);
    fs.writeFileSync(promptPath, prompt, "utf8");

    const adapter = adapterRegistry.get(provider);
    if (!isCliAdapter(adapter)) {
      throw new Error(`Provider "${provider}" is an HTTP adapter and cannot be spawned as a CLI process`);
    }

    const context = { prompt, workdir: projectPath, model, reasoningLevel, profile };
    const args = adapter.buildArgs(context);

    // Last line of defence before we hand argv to the OS: a permission-bypass
    // flag may only appear when policy actually resolved to "elevated".
    // Throws rather than silently stripping, so the failure is visible.
    assertArgsMatchMode(args, context.permissionMode ?? "restricted");

    // openclaw (and any future flag-delivery adapters) require prompt via CLI flag, not stdin.
    // On Windows (shell: true), passing the raw prompt as a CLI arg is unsafe due to shell
    // metacharacter injection (", &, |, etc.). Instead, fall back to stdin delivery on Windows.
    let win32StdinFallback = false;
    if (adapter.promptDelivery === "flag" && adapter.promptFlag) {
      if (process.platform === "win32") {
        // Windows with shell: true — unsafe to pass prompt as CLI flag argument.
        // Switch to stdin delivery: the prompt is already saved to promptPath for debugging,
        // and we will write it to stdin below (the stdin delivery block will handle it).
        args.push("--session-id", taskId);
        win32StdinFallback = true;
      } else {
        args.push("--session-id", taskId, adapter.promptFlag, prompt);
      }
    }

    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const { safeWrite, safeEnd } = createSafeLogStreamOps(logStream);
    safeWrite(`\n===== task run start ${new Date().toISOString()} | provider=${provider} =====\n`);

    // Remove CLAUDECODE env var to prevent "nested session" detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE;
    cleanEnv.PATH = withCliPathFallback(String(cleanEnv.PATH ?? process.env.PATH ?? ""));
    cleanEnv.NO_COLOR = "1";
    cleanEnv.FORCE_COLOR = "0";
    cleanEnv.CI = "1";
    if (!cleanEnv.TERM) cleanEnv.TERM = "dumb";

    // Check token freshness before spawn
    if (checkTokenFreshness) {
      const freshness = checkTokenFreshness(provider);
      if (freshness === "expired") {
        appendTaskLog(taskId, "warn", `${provider} token may be expired — re-authenticate in Settings`);
        broadcast("cli_auth_warning", { provider, reason: "token_expired" });
      }
    }

    const child = spawn(args[0], args.slice(1), {
      cwd: projectPath,
      env: cleanEnv,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    metrics?.incCounter("agent.spawn", { provider });
    const agentStartTime = Date.now();

    // --- Token tracking ---
    let tokenBudget: { maxInput: number; maxOutput: number } | null = null;
    try {
      const row = db
        .prepare(
          `SELECT wp.cost_profile_json FROM tasks t
           JOIN workflow_packs wp ON wp.key = t.workflow_pack_key
           WHERE t.id = ?`,
        )
        .get(taskId) as { cost_profile_json?: string } | undefined;
      if (row?.cost_profile_json) {
        const profile = JSON.parse(row.cost_profile_json);
        if (profile.max_input_tokens || profile.max_output_tokens) {
          tokenBudget = {
            maxInput: profile.max_input_tokens ?? Infinity,
            maxOutput: profile.max_output_tokens ?? Infinity,
          };
        }
      }
    } catch {
      // no budget — tracking still works, just no enforcement
    }

    let agentId: string | null = null;
    try {
      const taskRow = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | { assigned_agent_id?: string }
        | undefined;
      agentId = taskRow?.assigned_agent_id ?? null;
    } catch {
      // ignore
    }

    const supportsTracking = adapter.supportsTokenTracking;
    const tokenAccumulator = new TokenAccumulator(
      taskId,
      agentId,
      provider,
      { db, appendTaskLog, broadcast, nowMs },
      tokenBudget,
    );

    if (!supportsTracking) {
      appendTaskLog(taskId, "token_tracking_unavailable", `Provider "${provider}" does not support token tracking`);
    }

    let finished = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let stdoutListener: ((chunk: Buffer) => void) | null = null;
    let stderrListener: ((chunk: Buffer) => void) | null = null;
    const detachOutputListeners = () => {
      if (stdoutListener) {
        child.stdout?.off("data", stdoutListener);
        stdoutListener = null;
      }
      if (stderrListener) {
        child.stderr?.off("data", stderrListener);
        stderrListener = null;
      }
    };
    const clearRunTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
    };
    const triggerTimeout = (kind: "idle" | "hard") => {
      if (finished) return;
      finished = true;
      clearRunTimers();
      const timeoutMs = kind === "idle" ? TASK_RUN_IDLE_TIMEOUT_MS : TASK_RUN_HARD_TIMEOUT_MS;
      const reason =
        kind === "idle"
          ? `no output for ${Math.round(timeoutMs / 1000)}s`
          : `exceeded max runtime ${Math.round(timeoutMs / 1000)}s`;
      const msg = `[OctoOffice] RUN TIMEOUT (${reason})`;
      safeWrite(`\n${msg}\n`);
      appendTaskLog(taskId, "error", msg);
      try {
        if (child.pid && child.pid > 0) {
          killPidTree(child.pid);
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // ignore kill race
      }
    };
    const touchIdleTimer = () => {
      if (finished || TASK_RUN_IDLE_TIMEOUT_MS <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => triggerTimeout("idle"), TASK_RUN_IDLE_TIMEOUT_MS);
    };

    touchIdleTimer();
    if (TASK_RUN_HARD_TIMEOUT_MS > 0) {
      hardTimer = setTimeout(() => triggerTimeout("hard"), TASK_RUN_HARD_TIMEOUT_MS);
    }

    const existingProcess = activeProcesses.get(taskId);
    if (existingProcess?.pid) {
      log.warn({ taskId, existingPid: existingProcess.pid }, "killing existing process before spawning new one");
      killPidTree(existingProcess.pid);
      activeProcesses.delete(taskId);
    }
    activeProcesses.set(taskId, child);

    child.on("error", (err) => {
      finished = true;
      clearRunTimers();
      detachOutputListeners();
      log.error({ err, provider, taskId }, "spawn error");
      safeWrite(`\n[OctoOffice] SPAWN ERROR: ${err.message}\n`);
      safeEnd();
      if (activeProcesses.get(taskId) === child) {
        activeProcesses.delete(taskId);
      }
      appendTaskLog(taskId, "error", `Agent spawn failed: ${err.message}`);
    });

    // Deliver prompt via stdin for adapters that use stdin delivery,
    // or for flag-based adapters on Windows (shell injection fallback)
    if (adapter.promptDelivery !== "flag" || win32StdinFallback) {
      child.stdin?.write(prompt);
    }
    child.stdin?.end();

    // Pipe agent output to log file AND broadcast via WebSocket
    stdoutListener = (chunk: Buffer) => {
      touchIdleTimer();
      const text = normalizeStreamChunk(chunk, { dropCliNoise: true });
      if (!text) return;
      if (shouldSkipDuplicateCliOutput(taskId, "stdout", text)) return;
      safeWrite(text);
      broadcast("cli_output", { task_id: taskId, stream: "stdout", data: text });
      // Parse stream once and distribute events to subtask + token tracking
      const parsedEvents = adapter.parseStreamChunk(text);
      parseAndCreateSubtasks(taskId, provider, text, parsedEvents);
      // Process token usage events
      if (supportsTracking) {
        for (const evt of parsedEvents) {
          if (evt.type === "token_usage" && evt.metadata) {
            const result = tokenAccumulator.record({
              input_tokens: (evt.metadata.input_tokens as number) ?? 0,
              output_tokens: (evt.metadata.output_tokens as number) ?? 0,
              cache_read_tokens: evt.metadata.cache_read_tokens as number | undefined,
              cache_write_tokens: evt.metadata.cache_write_tokens as number | undefined,
              model: evt.metadata.model as string | undefined,
            });
            if (result === "exceeded") {
              log.warn({ taskId, provider }, "token budget exceeded — killing agent");
              finished = true;
              clearRunTimers();
              // Signal the run-complete-handler to treat this as a pause (preserve workflow state).
              // This mirrors the normal pause flow in execution-control.ts.
              stopRequestedTasks.add(taskId);
              stopRequestModeByTask.set(taskId, "pause");
              try {
                if (child.pid && child.pid > 0) {
                  killPidTree(child.pid);
                } else {
                  child.kill("SIGTERM");
                }
              } catch {
                // ignore kill race
              }
              // Move task to pending and reset agent to idle (mirrors normal pause flow).
              try {
                db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
                if (agentId) {
                  db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(agentId);
                  const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
                  broadcast("agent_status", updatedAgent);
                }
                const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
                broadcast("task_update", updatedTask);
              } catch (err) {
                log.error({ err, taskId }, "failed to update task/agent status on budget exceeded");
              }
            }
          }
        }
      }
    };
    stderrListener = (chunk: Buffer) => {
      touchIdleTimer();
      const text = normalizeStreamChunk(chunk, { dropCliNoise: true });
      if (!text) return;
      if (shouldSkipDuplicateCliOutput(taskId, "stderr", text)) return;
      safeWrite(text);
      broadcast("cli_output", { task_id: taskId, stream: "stderr", data: text });
    };
    child.stdout?.on("data", stdoutListener);
    child.stderr?.on("data", stderrListener);

    child.on("close", (code) => {
      finished = true;
      clearRunTimers();
      detachOutputListeners();
      metrics?.recordHistogram("agent.duration_ms", Date.now() - agentStartTime, { provider });
      metrics?.incCounter("agent.exit", { provider, code: String(code ?? -1) });
      const summary = tokenAccumulator.getSummary();
      if (summary.input_tokens > 0 || summary.output_tokens > 0) {
        appendTaskLog(
          taskId,
          "token_usage_summary",
          `Tokens: ${summary.input_tokens} input, ${summary.output_tokens} output, ${summary.cache_read_tokens} cache-read, ${summary.cache_write_tokens} cache-write`,
        );
      }
      safeEnd();
      try {
        fs.unlinkSync(promptPath);
      } catch {
        /* ignore */
      }
      // Only delete if this is still the active process for this task
      if (activeProcesses.get(taskId) === child) {
        activeProcesses.delete(taskId);
      }
    });

    return child;
  }

  return {
    codexThreadToSubtask,
    spawnCliAgent,
  };
}
