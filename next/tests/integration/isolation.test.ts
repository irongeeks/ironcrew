import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../packages/tools/workspace.ts";
import {
  isVerifiedExecutionPort,
  LinuxIsolation,
  type IsolationProfile,
} from "../../packages/tools/isolation/index.ts";
import { safeRelative } from "../../packages/tools/isolation/files.ts";
it("never accepts configuration or a forged capability as OS isolation evidence", async () => {
  let invoked = false;
  const fake = {
    attestation: { verified: true },
    execute: async () => {
      invoked = true;
      throw new Error("must not run");
    },
  };
  expect(isVerifiedExecutionPort(fake)).toBe(false);
  const directory = await mkdtemp(path.join(tmpdir(), "isolation-failclosed-"));
  try {
    const workspace = new Workspace(directory, { executionPort: fake });
    await expect(workspace.execute({ argv: ["node", "-e", "process.exit(0)"] })).rejects.toThrow(
      "isolation_profile_unverified",
    );
    expect(invoked).toBe(false);
    await expect(LinuxIsolation.create({ verified: true } as unknown as IsolationProfile)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("copy boundaries reject aliases and credential paths while allowing real build paths", () => {
  for (const item of [
    "../secret",
    "/tmp/file",
    "a/../../b",
    "C:\\x",
    "a/.env.production",
    ".git/config",
    "a/CON",
    "a/file.",
    "x//z",
    "a/./b",
    "x\0z",
  ])
    expect(safeRelative(item), item).toBe(false);
  for (const item of ["dist/index.html", "theme/functions.php", "src/App.jsx"])
    expect(safeRelative(item), item).toBe(true);
});
