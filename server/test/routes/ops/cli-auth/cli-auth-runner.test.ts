import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { CliAuthRunner } from "../../../../modules/routes/ops/cli-auth/cli-auth-runner.ts";

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => {
  return {
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

function createMockProc({ emitError }: { emitError?: Error } = {}): any {
  const proc = new EventEmitter();
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  (proc as any).stdin = { writable: true, write: vi.fn() };
  (proc as any).pid = 12345;
  (proc as any).kill = vi.fn();
  // Simulate async stdout emission
  setTimeout(() => {
    if (emitError) {
      proc.emit("error", emitError);
    } else {
      (proc as any).stdout.emit(
        "data",
        Buffer.from(
          "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=test",
        ),
      );
    }
  }, 10);
  return proc;
}

describe("CliAuthRunner", () => {
  let runner: CliAuthRunner;

  beforeEach(() => {
    mockSpawn.mockImplementation(() => createMockProc());
    runner = new CliAuthRunner({
      detectAllCli: vi
        .fn()
        .mockResolvedValue({ claude: { installed: true, authenticated: false, version: "1.0", authHint: "" } }),
      sessionTtlMs: 5000,
    });
  });

  afterEach(() => {
    runner.dispose();
  });

  it("starts a session and returns parsed output", async () => {
    const result = await runner.startSession("claude");
    expect(result.sessionId).toBeDefined();
    expect(result.verificationUrl).toMatch(/^https:\/\/claude\.com/);
  });

  it("rejects duplicate sessions for the same provider", async () => {
    await runner.startSession("claude");
    await expect(runner.startSession("claude")).rejects.toThrow(/already running/);
  });

  it("returns session status", async () => {
    const { sessionId } = await runner.startSession("claude");
    const status = await runner.getStatus("claude", sessionId);
    expect(["pending", "success"]).toContain(status.status);
  });

  it("cancels a session", async () => {
    const { sessionId } = await runner.startSession("claude");
    const result = runner.cancelSession("claude", sessionId);
    expect(result.cancelled).toBe(true);
  });

  it("rejects unknown provider", async () => {
    await expect(runner.startSession("unknown" as any)).rejects.toThrow(/unsupported provider/i);
  });

  it("rejects invalid session ID on status check", async () => {
    const status = await runner.getStatus("claude", "nonexistent");
    expect(status.status).toBe("failed");
  });

  it("handles spawn error (e.g. missing CLI binary) without crashing", async () => {
    mockSpawn.mockImplementation(() => createMockProc({ emitError: new Error("spawn claude ENOENT") }));
    const result = await runner.startSession("claude");
    expect(result.sessionId).toBeDefined();

    // Wait for the async error event to fire
    await new Promise((r) => setTimeout(r, 50));

    const status = await runner.getStatus("claude", result.sessionId);
    expect(status.status).toBe("failed");
    expect(status.error).toContain("ENOENT");
  });

  it("does not mark re-auth as success from stale credentials", async () => {
    // Provider is already authenticated before session starts
    const detectAllCli = vi.fn().mockResolvedValue({
      claude: { installed: true, authenticated: true, version: "1.0", authHint: "" },
    });
    runner.dispose();
    runner = new CliAuthRunner({ detectAllCli, sessionTtlMs: 5000 });

    const result = await runner.startSession("claude");
    const status = await runner.getStatus("claude", result.sessionId);

    // Should remain pending, not auto-succeed from pre-existing auth
    expect(status.status).toBe("pending");
    expect(status.authenticated).toBe(false);
  });
});
