/**
 * Iron Command OS — process tree termination.
 *
 * Standalone (no database, no logging dependency) so the runtime layer can
 * kill a spawned CLI cleanly without pulling in the upstream runtime
 * god-object. Mirrors the signal-escalation pattern OctoOffice already uses:
 * try the process GROUP first (children spawned by the CLI die with it),
 * fall back to the single pid, escalate from a graceful signal to SIGKILL
 * only if the process is still alive after a grace period.
 */

import { execFileSync } from "node:child_process";

export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate a process and, on POSIX, its process group. Escalates from
 * SIGTERM to SIGKILL after `graceMs` if the process is still alive.
 *
 * Never throws: a kill racing an already-exited process is the common case,
 * not an error condition.
 */
export function killProcessTree(pid: number, graceMs = 1200): void {
  if (pid <= 0) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 8000 });
    } catch {
      // already exited, or taskkill unavailable — nothing more to do
    }
    return;
  }

  const signalTree = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal); // the process group, when the child was spawned detached
    } catch {
      // no such group (already gone, or not detached) — try the pid alone below
    }
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  };

  signalTree("SIGTERM");
  setTimeout(() => {
    if (isPidAlive(pid)) signalTree("SIGKILL");
  }, graceMs);
}
