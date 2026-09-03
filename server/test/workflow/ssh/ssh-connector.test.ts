// server/test/workflow/ssh/ssh-connector.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SshConfig } from "../../../modules/workflow/ssh/types.ts";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { createSshConnector } from "../../../modules/workflow/ssh/ssh-connector.ts";

const TEST_CONFIG: SshConfig = {
  host: "100.101.102.103",
  port: 22,
  user: "user",
  private_key_path: "/home/user/.ssh/id_ed25519",
  known_hosts_policy: "accept",
};

function mockSpawnSuccess(stdout: string, stderr = "") {
  const mockProc = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") setTimeout(() => cb(Buffer.from(stdout)), 0);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data" && stderr) setTimeout(() => cb(Buffer.from(stderr)), 0);
      }),
    },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === "close") setTimeout(() => cb(0), 1);
    }),
    kill: vi.fn(),
  };
  (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  return mockProc;
}

function mockSpawnFailure(exitCode: number, stderr: string) {
  const mockProc = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") setTimeout(() => cb(Buffer.from(stderr)), 0);
      }),
    },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === "close") setTimeout(() => cb(exitCode), 1);
    }),
    kill: vi.fn(),
  };
  (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  return mockProc;
}

describe("SshConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("testConnection spawns ssh with correct args", async () => {
    mockSpawnSuccess("");
    const connector = createSshConnector(TEST_CONFIG);
    const result = await connector.testConnection();
    expect(result).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-o", "ConnectTimeout=5", "user@100.101.102.103"]),
      expect.any(Object),
    );
  });

  it("testConnection returns false on failure", async () => {
    mockSpawnFailure(255, "Connection refused");
    const connector = createSshConnector(TEST_CONFIG);
    const result = await connector.testConnection();
    expect(result).toBe(false);
  });

  it("exec runs command via ssh", async () => {
    mockSpawnSuccess("file1\nfile2\n");
    const connector = createSshConnector(TEST_CONFIG);
    const result = await connector.exec("ls /home");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("file1");
  });

  it("exec rejects disallowed commands", async () => {
    const connector = createSshConnector(TEST_CONFIG);
    await expect(connector.exec("sudo rm -rf /")).rejects.toThrow("not allowed");
  });

  it("createDirectory runs mkdir -p via ssh", async () => {
    mockSpawnSuccess("");
    const connector = createSshConnector(TEST_CONFIG);
    await connector.createDirectory("/home/user/newdir");
    expect(spawn).toHaveBeenCalledWith("ssh", expect.arrayContaining(["user@100.101.102.103"]), expect.any(Object));
  });

  it("listDirectory parses ls output", async () => {
    const lsOutput = [
      "drwxr-xr-x 2 user user 4096 2026-03-18 10:00 src",
      "-rw-r--r-- 1 user user 1234 2026-03-18 09:00 file.ts",
    ].join("\n");
    mockSpawnSuccess(lsOutput);
    const connector = createSshConnector(TEST_CONFIG);
    const entries = await connector.listDirectory("/home/user");
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("directory");
    expect(entries[0].name).toBe("src");
    expect(entries[1].type).toBe("file");
    expect(entries[1].name).toBe("file.ts");
  });
});
