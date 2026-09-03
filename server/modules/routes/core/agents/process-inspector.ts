import { execFile } from "node:child_process";
import path from "node:path";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { logger } from "../../../../observability/logger.ts";
import { httpError } from "../../http-errors.ts";

const log = logger.child({ module: "core" });

type SystemProcessInfo = {
  pid: number;
  ppid: number | null;
  name: string;
  command: string;
};

type ManagedProcessProvider = "claude" | "codex" | "gemini" | "opencode" | "node" | "python";

const CLI_EXECUTABLE_PROVIDER_MAP: Record<string, ManagedProcessProvider> = {
  claude: "claude",
  "claude.exe": "claude",
  codex: "codex",
  "codex.exe": "codex",
  gemini: "gemini",
  "gemini.exe": "gemini",
  opencode: "opencode",
  "opencode.exe": "opencode",
  node: "node",
  "node.exe": "node",
  python: "python",
  "python.exe": "python",
  python3: "python",
  "python3.exe": "python",
  py: "python",
  "py.exe": "python",
};

function detectCliProviderFromExecutable(name: string): ManagedProcessProvider | null {
  const normalized = path
    .basename(String(name ?? ""))
    .trim()
    .toLowerCase();
  if (CLI_EXECUTABLE_PROVIDER_MAP[normalized]) return CLI_EXECUTABLE_PROVIDER_MAP[normalized];
  if (normalized.startsWith("python")) return "python";
  return null;
}

function runExecFileText(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          (err as any).stderr = stderr;
          reject(err);
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

function parseUnixProcessTable(raw: string): SystemProcessInfo[] {
  const lines = raw.split(/\r?\n/);
  const rows: SystemProcessInfo[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const name = String(match[3] ?? "").trim();
    const args = String(match[4] ?? "").trim();
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid: Number.isFinite(ppid) && ppid >= 0 ? ppid : null,
      name,
      command: args || name,
    });
  }
  return rows;
}

function parseWindowsProcessJson(raw: string): SystemProcessInfo[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const rows: SystemProcessInfo[] = [];
  for (const item of items) {
    const pid = Number(item?.ProcessId ?? item?.processid ?? item?.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const ppidRaw = Number(item?.ParentProcessId ?? item?.parentprocessid ?? item?.ppid);
    const name = String(item?.Name ?? item?.name ?? "").trim();
    const commandLine = String(item?.CommandLine ?? item?.commandline ?? "").trim();
    rows.push({
      pid,
      ppid: Number.isFinite(ppidRaw) && ppidRaw >= 0 ? ppidRaw : null,
      name,
      command: commandLine || name,
    });
  }
  return rows;
}

async function listSystemProcesses(): Promise<SystemProcessInfo[]> {
  if (process.platform === "win32") {
    const psCommand =
      "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const candidates = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"];
    for (const shell of candidates) {
      try {
        const stdout = await runExecFileText(
          shell,
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
          20000,
        );
        const parsed = parseWindowsProcessJson(stdout);
        if (parsed.length) return parsed;
      } catch {
        // Fallback to next candidate shell
      }
    }

    try {
      const stdout = await runExecFileText("tasklist", ["/FO", "CSV", "/NH"], 20000);
      const rows: SystemProcessInfo[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^"([^"]+)","([^"]+)"/);
        if (!match) continue;
        const name = String(match[1] ?? "").trim();
        const pid = Number.parseInt(String(match[2] ?? "").replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        rows.push({ pid, ppid: null, name, command: name });
      }
      return rows;
    } catch {
      return [];
    }
  }

  const stdout = await runExecFileText("ps", ["-eo", "pid=,ppid=,comm=,args="], 15000);
  return parseUnixProcessTable(stdout);
}

function isTaskExecutionStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "planned" ||
    normalized === "collaborating" ||
    normalized === "in_progress" ||
    normalized === "review"
  );
}

