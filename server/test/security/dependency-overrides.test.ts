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

/** Parse the leading ">=x.y.z" of an override value into a comparable tuple. */
function parseFloor(value: string | undefined): [number, number, number] | null {
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Assert an override pins `pkg` at or above `minimum`.
 *
 * Deliberately a floor comparison rather than string equality: raising a pin in
 * response to a newer advisory must not fail this guard, while removing or
 * weakening one still must. An exact-match assertion fails on exactly the
 * change you want people to make.
 */
function expectPinAtLeast(overrides: Record<string, string>, pkg: string, minimum: [number, number, number]): void {
  const key = Object.keys(overrides).find((k) => k === pkg || k.startsWith(`${pkg}@`));
  expect(key, `expected a pnpm.overrides entry for ${pkg}`).toBeDefined();

  const floor = parseFloor(overrides[key as string]);
  expect(floor, `pnpm.overrides['${key}'] must pin a minimum version`).not.toBeNull();

  const actual = floor as [number, number, number];
  // Component-wise comparison rather than packing into one number: a packed
  // encoding silently carries once a component reaches its assumed width.
  const atLeast = (() => {
    for (let i = 0; i < 3; i++) {
      if (actual[i] > minimum[i]) return true;
      if (actual[i] < minimum[i]) return false;
    }
    return true;
  })();

  expect(atLeast, `${pkg} is pinned to >=${actual.join(".")}, below the required >=${minimum.join(".")}`).toBe(true);
}

describe("pnpm.overrides security pins", () => {
  it("pins ip-address to a patched version (>=10.1.1) for GHSA-v2v4-37r5-5v8g", () => {
    expectPinAtLeast(readPackageManifest().pnpm?.overrides ?? {}, "ip-address", [10, 1, 1]);
  });

  // Pins added for the advisories that were failing `pnpm audit --audit-level=high`.
  it.each([
    ["fast-uri", [4, 1, 4] as [number, number, number], "GHSA-fph4-wmhf-6fwf / GHSA-jqff-g426-hqxp"],
    ["postcss", [8, 5, 18] as [number, number, number], "postcss <=8.5.17"],
    ["nanoid", [3, 3, 18] as [number, number, number], "nanoid <3.3.18"],
    ["browserslist", [4, 28, 7] as [number, number, number], "browserslist <=4.28.6"],
    ["undici", [8, 9, 0] as [number, number, number], "undici >=8.0.0 <8.9.0"],
    ["js-yaml", [4, 3, 1] as [number, number, number], "js-yaml <4.3.1"],
  ])("pins %s to a patched version for %s", (pkg, minimum) => {
    expectPinAtLeast(readPackageManifest().pnpm?.overrides ?? {}, pkg as string, minimum);
  });

  it("keeps js-yaml on the 4.x line so a security pin is not a breaking major bump", () => {
    const overrides = readPackageManifest().pnpm?.overrides ?? {};
    const key = Object.keys(overrides).find((k) => k === "js-yaml" || k.startsWith("js-yaml@"));
    expect(overrides[key as string]).toContain("<5");
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
