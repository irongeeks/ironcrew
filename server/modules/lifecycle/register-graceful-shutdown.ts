import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket as WsSocket, WebSocketServer } from "ws";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "graceful-shutdown" });

interface RegisterGracefulShutdownHandlersOptions {
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  killPidTree: (pid: number) => void;
  rollbackTaskWorktree: (taskId: string, reason: string) => void;
  db: DatabaseSync;
  nowMs: () => number;
  endTaskExecutionSession: (taskId: string, reason: string) => void;
  wsClients: Set<WsSocket>;
  wss: WebSocketServer;
  server: { close: (callback: () => void) => void };
  onBeforeClose?: () => void;
}

export function registerGracefulShutdownHandlers({
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
  onBeforeClose,
}: RegisterGracefulShutdownHandlersOptions): void {
  function gracefulShutdown(signal: string, exitCode = 0): void {
    log.info({ signal }, "shutdown signal received, shutting down gracefully");

    try {
      onBeforeClose?.();
    } catch {
      // ignore pre-close cleanup failures
    }

    for (const [taskId, child] of activeProcesses) {
      log.info({ taskId, pid: child.pid }, "stopping process for task");
      stopRequestedTasks.add(taskId);
      if (child.pid) {
        killPidTree(child.pid);
      }
      activeProcesses.delete(taskId);

      rollbackTaskWorktree(taskId, "server_shutdown");

      const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | {
            assigned_agent_id: string | null;
          }
        | undefined;
      if (task?.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
      }
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'in_progress'").run(
        nowMs(),
        taskId,
      );
      endTaskExecutionSession(taskId, "server_shutdown");
    }

    for (const ws of wsClients) {
      ws.close(1001, "Server shutting down");
    }
    wsClients.clear();

    wss.close(() => {
      server.close(() => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        log.info({ exitCode }, "shutdown complete");
        process.exit(exitCode);
      });
    });

    setTimeout(() => {
      log.error("forced exit after timeout");
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception — initiating shutdown");
    gracefulShutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason) => {
    log.fatal({ err: reason }, "unhandled promise rejection — initiating shutdown");
    gracefulShutdown("unhandledRejection", 1);
  });

  process.once("SIGUSR2", () => {
    log.info("SIGUSR2 received (nodemon restart), cleaning up active processes");
    for (const [taskId, child] of activeProcesses) {
      if (child.pid) {
        killPidTree(child.pid);
      }
      activeProcesses.delete(taskId);

      rollbackTaskWorktree(taskId, "nodemon_restart");

      const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | { assigned_agent_id: string | null }
        | undefined;
      if (task?.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
      }
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'in_progress'").run(
        nowMs(),
        taskId,
      );
      endTaskExecutionSession(taskId, "nodemon_restart");
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.kill(process.pid, "SIGUSR2");
  });
}
