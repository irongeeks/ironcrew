import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { isPidAlive, killProcessTree } from "./process-kill.ts";

describe("isPidAlive", () => {
  it("is true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false for pid 0 and negative values", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
  });

  it("is false for a pid that does not exist", () => {
    // A pid astronomically unlikely to be in use on a CI runner.
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });
});

describe("killProcessTree (real process, Linux)", () => {
  it("terminates a real spawned process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.stdout.write('ready');"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    try {
      await once(child.stdout!, "data");
      expect(child.pid).toBeGreaterThan(0);
      expect(isPidAlive(child.pid!)).toBe(true);
      const exited = once(child, "exit");
      killProcessTree(child.pid!, 300);
      await exited;
      expect(isPidAlive(child.pid!)).toBe(false);
    } finally {
      if (child.pid && isPidAlive(child.pid)) child.kill("SIGKILL");
    }
  }, 10_000);

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    // Readiness is acknowledged after the signal handler is installed. A
    // fixed sleep races process startup on busy CI hosts and tests SIGTERM
    // default behavior instead of escalation.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => process.stdout.write('ignored')); setInterval(() => {}, 1000); process.stdout.write('ready');",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      },
    );
    try {
      await once(child.stdout!, "data");
      const ignored = once(child.stdout!, "data");
      const exited = once(child, "exit");
      killProcessTree(child.pid!, 300);
      const [acknowledgement] = await ignored;
      expect(String(acknowledgement)).toContain("ignored");
      const [, signal] = await exited;
      expect(signal).toBe("SIGKILL");
      expect(isPidAlive(child.pid!)).toBe(false);
    } finally {
      if (child.pid && isPidAlive(child.pid)) child.kill("SIGKILL");
    }
  }, 10_000);

  it("does not throw when the pid is already gone", () => {
    expect(() => killProcessTree(2_000_000_000)).not.toThrow();
  });

  it("is a no-op for pid <= 0", () => {
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
  });
});
