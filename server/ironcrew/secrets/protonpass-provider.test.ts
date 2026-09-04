import { describe, it, expect } from "vitest";
import { ProtonPassSecretProvider, extractFieldValue } from "./protonpass-provider.ts";
import { SecretResolutionError } from "./secret-provider.ts";
import type { CliRunner, CliRunResult } from "../shared/cli-runner.ts";

function fakeRunner(byArgv: (argv: readonly string[]) => CliRunResult): CliRunner {
  return async (argv) => byArgv(argv);
}

const ok = (stdout = "", stderr = ""): CliRunResult => ({ stdout, stderr, code: 0 });
const fail = (stderr = "boom"): CliRunResult => ({ stdout: "", stderr, code: 1 });

describe("extractFieldValue", () => {
  it("returns a plain string result as-is", () => {
    expect(extractFieldValue("hunter2", "password")).toBe("hunter2");
  });

  it("reads a top-level field matching the requested name", () => {
    expect(extractFieldValue({ password: "hunter2" }, "password")).toBe("hunter2");
  });

  it("reads a field nested under 'fields'", () => {
    expect(extractFieldValue({ fields: { username: "bob" } }, "username")).toBe("bob");
  });

  it("falls back to 'value' for the password field", () => {
    expect(extractFieldValue({ value: "hunter2" }, "password")).toBe("hunter2");
  });

  it("returns null when nothing matches", () => {
    expect(extractFieldValue({ other: "x", another: "y" }, "password")).toBeNull();
  });

  it("returns null for non-object, non-string input", () => {
    expect(extractFieldValue(null, "password")).toBeNull();
    expect(extractFieldValue(42, "password")).toBeNull();
  });
});

describe("ProtonPassSecretProvider", () => {
  it("rejects a ref for a different provider", async () => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok()) });
    await expect(provider.resolve({ provider: "vaultwarden", itemRef: "x" })).rejects.toBeInstanceOf(
      SecretResolutionError,
    );
  });

  it("rejects an itemRef that is not 'shareId:itemId'", async () => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok()) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "not-a-valid-ref" })).rejects.toThrow(
      /shareId.*itemId/,
    );
  });

  it("resolves via --share-id/--item-id/--field with json output", async () => {
    const calls: string[][] = [];
    const provider = new ProtonPassSecretProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        return ok(JSON.stringify({ password: "s3cr3t" }));
      }),
    });
    const value = await provider.resolve({ provider: "protonpass", itemRef: "share1:item1" });
    expect(value).toBe("s3cr3t");
    expect(calls[0]).toEqual([
      "pass-cli",
      "item",
      "view",
      "--share-id",
      "share1",
      "--item-id",
      "item1",
      "--field",
      "password",
      "--output",
      "json",
    ]);
  });

  it("passes a non-default field through", async () => {
    const calls: string[][] = [];
    const provider = new ProtonPassSecretProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        return ok(JSON.stringify({ fields: { totp: "123456" } }));
      }),
    });
    const value = await provider.resolve({ provider: "protonpass", itemRef: "s:i", field: "totp" });
    expect(value).toBe("123456");
    expect(calls[0]).toContain("--field");
    expect(calls[0]).toContain("totp");
  });

  it("throws SecretResolutionError when pass-cli exits non-zero", async () => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => fail("item not found")) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "s:i" })).rejects.toThrow(
      /could not resolve item.*item not found/,
    );
  });

  it("throws when the output is not valid JSON", async () => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok("not json")) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "s:i" })).rejects.toThrow(/could not parse/);
  });

  it("throws when the requested field is absent from the item", async () => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok(JSON.stringify({ other: "x" }))) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "s:i" })).rejects.toThrow(/has no value/);
  });

  describe("testConnection", () => {
    it("reports ok when pass-cli info succeeds", async () => {
      const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok("logged in as ops-token")) });
      const status = await provider.testConnection();
      expect(status).toEqual({ ok: true, message: "logged in as ops-token" });
    });

    it("reports not-ok when pass-cli info fails", async () => {
      const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => fail("not logged in")) });
      const status = await provider.testConnection();
      expect(status).toEqual({ ok: false, message: "not logged in" });
    });

    it("reports not-ok when pass-cli is not installed", async () => {
      const provider = new ProtonPassSecretProvider({
        run: fakeRunner(() => {
          throw new Error("spawn pass-cli ENOENT");
        }),
      });
      const status = await provider.testConnection();
      expect(status.ok).toBe(false);
      expect(status.message).toMatch(/ENOENT/);
    });
  });
});
