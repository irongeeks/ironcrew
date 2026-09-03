import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
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
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 100)); // let it actually start
    expect(child.pid).toBeGreaterThan(0);
    expect(isPidAlive(child.pid!)).toBe(true);

    killProcessTree(child.pid!, 300);

    await new Promise((r) => setTimeout(r, 250));
    expect(isPidAlive(child.pid!)).toBe(false);
  }, 10_000);

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    // Ignore SIGTERM so only the SIGKILL escalation can end it.
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      stdio: "ignore",
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(isPidAlive(child.pid!)).toBe(true);

    killProcessTree(child.pid!, 300);

    // Still alive right after SIGTERM, since it's ignored...
    await new Promise((r) => setTimeout(r, 100));
    expect(isPidAlive(child.pid!)).toBe(true);

    // ...but gone once the grace period elapses and SIGKILL fires.
    await new Promise((r) => setTimeout(r, 500));
    expect(isPidAlive(child.pid!)).toBe(false);
  }, 10_000);

  it("does not throw when the pid is already gone", () => {
    expect(() => killProcessTree(2_000_000_000)).not.toThrow();
  });

  it("is a no-op for pid <= 0", () => {
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
  });
});
