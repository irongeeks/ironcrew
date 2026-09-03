import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Dependency overrides guard
//
// These tests assert that security-critical pnpm overrides remain in
// package.json. If a future maintainer accidentally removes one while
// reorganising the manifest, the unit suite catches it before the audit
// regression slips into a release.
// ---------------------------------------------------------------------------

interface PackageManifest {
  pnpm?: {
    overrides?: Record<string, string>;
  };
}

function readPackageManifest(): PackageManifest {
  const path = resolve(__dirname, "../../../package.json");
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as PackageManifest;
}

describe("pnpm.overrides security pins", () => {
  it("pins ip-address to a patched version (>=10.1.1) for GHSA-v2v4-37r5-5v8g", () => {
    const manifest = readPackageManifest();
    const overrides = manifest.pnpm?.overrides ?? {};
    const ipAddressOverride = overrides["ip-address"];

    expect(ipAddressOverride, "pnpm.overrides['ip-address'] must be set").toBeDefined();
    expect(ipAddressOverride).toBe(">=10.1.1");
  });

  it("pins hono to a version that closes GHSA-9vqf-7f2p-gf9v and GHSA-69xw-7hcm-h432 (A-004)", () => {
    // hono <4.12.16 has bodyLimit() bypass + JSX HTML injection. The MCP SDK
    // pulls hono in transitively, so we override to >=4.12.16.
    const manifest = readPackageManifest();
    const overrides = manifest.pnpm?.overrides ?? {};
    const honoOverrideKey = Object.keys(overrides).find((k) => k === "hono" || k.startsWith("hono@"));
    expect(honoOverrideKey, "expected an override key for hono in package.json").toBeDefined();
    const value = overrides[honoOverrideKey as string];
    expect(value).toMatch(/^>=4\.12\.(1[6-9]|[2-9]\d)/);
  });
});
