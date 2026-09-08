import { describe, it, expect } from "vitest";
import { ProtonPassSecretProvider } from "./protonpass-provider.ts";
import { SecretResolutionError } from "./secret-provider.ts";
import { spawnCliRunner, type CliRunner, type CliRunResult } from "../shared/cli-runner.ts";

function fakeRunner(byArgv: (argv: readonly string[]) => CliRunResult): CliRunner {
  return async (argv) => byArgv(argv);
}

const ok = (stdout = "", stderr = ""): CliRunResult => ({ stdout, stderr, code: 0 });
const fail = (stderr = "boom"): CliRunResult => ({ stdout: "", stderr, code: 1 });

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

  it("resolves via --share-id/--item-id/--field with plaintext output", async () => {
    const calls: string[][] = [];
    const provider = new ProtonPassSecretProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        return ok("s3cr3t\n");
      }),
    });
    const value = await provider.resolve({ provider: "protonpass", itemRef: "share1:item1" });
    expect(value).toBe("s3cr3t");
    expect(calls[0]).toEqual(["pass-cli", "item", "view", "--share-id=share1", "--item-id=item1", "--field=password"]);
  });

  it("preserves leading hyphens and literal characters through a real CLI parser", async () => {
    const shareId = "-share== ü $(literal)";
    const itemId = "-PNhb9yOmaOu== & item";
    const field = "-field=value";
    const fixture = `
      const { parseArgs } = require('node:util');
      const { values } = parseArgs({ args: process.argv.slice(1), strict: true,
        options: { 'share-id': { type: 'string' }, 'item-id': { type: 'string' },
          field: { type: 'string' } } });
      process.stdout.write(JSON.stringify(values));
    `;
    const provider = new ProtonPassSecretProvider({
      run: (argv, options) => spawnCliRunner([process.execPath, "-e", fixture, "--", ...argv.slice(3)], options),
    });
    const result = await provider.resolve({ provider: "protonpass", itemRef: `${shareId}:${itemId}`, field });
    expect(JSON.parse(result)).toEqual({ "share-id": shareId, "item-id": itemId, field });
    const oldForm = await spawnCliRunner([process.execPath, "-e", fixture, "--", "--item-id", itemId]);
    expect(oldForm.code).not.toBe(0);
  });

  it("passes a non-default field through", async () => {
    const calls: string[][] = [];
    const provider = new ProtonPassSecretProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        return ok("123456\n");
      }),
    });
    const value = await provider.resolve({ provider: "protonpass", itemRef: "s:i", field: "totp" });
    expect(value).toBe("123456");
    expect(calls[0]).toContain("--field=totp");
  });

  it.each([
    "sk-or-v1-fixture",
    '"quoted"',
    '{"password":"literal"}',
    "  padded secret  ",
    "line one\nline two",
    "secret\n",
    "secret\r",
    "\r",
  ])("preserves the literal secret value %j and removes only one CLI newline", async (secret) => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok(secret + "\n")) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "s:i" })).resolves.toBe(secret);
  });

  it.each(["", "\n"])("rejects an empty field %j", async (output) => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok(output)) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "s:i" })).rejects.toThrow(/has no value/);
  });

  it("accepts a field without a trailing newline", async () => {
    const provider = new ProtonPassSecretProvider({ run: fakeRunner(() => ok("literal secret")) });
    await expect(provider.resolve({ provider: "protonpass", itemRef: "s:i" })).resolves.toBe("literal secret");
  });

  it("rejects failed CLI output without exposing stdout or stderr", async () => {
    const provider = new ProtonPassSecretProvider({
      run: fakeRunner(() => ({ code: 1, stdout: "private stdout", stderr: "private stderr" })),
    });
    const error = await provider.resolve({ provider: "protonpass", itemRef: "s:i" }).catch((error) => error);
    expect(error).toBeInstanceOf(SecretResolutionError);
    expect(error.message).toMatch(/could not resolve/);
    expect(error.message).not.toMatch(/private stdout|private stderr/);
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
