import { execFileSync } from "node:child_process";

type DbLike = {
  prepare: (sql: string) => {
    run: (...args: any[]) => unknown;
  };
};

type CreateProcessToolsDeps = {
  db: DbLike;
  nowMs: () => number;
};

export function createProcessTools(deps: CreateProcessToolsDeps) {
  const { db, nowMs } = deps;

  function isPidAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function killPidTree(pid: number): void {
    if (pid <= 0) return;

    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 8000 });
      } catch {
        /* ignore */
      }
      return;
    }

    const signalTree = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        /* ignore */
      }
      try {
        process.kill(pid, sig);
      } catch {
        /* ignore */
      }
    };

    signalTree("SIGTERM");
    setTimeout(() => {
      if (isPidAlive(pid)) signalTree("SIGKILL");
    }, 1200);
  }

  function interruptPidTree(pid: number): void {
    if (pid <= 0) return;

    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T"], { stdio: "ignore", timeout: 8000 });
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (isPidAlive(pid)) {
          try {
            execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 8000 });
          } catch {
            /* ignore */
          }
        }
      }, 1200);
      return;
    }

    const signalTree = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        /* ignore */
      }
      try {
        process.kill(pid, sig);
      } catch {
        /* ignore */
      }
    };

    signalTree("SIGINT");
    setTimeout(() => {
      if (isPidAlive(pid)) signalTree("SIGTERM");
    }, 1200);
    setTimeout(() => {
      if (isPidAlive(pid)) signalTree("SIGKILL");
    }, 2600);
  }

  function appendTaskLog(taskId: string, kind: string, message: string): void {
    const t = nowMs();
    db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
      taskId,
      kind,
      message,
      t,
    );
  }

  return {
    killPidTree,
    isPidAlive,
    interruptPidTree,
    appendTaskLog,
  };
}
