import fs from "node:fs";
import path from "node:path";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { buildTaskInterruptControlToken } from "../../../../security/auth.ts";
import { buildTerminalProgressHints } from "./progress-hints.ts";
import { prettyStreamJson } from "./pretty-stream-json.ts";

export function registerTaskTerminalRoutes(ctx: RuntimeContext): void {
  const { app, logsDir, hasStructuredJsonLines, db, taskExecutionSessions, ensureTaskExecutionSession } = ctx;

  app.get("/api/tasks/:id/terminal", (req, res) => {
    const id = String(req.params.id);
    const lines = Math.min(Math.max(Number(req.query.lines ?? 200), 20), 20000);
    const logLimit = Math.min(Math.max(Number(req.query.log_limit ?? 400), 50), 2000);
    const pretty = String(req.query.pretty ?? "0") === "1";
    const filePath = path.join(logsDir, `${id}.log`);
    let activeSession = taskExecutionSessions.get(id);
    if (!activeSession) {
      const taskRow = db.prepare("SELECT assigned_agent_id, status FROM tasks WHERE id = ?").get(id) as
        | { assigned_agent_id: string | null; status: string }
        | undefined;
      const canAutoSession =
        Boolean(taskRow?.assigned_agent_id) &&
        taskRow?.status !== "done" &&
        taskRow?.status !== "cancelled" &&
        taskRow?.status !== "inbox";
      if (canAutoSession && taskRow?.assigned_agent_id) {
        const agentRow = db.prepare("SELECT cli_provider FROM agents WHERE id = ?").get(taskRow.assigned_agent_id) as
          | { cli_provider: string | null }
          | undefined;
        const provider = (agentRow?.cli_provider || "claude").trim() || "claude";
        activeSession = ensureTaskExecutionSession(id, taskRow.assigned_agent_id, provider);
      }
    }
    const interrupt = activeSession?.sessionId
      ? {
          session_id: activeSession.sessionId,
          control_token: buildTaskInterruptControlToken(id, activeSession.sessionId),
          requires_csrf: true,
        }
      : null;

    if (!fs.existsSync(filePath)) {
      return res.json({ ok: true, exists: false, path: filePath, text: "", interrupt });
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parts = raw.split(/\r?\n/);
    const tail = parts.slice(Math.max(0, parts.length - lines)).join("\n");
    let text = tail;
    let progressHints: ReturnType<typeof buildTerminalProgressHints> | null = null;
    if (pretty) {
      const parsed = prettyStreamJson(tail, { includeReasoning: true });
      text = parsed;
      if (hasStructuredJsonLines(tail)) {
        const hints = buildTerminalProgressHints(tail);
        if (hints.hints.length > 0) {
          progressHints = hints;
        }
      }
    }

    const taskLogs = db
      .prepare("SELECT id, kind, message, created_at FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(id, logLimit) as Array<{ id: number; kind: string; message: string; created_at: number }>;
    taskLogs.reverse();

    res.json({
      ok: true,
      exists: true,
      path: filePath,
      text,
      task_logs: taskLogs,
      progress_hints: progressHints,
      interrupt,
    });
  });
}
