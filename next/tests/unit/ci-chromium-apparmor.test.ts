import { expect, it } from "vitest";
import { chromiumAppArmorProfile } from "../../scripts/ci-chromium-apparmor.ts";
it("attaches userns permission only to the exact installed browser path", () => {
  const executable = "/home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
  expect(chromiumAppArmorProfile(executable)).toBe(
    `abi <abi/4.0>,\nprofile ironcrew-ci-chromium "${executable}" flags=(unconfined) {\n  userns,\n}\n`,
  );
  expect(chromiumAppArmorProfile("/tmp/own browser/chrome")).toContain('"/tmp/own browser/chrome"');
});
it("rejects AppArmor patterns, variables, rule injection and noncanonical paths", () => {
  for (const executable of [
    "chrome",
    "/tmp/**/chrome",
    "/tmp/?/chrome",
    "/tmp/[ab]/chrome",
    "/@{HOME}/chrome",
    '/tmp/chrome" {\n userns,\n}',
    "/tmp/a\\b/chrome",
    "/tmp/a/../chrome",
    "/tmp//chrome",
    "/tmp/chrome\n",
  ])
    expect(() => chromiumAppArmorProfile(executable), executable).toThrow(/literal absolute path/);
});
