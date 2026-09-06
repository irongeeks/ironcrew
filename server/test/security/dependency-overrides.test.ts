import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

// ---------------------------------------------------------------------------
// Dependency overrides guard
//
// These tests assert that security-critical pnpm overrides remain in
// pnpm-workspace.yaml. If a future maintainer accidentally removes one while
// reorganising the manifest, the unit suite catches it before the audit
// regression slips into a release.
// ---------------------------------------------------------------------------

interface WorkspaceManifest {
  overrides?: Record<string, string>;
}

function readOverrides(): Record<string, string> {
  const path = resolve(__dirname, "../../../pnpm-workspace.yaml");
  const manifest = load(readFileSync(path, "utf8")) as WorkspaceManifest;
  return manifest.overrides ?? {};
}

/** Parse an exact pin or leading ">=x.y.z" floor into a comparable tuple. */
function parseFloor(value: string | undefined): [number, number, number] | null {
  const m = /^(?:>=\s*)?(\d+)\.(\d+)\.(\d+)(?=$|\s+<)/.exec(value ?? "");
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
  expect(key, `expected a pnpm-workspace.yaml overrides entry for ${pkg}`).toBeDefined();

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
    expectPinAtLeast(readOverrides(), "ip-address", [10, 1, 1]);
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
    expectPinAtLeast(readOverrides(), pkg as string, minimum);
  });

  it("keeps js-yaml on the 4.x line so a security pin is not a breaking major bump", () => {
    const overrides = readOverrides();
    const key = Object.keys(overrides).find((k) => k === "js-yaml" || k.startsWith("js-yaml@"));
    expect(overrides[key as string]).toContain("<5");
  });

  // Minimum fixes from the v0.3.0 production audit, including moderate/low findings.
  it.each([
    ["body-parser", [2, 3, 0] as [number, number, number], "GHSA-v422-hmwv-36x6"],
    ["hono", [4, 12, 34] as [number, number, number], "GHSA-8j4g-w8fx-2239 / GHSA-f23p-vx2j-j53r"],
    ["@hono/node-server", [1, 19, 15] as [number, number, number], "GHSA-frvp-7c67-39w9"],
    ["qs", [6, 16, 0] as [number, number, number], "GHSA-4mjr-xmp4-gh2g"],
    ["@xmldom/xmldom", [0, 8, 15] as [number, number, number], "GHSA-6gmq-8vp8-gcm6"],
  ])("pins %s to the v0.3.0 audit fix for %s", (pkg, minimum) => {
    expectPinAtLeast(readOverrides(), pkg as string, minimum);
  });
});
