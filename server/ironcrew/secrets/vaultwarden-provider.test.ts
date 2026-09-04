import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultwardenSecretProvider } from "./vaultwarden-provider.ts";
import { SecretResolutionError } from "./secret-provider.ts";
import type { CliRunner, CliRunResult } from "../shared/cli-runner.ts";

function fakeRunner(byArgv: (argv: readonly string[]) => CliRunResult): CliRunner {
  return async (argv) => byArgv(argv);
}

const ok = (stdout = "", stderr = ""): CliRunResult => ({ stdout, stderr, code: 0 });
const fail = (stderr = "boom"): CliRunResult => ({ stdout: "", stderr, code: 1 });

describe("VaultwardenSecretProvider", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.BW_SESSION;
    delete process.env.BW_PASSWORD;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("rejects a ref for a different provider", async () => {
    const provider = new VaultwardenSecretProvider({ run: fakeRunner(() => ok()) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "x" })).rejects.toBeInstanceOf(
      SecretResolutionError,
    );
  });

  it("reuses BW_SESSION from the environment without unlocking", async () => {
    process.env.BW_SESSION = "existing-session";
    const calls: string[][] = [];
    const provider = new VaultwardenSecretProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        return ok("s3cr3t\n");
      }),
    });
    const value = await provider.resolve({ provider: "vaultwarden", itemRef: "github" });
    expect(value).toBe("s3cr3t");
    expect(calls).toEqual([["bw", "get", "password", "github", "--session", "existing-session"]]);
  });

  it("unlocks with BW_PASSWORD when no session is available, then reuses the session", async () => {
    process.env.BW_PASSWORD = "master-pw";
    const calls: string[][] = [];
    const provider = new VaultwardenSecretProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        if (argv[1] === "unlock") return ok("fresh-session\n");
        return ok("resolved-value\n");
      }),
    });
    const value = await provider.resolve({ provider: "vaultwarden", itemRef: "github" });
    expect(value).toBe("resolved-value");
    expect(calls[0]).toEqual(["bw", "unlock", "--raw", "--passwordenv", "BW_PASSWORD"]);

    // Second resolution reuses the cached session — no second unlock call.
    await provider.resolve({ provider: "vaultwarden", itemRef: "gitlab" });
    const unlockCalls = calls.filter((c) => c[1] === "unlock");
    expect(unlockCalls).toHaveLength(1);
  });

  it("configures the server exactly once, before unlocking, when serverUrl is set and no session exists yet", async () => {
    process.env.BW_PASSWORD = "master-pw";
    const calls: string[][] = [];
    const provider = new VaultwardenSecretProvider({
      serverUrl: "https://vault.example.com",
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        if (argv[1] === "unlock") return ok("session\n");
        return ok("v\n");
      }),
    });
    await provider.resolve({ provider: "vaultwarden", itemRef: "a" });
    await provider.resolve({ provider: "vaultwarden", itemRef: "b" });
    const configCalls = calls.filter((c) => c[1] === "config");
    expect(configCalls).toEqual([["bw", "config", "server", "https://vault.example.com"]]);
    expect(calls[0]).toEqual(["bw", "config", "server", "https://vault.example.com"]);
    expect(calls[1][1]).toBe("unlock");
  });

  it("throws when neither BW_SESSION nor BW_PASSWORD is set", async () => {
    const provider = new VaultwardenSecretProvider({ run: fakeRunner(() => ok()) });
    await expect(provider.resolve({ provider: "vaultwarden", itemRef: "x" })).rejects.toThrow(
      /BW_SESSION.*BW_PASSWORD/,
    );
  });

  it("throws SecretResolutionError when unlock fails", async () => {
    process.env.BW_PASSWORD = "wrong";
    const provider = new VaultwardenSecretProvider({ run: fakeRunner(() => fail("invalid master password")) });
    await expect(provider.resolve({ provider: "vaultwarden", itemRef: "x" })).rejects.toThrow(
      /unlock failed.*invalid master password/,
    );
  });

  it("throws SecretResolutionError when bw get fails", async () => {
    process.env.BW_SESSION = "s";
    const provider = new VaultwardenSecretProvider({
      run: fakeRunner((argv) => (argv[1] === "get" ? fail("not found") : ok())),
    });
    await expect(provider.resolve({ provider: "vaultwarden", itemRef: "missing" })).rejects.toThrow(
      /could not resolve "missing"/,
    );
  });

  it("throws when the resolved value is empty", async () => {
    process.env.BW_SESSION = "s";
    const provider = new VaultwardenSecretProvider({ run: fakeRunner(() => ok("   ")) });
    await expect(provider.resolve({ provider: "vaultwarden", itemRef: "x" })).rejects.toThrow(/has no value/);
  });

  it("uses a non-default field when requested", async () => {
    process.env.BW_SESSION = "s";
    const calls: string[][] = [];
    const provider = new VaultwardenSecretProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        return ok("user@example.com\n");
      }),
    });
    const value = await provider.resolve({ provider: "vaultwarden", itemRef: "github", field: "username" });
    expect(value).toBe("user@example.com");
    expect(calls[0]).toEqual(["bw", "get", "username", "github", "--session", "s"]);
  });

  describe("testConnection", () => {
    it("reports ok when bw status returns unlocked", async () => {
      const provider = new VaultwardenSecretProvider({
        run: fakeRunner(() => ok(JSON.stringify({ status: "unlocked" }))),
      });
      const status = await provider.testConnection();
      expect(status).toEqual({ ok: true, message: "bw status: unlocked" });
    });

    it("reports ok when bw status returns locked (still reachable/authenticated)", async () => {
      const provider = new VaultwardenSecretProvider({
        run: fakeRunner(() => ok(JSON.stringify({ status: "locked" }))),
      });
      expect((await provider.testConnection()).ok).toBe(true);
    });

    it("reports not-ok when bw status returns unauthenticated", async () => {
      const provider = new VaultwardenSecretProvider({
        run: fakeRunner(() => ok(JSON.stringify({ status: "unauthenticated" }))),
      });
      const status = await provider.testConnection();
      expect(status.ok).toBe(false);
    });

    it("reports not-ok when bw is not installed", async () => {
      const provider = new VaultwardenSecretProvider({
        run: fakeRunner(() => {
          throw new Error("spawn bw ENOENT");
        }),
      });
      const status = await provider.testConnection();
      expect(status.ok).toBe(false);
      expect(status.message).toMatch(/ENOENT/);
    });

    it("never includes a resolved secret value in its message", async () => {
      const provider = new VaultwardenSecretProvider({ run: fakeRunner(() => fail("network unreachable")) });
      const status = await provider.testConnection();
      expect(status.message).not.toMatch(/session|password/i);
    });
  });
});
