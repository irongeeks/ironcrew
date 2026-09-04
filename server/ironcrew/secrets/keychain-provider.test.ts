import { describe, it, expect, vi } from "vitest";
import { KeychainSecretProvider, parseKeychainRef } from "./keychain-provider.ts";
import { SecretResolutionError } from "./secret-provider.ts";
import type { CliRunner } from "../shared/cli-runner.ts";
import type { SecretRef } from "./secret-ref.ts";

function runner(result: { stdout?: string; stderr?: string; code?: number | null }) {
  const calls: string[][] = [];
  const run: CliRunner = async (argv) => {
    calls.push([...argv]);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  };
  return { run, calls };
}

function ref(itemRef: string): SecretRef {
  return { provider: "keychain", itemRef };
}

describe("parseKeychainRef", () => {
  it("reads a bare service", () => {
    expect(parseKeychainRef("smtp")).toEqual({ service: "smtp", account: null });
  });

  it("reads service and account", () => {
    expect(parseKeychainRef("smtp:robert")).toEqual({ service: "smtp", account: "robert" });
  });

  it("refuses a half-written ref rather than guessing", () => {
    // Guessing here would mean looking up the wrong entry and only finding
    // out mid-run.
    for (const bad of ["", "   ", ":robert", "smtp:", ":"]) {
      expect(() => parseKeychainRef(bad)).toThrow(SecretResolutionError);
    }
  });
});

describe("resolve on Linux (secret-tool)", () => {
  it("looks the secret up by service", async () => {
    const { run, calls } = runner({ stdout: "geheim" });
    const provider = new KeychainSecretProvider({ platform: "linux", run });

    expect(await provider.resolve(ref("smtp"))).toBe("geheim");
    expect(calls[0]).toEqual(["secret-tool", "lookup", "service", "smtp"]);
  });

  it("adds the account attribute when the ref names one", async () => {
    const { run, calls } = runner({ stdout: "geheim" });
    const provider = new KeychainSecretProvider({ platform: "linux", run });

    await provider.resolve(ref("smtp:robert"));
    expect(calls[0]).toEqual(["secret-tool", "lookup", "service", "smtp", "account", "robert"]);
  });

  it("never builds a shell string", async () => {
    const { run, calls } = runner({ stdout: "x" });
    const provider = new KeychainSecretProvider({ platform: "linux", run });

    await provider.resolve(ref("smtp; rm -rf /"));
    // The injection lives harmlessly inside one argv element.
    expect(calls[0]).toContain("smtp; rm -rf /");
    expect(calls[0]).toHaveLength(4);
  });
});

describe("resolve on macOS (security)", () => {
  it("uses find-generic-password with -w", async () => {
    const { run, calls } = runner({ stdout: "geheim\n" });
    const provider = new KeychainSecretProvider({ platform: "darwin", run });

    expect(await provider.resolve(ref("smtp:robert"))).toBe("geheim");
    expect(calls[0]).toEqual(["security", "find-generic-password", "-w", "-s", "smtp", "-a", "robert"]);
  });
});

describe("failures say something actionable", () => {
  it("reports a missing entry without echoing the tool's own output", async () => {
    const { run } = runner({ code: 1, stderr: "secret-tool: no results for service=smtp" });
    const provider = new KeychainSecretProvider({ platform: "linux", run });

    await expect(provider.resolve(ref("smtp"))).rejects.toThrow(/Kein Eintrag/);
    // The tool's stderr can echo the query back; the query is a locator the
    // operator chose and may describe what the secret is for.
    await expect(provider.resolve(ref("smtp"))).rejects.not.toThrow(/no results/);
  });

  it("names the binary when it cannot be executed at all", async () => {
    const provider = new KeychainSecretProvider({
      platform: "linux",
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(provider.resolve(ref("smtp"))).rejects.toThrow(/secret-tool/);
  });

  it("refuses an empty entry rather than returning an empty secret", async () => {
    const { run } = runner({ stdout: "" });
    const provider = new KeychainSecretProvider({ platform: "linux", run });
    await expect(provider.resolve(ref("smtp"))).rejects.toThrow(/leer/);
  });

  it("keeps a secret that genuinely ends in whitespace intact", async () => {
    const { run } = runner({ stdout: "geheim  \n" });
    const provider = new KeychainSecretProvider({ platform: "linux", run });
    // Only the line ending is trimmed: trailing spaces can be part of a
    // password, and silently eating them produces an auth failure nobody
    // can explain.
    expect(await provider.resolve(ref("smtp"))).toBe("geheim  ");
  });

  it("refuses a platform with no keychain", async () => {
    const provider = new KeychainSecretProvider({
      platform: "win32",
      run: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    await expect(provider.resolve(ref("smtp"))).rejects.toThrow(/win32/);
  });
});

describe("testConnection tells a server operator the truth", () => {
  const originalBus = process.env.DBUS_SESSION_BUS_ADDRESS;

  it("says the keychain is unreachable without a session bus", async () => {
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      const { run } = runner({ stdout: "secret-tool 0.21" });
      const provider = new KeychainSecretProvider({ platform: "linux", run });

      const status = await provider.testConnection();
      // This is the whole point of probing: a service starting at boot has no
      // desktop session, and finding that out here beats finding it out
      // inside a run.
      expect(status.ok).toBe(false);
      expect(status.message).toMatch(/Vaultwarden|Proton Pass/);
    } finally {
      if (originalBus !== undefined) process.env.DBUS_SESSION_BUS_ADDRESS = originalBus;
    }
  });

  it("reports ok when the binary and a session bus are both there", async () => {
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    try {
      const { run } = runner({ stdout: "secret-tool 0.21" });
      const provider = new KeychainSecretProvider({ platform: "linux", run });
      expect(await provider.testConnection()).toMatchObject({ ok: true });
    } finally {
      if (originalBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = originalBus;
    }
  });

  it("reports a missing binary instead of throwing", async () => {
    const provider = new KeychainSecretProvider({
      platform: "darwin",
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    // The Settings UI asks "does this work?"; an exception there is an outage
    // in the page rather than an answer.
    expect(await provider.testConnection()).toMatchObject({ ok: false });
  });

  it("says no on a platform without a keychain", async () => {
    const provider = new KeychainSecretProvider({ platform: "win32", run: vi.fn() as unknown as CliRunner });
    expect(await provider.testConnection()).toMatchObject({ ok: false });
  });
});
