import { afterEach, expect, test, vi } from "vitest";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { testNodeRuntime } from "../fixtures/node-runtime.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test.each(["darwin", "linux", "win32"])("uses the running Node executable on %s without an override", (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
  expect(testNodeRuntime({})).toBe(process.execPath);
});

test("honors an explicit executable with spaces and runs its copied standalone fixture", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-node-selection-"));
  directories.push(directory);
  const override = path.join(directory, process.platform === "win32" ? "selected node.exe" : "selected node");
  await copyFile(testNodeRuntime(), override);
  expect(testNodeRuntime({ IRONCREW_TEST_NODE: override })).toBe(override);
  expect(
    execFileSync(testNodeRuntime({ IRONCREW_TEST_NODE: override }), ["-p", "40 + 2"], {
      encoding: "utf8",
      env: {},
    }).trim(),
  ).toBe("42");
});

test("rejects missing, empty and directory overrides instead of skipping or falling back", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-invalid-node-"));
  directories.push(directory);
  for (const runtime of [path.join(directory, "missing-node"), "", directory]) {
    expect(() => testNodeRuntime({ IRONCREW_TEST_NODE: runtime })).toThrow(
      "Set IRONCREW_TEST_NODE to a valid Node 26.4.0 executable",
    );
  }
});
