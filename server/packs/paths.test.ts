import path from "node:path";
import { describe, expect, it } from "vitest";
import { communityPacksDir } from "./paths.ts";

describe("community pack storage", () => {
  const cwd = path.resolve("fixture-installation");
  it("preserves the operator location outside E2E", () => {
    expect(communityPacksDir(cwd, {})).toBe(path.join(cwd, "server", "packs", "community"));
  });
  it("isolates each browser run from operator packs and other runs", () => {
    const resolve = (runId: string) => communityPacksDir(cwd, { IRONCREW_E2E: "1", IRONCREW_E2E_RUN_ID: runId });
    expect(resolve("a".repeat(32))).toBe(path.join(cwd, ".tmp", "e2e-runtime", "a".repeat(32), "community-packs"));
    expect(resolve("a".repeat(32))).not.toBe(resolve("b".repeat(32)));
  });
  it("refuses missing or unsafe browser run identities", () => {
    for (const runId of [undefined, "../../operator", "not-a-run-id"]) {
      expect(() => communityPacksDir(cwd, { IRONCREW_E2E: "1", IRONCREW_E2E_RUN_ID: runId })).toThrow();
    }
  });
});