export function registerAgentProcessInspectorRoutes(ctx: RuntimeContext): void {
  const {
    app,
    db,
    activeProcesses,
    taskExecutionSessions,
    killPidTree,
    stopRequestedTasks,
    stopRequestModeByTask,
    stopProgressTimer,
    endTaskExecutionSession,
    clearTaskWorkflowState,
    appendTaskLog,
    broadcast,
    nowMs,
  } = ctx;

  app.get("/api/agents/active", (_req, res) => {
    try {
      const workingAgents = db
        .prepare(
          `
      SELECT a.id, a.name, a.name_ko, a.avatar_emoji, a.role, a.status, a.current_task_id,
             a.department_id, a.cli_provider,
             COALESCE(d.name, '') AS dept_name,
             COALESCE(d.name_ko, '') AS dept_name_ko,
             t.id AS task_id, t.title AS task_title, t.status AS task_status,
             t.started_at AS task_started_at
      FROM agents a
      LEFT JOIN departments d ON d.id = a.department_id
      LEFT JOIN tasks t ON t.id = a.current_task_id
      WHERE a.status = 'working'
      ORDER BY a.name
    `,
        )
        .all() as Array<Record<string, unknown>>;

      const now = Date.now();
      const result = workingAgents.map((row) => {
        const taskId = row.task_id as string | null;
        const session = taskId ? taskExecutionSessions.get(taskId) : undefined;
        const hasProcess = taskId ? activeProcesses.has(taskId) : false;
        return {
          ...row,
          has_active_process: hasProcess,
          session_opened_at: session?.openedAt ?? null,
          last_activity_at: session?.lastTouchedAt ?? null,
          idle_seconds: session?.lastTouchedAt ? Math.round((now - session.lastTouchedAt) / 1000) : null,
        };
      });

      res.json({ ok: true, agents: result });
    } catch (err) {
      log.error({ err }, "active-agents error");
      httpError(res, 500, "active_agents_fetch_failed", "Failed to fetch active agents");
    }
  });

  app.get("/api/agents/cli-processes", async (_req, res) => {
    try {
      const allProcesses = await listSystemProcesses();
      const cliProcesses = allProcesses
        .map((proc) => {
          const provider = detectCliProviderFromExecutable(proc.name);
          return provider ? { ...proc, provider } : null;
        })
        .filter(Boolean) as Array<SystemProcessInfo & { provider: ManagedProcessProvider }>;

      const trackedTaskByPid = new Map<number, string>();
      for (const [taskId, child] of activeProcesses.entries()) {
        const pid = Number(child?.pid ?? 0);
        if (Number.isFinite(pid) && pid > 0) trackedTaskByPid.set(pid, taskId);
      }

      const trackedTaskIds = Array.from(new Set(Array.from(trackedTaskByPid.values())));
      const taskMetaById = new Map<
        string,
        {
          task_id: string;
          task_title: string | null;
          task_status: string | null;
          agent_id: string | null;
          agent_name: string | null;
          agent_name_ko: string | null;
          agent_status: string | null;
          agent_current_task_id: string | null;
        }
      >();
      for (const taskId of trackedTaskIds) {
        const meta = db
          .prepare(
            `
        SELECT
          t.id AS task_id,
          t.title AS task_title,
          t.status AS task_status,
          a.id AS agent_id,
          a.name AS agent_name,
          a.name_ko AS agent_name_ko,
          a.status AS agent_status,
          a.current_task_id AS agent_current_task_id
        FROM tasks t
        LEFT JOIN agents a ON a.current_task_id = t.id
        WHERE t.id = ?
      `,
          )
          .get(taskId) as
          | {
              task_id: string;
              task_title: string | null;
              task_status: string | null;
              agent_id: string | null;
              agent_name: string | null;
              agent_name_ko: string | null;
              agent_status: string | null;
              agent_current_task_id: string | null;
            }
          | undefined;
        if (meta) taskMetaById.set(taskId, meta);
      }

      const now = Date.now();
      const result = cliProcesses
        .map((proc) => {
          const trackedTaskId = trackedTaskByPid.get(proc.pid) ?? null;
          const taskMeta = trackedTaskId ? taskMetaById.get(trackedTaskId) : undefined;
          const session = trackedTaskId ? taskExecutionSessions.get(trackedTaskId) : undefined;
          const idleSeconds = session?.lastTouchedAt
            ? Math.max(0, Math.round((now - session.lastTouchedAt) / 1000))
            : null;
          let isIdle = false;
          let idleReason = "";

          if (!trackedTaskId) {
            isIdle = true;
            idleReason = "untracked_process";
          } else if (!taskMeta) {
            isIdle = true;
            idleReason = "task_missing";
          } else if (!isTaskExecutionStatus(taskMeta.task_status)) {
            isIdle = true;
            idleReason = "task_not_running";
          } else if (taskMeta.agent_status !== "working" || taskMeta.agent_current_task_id !== trackedTaskId) {
            isIdle = true;
            idleReason = "agent_not_working";
          } else if (!session?.lastTouchedAt) {
            isIdle = true;
            idleReason = "no_session_activity";
          } else if (idleSeconds !== null && idleSeconds >= 300) {
            isIdle = true;
            idleReason = "inactive_over_5m";
          }

          return {
            pid: proc.pid,
            ppid: proc.ppid,
            provider: proc.provider,
            executable: proc.name,
            command: String(proc.command ?? "").slice(0, 1000),
            is_tracked: Boolean(trackedTaskId),
            is_idle: isIdle,
            idle_reason: idleReason || null,
            task_id: trackedTaskId,
            task_title: taskMeta?.task_title ?? null,
            task_status: taskMeta?.task_status ?? null,
            agent_id: taskMeta?.agent_id ?? null,
            agent_name: taskMeta?.agent_name ?? null,
            agent_name_ko: taskMeta?.agent_name_ko ?? null,
            agent_status: taskMeta?.agent_status ?? null,
            session_opened_at: session?.openedAt ?? null,
            last_activity_at: session?.lastTouchedAt ?? null,
            idle_seconds: idleSeconds,
          };
        })
        .sort((a, b) => {
          if (a.is_idle !== b.is_idle) return a.is_idle ? -1 : 1;
          const byProvider = String(a.provider).localeCompare(String(b.provider));
          if (byProvider !== 0) return byProvider;
          return a.pid - b.pid;
        });

      res.json({ ok: true, processes: result });
    } catch (err) {
      log.error({ err }, "cli-processes error");
      httpError(res, 500, "cli_processes_inspect_failed", "Failed to inspect CLI processes");
    }
  });

  app.delete("/api/agents/cli-processes/:pid", (req, res) => {
    const pid = Number.parseInt(String(req.params.pid), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return httpError(res, 400, "invalid_pid");
    }
    if (pid === process.pid) {
      return httpError(res, 400, "cannot_kill_server_process");
    }

    let trackedTaskId: string | null = null;
    for (const [taskId, child] of activeProcesses.entries()) {
      if (Number(child?.pid ?? 0) === pid) {
        trackedTaskId = taskId;
        break;
      }
    }

    try {
      killPidTree(pid);
    } catch {
      // Continue state cleanup even if kill signal fails
    }

    if (trackedTaskId) {
      stopRequestedTasks.add(trackedTaskId);
      stopRequestModeByTask.set(trackedTaskId, "cancel");
      stopProgressTimer(trackedTaskId);
      endTaskExecutionSession(trackedTaskId, "cli_process_killed");
      clearTaskWorkflowState(trackedTaskId);
      activeProcesses.delete(trackedTaskId);

      const task = db.prepare("SELECT id, title, status FROM tasks WHERE id = ?").get(trackedTaskId) as
        | {
            id: string;
            title: string;
            status: string;
          }
        | undefined;
      if (task) {
        appendTaskLog(trackedTaskId, "system", `CLI process force-killed from inspector (pid=${pid})`);
        const normalizedStatus = String(task.status ?? "").toLowerCase();
        if (
          normalizedStatus !== "done" &&
          normalizedStatus !== "cancelled" &&
          normalizedStatus !== "pending" &&
          normalizedStatus !== "inbox"
        ) {
          db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowMs(), trackedTaskId);
        }
        const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(trackedTaskId);
        broadcast("task_update", updatedTask);
      }

      const linkedAgents = db.prepare("SELECT id FROM agents WHERE current_task_id = ?").all(trackedTaskId) as Array<{
        id: string;
      }>;
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE current_task_id = ?").run(
        trackedTaskId,
      );
      for (const linked of linkedAgents) {
        const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(linked.id);
        if (updatedAgent) broadcast("agent_status", updatedAgent);
      }
    }

    res.json({ ok: true, pid, tracked_task_id: trackedTaskId });
  });
}
