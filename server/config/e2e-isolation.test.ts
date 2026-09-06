import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertE2EIsolation, assertE2EPathsSafe, e2ePaths } from "./e2e-isolation.ts";

const runId = "a".repeat(32);
const dirs: string[] = [];
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-isolation-"));
  dirs.push(cwd);
  const paths = e2ePaths(runId, cwd);
  const env = {
    IRONCREW_E2E: "1",
    IRONCREW_E2E_RUN_ID: runId,
    HOST: "127.0.0.1",
    PORT: "8791",
    DB_PATH: paths.dbPath,
    LOGS_DIR: paths.logsDir,
  };
  return { cwd, env, ...paths };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("E2E database isolation", () => {
  it("allows only the dedicated loopback port and run-specific database", () => {
    const { cwd, env } = fixture();
    expect(() => assertE2EIsolation(env, cwd)).not.toThrow();
    for (const override of [
      { PORT: "8790" },
      { HOST: "0.0.0.0" },
      { DB_PATH: path.join(cwd, "ironcrew.sqlite") },
      { LOGS_DIR: "logs" },
      { IRONCREW_E2E_RUN_ID: "../../live" },
      { IRONCREW_E2E: "0" },
    ]) {
      expect(() => assertE2EIsolation({ ...env, ...override }, cwd)).toThrow();
    }
  });
  it("rejects a missing run ID and leaves ordinary startup alone", () => {
    expect(() => assertE2EIsolation({ IRONCREW_E2E: "1" })).toThrow();
    expect(() => assertE2EIsolation({ DB_PATH: "ironcrew.sqlite" })).not.toThrow();
  });
  it("rejects a scratch directory symlink before touching data", () => {
    const { cwd, env } = fixture();
    const live = path.join(cwd, "live");
    fs.mkdirSync(live);
    fs.symlinkSync(live, path.join(cwd, ".tmp"), "dir");
    expect(() => assertE2EIsolation(env, cwd)).toThrow(/symlink/);
    expect(fs.readdirSync(live)).toEqual([]);
  });
  it.each(["", "-wal", "-shm"])("rejects database%s symlinks", (suffix) => {
    const { cwd, dbPath, runtimeDir } = fixture();
    fs.mkdirSync(runtimeDir, { recursive: true });
    const live = path.join(cwd, "live.sqlite");
    fs.writeFileSync(live, "operator data");
    fs.symlinkSync(live, `${dbPath}${suffix}`);
    expect(() => assertE2EPathsSafe(runId, cwd)).toThrow(/symlink/);
    expect(fs.readFileSync(live, "utf8")).toBe("operator data");
  });
});
